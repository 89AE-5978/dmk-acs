'use strict';
/**
 * Segurança das entradas do DMK ACS (painel do admin e app do cliente avulso).
 *
 * - Senha: scrypt (N=2^15, r=8, p=1) com sal aleatório; comparação em tempo constante.
 *   Nunca se guarda a senha, só o resultado do scrypt.
 * - Segunda etapa: TOTP (RFC 6238; Google Authenticator, Authy...), 6 dígitos a cada 30 s,
 *   tolerância de 1 passo e sem reuso do mesmo código. Códigos de recuperação de uso único.
 * - Bloqueios:
 *     conta  - 5 erros seguidos bloqueiam 15 min; cada novo bloqueio dobra (até 24 h).
 *     IP     - 10 erros em 15 min bloqueiam o IP por 1 h; reincidente em 24 h fica 24 h.
 *     ritmo  - no máximo 20 tentativas de entrada por minuto por IP.
 *   Mensagens de erro genéricas ("usuário ou senha inválidos"): não revelam se o usuário existe.
 * - Auditoria: cada entrada, erro e bloqueio vai para <dados>/auditoria.log (uma linha JSON),
 *   com tamanho limitado (guarda só as linhas mais recentes).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ------------------------------------------------------------------ senha
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(senha), sal, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sal.toString('base64')}$${h.toString('base64')}`;
}

// Hash "falso" para gastar o mesmo tempo quando o usuário não existe (não revela quem existe)
const HASH_FALSO = hashSenha(crypto.randomBytes(16).toString('hex'));

function conferirSenha(senha, guardado) {
  const partes = String(guardado || HASH_FALSO).split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;
  const [, N, r, p, sal, h] = partes;
  const esperado = Buffer.from(h, 'base64');
  const obtido = crypto.scryptSync(String(senha), Buffer.from(sal, 'base64'), esperado.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(esperado, obtido) && !!guardado;
}

const COMUNS = ['123456', 'senha', 'password', 'qwerty', 'admin', 'dmk', 'provedor', 'internet', 'mudar', 'abc123', '102030'];
/** Regra de senha forte. Devolve a mensagem do problema ou '' se está boa. */
function problemaSenha(senha, usuario = '', minimo = 10) {
  const s = String(senha || '');
  if (s.length < minimo) return `A senha precisa ter pelo menos ${minimo} caracteres.`;
  if (s.length > 128) return 'Senha longa demais (máximo 128).';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
  if (classes < 3) return 'Misture pelo menos 3 tipos: minúsculas, maiúsculas, números e símbolos.';
  const baixa = s.toLowerCase();
  if (usuario && baixa.includes(String(usuario).toLowerCase())) return 'A senha não pode conter o usuário.';
  if (COMUNS.some((c) => baixa.includes(c)) && s.length < 16) return 'Senha fácil de adivinhar. Evite palavras comuns como "senha", "admin" ou sequências.';
  if (/(.)\1{3,}/.test(s)) return 'Evite repetir o mesmo caractere várias vezes.';
  return '';
}

// ------------------------------------------------------------------ TOTP
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0; let valor = 0; let s = '';
  for (const b of buf) { valor = (valor << 8) | b; bits += 8; while (bits >= 5) { s += B32[(valor >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) s += B32[(valor << (5 - bits)) & 31];
  return s;
}
function deBase32(s) {
  const limpo = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let valor = 0; const out = [];
  for (const c of limpo) { valor = (valor << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((valor >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
const novoSegredoTotp = () => base32(crypto.randomBytes(20));

function codigoTotp(segredo, passo) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(passo));
  const h = crypto.createHmac('sha1', deBase32(segredo)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
const passoAtual = (agora = Date.now()) => Math.floor(agora / 30000);

/** Confere o código: aceita o passo atual e 1 para cada lado. Devolve o passo usado ou null. Recusa reuso. */
function conferirTotp(segredo, codigo, ultimoPassoUsado = -1, agora = Date.now()) {
  const c = String(codigo || '').replace(/\D/g, '');
  if (c.length !== 6 || !segredo) return null;
  const p = passoAtual(agora);
  for (const d of [0, -1, 1]) {
    const passo = p + d;
    if (passo <= ultimoPassoUsado) continue;
    const esperado = Buffer.from(codigoTotp(segredo, passo));
    if (crypto.timingSafeEqual(esperado, Buffer.from(c))) return passo;
  }
  return null;
}
const uriTotp = (segredo, usuario, emissor = 'DMK ACS') =>
  `otpauth://totp/${encodeURIComponent(emissor)}:${encodeURIComponent(usuario)}?secret=${segredo}&issuer=${encodeURIComponent(emissor)}&algorithm=SHA1&digits=6&period=30`;

// ------------------------------------------------------------------ códigos de recuperação
const SEM_AMBIGUOS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function aleatorio(n, alfabeto = SEM_AMBIGUOS) {
  const b = crypto.randomBytes(n);
  return [...b].map((x) => alfabeto[x % alfabeto.length]).join('');
}
const hashCurto = (s) => crypto.createHash('sha256').update(String(s).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
function novosCodigosRecuperacao(qtd = 8) {
  const codigos = Array.from({ length: qtd }, () => `${aleatorio(4)}-${aleatorio(4)}`);
  return { codigos, hashes: codigos.map(hashCurto) };
}
/** Usa um código de recuperação (some da lista). Devolve a nova lista de hashes ou null. */
function usarCodigoRecuperacao(hashes, codigo) {
  const h = hashCurto(codigo);
  const i = (hashes || []).indexOf(h);
  if (i < 0) return null;
  return hashes.filter((_, k) => k !== i);
}

// ------------------------------------------------------------------ bloqueios por IP + auditoria
function criarGuarda(pastaDados, { logMax = 2 * 1024 * 1024 } = {}) {
  const arquivo = path.join(pastaDados, 'seguranca.json');
  const auditoria = path.join(pastaDados, 'auditoria.log');
  let estado = { ips: {} };
  try { estado = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { /* começa vazio */ }
  estado.ips ||= {};
  const ritmo = new Map();   // ip -> [instantes] (só memória)

  function gravar() {
    const agora = Date.now();
    for (const [ip, e] of Object.entries(estado.ips)) {   // tira o que já venceu
      e.falhas = (e.falhas || []).filter((t) => agora - t < 15 * 60e3);
      if ((!e.bloqueadoAte || e.bloqueadoAte < agora) && !e.falhas.length && (!e.ultimoBloqueio || agora - e.ultimoBloqueio > 86400e3)) delete estado.ips[ip];
    }
    const tmp = arquivo + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(estado), { mode: 0o600 });
    fs.renameSync(tmp, arquivo);
  }

  function registrar(evento, dados = {}) {
    try {
      fs.appendFileSync(auditoria, JSON.stringify({ quando: new Date().toISOString(), evento, ...dados }) + '\n', { mode: 0o600 });
      const st = fs.statSync(auditoria);
      if (st.size > logMax) {   // guarda só a metade mais recente
        const linhas = fs.readFileSync(auditoria, 'utf8').split('\n');
        fs.writeFileSync(auditoria, linhas.slice(Math.floor(linhas.length / 2)).join('\n'), { mode: 0o600 });
      }
    } catch { /* auditoria não pode derrubar a entrada */ }
  }

  return {
    registrar,

    /** Lança erro 429 se o IP está bloqueado ou passou do ritmo. Chamar antes de conferir senha. */
    conferirIp(ip) {
      const agora = Date.now();
      const e = estado.ips[ip];
      if (e && e.bloqueadoAte > agora) {
        throw Object.assign(new Error(`Acesso bloqueado por segurança. Tente de novo em ${Math.ceil((e.bloqueadoAte - agora) / 60e3)} min.`), { status: 429 });
      }
      const lista = (ritmo.get(ip) || []).filter((t) => agora - t < 60e3);
      lista.push(agora); ritmo.set(ip, lista);
      if (lista.length > 20) throw Object.assign(new Error('Muitas tentativas seguidas. Espere um minuto.'), { status: 429 });
    },

    falhaIp(ip, motivo) {
      const agora = Date.now();
      const e = (estado.ips[ip] ||= { falhas: [] });
      e.falhas = (e.falhas || []).filter((t) => agora - t < 15 * 60e3);
      e.falhas.push(agora);
      if (e.falhas.length >= 10) {
        const reincidente = e.ultimoBloqueio && agora - e.ultimoBloqueio < 86400e3;
        e.bloqueadoAte = agora + (reincidente ? 24 * 3600e3 : 3600e3);
        e.ultimoBloqueio = agora; e.motivo = motivo; e.falhas = [];
        registrar('ip-bloqueado', { ip, ate: new Date(e.bloqueadoAte).toISOString(), motivo });
      }
      gravar();
    },
    sucessoIp(ip) { if (estado.ips[ip]) { estado.ips[ip].falhas = []; gravar(); } },

    bloqueados() {
      const agora = Date.now();
      return Object.entries(estado.ips).filter(([, e]) => e.bloqueadoAte > agora).map(([ip, e]) => ({ ip, ate: new Date(e.bloqueadoAte).toISOString(), motivo: e.motivo || '' }));
    },
    desbloquear(ip) { if (estado.ips[ip]) { delete estado.ips[ip]; gravar(); return true; } return false; },

    ultimos(n = 60) {
      try {
        return fs.readFileSync(auditoria, 'utf8').trim().split('\n').slice(-n).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { return []; }
    },
  };
}

/** Bloqueio de CONTA (guardado no próprio registro da conta). */
function contaBloqueada(conta, agora = Date.now()) { return conta && conta.bloqueadoAte && conta.bloqueadoAte > agora ? conta.bloqueadoAte : 0; }
function falhaConta(conta, agora = Date.now()) {
  conta.falhas = (conta.falhas || 0) + 1;
  if (conta.falhas >= 5) {
    conta.nivelBloqueio = Math.min((conta.nivelBloqueio || 0) + 1, 7);
    conta.bloqueadoAte = agora + Math.min(15 * 60e3 * 2 ** (conta.nivelBloqueio - 1), 24 * 3600e3);
    conta.falhas = 0;
    return true;
  }
  return false;
}
function sucessoConta(conta) { conta.falhas = 0; conta.bloqueadoAte = 0; conta.nivelBloqueio = 0; conta.ultimoAcesso = new Date().toISOString(); }

module.exports = {
  hashSenha, conferirSenha, problemaSenha,
  novoSegredoTotp, codigoTotp, conferirTotp, uriTotp, passoAtual,
  novosCodigosRecuperacao, usarCodigoRecuperacao, aleatorio,
  criarGuarda, contaBloqueada, falhaConta, sucessoConta,
};
