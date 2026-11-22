'use strict';
/**
 * Integração com o DMK Prisma (servidor-a-servidor, "Authorization: Bearer <segredo>") e a
 * entrada por ticket (/entrar) que o Prisma usa para abrir a Central e o módulo do provedor.
 * Em modo simulação, /simulacao/* faz o papel do Prisma gerando os tickets.
 */
module.exports = function rotasIntegracao(ctx) {
  const { rota, enviar, lerCorpo, banco, sessoes, CFG, VERSAO, Erro400, definirCookie, chaveProvedor, nbi, validarWifi, trocarWifi, reiniciar, guarda, log,
    contas, estadoAcs, PROJECAO, paraTela, lerClientes, gravarClientes, validarCanal, trocarCanal, lerAparelhos } = ctx;

  rota('GET', '/entrar', async (req, res, m, url) => {
    const d = sessoes.lerTicket(url.searchParams.get('ticket'));
    if (!d) return enviar(res, 401, 'Link de acesso inválido ou vencido. Abra o módulo de novo pelo DMK Prisma.');
    const token = sessoes.criar(d);
    res.writeHead(303, {
      Location: d.papel === 'central' ? 'central/' : 'provedor/',
      // Lax: a entrada vem de um redirecionamento do DMK Prisma
      'Set-Cookie': definirCookie(req, 'dmkacs', token, { sameSite: 'Lax' }),
      'Cache-Control': 'no-store',
    });
    res.end();
  });

  rota('POST', '/api/sair', async (req, res) => {   // mantido para o módulo aberto pelo Prisma
    enviar(res, 200, { ok: true }, { 'Set-Cookie': definirCookie(req, 'dmkacs', '', { maxAge: 0 }) });
  });

  function exigirIntegracao(req) {
    // A API de integração é só servidor-a-servidor: o Prisma chama 127.0.0.1 direto. Pedido que passou
    // pelo nginx do painel público (traz X-Real-IP / X-Forwarded-For) é recusado como se não existisse:
    // mesmo quem tiver a chave não usa a API pela internet.
    if (req.headers['x-real-ip'] || req.headers['x-forwarded-for']) throw Object.assign(new Error('Não encontrado.'), { status: 404 });
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m || !sessoes.segredoConfere(m[1])) throw Object.assign(new Error('Integração não autorizada.'), { status: 401 });
  }

  // Endereço base do CWMP (o mesmo dos clientes avulsos, ex.: http://acs.danilodss.com.br:7547).
  // Provedor criado pela integração sem endereço próprio recebe <base>/<id>.
  const enderecoBase = () => (contas.config().enderecoAvulsos || CFG.enderecoAvulsos || '').replace(/\/+$/, '');
  const ID_PROVEDOR = '([a-z0-9][a-z0-9-]{1,39})';

  /** Contagem de roteadores (total/online) por provedor, numa consulta só ao ACS. */
  async function contagens() {
    const docs = await nbi.dispositivos({}, ['_id', '_lastInform', '_tags']);
    const porChave = new Map();
    for (const d of docs) {
      const r = paraTela(d);
      for (const t of d._tags || []) { const c = porChave.get(t) || { roteadores: 0, online: 0 }; c.roteadores++; if (r.online) c.online++; porChave.set(t, c); }
    }
    return porChave;
  }
  const provedorPublico = (p, porChave) => ({
    id: p.id, nome: p.nome, ativo: p.ativo, enderecoAcs: p.enderecoAcs,
    ...(porChave ? porChave.get(chaveProvedor(p)) || { roteadores: 0, online: 0 } : {}),
    criadoEm: p.criadoEm, atualizadoEm: p.atualizadoEm,
  });
  function provedorAtivoDe(d) {
    const p = banco.obter(String(d.provedor || ''));
    if (!p) throw Object.assign(new Error('Provedor não cadastrado no ACS.'), { status: 404 });
    if (!p.ativo) throw Object.assign(new Error('Módulo ACS desativado para este provedor.'), { status: 403 });
    return p;
  }
  /** Roteador do provedor pelo login PPPoE (lido do roteador pelo parâmetro virtual dmk_pppoe). */
  async function roteadorPorPppoe(p, pppoe) {
    pppoe = String(pppoe || '').trim();
    if (!pppoe) throw new Erro400('Informe o login PPPoE do cliente.', 'pppoe');
    const [doc] = await nbi.dispositivos({ _tags: chaveProvedor(p), 'VirtualParameters.dmk_pppoe': pppoe }, PROJECAO);
    if (!doc) throw Object.assign(new Error('Nenhum roteador deste provedor com esse login PPPoE.'), { status: 404 });
    return doc;
  }

  // Situação do ACS e endereço base para montar os endereços dos provedores
  rota('GET', '/api/integracao/info', async (req, res) => {
    exigirIntegracao(req);
    enviar(res, 200, { versao: VERSAO, acs: estadoAcs, enderecoBase: enderecoBase(), onlineMin: CFG.onlineMin });
  });

  rota('GET', '/api/integracao/provedores', async (req, res) => {
    exigirIntegracao(req);
    const porChave = await contagens().catch(() => null);
    enviar(res, 200, banco.listar().map((p) => provedorPublico(p, porChave)));
  });
  rota('GET', `/api/integracao/provedores/${ID_PROVEDOR}`, async (req, res, m) => {
    exigirIntegracao(req);
    const p = banco.obter(m[1]);
    if (!p) return enviar(res, 404, { erro: 'Provedor não cadastrado no ACS.' });
    enviar(res, 200, provedorPublico(p, await contagens().catch(() => null)));
  });

  // Cria ou altera (mesmo pedido, pode repetir): { nome, ativo, enderecoAcs? }
  rota('PUT', `/api/integracao/provedores/${ID_PROVEDOR}`, async (req, res, m) => {
    exigirIntegracao(req);
    const d = await lerCorpo(req);
    const existente = banco.obter(m[1]);
    let p;
    if (existente) {
      p = banco.alterar(m[1], { nome: d.nome, enderecoAcs: d.enderecoAcs || undefined, ativo: typeof d.ativo === 'boolean' ? d.ativo : undefined });
    } else {
      const base = enderecoBase();
      if (!d.enderecoAcs && !base) throw new Erro400('O ACS ainda não tem endereço base (painel > Conexão). Informe enderecoAcs.', 'enderecoAcs');
      p = banco.criar({ id: m[1], nome: d.nome, enderecoAcs: d.enderecoAcs || `${base}/${m[1]}`, ativo: d.ativo !== false });
    }
    guarda.registrar(existente ? 'provedor-alterado' : 'provedor-criado', { por: 'DMK Prisma', provedor: p.id, ativo: p.ativo });
    log(`DMK Prisma: provedor ${p.id} ${existente ? 'alterado' : 'criado'} (${p.ativo ? 'ativo' : 'desativado'}, ${p.enderecoAcs})`);
    enviar(res, existente ? 200 : 201, provedorPublico(p, null));
  });
  // Empresa excluída no Prisma: tira o provedor do ACS (os roteadores continuam no ACS, sem dono)
  rota('DELETE', `/api/integracao/provedores/${ID_PROVEDOR}`, async (req, res, m) => {
    exigirIntegracao(req);
    const ok = banco.remover(m[1]);
    if (ok) { gravarClientes(m[1], null); guarda.registrar('provedor-excluido', { por: 'DMK Prisma', provedor: m[1] }); }
    enviar(res, ok ? 200 : 404, ok ? { ok } : { erro: 'Provedor não cadastrado no ACS.' });
  });
  // Nomes dos clientes na lista do provedor: { clientes: { "login.pppoe": "NOME", ... } } (substitui a lista)
  rota('PUT', `/api/integracao/provedores/${ID_PROVEDOR}/clientes`, async (req, res, m) => {
    exigirIntegracao(req);
    if (!banco.obter(m[1])) return enviar(res, 404, { erro: 'Provedor não cadastrado no ACS.' });
    const d = await lerCorpo(req, 5 * 1024 * 1024);
    if (!d.clientes || typeof d.clientes !== 'object' || Array.isArray(d.clientes)) throw new Erro400('Envie clientes como { "login.pppoe": "NOME" }.', 'clientes');
    const mapa = {};
    for (const [login, nome] of Object.entries(d.clientes)) {
      const l = String(login).trim().slice(0, 128), n = String(nome ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
      if (l && n) mapa[l] = n;
    }
    gravarClientes(m[1], mapa);
    enviar(res, 200, { ok: true, clientes: Object.keys(mapa).length });
  });

  // Roteador do assinante (central do assinante / robô): ?provedor=starnet&pppoe=joao.silva
  rota('GET', '/api/integracao/roteador', async (req, res, m, url) => {
    exigirIntegracao(req);
    const p = provedorAtivoDe({ provedor: url.searchParams.get('provedor') });
    const doc = await roteadorPorPppoe(p, url.searchParams.get('pppoe'));
    enviar(res, 200, paraTela(doc, lerClientes(p.id)));
  });
  // Canal do Wi-Fi: { provedor, pppoe, faixa: "24" | "5", canal: "auto" | número }
  rota('POST', '/api/integracao/canal', async (req, res) => {
    exigirIntegracao(req);
    const d = await lerCorpo(req);
    const p = provedorAtivoDe(d);
    const doc = await roteadorPorPppoe(p, d.pppoe);
    const atual = paraTela(doc)[String(d.faixa) === '5' ? 'canal5' : 'canal24'];
    const canal = validarCanal(d.faixa, d.canal, atual);
    guarda.registrar('integracao-canal', { provedor: p.id, roteador: doc._id, faixa: String(d.faixa), canal });
    enviar(res, 200, { situacao: await trocarCanal(doc._id, String(d.faixa), canal) });
  });
  // Aparelhos conectados (lê do roteador na hora): ?provedor=starnet&pppoe=joao.silva
  rota('GET', '/api/integracao/aparelhos', async (req, res, m, url) => {
    exigirIntegracao(req);
    const p = provedorAtivoDe({ provedor: url.searchParams.get('provedor') });
    const doc = await roteadorPorPppoe(p, url.searchParams.get('pppoe'));
    enviar(res, 200, await lerAparelhos(doc._id));
  });
  rota('POST', '/api/integracao/reiniciar', async (req, res) => {
    exigirIntegracao(req);
    const d = await lerCorpo(req);
    const p = provedorAtivoDe(d);
    const doc = await roteadorPorPppoe(p, d.pppoe);
    guarda.registrar('integracao-reiniciar', { provedor: p.id, roteador: doc._id });
    enviar(res, 200, { situacao: await reiniciar(doc._id) });
  });
  rota('POST', '/api/integracao/ticket', async (req, res) => {
    exigirIntegracao(req);
    const d = await lerCorpo(req);
    if (d.papel !== 'central' && d.papel !== 'provedor') throw new Erro400('papel deve ser central ou provedor.');
    if (d.papel === 'provedor' && !banco.obter(d.provedor)?.ativo) return enviar(res, 403, { erro: 'Módulo ACS desativado para este provedor.' });
    enviar(res, 200, { caminho: 'entrar?ticket=' + encodeURIComponent(sessoes.gerarTicket({ papel: d.papel, provedor: d.provedor, nome: d.nome })) });
  });
  // Central do assinante / robô de atendimento: troca o Wi-Fi do cliente do provedor pelo login PPPoE.
  // { provedor, pppoe, ssid, senha? }  (senha vazia: troca só o nome)
  rota('POST', '/api/integracao/wifi', async (req, res) => {
    exigirIntegracao(req);
    const d = await lerCorpo(req);
    const p = provedorAtivoDe(d);
    const doc = await roteadorPorPppoe(p, d.pppoe);
    const wifi = validarWifi(d.ssid, d.senha);
    guarda.registrar('integracao-wifi', { provedor: p.id, roteador: doc._id });
    enviar(res, 200, { situacao: await trocarWifi(doc._id, wifi) });
  });

  if (CFG.simulacao) {
    rota('POST', '/simulacao/entrar', async (req, res) => {
      const d = await lerCorpo(req);
      const papel = d.papel === 'provedor' ? 'provedor' : 'central';
      const ticket = sessoes.gerarTicket({ papel, provedor: papel === 'provedor' ? String(d.provedor || '') : undefined, nome: papel === 'central' ? 'DMK Prisma (simulação)' : 'Operador (simulação)' });
      enviar(res, 200, { caminho: 'entrar?ticket=' + encodeURIComponent(ticket) });
    });
    rota('GET', '/simulacao/provedores', async (req, res) => enviar(res, 200, banco.listar().map((p) => ({ id: p.id, nome: p.nome, ativo: p.ativo }))));
  }
};
