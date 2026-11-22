'use strict';
/**
 * Contas do DMK ACS em <dados>/contas.json (permissão 600, gravação atômica):
 *   admins  - quem entra no painel público (usuário + senha + autenticador).
 *   avulsos - clientes avulsos ("DMK Wi-Fi"): cadastro, código do endereço do ACS e acesso ao app.
 * E <dados>/config-painel.json: endereço base do ACS para os clientes avulsos.
 *
 * Cliente avulso: o roteador dele aponta para  <endereço base>/c/<CÓDIGO>  e cai sozinho na conta
 * (mesma marcação por endereço que separa os provedores).
 */
const fs = require('node:fs');
const path = require('node:path');
const { Erro400 } = require('./armazenamento');
const seg = require('./seguranca');

const USUARIO = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function criarContas(pastaDados) {
  const arquivo = path.join(pastaDados, 'contas.json');
  const arqConfig = path.join(pastaDados, 'config-painel.json');

  function ler() {
    try { const d = JSON.parse(fs.readFileSync(arquivo, 'utf8')); return { admins: d.admins || [], avulsos: d.avulsos || [] }; } catch (e) {
      if (e.code === 'ENOENT') return { admins: [], avulsos: [] };
      throw new Error('contas.json ilegível: ' + e.message);
    }
  }
  function gravar(d) {
    const tmp = arquivo + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, arquivo);
  }
  /** Lê, deixa a função mudar e grava (tudo síncrono: sem corrida entre pedidos). */
  function mudar(fn) { const d = ler(); const r = fn(d); gravar(d); return r; }

  const normUsuario = (u) => String(u || '').trim().toLowerCase();
  function validarUsuario(u, d, ignorar) {
    if (!USUARIO.test(u)) throw new Erro400('Usuário: 3 a 32 letras minúsculas, números, ponto, hífen ou _.', 'usuario');
    if ([...d.admins, ...d.avulsos].some((c) => c.usuario === u && c !== ignorar)) throw new Erro400('Esse usuário já existe.', 'usuario');
  }

  return {
    ler, mudar,

    // ---------------- configuração
    config() {
      try { return { enderecoAvulsos: '', ...JSON.parse(fs.readFileSync(arqConfig, 'utf8')) }; } catch { return { enderecoAvulsos: '' }; }
    },
    gravarConfig(c) {
      const tmp = arqConfig + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
      fs.renameSync(tmp, arqConfig);
    },

    // ---------------- admins
    temAdmin() { return ler().admins.length > 0; },
    admin(usuario) { return ler().admins.find((a) => a.usuario === normUsuario(usuario)) || null; },

    criarAdmin({ usuario, senha, totpSegredo, recuperacao }) {
      return mudar((d) => {
        const u = normUsuario(usuario);
        validarUsuario(u, d);
        const p = seg.problemaSenha(senha, u, 10);
        if (p) throw new Erro400(p, 'senha');
        const a = { usuario: u, senhaHash: seg.hashSenha(senha), totpSegredo, totpUltimoPasso: -1, recuperacao, falhas: 0, bloqueadoAte: 0, nivelBloqueio: 0, criadoEm: new Date().toISOString(), ultimoAcesso: '' };
        d.admins.push(a);
        return a;
      });
    },
    alterarAdmin(usuario, fn) {
      return mudar((d) => { const a = d.admins.find((x) => x.usuario === normUsuario(usuario)); if (!a) return null; fn(a); return a; });
    },

    // ---------------- clientes avulsos
    avulsos() { return ler().avulsos; },
    avulso(codigo) { return ler().avulsos.find((c) => c.codigo === String(codigo || '').toUpperCase()) || null; },
    avulsoPorUsuario(usuario) { return ler().avulsos.find((c) => c.usuario === normUsuario(usuario)) || null; },

    criarAvulso(entrada) {
      return mudar((d) => {
        const nome = String(entrada.nome ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
        if (nome.length < 3 || nome.length > 80) throw new Erro400('Informe o nome completo do cliente.', 'nome');
        const telefone = String(entrada.telefone ?? '').replace(/\D/g, '');
        if (telefone && (telefone.length < 10 || telefone.length > 13)) throw new Erro400('Telefone inválido. Ex.: (11) 98888-7777', 'telefone');
        const email = String(entrada.email ?? '').trim().toLowerCase();
        if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) throw new Erro400('E-mail inválido.', 'email');
        const u = normUsuario(entrada.usuario);
        validarUsuario(u, d);
        let codigo;
        do { codigo = seg.aleatorio(6); } while (d.avulsos.some((c) => c.codigo === codigo));
        const senhaInicial = `${seg.aleatorio(4)}-${seg.aleatorio(4)}`;   // provisória: o cliente troca no app
        const agora = new Date().toISOString();
        const c = { codigo, nome, telefone, email, usuario: u, senhaHash: seg.hashSenha(senhaInicial), trocarSenha: true, ativo: true, falhas: 0, bloqueadoAte: 0, nivelBloqueio: 0, criadoEm: agora, atualizadoEm: agora, ultimoAcesso: '' };
        d.avulsos.push(c);
        return { cliente: c, senhaInicial };
      });
    },

    alterarAvulso(codigo, entrada) {
      return mudar((d) => {
        const c = d.avulsos.find((x) => x.codigo === String(codigo).toUpperCase());
        if (!c) return null;
        if (entrada.nome != null) {
          const nome = String(entrada.nome).trim().replace(/\s+/g, ' ').toUpperCase();
          if (nome.length < 3) throw new Erro400('Informe o nome completo do cliente.', 'nome');
          c.nome = nome;
        }
        if (entrada.telefone != null) {
          const t = String(entrada.telefone).replace(/\D/g, '');
          if (t && (t.length < 10 || t.length > 13)) throw new Erro400('Telefone inválido. Ex.: (11) 98888-7777', 'telefone');
          c.telefone = t;
        }
        if (entrada.email != null) {
          const e = String(entrada.email).trim().toLowerCase();
          if (e && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)) throw new Erro400('E-mail inválido.', 'email');
          c.email = e;
        }
        if (entrada.usuario != null && normUsuario(entrada.usuario) !== c.usuario) {
          const u = normUsuario(entrada.usuario); validarUsuario(u, d, c); c.usuario = u;
        }
        if (typeof entrada.ativo === 'boolean') c.ativo = entrada.ativo;
        c.atualizadoEm = new Date().toISOString();
        return c;
      });
    },

    /** Nova senha provisória (o admin entrega ao cliente; ele troca no primeiro acesso). */
    novaSenhaAvulso(codigo) {
      return mudar((d) => {
        const c = d.avulsos.find((x) => x.codigo === String(codigo).toUpperCase());
        if (!c) return null;
        const senha = `${seg.aleatorio(4)}-${seg.aleatorio(4)}`;
        Object.assign(c, { senhaHash: seg.hashSenha(senha), trocarSenha: true, falhas: 0, bloqueadoAte: 0, nivelBloqueio: 0, atualizadoEm: new Date().toISOString() });
        return senha;
      });
    },

    alterarConta(tipo, chave, fn) {
      return mudar((d) => {
        const c = tipo === 'admin' ? d.admins.find((x) => x.usuario === chave) : d.avulsos.find((x) => x.codigo === chave);
        if (c) fn(c);
        return c || null;
      });
    },

    removerAvulso(codigo) {
      return mudar((d) => { const n = d.avulsos.length; d.avulsos = d.avulsos.filter((c) => c.codigo !== String(codigo).toUpperCase()); return d.avulsos.length < n; });
    },
  };
}

/** Dados do cliente avulso que podem sair na tela (nunca hash, nunca bloqueio interno). */
function avulsoPublico(c) {
  const { senhaHash, falhas, nivelBloqueio, ...resto } = c;   // eslint-disable-line no-unused-vars
  return { ...resto, bloqueado: !!seg.contaBloqueada(c) };
}

module.exports = { criarContas, avulsoPublico };
