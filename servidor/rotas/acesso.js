'use strict';
/**
 * Login do admin no painel público (/admin/).
 *
 * Primeiro acesso (ainda não existe admin):
 *   1. código de primeiro acesso (fica só no servidor: dados/primeiro-acesso.txt e no log) + usuário + senha
 *   2. escaneia o QR no app autenticador e confirma um código de 6 dígitos
 *   3. recebe 8 códigos de recuperação (mostrados uma vez só) -> conta criada, código apagado
 *
 * Entrada:  usuário + senha  ->  código do autenticador (ou um código de recuperação)  ->  sessão
 * A sessão do admin cai com 30 min sem uso (e no máximo 12 h). Cookie HttpOnly, SameSite=Strict,
 * Secure quando em HTTPS.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const qr = require('../lib/qr');

module.exports = function rotasAcesso(ctx) {
  const { rota, enviar, lerCorpo, contas, seg, guarda, sessoes, ipDe, definirCookie, cookie, CFG, Erro400, codigoPrimeiroAcesso, log } = ctx;

  const pendentes = new Map();   // primeiro acesso em andamento: token -> {usuario, senha, segredo, expira}
  const desafios = new Map();    // senha certa, falta o autenticador: token -> {usuario, ip, expira, tentativas}
  setInterval(() => {
    const agora = Date.now();
    for (const m of [pendentes, desafios]) for (const [k, v] of m) if (v.expira < agora) m.delete(k);
  }, 60e3).unref();

  const token = () => crypto.randomBytes(24).toString('base64url');
  const igual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  rota('GET', '/api/acesso/estado', async (req, res) => {
    enviar(res, 200, { temAdmin: contas.temAdmin(), simulacao: CFG.simulacao });
  });

  // ---------------- primeiro acesso
  rota('POST', '/api/acesso/primeiro/iniciar', async (req, res) => {
    const ip = ipDe(req);
    guarda.conferirIp(ip);
    const codigo = codigoPrimeiroAcesso();
    if (!codigo) return enviar(res, 409, { erro: 'O administrador já foi criado. Entre com usuário e senha.' });
    const d = await lerCorpo(req);
    if (!igual(String(d.codigo || '').trim().toUpperCase(), codigo)) {
      guarda.falhaIp(ip, 'código de primeiro acesso errado');
      guarda.registrar('primeiro-acesso-codigo-errado', { ip });
      throw new Erro400('Código de primeiro acesso errado. Ele está no servidor, em dados/primeiro-acesso.txt.', 'codigo');
    }
    const usuario = String(d.usuario || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(usuario)) throw new Erro400('Usuário: 3 a 32 letras minúsculas, números, ponto, hífen ou _.', 'usuario');
    const problema = seg.problemaSenha(d.senha, usuario, 10);
    if (problema) throw new Erro400(problema, 'senha');
    if (d.senha !== d.confirmar) throw new Erro400('A confirmação não bate com a senha.', 'confirmar');
    const segredo = seg.novoSegredoTotp();
    const t = token();
    pendentes.set(t, { usuario, senha: d.senha, segredo, expira: Date.now() + 10 * 60e3 });
    const uri = seg.uriTotp(segredo, usuario);
    enviar(res, 200, { token: t, segredo, qr: 'data:image/svg+xml;base64,' + Buffer.from(qr.svg(uri, 5)).toString('base64') });
  });

  rota('POST', '/api/acesso/primeiro/concluir', async (req, res) => {
    const ip = ipDe(req);
    guarda.conferirIp(ip);
    const d = await lerCorpo(req);
    const p = pendentes.get(String(d.token || ''));
    if (!p || p.expira < Date.now()) throw new Erro400('O cadastro expirou (10 min). Comece de novo.', 'token');
    const passo = seg.conferirTotp(p.segredo, d.codigo);
    if (passo === null) { guarda.falhaIp(ip, 'autenticador errado no primeiro acesso'); throw new Erro400('Código do autenticador não confere. Veja se o horário do celular está certo.', 'codigo'); }
    const { codigos, hashes } = seg.novosCodigosRecuperacao();
    const admin = contas.criarAdmin({ usuario: p.usuario, senha: p.senha, totpSegredo: p.segredo, recuperacao: hashes });
    contas.alterarAdmin(admin.usuario, (a) => { a.totpUltimoPasso = passo; });
    pendentes.delete(String(d.token));
    try { fs.unlinkSync(path.join(CFG.dados, 'primeiro-acesso.txt')); } catch { /* já não existia */ }
    guarda.registrar('admin-criado', { usuario: admin.usuario, ip });
    log(`Admin "${admin.usuario}" criado (primeiro acesso concluído).`);
    enviar(res, 200, { usuario: admin.usuario, codigosRecuperacao: codigos });
  });

  // ---------------- entrada: senha
  rota('POST', '/api/acesso/entrar', async (req, res) => {
    const ip = ipDe(req);
    guarda.conferirIp(ip);
    const d = await lerCorpo(req);
    const usuario = String(d.usuario || '').trim().toLowerCase();
    const conta = contas.admin(usuario);
    const ate = seg.contaBloqueada(conta);
    if (ate) {
      guarda.falhaIp(ip, 'tentativa em conta bloqueada');
      throw Object.assign(new Error(`Conta bloqueada por segurança depois de várias tentativas. Tente em ${Math.ceil((ate - Date.now()) / 60e3)} min.`), { status: 429 });
    }
    const certa = seg.conferirSenha(String(d.senha || ''), conta && conta.senhaHash);   // gasta o mesmo tempo mesmo sem conta
    if (!conta || !certa) {
      guarda.falhaIp(ip, 'senha errada');
      if (conta) {
        let bloqueou = false;
        contas.alterarAdmin(usuario, (a) => { bloqueou = seg.falhaConta(a); });
        if (bloqueou) guarda.registrar('conta-bloqueada', { usuario, ip });
      }
      guarda.registrar('entrada-recusada', { usuario: usuario.slice(0, 32), ip, etapa: 'senha' });
      throw Object.assign(new Error('Usuário ou senha inválidos.'), { status: 401 });
    }
    const t = token();
    desafios.set(t, { usuario, ip, expira: Date.now() + 5 * 60e3, tentativas: 0 });
    enviar(res, 200, { etapa: 'autenticador', desafio: t });
  });

  // ---------------- entrada: autenticador (ou código de recuperação)
  rota('POST', '/api/acesso/autenticador', async (req, res) => {
    const ip = ipDe(req);
    guarda.conferirIp(ip);
    const d = await lerCorpo(req);
    const desafio = desafios.get(String(d.desafio || ''));
    if (!desafio || desafio.expira < Date.now() || desafio.ip !== ip) {
      throw Object.assign(new Error('A etapa expirou. Entre com usuário e senha de novo.'), { status: 401, reiniciar: true });
    }
    const conta = contas.admin(desafio.usuario);
    if (!conta || seg.contaBloqueada(conta)) { desafios.delete(String(d.desafio)); throw Object.assign(new Error('Conta bloqueada por segurança. Tente mais tarde.'), { status: 429 }); }

    const texto = String(d.codigo || '').trim();
    let ok = false; let usouRecuperacao = false;
    if (/^\d{6}$/.test(texto.replace(/\s/g, ''))) {
      const passo = seg.conferirTotp(conta.totpSegredo, texto, conta.totpUltimoPasso ?? -1);
      if (passo !== null) { ok = true; contas.alterarAdmin(conta.usuario, (a) => { a.totpUltimoPasso = passo; }); }
    } else {
      const resto = seg.usarCodigoRecuperacao(conta.recuperacao, texto);
      if (resto) { ok = true; usouRecuperacao = true; contas.alterarAdmin(conta.usuario, (a) => { a.recuperacao = resto; }); }
    }

    if (!ok) {
      guarda.falhaIp(ip, 'autenticador errado');
      let bloqueou = false;
      contas.alterarAdmin(conta.usuario, (a) => { bloqueou = seg.falhaConta(a); });
      guarda.registrar('entrada-recusada', { usuario: conta.usuario, ip, etapa: 'autenticador' });
      if (bloqueou) { guarda.registrar('conta-bloqueada', { usuario: conta.usuario, ip }); desafios.delete(String(d.desafio)); }
      if (++desafio.tentativas >= 5) desafios.delete(String(d.desafio));
      throw Object.assign(new Error('Código inválido.'), { status: 401, campo: 'codigo' });
    }

    desafios.delete(String(d.desafio));
    contas.alterarAdmin(conta.usuario, (a) => seg.sucessoConta(a));
    guarda.sucessoIp(ip);
    guarda.registrar('entrada', { usuario: conta.usuario, ip, recuperacao: usouRecuperacao || undefined });
    const s = sessoes.criar({ papel: 'central', nome: conta.usuario, admin: conta.usuario, ip, inatividadeMs: 30 * 60e3, duracaoMs: 12 * 3600e3 });
    const restantes = usouRecuperacao ? (contas.admin(conta.usuario).recuperacao || []).length : undefined;
    enviar(res, 200, { ok: true, codigosRestantes: restantes }, { 'Set-Cookie': definirCookie(req, 'dmkacs', s) });
  });

  rota('POST', '/api/acesso/sair', async (req, res) => {
    const s = sessoes.obter(cookie(req, 'dmkacs'));
    if (s && s.admin) guarda.registrar('saida', { usuario: s.admin, ip: ipDe(req) });
    sessoes.encerrar(cookie(req, 'dmkacs'));
    enviar(res, 200, { ok: true }, { 'Set-Cookie': definirCookie(req, 'dmkacs', '', { maxAge: 0 }) });
  });
};
