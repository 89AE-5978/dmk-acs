'use strict';
/**
 * Painel do admin DMK (/central/): provedores, clientes avulsos, segurança e conexão com o DMK Prisma.
 * Entra quem tem sessão "central": login do admin (usuário + senha + autenticador) ou ticket do
 * DMK Prisma. Ações sensíveis (segredo de integração, senha, códigos de recuperação) exigem o
 * login do admin e um código do autenticador na hora.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { avulsoPublico } = require('../lib/contas');

module.exports = function rotasCentral(ctx) {
  const {
    rota, enviar, lerCorpo, exigirSessao, banco, contas, guarda, seg, sessoes, nbi, ipDe, log, CFG, VERSAO, estadoAcs, Erro400,
    roteadoresDaChave, roteadorDaChave, validarWifi, trocarWifi, reiniciar, lerAgora, enderecoAvulso, chaveAvulso, chaveProvedor, lerSegredo, paraTela, PROJECAO, lerClientes,
  } = ctx;

  const central = (req) => exigirSessao(req, 'central');

  /** Ações sensíveis: só com login do admin + código do autenticador na hora. */
  function exigirConfirmacao(req, s, codigo) {
    if (!s.admin) throw Object.assign(new Error('Para isso, entre pelo painel com usuário, senha e autenticador.'), { status: 403 });
    const ip = ipDe(req);
    guarda.conferirIp(ip);
    const conta = contas.admin(s.admin);
    const passo = conta && seg.conferirTotp(conta.totpSegredo, codigo, conta.totpUltimoPasso ?? -1);
    if (passo == null) { guarda.falhaIp(ip, 'autenticador errado em ação sensível'); throw new Erro400('Código do autenticador inválido.', 'codigo'); }
    contas.alterarAdmin(conta.usuario, (a) => { a.totpUltimoPasso = passo; });
    return conta;
  }

  // ---------------------------------------------------------------- resumo (KPIs + listas)
  rota('GET', '/api/central/resumo', async (req, res) => {
    const s = central(req);
    const provedores = banco.listar();
    const avulsos = contas.avulsos();
    const docs = await nbi.dispositivos({}, PROJECAO);
    const porChave = new Map();
    for (const p of provedores) porChave.set(chaveProvedor(p), { total: 0, online: 0 });
    for (const c of avulsos) { const k = chaveAvulso(c.codigo); if (k) porChave.set(k, { total: 0, online: 0, roteador: null }); }
    const sem = { total: 0, online: 0 };
    for (const d of docs) {
      const r = paraTela(d);
      const conta = (d._tags || []).map((t) => porChave.get(t)).find(Boolean) || sem;
      conta.total++; if (r.online) conta.online++;
      if ('roteador' in conta && !conta.roteador) conta.roteador = r;   // cliente avulso: o 1º roteador dele
    }
    const zero = { total: 0, online: 0, roteador: null };
    enviar(res, 200, {
      usuario: s.nome, admin: !!s.admin, versao: VERSAO, acs: estadoAcs,
      enderecoAvulsos: contas.config().enderecoAvulsos || CFG.enderecoAvulsos || '',
      provedores: provedores.map((p) => { const { roteador, ...n } = porChave.get(chaveProvedor(p)) || zero; void roteador; return { ...p, chave: chaveProvedor(p), ...n }; }),
      avulsos: avulsos.map((c) => ({ ...avulsoPublico(c), enderecoAcs: enderecoAvulso(c.codigo), ...(porChave.get(chaveAvulso(c.codigo)) || zero) })),
      semDono: sem,
    });
  });

  // ---------------------------------------------------------------- provedores
  rota('POST', '/api/central/provedores', async (req, res) => { central(req); enviar(res, 201, banco.criar(await lerCorpo(req))); });
  rota('PUT', '/api/central/provedores/([a-z0-9-]+)', async (req, res, m) => {
    const s = central(req);
    const p = banco.alterar(m[1], await lerCorpo(req));
    if (!p) return enviar(res, 404, { erro: 'Provedor não encontrado.' });
    guarda.registrar('provedor-alterado', { por: s.nome, provedor: p.id, ativo: p.ativo });
    log(`Central (${s.nome}): provedor ${p.id} ${p.ativo ? 'ativo' : 'desativado'} (${p.enderecoAcs})`);
    enviar(res, 200, p);
  });
  rota('DELETE', '/api/central/provedores/([a-z0-9-]+)', async (req, res, m) => {
    const s = central(req);
    const ok = banco.remover(m[1]);
    if (ok) guarda.registrar('provedor-excluido', { por: s.nome, provedor: m[1] });
    enviar(res, ok ? 200 : 404, { ok });
  });
  rota('GET', '/api/central/provedores/([a-z0-9-]+)/roteadores', async (req, res, m) => {
    central(req);
    const p = banco.obter(m[1]);
    if (!p) return enviar(res, 404, { erro: 'Provedor não encontrado.' });
    enviar(res, 200, await roteadoresDaChave(chaveProvedor(p), lerClientes(p.id)));
  });

  // ---------------------------------------------------------------- clientes avulsos
  rota('PUT', '/api/central/config', async (req, res) => {
    const s = central(req);
    const d = await lerCorpo(req);
    let base = String(d.enderecoAvulsos || '').trim();
    if (base && !/^[a-z]+:\/\//i.test(base)) base = 'http://' + base;
    let u;
    try { u = new URL(base); } catch { throw new Erro400('Endereço inválido. Ex.: acs.dmksolutions.io ou http://acs.dmksolutions.io:7547', 'enderecoAvulsos'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new Erro400('Use só o domínio (e a porta), sem caminho.', 'enderecoAvulsos');
    if (!u.port && u.protocol === 'http:') u.port = '7547';
    const endereco = `${u.protocol}//${u.host}`;
    const dono = banco.listar().find((p) => new URL(p.enderecoAcs).host === u.host && new URL(p.enderecoAcs).pathname === '/');
    if (dono) throw new Erro400(`Esse domínio já é do provedor ${dono.nome}. Use um domínio da DMK para os clientes avulsos.`, 'enderecoAvulsos');
    contas.gravarConfig({ ...contas.config(), enderecoAvulsos: endereco });
    guarda.registrar('config-alterada', { por: s.nome, enderecoAvulsos: endereco });
    enviar(res, 200, { enderecoAvulsos: endereco });
  });

  rota('POST', '/api/central/avulsos', async (req, res) => {
    const s = central(req);
    if (!enderecoAvulso('X')) throw new Erro400('Defina antes o endereço do ACS para clientes avulsos (seção Conexão).');
    const { cliente, senhaInicial } = contas.criarAvulso(await lerCorpo(req));
    guarda.registrar('avulso-criado', { por: s.nome, codigo: cliente.codigo });
    enviar(res, 201, { cliente: { ...avulsoPublico(cliente), enderecoAcs: enderecoAvulso(cliente.codigo) }, senhaInicial });
  });
  rota('PUT', '/api/central/avulsos/([A-Z0-9]{6})', async (req, res, m) => {
    const s = central(req);
    const c = contas.alterarAvulso(m[1], await lerCorpo(req));
    if (!c) return enviar(res, 404, { erro: 'Cliente não encontrado.' });
    if (!c.ativo) sessoes.encerrarOnde((x) => x.papel === 'cliente' && x.codigo === c.codigo);   // desativado sai do app na hora
    guarda.registrar('avulso-alterado', { por: s.nome, codigo: c.codigo, ativo: c.ativo });
    enviar(res, 200, { ...avulsoPublico(c), enderecoAcs: enderecoAvulso(c.codigo) });
  });
  rota('DELETE', '/api/central/avulsos/([A-Z0-9]{6})', async (req, res, m) => {
    const s = central(req);
    const ok = contas.removerAvulso(m[1]);
    if (ok) { sessoes.encerrarOnde((x) => x.papel === 'cliente' && x.codigo === m[1]); guarda.registrar('avulso-excluido', { por: s.nome, codigo: m[1] }); }
    enviar(res, ok ? 200 : 404, { ok });
  });
  rota('POST', '/api/central/avulsos/([A-Z0-9]{6})/nova-senha', async (req, res, m) => {
    const s = central(req);
    const senha = contas.novaSenhaAvulso(m[1]);
    if (!senha) return enviar(res, 404, { erro: 'Cliente não encontrado.' });
    sessoes.encerrarOnde((x) => x.papel === 'cliente' && x.codigo === m[1]);
    guarda.registrar('avulso-nova-senha', { por: s.nome, codigo: m[1] });
    enviar(res, 200, { senha });
  });
  rota('GET', '/api/central/avulsos/([A-Z0-9]{6})/roteadores', async (req, res, m) => {
    central(req);
    if (!contas.avulso(m[1])) return enviar(res, 404, { erro: 'Cliente não encontrado.' });
    enviar(res, 200, await roteadoresDaChave(chaveAvulso(m[1]), {}));
  });
  // Suporte: o admin também troca Wi-Fi / reinicia o roteador do cliente avulso
  rota('POST', '/api/central/avulsos/([A-Z0-9]{6})/roteadores/([^/]+)/(wifi|reiniciar|atualizar)', async (req, res, m) => {
    const s = central(req);
    const id = await roteadorDaChave(chaveAvulso(m[1]), decodeURIComponent(m[2]));
    if (m[3] === 'wifi') {
      const d = await lerCorpo(req);
      const w = validarWifi(d.ssid, d.senha);
      guarda.registrar('wifi-alterado', { por: s.nome, avulso: m[1], roteador: id });
      return enviar(res, 200, { situacao: await trocarWifi(id, w) });
    }
    if (m[3] === 'reiniciar') { guarda.registrar('roteador-reiniciado', { por: s.nome, avulso: m[1], roteador: id }); return enviar(res, 200, { situacao: await reiniciar(id) }); }
    enviar(res, 200, await lerAgora(id));
  });

  // ---------------------------------------------------------------- segurança
  rota('GET', '/api/central/seguranca', async (req, res) => {
    const s = central(req);
    const conta = s.admin ? contas.admin(s.admin) : null;
    enviar(res, 200, {
      conta: conta ? { usuario: conta.usuario, criadoEm: conta.criadoEm, ultimoAcesso: conta.ultimoAcesso, codigosRestantes: (conta.recuperacao || []).length } : null,
      bloqueados: guarda.bloqueados(),
      registros: guarda.ultimos(80),
    });
  });
  rota('POST', '/api/central/seguranca/desbloquear', async (req, res) => {
    const s = central(req);
    const { ip } = await lerCorpo(req);
    const ok = guarda.desbloquear(String(ip || ''));
    if (ok) guarda.registrar('ip-desbloqueado', { por: s.nome, ip });
    enviar(res, ok ? 200 : 404, { ok });
  });
  rota('POST', '/api/central/seguranca/senha', async (req, res) => {
    const s = central(req);
    const d = await lerCorpo(req);
    const conta = exigirConfirmacao(req, s, d.codigo);
    if (!seg.conferirSenha(String(d.atual || ''), conta.senhaHash)) { guarda.falhaIp(ipDe(req), 'senha atual errada'); throw new Erro400('Senha atual errada.', 'atual'); }
    const p = seg.problemaSenha(d.nova, conta.usuario, 10);
    if (p) throw new Erro400(p, 'nova');
    if (d.nova !== d.confirmar) throw new Erro400('A confirmação não bate com a senha nova.', 'confirmar');
    contas.alterarAdmin(conta.usuario, (a) => { a.senhaHash = seg.hashSenha(d.nova); });
    sessoes.encerrarOnde((x) => x.admin === conta.usuario);   // derruba todas as sessões (inclusive esta)
    guarda.registrar('senha-alterada', { usuario: conta.usuario, ip: ipDe(req) });
    enviar(res, 200, { ok: true });
  });
  rota('POST', '/api/central/seguranca/recuperacao', async (req, res) => {
    const s = central(req);
    const d = await lerCorpo(req);
    const conta = exigirConfirmacao(req, s, d.codigo);
    const { codigos, hashes } = seg.novosCodigosRecuperacao();
    contas.alterarAdmin(conta.usuario, (a) => { a.recuperacao = hashes; });
    guarda.registrar('recuperacao-renovada', { usuario: conta.usuario, ip: ipDe(req) });
    enviar(res, 200, { codigos });
  });

  // ---------------------------------------------------------------- conexão com o DMK Prisma
  rota('GET', '/api/central/integracao', async (req, res) => {
    central(req);
    const segredo = lerSegredo();
    enviar(res, 200, { segredoFinal: segredo.slice(-6), arquivo: path.join(CFG.dados, 'segredo-integracao.txt'), endereco: `http://127.0.0.1:${CFG.porta}` });
  });
  rota('POST', '/api/central/integracao/revelar', async (req, res) => {
    const s = central(req);
    const d = await lerCorpo(req);
    exigirConfirmacao(req, s, d.codigo);
    guarda.registrar('segredo-revelado', { por: s.nome, ip: ipDe(req) });
    enviar(res, 200, { segredo: lerSegredo() });
  });
  rota('POST', '/api/central/integracao/novo', async (req, res) => {
    const s = central(req);
    const d = await lerCorpo(req);
    exigirConfirmacao(req, s, d.codigo);
    const novo = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(CFG.dados, 'segredo-integracao.txt'), novo, { mode: 0o600 });
    sessoes.trocarSegredo(novo);
    guarda.registrar('segredo-trocado', { por: s.nome, ip: ipDe(req) });
    enviar(res, 200, { segredo: novo });
  });
};
