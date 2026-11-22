'use strict';
/**
 * Módulo do provedor (/provedor/), aberto pelo DMK Prisma com ticket.
 * O provedor só vê e só comanda roteadores com a marca do endereço DELE; com o módulo
 * desativado pela Central, tudo é recusado na hora.
 */
module.exports = function rotasProvedor(ctx) {
  const { rota, enviar, lerCorpo, exigirSessao, banco, guarda, log, CFG, VERSAO, roteadoresDaChave, roteadorDaChave, validarWifi, trocarWifi, reiniciar, lerAgora, chaveProvedor, lerClientes, validarCanal, trocarCanal, lerAparelhos, canalAtual } = ctx;

  function provedorAtivo(req) {
    const s = exigirSessao(req, 'provedor');
    const p = banco.obter(s.provedor);
    if (!p) throw Object.assign(new Error('Provedor não cadastrado no DMK ACS.'), { status: 403, desativado: true });
    if (!p.ativo) throw Object.assign(new Error('O módulo ACS está desativado para este provedor. Fale com a DMK.'), { status: 403, desativado: true });
    return { s, p };
  }

  rota('GET', '/api/provedor/info', async (req, res) => {
    const { s, p } = provedorAtivo(req);
    enviar(res, 200, {
      id: p.id, nome: p.nome, usuario: s.nome, versao: VERSAO, onlineMin: CFG.onlineMin,
      enderecoAcs: p.enderecoAcs,
      mikrotik: `/tr069-client set enabled=yes acs-url=${p.enderecoAcs} periodic-inform-enabled=yes periodic-inform-interval=5m`,
    });
  });
  rota('GET', '/api/provedor/roteadores', async (req, res) => {
    const { p } = provedorAtivo(req);
    enviar(res, 200, await roteadoresDaChave(chaveProvedor(p), lerClientes(p.id)));
  });
  rota('POST', '/api/provedor/roteadores/([^/]+)/wifi', async (req, res, m) => {
    const { s, p } = provedorAtivo(req);
    const id = await roteadorDaChave(chaveProvedor(p), decodeURIComponent(m[1]));
    const corpo = await lerCorpo(req);
    const dados = validarWifi(corpo.ssid, corpo.senha);
    log(`Provedor ${p.id} (${s.nome}): Wi-Fi do roteador ${id} -> "${dados.ssid}"${dados.senha ? ' + senha nova' : ''}`);
    guarda.registrar('wifi-alterado', { por: s.nome, provedor: p.id, roteador: id });
    enviar(res, 200, { situacao: await trocarWifi(id, dados) });
  });
  rota('POST', '/api/provedor/roteadores/([^/]+)/reiniciar', async (req, res, m) => {
    const { s, p } = provedorAtivo(req);
    const id = await roteadorDaChave(chaveProvedor(p), decodeURIComponent(m[1]));
    guarda.registrar('roteador-reiniciado', { por: s.nome, provedor: p.id, roteador: id });
    enviar(res, 200, { situacao: await reiniciar(id) });
  });
  // Canal do Wi-Fi: { faixa: "24" | "5", canal: "auto" | número }
  rota('POST', '/api/provedor/roteadores/([^/]+)/canal', async (req, res, m) => {
    const { s, p } = provedorAtivo(req);
    const id = await roteadorDaChave(chaveProvedor(p), decodeURIComponent(m[1]));
    const d = await lerCorpo(req);
    const canal = validarCanal(d.faixa, d.canal, await canalAtual(id, String(d.faixa)));
    log(`Provedor ${p.id} (${s.nome}): canal ${d.faixa === '5' ? '5' : '2,4'} GHz do roteador ${id} -> ${canal}`);
    guarda.registrar('canal-alterado', { por: s.nome, provedor: p.id, roteador: id, faixa: String(d.faixa), canal });
    enviar(res, 200, { situacao: await trocarCanal(id, String(d.faixa), canal) });
  });
  rota('POST', '/api/provedor/roteadores/([^/]+)/aparelhos', async (req, res, m) => {
    const { p } = provedorAtivo(req);
    const id = await roteadorDaChave(chaveProvedor(p), decodeURIComponent(m[1]));
    enviar(res, 200, await lerAparelhos(id));
  });
  rota('POST', '/api/provedor/roteadores/([^/]+)/atualizar', async (req, res, m) => {
    const { p } = provedorAtivo(req);
    const id = await roteadorDaChave(chaveProvedor(p), decodeURIComponent(m[1]));
    enviar(res, 200, await lerAgora(id, p.id));
  });
};
