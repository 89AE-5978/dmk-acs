/* DMK ACS - página da simulação: gera o ticket de entrada como o DMK Prisma fará em produção. */
'use strict';
(() => {
  const { $, esc, el, ic, Tema, avisar, api } = window.DMK;
  DMK.iconesDaPagina();
  Tema.iniciar($('[data-tema]'));

  async function entrar(papel, provedor) {
    try {
      const { caminho } = await api('POST', 'simulacao/entrar', { papel, provedor });
      location.href = caminho;
    } catch (e) { avisar('Não deu certo', e.message, 'erro'); }
  }

  const central = $('[data-central]');
  central.innerHTML = `${ic('provedor')}<span>Entrar como Central DMK</span>`;
  central.addEventListener('click', () => entrar('central'));

  api('GET', 'simulacao/provedores').then((ps) => {
    const alvo = $('[data-provedores]');
    if (!ps.length) { alvo.innerHTML = '<p class="fraco">Nenhum provedor cadastrado. Entre como Central e cadastre.</p>'; return; }
    for (const p of ps) {
      const b = el(`<button type="button" class="btn">${ic('wifi')}<span class="reticencias">${esc(p.nome)}${p.ativo ? '' : ' (desativado)'}</span></button>`);
      b.addEventListener('click', () => entrar('provedor', p.id));
      alvo.append(b);
    }
  }).catch((e) => avisar('Não deu certo', e.message, 'erro'));
})();
