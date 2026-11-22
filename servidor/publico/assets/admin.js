/* DMK ACS - entrada do administrador: primeiro acesso, senha e app autenticador. */
'use strict';
(() => {
  const { $, esc, el, ic, Tema, avisar, api, campo, erroNoCampo, botaoCarregando, copiar } = window.DMK;
  DMK.iconesDaPagina();
  Tema.iniciar($('[data-tema]'));
  const etapa = $('[data-etapa]');

  /** Monta um formulário da etapa: título, campos e botão principal. */
  function formulario({ titulo, texto, campos, botao, icone = 'ok', extra = null }) {
    etapa.innerHTML = '';
    const f = el('<form class="form-entrada" autocomplete="off" novalidate></form>');
    f.append(el(`<h2>${esc(titulo)}</h2>`));
    if (texto) f.append(el(`<p class="fraco">${esc(texto)}</p>`));
    campos.forEach((c) => f.append(c));
    if (extra) f.append(extra);
    const b = el(`<button type="submit" class="btn primario largo">${ic(icone)}<span>${esc(botao)}</span></button>`);
    f.append(b);
    etapa.append(f);
    f.querySelector('input')?.focus();
    return { f, b };
  }

  function senhaComOlho(opcoes) {
    const r = campo({ tipo: 'password', ...opcoes });
    const inp = r.querySelector('input');
    const olho = el(`<button type="button" class="btn ico" title="Mostrar senha" tabindex="-1">${ic('olho')}</button>`);
    const linha = el('<div class="com-botao"></div>');
    inp.replaceWith(linha); linha.append(inp, olho);
    olho.addEventListener('click', () => { inp.type = inp.type === 'password' ? 'text' : 'password'; inp.focus(); });
    return r;
  }

  const enviarCom = (b, f, fn) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (b.disabled) return;   // já enviando: ignora o 2º envio (ex.: envio automático no 6º dígito + Enter)
    botaoCarregando(b, true);
    try { await fn(Object.fromEntries(new FormData(f))); } catch (err) {
      botaoCarregando(b, false);
      if (err.reiniciar) { avisar('Entre de novo', err.message, 'erro'); return entrar(); }
      if (!(err.campo && erroNoCampo(f, err.campo, err.message))) avisar('Não deu certo', err.message, 'erro');
      else (window.DMK.Som.erro)();
    }
  });

  // ---------------------------------------------------------------- entrada
  function entrar() {
    const { f, b } = formulario({
      titulo: 'Entrar', icone: 'cadeado', botao: 'Continuar',
      campos: [
        campo({ rotulo: 'Usuário', nome: 'usuario', max: 32 }),
        senhaComOlho({ rotulo: 'Senha', nome: 'senha', max: 128 }),
      ],
    });
    f.querySelector('[name="usuario"]').autocomplete = 'username';
    f.querySelector('[name="senha"]').autocomplete = 'current-password';
    enviarCom(b, f, async (d) => {
      const r = await api('POST', '../api/acesso/entrar', { usuario: d.usuario, senha: d.senha });
      autenticador(r.desafio);
    });
  }

  function autenticador(desafio, recuperacao = false) {
    const { f, b } = formulario({
      titulo: recuperacao ? 'Código de recuperação' : 'App autenticador', icone: 'ok', botao: 'Entrar',
      texto: recuperacao ? 'Digite um dos códigos de recuperação que você guardou (cada um vale uma vez).' : 'Abra o Google Authenticator (ou Authy) e digite o código de 6 dígitos do DMK ACS.',
      campos: [campo({ rotulo: recuperacao ? 'Código de recuperação' : 'Código de 6 dígitos', nome: 'codigo', max: recuperacao ? 9 : 6, placeholder: recuperacao ? 'XXXX-XXXX' : '000000' })],
      extra: el(`<button type="button" class="link-acao">${recuperacao ? 'Usar o app autenticador' : 'Perdi o celular: usar código de recuperação'}</button>`),
    });
    const inp = f.querySelector('[name="codigo"]');
    inp.classList.add(recuperacao ? 'codigo-rec' : 'codigo-6');
    if (!recuperacao) { inp.inputMode = 'numeric'; inp.autocomplete = 'one-time-code'; }
    f.querySelector('.link-acao').addEventListener('click', () => autenticador(desafio, !recuperacao));
    if (!recuperacao) inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 6); if (inp.value.length === 6) f.requestSubmit(); });
    enviarCom(b, f, async (d) => {
      const r = await api('POST', '../api/acesso/autenticador', { desafio, codigo: d.codigo });
      if (r.codigosRestantes != null) sessionStorage.setItem('dmkacs-rec', String(r.codigosRestantes));
      location.href = '../central/';
    });
  }

  // ---------------------------------------------------------------- primeiro acesso
  function primeiroAcesso() {
    const { f, b } = formulario({
      titulo: 'Primeiro acesso', icone: 'mais', botao: 'Continuar',
      texto: 'Crie o administrador. O código de primeiro acesso fica só no servidor (arquivo dados/primeiro-acesso.txt e no log ao ligar).',
      campos: [
        campo({ rotulo: 'Código de primeiro acesso', nome: 'codigo', max: 14, placeholder: 'XXXX-XXXX-XXXX' }),
        campo({ rotulo: 'Usuário', nome: 'usuario', max: 32, ajuda: 'Minúsculas, números, ponto ou hífen.' }),
        senhaComOlho({ rotulo: 'Senha', nome: 'senha', max: 128, ajuda: 'Mínimo 10 caracteres, misturando maiúsculas, minúsculas, números e símbolos.' }),
        senhaComOlho({ rotulo: 'Confirmar senha', nome: 'confirmar', max: 128 }),
      ],
    });
    f.querySelector('[name="codigo"]').classList.add('codigo-rec');
    enviarCom(b, f, async (d) => {
      const r = await api('POST', '../api/acesso/primeiro/iniciar', d);
      configurarAutenticador(r);
    });
  }

  function configurarAutenticador({ token, segredo, qr }) {
    const caixaQr = el(`<div class="qr-caixa"><img alt="QR Code do app autenticador"><div><small class="fraco">Ou digite esta chave no app:</small>
      <div class="codigo"><code></code><button type="button" class="fantasma" aria-label="Copiar chave">${ic('copiar')}</button></div></div></div>`);
    caixaQr.querySelector('img').src = qr;
    caixaQr.querySelector('code').textContent = segredo.replace(/(.{4})/g, '$1 ').trim();
    caixaQr.querySelector('button').addEventListener('click', () => copiar(segredo));
    const { f, b } = formulario({
      titulo: 'Configure o app autenticador', icone: 'ok', botao: 'Confirmar',
      texto: 'No Google Authenticator (ou Authy) toque em "+" e escaneie o QR. Depois digite o código de 6 dígitos que aparecer.',
      campos: [caixaQr, campo({ rotulo: 'Código de 6 dígitos', nome: 'codigo', max: 6, placeholder: '000000' })],
    });
    const inp = f.querySelector('[name="codigo"]');
    inp.classList.add('codigo-6'); inp.inputMode = 'numeric';
    inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 6); });
    inp.focus();
    enviarCom(b, f, async (d) => {
      const r = await api('POST', '../api/acesso/primeiro/concluir', { token, codigo: d.codigo });
      mostrarRecuperacao(r.codigosRecuperacao);
    });
  }

  function mostrarRecuperacao(codigos) {
    etapa.innerHTML = '';
    const caixa = el(`<div class="form-entrada"><h2>Guarde os códigos de recuperação</h2>
      <p class="fraco">Se perder o celular do autenticador, cada código abaixo permite entrar UMA vez. Eles não aparecem de novo: copie e guarde em lugar seguro (ex.: o seu cofre de senhas).</p>
      <div class="codigos-rec"></div>
      <div class="linha-botoes"><button type="button" class="btn" data-copiar>${ic('copiar')}<span>Copiar todos</span></button></div>
      <label class="marcar"><input type="checkbox" data-guardei><span>Guardei os códigos em lugar seguro</span></label>
      <button type="button" class="btn primario largo" data-ir disabled>${ic('cadeado')}<span>Ir para a entrada</span></button></div>`);
    caixa.querySelector('.codigos-rec').innerHTML = codigos.map((c) => `<code>${esc(c)}</code>`).join('');
    caixa.querySelector('[data-copiar]').addEventListener('click', () => copiar(codigos.join('\n')));
    const ir = caixa.querySelector('[data-ir]');
    caixa.querySelector('[data-guardei]').addEventListener('change', (e) => { ir.disabled = !e.target.checked; });
    ir.addEventListener('click', () => { avisar('Administrador criado', 'Agora entre com usuário, senha e o código do app.'); entrar(); });
    etapa.append(caixa);
  }

  api('GET', '../api/acesso/estado').then((e) => (e.temAdmin ? entrar() : primeiroAcesso())).catch((e) => avisar('Sem conexão', e.message, 'erro'));
})();
