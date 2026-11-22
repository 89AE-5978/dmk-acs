/* DMK ACS - tela da Central (admin DMK): provedores que usam o ACS, ativar/desativar, endereço. */
'use strict';
(() => {
  const { $, esc, el, ic, Tema, avisar, api, dataHora, abrirJanela, confirmar, comoFunciona, criarLista, campo, erroNoCampo, botaoCarregando, copiar, vazioHtml } = window.DMK;

  DMK.iconesDaPagina();
  Tema.iniciar($('[data-tema]'));
  $('[data-novo]').innerHTML = `${ic('mais')}<span>Novo provedor</span>`;
  $('[data-atualizar]').innerHTML = ic('atualizar');
  $('[data-ajuda]').innerHTML = ic('ajuda');

  let resumo = null;

  const lista = criarLista({
    cartao: $('[data-lista]'),
    busca: $('[data-busca]'),
    botaoFiltros: $('[data-filtros]'),
    vazio: { titulo: 'Nenhum provedor ainda', texto: 'Cadastre o primeiro provedor em "Novo provedor" e defina o endereço do ACS dele.' },
    aoAbrir: (p) => abrirFicha(p),
    colunas: [
      { id: 'nome', titulo: 'Provedor', largura: '26%', valor: (p) => p.nome, celula: (p) => `<div class="celula-dupla"><strong>${esc(p.nome)}</strong><small>${esc(p.id)}</small></div>` },
      { id: 'endereco', titulo: 'Endereço do ACS', largura: '30%', valor: (p) => p.enderecoAcs, celula: (p) => `<span class="mono">${esc(p.enderecoAcs)}</span>` },
      { id: 'total', titulo: 'Roteadores', largura: '11%', num: true, valor: (p) => p.total },
      { id: 'online', titulo: 'Online', largura: '10%', num: true, valor: (p) => p.online },
      { id: 'situacao', titulo: 'Situação', largura: '12%', opcoes: ['Ativo', 'Desativado'], valor: (p) => (p.ativo ? 'Ativo' : 'Desativado'), celula: (p) => `<span class="selo ${p.ativo ? 'ok' : 'desl'}">${p.ativo ? 'Ativo' : 'Desativado'}</span>` },
      { id: 'atualizado', titulo: 'Alterado em', largura: '11%', valor: (p) => p.atualizadoEm, celula: (p) => `<span class="fraco">${esc(dataHora(p.atualizadoEm))}</span>` },
    ],
  });

  function kpis() {
    const ps = resumo.provedores;
    const total = ps.reduce((s, p) => s + p.total, 0);
    const online = ps.reduce((s, p) => s + p.online, 0);
    const itens = [
      ['provedor', 'Provedores', ps.length, ''],
      ['ligar', 'Com ACS ativo', ps.filter((p) => p.ativo).length, 'ok'],
      ['roteador', 'Roteadores', total, ''],
      ['online', 'Online agora', online, 'ok'],
      ['alerta', 'Sem provedor', resumo.semProvedor.total, resumo.semProvedor.total ? 'atencao' : ''],
    ];
    $('[data-kpis]').innerHTML = itens.map(([i, r, v, t]) => `<div class="kpi ${t}"><span class="chip-icone">${ic(i)}</span><div class="txt"><div class="rot reticencias">${r}</div><div class="val">${v}</div></div></div>`).join('');
    $('[data-kpis] .kpi:last-child').title = 'Roteadores que se conectaram num endereço que não é de nenhum provedor cadastrado';
  }

  async function carregar(manual = false) {
    try {
      resumo = await api('GET', '../api/central/resumo');
      $('[data-usuario]').textContent = resumo.usuario || '';
      kpis();
      lista.definir(resumo.provedores);
      if (resumo.acs && !resumo.acs.scriptsOk && resumo.acs.erro) avisar('ACS ainda não respondeu', resumo.acs.erro, 'erro');
      if (manual) avisar('Lista atualizada');
    } catch (e) { tratarErro(e); }
  }

  function tratarErro(e) {
    if (e.status === 401) {
      document.querySelector('.app').replaceChildren(document.querySelector('.topo'), el(`<div class="bloqueio">${vazioHtml('Sessão encerrada', e.message, 'bloqueio')}</div>`));
      return;
    }
    avisar('Não deu certo', e.message, 'erro');
  }

  // ------------------------------------------------------------ ficha do provedor
  function abrirFicha(p) {
    const novo = !p;
    const abas = [{ id: 'dados', rotulo: 'Dados', icone: 'provedor', desenhar: desenharDados }];
    if (!novo) {
      abas.push({ id: 'roteadores', rotulo: 'Roteadores', icone: 'roteador', desenhar: desenharRoteadores });
      abas.push({ id: 'conexao', rotulo: 'Como conectar', icone: 'link', desenhar: desenharConexao });
    }
    const j = abrirJanela({
      icone: 'provedor', titulo: novo ? 'Novo provedor' : p.nome,
      sub: novo ? 'O provedor recebe o módulo ACS no DMK Prisma quando estiver ativo.' : `${p.total} roteador(es) · ${p.online} online · ${p.ativo ? 'módulo ativo' : 'módulo desativado'}`,
      abas, rodape: ' ',
    });

    function rodapeDados(form) {
      j.rodape.innerHTML = '';
      if (!novo) {
        const excluir = el(`<button type="button" class="btn perigo">${ic('lixo')}<span>Excluir</span></button>`);
        excluir.addEventListener('click', async () => {
          if (!(await confirmar({ titulo: `Excluir ${p.nome}?`, texto: 'O provedor sai do DMK ACS e perde o módulo. Os roteadores não são alterados: continuam no ACS e voltam a aparecer se você cadastrar o provedor de novo com o mesmo endereço.', botao: 'Excluir provedor', perigo: true, icone: 'lixo' }))) return;
          try { await api('DELETE', `../api/central/provedores/${p.id}`); avisar('Provedor excluído'); j.fechar(); carregar(); } catch (e) { tratarErro(e); }
        });
        const alternar = el(`<button type="button" class="btn ${p.ativo ? 'perigo' : ''}">${ic('ligar')}<span>${p.ativo ? 'Desativar módulo' : 'Ativar módulo'}</span></button>`);
        alternar.addEventListener('click', async () => {
          if (p.ativo && !(await confirmar({ titulo: `Desativar o ACS de ${p.nome}?`, texto: 'O provedor deixa de ver o módulo e não consegue mais mandar comandos aos roteadores. Os roteadores continuam ligados ao ACS e nada é apagado.', botao: 'Desativar', perigo: true }))) return;
          try {
            const r = await api('PUT', `../api/central/provedores/${p.id}`, { ativo: !p.ativo });
            avisar(r.ativo ? 'Módulo ativado' : 'Módulo desativado', `${r.nome} ${r.ativo ? 'já pode usar o ACS.' : 'não acessa mais o ACS.'}`);
            j.fechar(); carregar();
          } catch (e) { tratarErro(e); }
        });
        j.rodape.append(excluir, alternar);
      }
      const salvar = el(`<button type="button" class="btn primario">${ic('salvar')}<span>${novo ? 'Cadastrar e ativar' : 'Salvar'}</span></button>`);
      salvar.addEventListener('click', async () => {
        const d = Object.fromEntries(new FormData(form));
        botaoCarregando(salvar, true);
        try {
          const r = novo ? await api('POST', '../api/central/provedores', { id: d.id, nome: d.nome, enderecoAcs: d.enderecoAcs })
            : await api('PUT', `../api/central/provedores/${p.id}`, { nome: d.nome, enderecoAcs: d.enderecoAcs });
          avisar(novo ? 'Provedor cadastrado' : 'Provedor salvo', r.nome);
          j.fechar(); carregar();
        } catch (e) {
          botaoCarregando(salvar, false);
          if (!(e.campo && erroNoCampo(form, e.campo, e.message))) tratarErro(e);
        }
      });
      j.rodape.append(salvar);
    }

    function desenharDados(corpo) {
      const form = el('<form class="form" autocomplete="off"></form>');
      form.append(
        campo({ rotulo: 'Código', nome: 'id', valor: p?.id || '', somenteLeitura: !novo, placeholder: 'ex.: starnet', max: 40, ajuda: novo ? 'O mesmo código da empresa no DMK Prisma. Minúsculas, números e hífen.' : 'Ligação com a empresa no DMK Prisma (não muda).' }),
        campo({ rotulo: 'Nome do provedor', nome: 'nome', valor: p?.nome || '', max: 80 }),
        campo({ rotulo: 'Endereço do ACS deste provedor', nome: 'enderecoAcs', valor: p?.enderecoAcs || '', inteiro: true, placeholder: 'acs.provedor.com.br', ajuda: 'Domínio do provedor apontando para a VPS. Os roteadores configurados com este endereço aparecem só para ele. Sem porta, usa a 7547.' }),
      );
      form.addEventListener('submit', (e) => e.preventDefault());
      form.querySelector('[name="nome"]').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
      corpo.append(form);
      rodapeDados(form);
      form.querySelector(novo ? '[name="id"]' : '[name="nome"]').focus();
    }

    async function desenharRoteadores(corpo) {
      j.rodape.innerHTML = '';
      corpo.innerHTML = '<p class="fraco">Carregando roteadores…</p>';
      try {
        const rs = await api('GET', `../api/central/provedores/${p.id}/roteadores`);
        if (!rs.length) { corpo.innerHTML = vazioHtml('Nenhum roteador conectado ainda', 'Quando os roteadores deste provedor apontarem para o endereço dele, eles aparecem aqui.'); return; }
        corpo.innerHTML = `<p class="fraco">Somente leitura. Quem troca Wi-Fi e reinicia é o próprio provedor, no módulo dele.</p>
          <div class="mini-lista"><table><thead><tr><th>Cliente</th><th>PPPoE</th><th>Wi-Fi</th><th>Situação</th></tr></thead><tbody>
          ${rs.map((r) => `<tr><td>${esc(r.cliente || '—')}</td><td class="mono">${esc(r.pppoe || '—')}</td><td>${esc(r.ssid || '—')}</td><td><span class="selo ${r.online ? 'ok' : 'desl'}">${r.online ? 'Online' : 'Offline'}</span></td></tr>`).join('')}
          </tbody></table></div>`;
      } catch (e) { corpo.innerHTML = ''; tratarErro(e); }
    }

    function desenharConexao(corpo) {
      j.rodape.innerHTML = '';
      const cmd = `/tr069-client set enabled=yes acs-url=${p.enderecoAcs} periodic-inform-enabled=yes periodic-inform-interval=5m`;
      corpo.innerHTML = `
        <h4 class="secao">Endereço do ACS (URL)</h4>
        <div class="codigo"><code>${esc(p.enderecoAcs)}</code><button type="button" class="fantasma" data-copiar="${esc(p.enderecoAcs)}" aria-label="Copiar">${ic('copiar')}</button></div>
        <h4 class="secao">O que o provedor precisa fazer</h4>
        <ol class="passos">
          <li>Apontar o domínio <strong>${esc(new URL(p.enderecoAcs).hostname)}</strong> (registro A) para o IP da VPS do ACS.</li>
          <li>Na ONU/roteador do cliente, em TR-069/ACS: URL acima, inform periódico ligado (300 s).</li>
          <li>Em lote, pelo provisionamento da OLT ou do roteador, usando a mesma URL.</li>
        </ol>
        <h4 class="secao">RB MikroTik (RouterOS 7, pacote tr069-client)</h4>
        <div class="codigo"><code>${esc(cmd)}</code><button type="button" class="fantasma" data-copiar="${esc(cmd)}" aria-label="Copiar">${ic('copiar')}</button></div>`;
      corpo.querySelectorAll('[data-copiar]').forEach((b) => b.addEventListener('click', () => copiar(b.dataset.copiar)));
    }

    j.irPara('dados');
  }

  $('[data-novo]').addEventListener('click', () => abrirFicha(null));
  $('[data-atualizar]').addEventListener('click', () => carregar(true));
  $('[data-ajuda]').addEventListener('click', () => comoFunciona('Como funciona o ACS da DMK', `
    <ol class="passos">
      <li><strong>Cadastre o provedor</strong> com o mesmo código da empresa no DMK Prisma e o endereço do ACS dele (ex.: acs.starnet.com.br).</li>
      <li>Com o módulo <strong>ativo</strong>, o provedor vê "ACS · Roteadores" no DMK Prisma. Desativado, o módulo some para ele e os comandos são recusados.</li>
      <li>Cada roteador fica com o provedor <strong>pelo endereço do ACS gravado nele</strong>. Um provedor nunca vê roteador do outro.</li>
      <li>"Sem provedor" conta roteadores que chegaram por um endereço que nenhum provedor usa (ex.: configurados errado).</li>
    </ol>`));

  carregar();
  setInterval(() => { if (!document.hidden && !document.querySelector('.fundo-modal')) carregar(); }, 30000);
})();
