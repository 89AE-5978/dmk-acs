'use strict';
/**
 * Integração com o DMK Prisma (servidor-a-servidor, "Authorization: Bearer <segredo>") e a
 * entrada por ticket (/entrar) que o Prisma usa para abrir a Central e o módulo do provedor.
 * Em modo simulação, /simulacao/* faz o papel do Prisma gerando os tickets.
 */
module.exports = function rotasIntegracao(ctx) {
  const { rota, enviar, lerCorpo, banco, sessoes, CFG, Erro400, definirCookie, chaveProvedor, nbi, validarWifi, trocarWifi, guarda } = ctx;

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

  rota('GET', '/api/integracao/provedores', async (req, res) => {
    exigirIntegracao(req);
    enviar(res, 200, banco.listar().map((p) => ({ id: p.id, nome: p.nome, ativo: p.ativo })));
  });
  rota('POST', '/api/integracao/ticket', async (req, res) => {
    exigirIntegracao(req);
    const d = await lerCorpo(req);
    if (d.papel !== 'central' && d.papel !== 'provedor') throw new Erro400('papel deve ser central ou provedor.');
    if (d.papel === 'provedor' && !banco.obter(d.provedor)?.ativo) return enviar(res, 403, { erro: 'Módulo ACS desativado para este provedor.' });
    enviar(res, 200, { caminho: 'entrar?ticket=' + encodeURIComponent(sessoes.gerarTicket({ papel: d.papel, provedor: d.provedor, nome: d.nome })) });
  });
  // Central do assinante / robô de atendimento: troca o Wi-Fi do cliente do provedor pelo login PPPoE.
  rota('POST', '/api/integracao/wifi', async (req, res) => {
    exigirIntegracao(req);
    const d = await lerCorpo(req);
    const p = banco.obter(String(d.provedor || ''));
    if (!p || !p.ativo) return enviar(res, 403, { erro: 'Módulo ACS desativado para este provedor.' });
    const pppoe = String(d.pppoe || '').trim();
    if (!pppoe) throw new Erro400('Informe o login PPPoE do cliente.', 'pppoe');
    const [doc] = await nbi.dispositivos({ _tags: chaveProvedor(p), 'VirtualParameters.dmk_pppoe': pppoe }, ['_id']);
    if (!doc) return enviar(res, 404, { erro: 'Nenhum roteador deste provedor com esse login PPPoE.' });
    guarda.registrar('integracao-wifi', { provedor: p.id, roteador: doc._id });
    enviar(res, 200, { situacao: await trocarWifi(doc._id, validarWifi(d.ssid, d.senha)) });
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
