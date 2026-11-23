/* DMK ACS - módulo do provedor: roteadores dos clientes dele, troca de Wi-Fi e reinício. */
'use strict';
(() => {
  const { $, esc, el, ic, Tema, avisar, api, haQuanto, dataHora, abrirJanela, confirmar, comoFunciona, criarLista, campo, erroNoCampo, botaoCarregando, copiar, vazioHtml } = window.DMK;

  DMK.iconesDaPagina();
  Tema.iniciar($('[data-tema]'));
  $('[data-conectar]').innerHTML = `${ic('link')}<span>Conectar roteadores</span>`;
  $('[data-atualizar]').innerHTML = ic('atualizar');
  $('[data-ajuda]').innerHTML = ic('ajuda');

  let info = null;
  const RESULTADO = {
    aplicado: ['Enviado e aplicado', 'O roteador recebeu agora.'],
    'na-fila': ['Na fila do roteador', 'Ele não atendeu agora (desligado ou atrás de CGNAT). Recebe sozinho no próximo contato, em até 5 minutos.'],
  };

  const lista = criarLista({
    cartao: $('[data-lista]'),
    busca: $('[data-busca]'),
    botaoFiltros: $('[data-filtros]'),
    vazio: { titulo: 'Nenhum roteador conectado ainda', texto: 'Aponte os roteadores dos clientes para o seu endereço de ACS (botão "Conectar roteadores"). Eles aparecem aqui sozinhos.' },
    aoAbrir: (r) => abrirFicha(r),
    colunas: [
      { id: 'cliente', titulo: 'Cliente', largura: '23%', valor: (r) => r.cliente || r.pppoe, celula: (r) => `<div class="celula-dupla"><strong>${esc(r.cliente || 'Sem cliente vinculado')}</strong><small class="mono">${esc(r.pppoe || 'sem login PPPoE')}</small></div>` },
      { id: 'ssid', titulo: 'Wi-Fi', largura: '17%', valor: (r) => r.ssid, celula: (r) => esc(r.ssid || '—') },
      { id: 'modelo', titulo: 'Roteador', largura: '17%', valor: (r) => `${r.fabricante} ${r.modelo}`, celula: (r) => `<div class="celula-dupla"><span>${esc(r.modelo || '—')}</span><small>${esc(r.fabricante)}</small></div>` },
      { id: 'serial', titulo: 'Serial', largura: '11%', valor: (r) => r.serial, celula: (r) => `<span class="mono">${esc(r.serial)}</span>` },
      { id: 'ip', titulo: 'IP', largura: '11%', valor: (r) => r.ip, celula: (r) => `<span class="mono">${esc(r.ip || '—')}</span>` },
      { id: 'contato', titulo: 'Último contato', largura: '10%', valor: (r) => r.ultimoContato, celula: (r) => `<span class="fraco" title="${esc(dataHora(r.ultimoContato))}">${esc(haQuanto(r.ultimoContato))}</span>` },
      { id: 'situacao', titulo: 'Situação', largura: '11%', opcoes: ['Online', 'Offline'], valor: (r) => (r.online ? 'Online' : 'Offline'), celula: (r) => `<span class="selo ${r.online ? 'ok' : 'desl'}">${r.online ? 'Online' : 'Offline'}</span>` },
    ],
  });

  function kpis(rs) {
    const on = rs.filter((r) => r.online).length;
    const sem = rs.filter((r) => !r.cliente).length;
    const itens = [
      ['roteador', 'Roteadores', rs.length, ''],
      ['online', 'Online', on, 'ok'],
      ['offline', 'Offline', rs.length - on, rs.length - on ? 'perigo' : ''],
      ['usuario', 'Sem cliente vinculado', sem, sem ? 'atencao' : ''],
    ];
    $('[data-kpis]').innerHTML = itens.map(([i, r, v, t]) => `<div class="kpi ${t}"><span class="chip-icone">${ic(i)}</span><div class="txt"><div class="rot reticencias">${r}</div><div class="val">${v}</div></div></div>`).join('');
  }

  function bloquear(titulo, texto, tipo) {
    document.querySelector('.app').replaceChildren(document.querySelector('.topo'), el(`<div class="bloqueio">${vazioHtml(titulo, texto, tipo)}</div>`));
  }

  DMK.definirTratarErro((e) => tratarErro(e));
  function tratarErro(e) {
    if (e.status === 401) return bloquear('Sessão encerrada', e.message, 'bloqueio');
    if (e.desativado) return bloquear('Módulo ACS desativado', e.message, 'bloqueio');
    avisar('Não deu certo', e.message, 'erro');
  }

  async function carregar(manual = false) {
    try {
      if (!info) {
        info = await api('GET', '../api/provedor/info');
        $('[data-titulo]').textContent = `${info.nome} · Roteadores`;
        $('[data-usuario]').textContent = info.usuario || '';
        document.title = `${info.nome} · Roteadores`;
      }
      const rs = await api('GET', '../api/provedor/roteadores');
      kpis(rs);
      lista.definir(rs);
      if (manual) avisar('Lista atualizada');
    } catch (e) { tratarErro(e); }
  }

  // ------------------------------------------------------------ ficha do roteador
  function abrirFicha(r) {
    const j = abrirJanela({
      icone: 'roteador', titulo: r.cliente || r.pppoe || r.serial,
      sub: `${r.modelo} · ${r.online ? 'online' : 'offline'} · último contato ${haQuanto(r.ultimoContato)}`,
      abas: [
        { id: 'wifi', rotulo: 'Wi-Fi', icone: 'wifi', desenhar: desenharWifi },
        { id: 'canal', rotulo: 'Canal', icone: 'canal', desenhar: (corpo) => DMK.desenharCanal(corpo, j.rodape, r, `../api/provedor/roteadores/${encodeURIComponent(r.id)}/canal`, carregar) },
        { id: 'aparelhos', rotulo: 'Aparelhos', icone: 'aparelho', desenhar: (corpo) => DMK.desenharAparelhos(corpo, j.rodape, `../api/provedor/roteadores/${encodeURIComponent(r.id)}/aparelhos`) },
        { id: 'roteador', rotulo: 'Roteador', icone: 'chip', desenhar: desenharRoteador },
      ],
      rodape: ' ',
    });

    function desenharWifi(corpo) {
      const form = el('<form class="form" autocomplete="off"></form>');
      const senha = campo({ rotulo: 'Nova senha do Wi-Fi', nome: 'senha', tipo: 'password', max: 63, placeholder: 'mínimo 8 caracteres', ajuda: 'Deixe em branco para trocar só o nome.' });
      const olho = el(`<button type="button" class="btn ico" title="Mostrar senha">${ic('olho')}</button>`);
      const inp = senha.querySelector('input');
      const linha = el('<div class="com-botao"></div>');
      inp.replaceWith(linha); linha.append(inp, olho);
      olho.addEventListener('click', () => { inp.type = inp.type === 'password' ? 'text' : 'password'; });
      form.append(campo({ rotulo: 'Nome do Wi-Fi (SSID)', nome: 'ssid', valor: r.ssid, max: 32 }), senha);
      form.append(el(`<div class="aviso-caixa inteiro">${ic('wifi')}<span>Vale para a rede principal e para a de 5 GHz quando ela tem o mesmo nome. O cliente vai precisar reconectar os aparelhos com a senha nova.</span></div>`));
      form.addEventListener('submit', (e) => { e.preventDefault(); enviar.click(); });
      corpo.append(form);

      j.rodape.innerHTML = '';
      const enviar = el(`<button type="button" class="btn primario">${ic('enviar')}<span>Enviar para o roteador</span></button>`);
      enviar.addEventListener('click', async () => {
        const d = Object.fromEntries(new FormData(form));
        if (!d.ssid.trim()) return erroNoCampo(form, 'ssid', 'Informe o nome do Wi-Fi.');
        if (d.senha && d.senha.length < 8) return erroNoCampo(form, 'senha', 'A senha precisa ter pelo menos 8 caracteres.');
        botaoCarregando(enviar, true);
        try {
          const { situacao } = await api('POST', `../api/provedor/roteadores/${encodeURIComponent(r.id)}/wifi`, { ssid: d.ssid.trim(), senha: d.senha });
          avisar(...RESULTADO[situacao]);
          j.fechar();
          carregar();
        } catch (e) {
          botaoCarregando(enviar, false);
          if (!(e.campo && erroNoCampo(form, e.campo, e.message))) tratarErro(e);
        }
      });
      j.rodape.append(botaoReiniciar(), enviar);
      form.querySelector('[name="ssid"]').focus();
    }

    function desenharRoteador(corpo) {
      const dado = (i, rot, v, mono = false) => `<div class="dado">${ic(i)}<div><small>${rot}</small><strong class="${mono ? 'mono' : ''}">${esc(v || '—')}</strong></div></div>`;
      corpo.innerHTML = `<div class="dados">
        ${dado('usuario', 'Cliente', r.cliente)}${dado('etiqueta', 'Login PPPoE', r.pppoe, true)}
        ${dado('chip', 'Fabricante', r.fabricante)}${dado('roteador', 'Modelo', r.modelo)}
        ${dado('etiqueta', 'Serial', r.serial, true)}${dado('chip', 'Versão do firmware', r.versao)}
        ${dado('ip', 'IP de internet do roteador', r.ip, true)}${dado('relogio', 'Último contato', dataHora(r.ultimoContato))}
        </div>`;
      j.rodape.innerHTML = '';
      const atualizar = el(`<button type="button" class="btn">${ic('atualizar')}<span>Ler dados agora</span></button>`);
      atualizar.addEventListener('click', async () => {
        botaoCarregando(atualizar, true);
        try {
          const res = await api('POST', `../api/provedor/roteadores/${encodeURIComponent(r.id)}/atualizar`);
          if (res.roteador) Object.assign(r, res.roteador);
          avisar(...(res.situacao === 'aplicado' ? ['Dados lidos do roteador', 'Ficha atualizada.'] : RESULTADO['na-fila']));
          desenharRoteador(corpo);
          carregar();
        } catch (e) { botaoCarregando(atualizar, false); tratarErro(e); }
      });
      j.rodape.append(botaoReiniciar(), atualizar);
    }

    function botaoReiniciar() {
      const b = el(`<button type="button" class="btn perigo">${ic('reiniciar')}<span>Reiniciar</span></button>`);
      b.addEventListener('click', async () => {
        if (!(await confirmar({ titulo: 'Reiniciar o roteador?', texto: `A internet de ${r.cliente || 'este cliente'} cai por cerca de 1 a 2 minutos enquanto o roteador reinicia.`, botao: 'Reiniciar agora', perigo: true, icone: 'reiniciar' }))) return;
        botaoCarregando(b, true);
        try {
          const { situacao } = await api('POST', `../api/provedor/roteadores/${encodeURIComponent(r.id)}/reiniciar`);
          avisar(...(situacao === 'aplicado' ? ['Reinício enviado', 'O roteador está reiniciando.'] : RESULTADO['na-fila']));
          j.fechar();
        } catch (e) { botaoCarregando(b, false); tratarErro(e); }
      });
      return b;
    }

    j.irPara('wifi');
  }

  function abrirConectar() {
    const cmd = info.mikrotik;
    const j = abrirJanela({ icone: 'link', titulo: 'Conectar roteadores ao ACS', sub: 'Configure seus roteadores com este endereço para eles aparecerem aqui.', tamanho: 'medio', corpo: `
      <h4 class="secao">Endereço do ACS (URL)</h4>
      <div class="codigo"><code>${esc(info.enderecoAcs)}</code><button type="button" class="fantasma" data-copiar="${esc(info.enderecoAcs)}" aria-label="Copiar">${ic('copiar')}</button></div>
      <h4 class="secao">Na ONU / roteador do cliente</h4>
      <ol class="passos">
        <li>Abra a configuração de <strong>TR-069 / ACS / Gerenciamento remoto</strong>.</li>
        <li>Ligue o TR-069 e cole a URL acima em "ACS URL".</li>
        <li>Ligue o "Inform periódico" com intervalo de <strong>300</strong> segundos.</li>
        <li>Salve. Em até 5 minutos o roteador aparece na lista.</li>
      </ol>
      <div class="aviso-caixa">${ic('wifi')}<span>Dica: configure em lote pelo provisionamento da OLT ou pelo perfil padrão das ONUs, com a mesma URL.</span></div>
      <h4 class="secao">RB MikroTik (RouterOS 7, pacote tr069-client)</h4>
      <div class="codigo"><code>${esc(cmd)}</code><button type="button" class="fantasma" data-copiar="${esc(cmd)}" aria-label="Copiar">${ic('copiar')}</button></div>` });
    j.corpo.querySelectorAll('[data-copiar]').forEach((b) => b.addEventListener('click', () => copiar(b.dataset.copiar)));
  }

  $('[data-conectar]').addEventListener('click', () => info && abrirConectar());
  $('[data-atualizar]').addEventListener('click', () => carregar(true));
  $('[data-ajuda]').addEventListener('click', () => comoFunciona('Como funciona', `
    <ol class="passos">
      <li>Aqui aparecem só os roteadores configurados com o <strong>seu endereço de ACS</strong>.</li>
      <li>O cliente é reconhecido pelo <strong>login PPPoE</strong> que está no roteador.</li>
      <li>Clique num cliente para trocar o <strong>nome e a senha do Wi-Fi</strong> ou reiniciar o roteador.</li>
      <li><strong>Online</strong>: falou com o ACS nos últimos ${info?.onlineMin ?? 11} minutos. Comando para roteador que não atende na hora fica na fila e é aplicado no próximo contato.</li>
    </ol>`));

  Promise.resolve(carregar()).finally(() => DMK.pronto());
  setInterval(() => { if (!document.hidden && !document.querySelector('.fundo-modal')) carregar(); }, 30000);
})();
