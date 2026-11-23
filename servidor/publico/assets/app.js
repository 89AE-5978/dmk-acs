/* DMK Wi-Fi - app do cliente avulso: entra com usuário e senha, troca nome/senha do Wi-Fi e reinicia. */
'use strict';
(() => {
  const { $, esc, el, ic, Tema, avisar, api, haQuanto, abrirJanela, confirmar, campo, erroNoCampo, botaoCarregando, vazioHtml } = window.DMK;
  DMK.iconesDaPagina();
  Tema.iniciar($('[data-tema]'));
  const conteudo = $('[data-conteudo]');
  const menu = $('[data-menu]');
  menu.innerHTML = ic('menu');
  let eu = null;

  // Instalável: registra o service worker (abre mesmo com internet ruim)
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  function senhaComOlho(opcoes) {
    const r = campo({ tipo: 'password', ...opcoes });
    const inp = r.querySelector('input');
    const olho = el(`<button type="button" class="btn ico" title="Mostrar senha" tabindex="-1">${ic('olho')}</button>`);
    const linha = el('<div class="com-botao"></div>');
    inp.replaceWith(linha); linha.append(inp, olho);
    olho.addEventListener('click', () => { inp.type = inp.type === 'password' ? 'text' : 'password'; });
    return r;
  }

  DMK.definirTratarErro((e) => tratarErro(e));
  function tratarErro(e, form) {
    if (e.status === 401) return telaEntrar();
    if (e.desativado) { conteudo.innerHTML = vazioHtml('Acesso desativado', e.message, 'bloqueio'); menu.classList.add('oculto'); return; }
    if (!(form && e.campo && erroNoCampo(form, e.campo, e.message))) avisar('Não deu certo', e.message, 'erro');
  }

  // ---------------------------------------------------------------- entrar
  function telaEntrar() {
    menu.classList.add('oculto');
    $('[data-sub]').textContent = 'Seu Wi-Fi na palma da mão';
    conteudo.innerHTML = '';
    const caixa = el(`<div class="cartao-entrada cartao-app"><div class="entrada-marca"><span class="chip-icone grande">${ic('wifi')}</span><div><h1>Entrar</h1><p>Use o usuário e a senha que a DMK enviou.</p></div></div></div>`);
    const f = el('<form class="form-entrada" autocomplete="on" novalidate></form>');
    f.append(campo({ rotulo: 'Usuário', nome: 'usuario', max: 32 }), senhaComOlho({ rotulo: 'Senha', nome: 'senha', max: 128 }));
    f.querySelector('[name="usuario"]').autocomplete = 'username';
    f.querySelector('[name="usuario"]').autocapitalize = 'none';
    f.querySelector('[name="senha"]').autocomplete = 'current-password';
    const b = el(`<button type="submit" class="btn primario largo">${ic('cadeado')}<span>Entrar</span></button>`);
    f.append(b, el('<p class="fraco pequeno">Esqueceu a senha? Fale com a DMK: ela gera uma senha provisória nova.</p>'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (b.disabled) return;   // já enviando: ignora o 2º envio
      botaoCarregando(b, true);
      try {
        const d = Object.fromEntries(new FormData(f));
        await api('POST', '../api/app/entrar', { usuario: d.usuario, senha: d.senha });
        carregar();
      } catch (err) { botaoCarregando(b, false); avisar('Não deu certo', err.message, 'erro'); }
    });
    caixa.append(f);
    conteudo.append(caixa);
    f.querySelector('input').focus();
  }

  // ---------------------------------------------------------------- trocar a própria senha
  function trocarSenha(obrigatoria = false) {
    const j = abrirJanela({ icone: 'cadeado', titulo: obrigatoria ? 'Crie a sua senha' : 'Trocar minha senha', tamanho: 'pequeno', corpo: '<div></div>', rodape: ' ', fixa: obrigatoria });
    if (obrigatoria) j.corpo.firstChild.append(el(`<div class="aviso-caixa">${ic('cadeado')}<span>A senha que você recebeu é provisória. Crie uma só sua para continuar.</span></div>`));
    const f = el('<form class="form" autocomplete="off"></form>');
    f.append(
      senhaComOlho({ rotulo: obrigatoria ? 'Senha provisória' : 'Senha atual', nome: 'atual', max: 128, inteiro: true }),
      senhaComOlho({ rotulo: 'Senha nova', nome: 'nova', max: 128, inteiro: true, ajuda: 'Mínimo 8, misturando letras maiúsculas, minúsculas, números ou símbolos.' }),
      senhaComOlho({ rotulo: 'Confirmar senha nova', nome: 'confirmar', max: 128, inteiro: true }),
    );
    f.addEventListener('submit', (e) => e.preventDefault());
    j.corpo.firstChild.append(f);
    j.rodape.innerHTML = '';
    const ok = el(`<button type="button" class="btn primario">${ic('salvar')}<span>Salvar senha</span></button>`);
    ok.addEventListener('click', async () => {
      botaoCarregando(ok, true);
      try { await api('POST', '../api/app/senha', Object.fromEntries(new FormData(f))); avisar('Senha salva', 'Use a senha nova nas próximas entradas.'); j.fechar(); carregar(); } catch (e) { botaoCarregando(ok, false); tratarErro(e, f); }
    });
    j.rodape.append(ok);
    f.querySelector('input').focus();
  }

  // ---------------------------------------------------------------- início: o roteador
  async function carregar() {
    try { eu = await api('GET', '../api/app/eu'); } catch (e) { return tratarErro(e); }
    menu.classList.remove('oculto');
    $('[data-sub]').textContent = eu.nome;
    desenhar();
    if (eu.trocarSenha) trocarSenha(true);
  }

  function desenhar() {
    conteudo.innerHTML = '';
    if (!eu.roteadores.length) {
      conteudo.innerHTML = vazioHtml('Seu roteador ainda não apareceu', 'A DMK está configurando o seu roteador. Assim que ele se conectar, ele aparece aqui (em até 5 minutos).');
      return;
    }
    for (const r of eu.roteadores) {
      const c = el(`<section class="cartao-roteador ${r.online ? 'on' : 'off'}">
        <div class="wifi-grande">${ic('wifi')}</div>
        <small class="fraco">Nome do seu Wi-Fi</small>
        <h2 class="reticencias"></h2>
        <span class="selo ${r.online ? 'ok' : 'desl'}">${r.online ? 'Conectado' : 'Sem contato'} · ${esc(haQuanto(r.ultimoContato))}</span>
        <p class="fraco reticencias">${esc(r.fabricante)} ${esc(r.modelo)}</p>
        <div class="acoes-roteador">
          <button type="button" class="btn primario" data-wifi>${ic('wifi')}<span>Wi-Fi</span></button>
          <button type="button" class="btn" data-aparelhos>${ic('aparelho')}<span>Aparelhos</span></button>
          <button type="button" class="btn" data-canal>${ic('canal')}<span>Canal</span></button>
          <button type="button" class="btn" data-reiniciar>${ic('reiniciar')}<span>Reiniciar</span></button>
        </div></section>`);
      c.querySelector('h2').textContent = r.ssid || '—';
      c.querySelector('[data-wifi]').addEventListener('click', () => trocarWifi(r));
      c.querySelector('[data-reiniciar]').addEventListener('click', () => reiniciar(r));
      c.querySelector('[data-aparelhos]').addEventListener('click', () => {
        const j = abrirJanela({ icone: 'aparelho', titulo: 'Aparelhos conectados', sub: 'Quem está usando a sua internet agora', tamanho: 'medio', rodape: ' ' });
        DMK.desenharAparelhos(j.corpo, j.rodape, `../api/app/roteadores/${encodeURIComponent(r.id)}/aparelhos`);
      });
      c.querySelector('[data-canal]').addEventListener('click', () => {
        const j = abrirJanela({ icone: 'canal', titulo: 'Canal do Wi-Fi', sub: 'Para melhorar o sinal perto de outras redes', tamanho: 'pequeno', rodape: ' ' });
        DMK.desenharCanal(j.corpo, j.rodape, r, `../api/app/roteadores/${encodeURIComponent(r.id)}/canal`, () => { j.fechar(); carregar(); });
      });
      conteudo.append(c);
    }
    if (eu.roteadores.some((r) => !r.online)) conteudo.append(el(`<p class="fraco pequeno centro">Sem contato agora? O roteador pode estar desligado. O que você mudar é aplicado assim que ele voltar.</p>`));
  }

  const RESULTADO = {
    aplicado: ['Pronto!', 'O roteador já recebeu. Conecte seus aparelhos de novo com o nome e a senha novos.'],
    'na-fila': ['Vai chegar em instantes', 'O roteador recebe no próximo contato (até 5 minutos).'],
  };

  function trocarWifi(r) {
    const j = abrirJanela({ icone: 'wifi', titulo: 'Trocar Wi-Fi', sub: 'Nome e senha da sua rede', tamanho: 'pequeno', corpo: '<div></div>', rodape: ' ' });
    const f = el('<form class="form" autocomplete="off"></form>');
    f.append(
      campo({ rotulo: 'Nome do Wi-Fi', nome: 'ssid', valor: r.ssid, max: 32, inteiro: true }),
      senhaComOlho({ rotulo: 'Senha nova do Wi-Fi', nome: 'senha', max: 63, inteiro: true, placeholder: 'mínimo 8 caracteres', ajuda: 'Deixe em branco para trocar só o nome.' }),
    );
    f.addEventListener('submit', (e) => { e.preventDefault(); ok.click(); });
    j.corpo.firstChild.append(f);
    j.rodape.innerHTML = '';
    const ok = el(`<button type="button" class="btn primario">${ic('enviar')}<span>Salvar no roteador</span></button>`);
    ok.addEventListener('click', async () => {
      const d = Object.fromEntries(new FormData(f));
      if (!d.ssid.trim()) return erroNoCampo(f, 'ssid', 'Digite o nome do Wi-Fi.');
      if (d.senha && d.senha.length < 8) return erroNoCampo(f, 'senha', 'A senha precisa ter pelo menos 8 caracteres.');
      botaoCarregando(ok, true);
      try { const x = await api('POST', `../api/app/roteadores/${encodeURIComponent(r.id)}/wifi`, { ssid: d.ssid.trim(), senha: d.senha }); avisar(...RESULTADO[x.situacao]); j.fechar(); carregar(); } catch (e) { botaoCarregando(ok, false); tratarErro(e, f); }
    });
    j.rodape.append(ok);
  }

  async function reiniciar(r) {
    if (!(await confirmar({ titulo: 'Reiniciar o roteador?', texto: 'Sua internet cai por 1 a 2 minutos e volta sozinha.', botao: 'Reiniciar', icone: 'reiniciar' }))) return;
    try { const x = await api('POST', `../api/app/roteadores/${encodeURIComponent(r.id)}/reiniciar`); avisar(x.situacao === 'aplicado' ? 'Reiniciando…' : RESULTADO['na-fila'][0], x.situacao === 'aplicado' ? 'Em 1 a 2 minutos a internet volta.' : RESULTADO['na-fila'][1]); } catch (e) { tratarErro(e); }
  }

  // Menu do topo (seletor padrão do sistema, sem menu nativo)
  menu.addEventListener('click', () => DMK.abrirMenu(menu, [{ valor: 'senha', rotulo: 'Trocar minha senha' }, { valor: 'sair', rotulo: 'Sair' }], null, async (v) => {
    if (v === 'senha') return trocarSenha();
    try { await api('POST', '../api/app/sair'); } catch { /* sai mesmo assim */ }
    telaEntrar();
  }));

  Promise.resolve(carregar()).finally(() => DMK.pronto());
  setInterval(() => { if (!document.hidden && eu && !document.querySelector('.fundo-modal')) carregar(); }, 30000);
})();
