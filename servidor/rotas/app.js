'use strict';
/**
 * App do cliente avulso (/app/), instalável no celular.
 * Entrada com usuário e senha (mesmos bloqueios de conta e de IP do admin). No primeiro acesso o
 * cliente troca a senha provisória que recebeu. Ele vê só o(s) roteador(es) do endereço dele
 * (<base>/c/<CÓDIGO>), troca nome/senha do Wi-Fi e reinicia.
 * Sessão de 30 dias no aparelho (cookie "dmkapp", separado do painel); conta desativada cai na hora.
 */
module.exports = function rotasApp(ctx) {
  const { rota, enviar, lerCorpo, contas, seg, guarda, sessoes, ipDe, cookie, definirCookie, Erro400, roteadoresDaChave, roteadorDaChave, validarWifi, trocarWifi, reiniciar, chaveAvulso, validarCanal, trocarCanal, lerAparelhos, canalAtual } = ctx;

  function cliente(req) {
    const s = sessoes.obter(cookie(req, 'dmkapp'));
    if (!s || s.papel !== 'cliente') throw Object.assign(new Error('Entre de novo no aplicativo.'), { status: 401 });
    const c = contas.avulso(s.codigo);
    if (!c || !c.ativo) { sessoes.encerrar(cookie(req, 'dmkapp')); throw Object.assign(new Error('Seu acesso está desativado. Fale com a DMK.'), { status: 403, desativado: true }); }
    return { s, c };
  }

  rota('POST', '/api/app/entrar', async (req, res) => {
    const ip = ipDe(req);
    guarda.conferirIp(ip);
    const d = await lerCorpo(req);
    const usuario = String(d.usuario || '').trim().toLowerCase();
    const c = contas.avulsoPorUsuario(usuario);
    const ate = seg.contaBloqueada(c);
    if (ate) { guarda.falhaIp(ip, 'app: conta bloqueada'); throw Object.assign(new Error(`Muitas tentativas erradas. Tente de novo em ${Math.ceil((ate - Date.now()) / 60e3)} min.`), { status: 429 }); }
    const certa = seg.conferirSenha(String(d.senha || ''), c && c.senhaHash);
    if (!c || !certa) {
      guarda.falhaIp(ip, 'app: senha errada');
      if (c) contas.alterarConta('avulso', c.codigo, (x) => { if (seg.falhaConta(x)) guarda.registrar('app-conta-bloqueada', { codigo: x.codigo, ip }); });
      guarda.registrar('app-entrada-recusada', { usuario: usuario.slice(0, 32), ip });
      throw Object.assign(new Error('Usuário ou senha inválidos.'), { status: 401 });
    }
    if (!c.ativo) throw Object.assign(new Error('Seu acesso está desativado. Fale com a DMK.'), { status: 403 });
    contas.alterarConta('avulso', c.codigo, (x) => seg.sucessoConta(x));
    guarda.sucessoIp(ip);
    guarda.registrar('app-entrada', { codigo: c.codigo, ip });
    const t = sessoes.criar({ papel: 'cliente', codigo: c.codigo, nome: c.nome, duracaoMs: 30 * 86400e3 });
    enviar(res, 200, { ok: true, trocarSenha: !!c.trocarSenha }, { 'Set-Cookie': definirCookie(req, 'dmkapp', t, { maxAge: 30 * 86400 }) });
  });

  rota('POST', '/api/app/sair', async (req, res) => {
    sessoes.encerrar(cookie(req, 'dmkapp'));
    enviar(res, 200, { ok: true }, { 'Set-Cookie': definirCookie(req, 'dmkapp', '', { maxAge: 0 }) });
  });

  rota('GET', '/api/app/eu', async (req, res) => {
    const { c } = cliente(req);
    const roteadores = await roteadoresDaChave(chaveAvulso(c.codigo), {});
    enviar(res, 200, { nome: c.nome, usuario: c.usuario, trocarSenha: !!c.trocarSenha, roteadores });
  });

  rota('POST', '/api/app/senha', async (req, res) => {
    const { c } = cliente(req);
    const ip = ipDe(req);
    guarda.conferirIp(ip);
    const d = await lerCorpo(req);
    if (!seg.conferirSenha(String(d.atual || ''), c.senhaHash)) { guarda.falhaIp(ip, 'app: senha atual errada'); throw new Erro400('Senha atual errada.', 'atual'); }
    const p = seg.problemaSenha(d.nova, c.usuario, 8);
    if (p) throw new Erro400(p, 'nova');
    if (d.nova !== d.confirmar) throw new Erro400('A confirmação não bate com a senha nova.', 'confirmar');
    contas.alterarConta('avulso', c.codigo, (x) => { x.senhaHash = seg.hashSenha(d.nova); x.trocarSenha = false; });
    // Derruba as outras sessões do cliente (outro celular com a senha antiga), mantém esta
    const atual = cookie(req, 'dmkapp');
    const minha = sessoes.obter(atual);
    sessoes.encerrarOnde((x) => x.papel === 'cliente' && x.codigo === c.codigo && x !== minha);
    guarda.registrar('app-senha-alterada', { codigo: c.codigo, ip });
    enviar(res, 200, { ok: true });
  });

  rota('POST', '/api/app/roteadores/([^/]+)/(wifi|reiniciar|canal|aparelhos)', async (req, res, m) => {
    const { c } = cliente(req);
    if (c.trocarSenha) throw Object.assign(new Error('Troque a senha provisória antes de continuar.'), { status: 403 });
    const id = await roteadorDaChave(chaveAvulso(c.codigo), decodeURIComponent(m[1]));
    if (m[2] === 'aparelhos') return enviar(res, 200, await lerAparelhos(id));
    if (m[2] === 'canal') {
      const d = await lerCorpo(req);
      const canal = validarCanal(d.faixa, d.canal, await canalAtual(id, String(d.faixa)));
      guarda.registrar('app-canal', { codigo: c.codigo, roteador: id, faixa: String(d.faixa), canal });
      return enviar(res, 200, { situacao: await trocarCanal(id, String(d.faixa), canal) });
    }
    if (m[2] === 'reiniciar') { guarda.registrar('app-reiniciar', { codigo: c.codigo, roteador: id }); return enviar(res, 200, { situacao: await reiniciar(id) }); }
    const d = await lerCorpo(req);
    const w = validarWifi(d.ssid, d.senha);
    guarda.registrar('app-wifi', { codigo: c.codigo, roteador: id });
    enviar(res, 200, { situacao: await trocarWifi(id, w) });
  });
};
