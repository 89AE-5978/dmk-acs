/* DMK ACS - painel do admin: Provedores, Clientes avulsos, Segurança e Conexão (DMK Prisma).
   Padrão de tela de seções do DMK Prisma: menu de seções + Pesquisar + Filtros na mesma linha,
   KPIs numa fileira, tela fixa (só a lista rola), ajuda em pop-up. */
'use strict';
(() => {
  const { $, esc, el, ic, Tema, avisar, api, dataHora, haQuanto, abrirJanela, confirmar, comoFunciona, criarLista, campo, erroNoCampo, botaoCarregando, copiar, vazioHtml, mascaraTelefone, telefoneBonito } = window.DMK;

  DMK.iconesDaPagina();
  Tema.iniciar($('[data-tema]'));
  $('[data-atualizar]').innerHTML = ic('atualizar');
  $('[data-ajuda]').innerHTML = ic('ajuda');
  $('[data-sair]').innerHTML = ic('sair');

  let resumo = null;
  const SECOES = [
    { id: 'provedores', rotulo: 'Provedores', icone: 'provedor', novo: 'Novo provedor', lista: true },
    { id: 'avulsos', rotulo: 'Clientes avulsos', icone: 'usuario', novo: 'Novo cliente', lista: true },
    { id: 'seguranca', rotulo: 'Segurança', icone: 'cadeado' },
    { id: 'conexao', rotulo: 'Conexão', icone: 'link' },
  ];
  let secao = 'provedores';
  try { secao = sessionStorage.getItem('dmkacs-secao') || secao; } catch { /* sem armazenamento */ }   // F5 mantém a seção

  // ------------------------------------------------------------ erros e sessão
  function tratarErro(e) {
    if (e.status === 401) { location.href = '../admin/'; return; }
    avisar('Não deu certo', e.message, 'erro');
  }

  // ------------------------------------------------------------ barra: seções + pesquisa/filtros por lista
  const buscas = {};
  for (const s of SECOES.filter((x) => x.lista)) {
    const grupo = el(`<div class="grupo-busca oculto" data-busca-de="${s.id}"><label class="busca">${ic('pesquisar')}<input type="search" aria-label="Pesquisar"></label><button type="button" class="btn"></button></div>`);
    grupo.querySelector('input').placeholder = s.id === 'provedores' ? 'Pesquisar provedor, endereço…' : 'Pesquisar cliente, usuário, código…';
    $('[data-fixos]').append(grupo);
    buscas[s.id] = { input: grupo.querySelector('input'), filtros: grupo.querySelector('button'), grupo };
  }
  for (const s of SECOES) {
    const b = el(`<button type="button" class="secao-btn" role="tab" data-ir="${s.id}" title="${esc(s.rotulo)}">${ic(s.icone)}<span>${esc(s.rotulo)}</span></button>`);
    b.addEventListener('click', () => irPara(s.id));
    $('[data-secoes]').append(b);
  }

  function irPara(id) {
    secao = id;
    try { sessionStorage.setItem('dmkacs-secao', id); } catch { /* ignora */ }
    const s = SECOES.find((x) => x.id === id);
    document.querySelectorAll('[data-ir]').forEach((b) => b.classList.toggle('ativa', b.dataset.ir === id));
    document.querySelectorAll('[data-sec]').forEach((m) => m.classList.toggle('oculto', m.dataset.sec !== id));
    Object.entries(buscas).forEach(([k, v]) => v.grupo.classList.toggle('oculto', k !== id));
    $('[data-fixos]').classList.toggle('oculto', !s.lista);
    const novo = $('[data-novo]');
    novo.classList.toggle('oculto', !s.novo);
    if (s.novo) novo.innerHTML = `${ic('mais')}<span>${esc(s.novo)}</span>`;
    if (id === 'seguranca') desenharSeguranca();
    if (id === 'conexao') desenharConexao();
  }

  // ------------------------------------------------------------ KPIs
  function kpis() {
    const ps = resumo.provedores; const cs = resumo.avulsos;
    const total = ps.reduce((s, p) => s + p.total, 0) + cs.reduce((s, c) => s + c.total, 0) + resumo.semDono.total;
    const online = ps.reduce((s, p) => s + p.online, 0) + cs.reduce((s, c) => s + c.online, 0) + resumo.semDono.online;
    const itens = [
      ['provedor', 'Provedores ativos', `${ps.filter((p) => p.ativo).length}/${ps.length}`, ''],
      ['usuario', 'Clientes avulsos', cs.length, ''],
      ['roteador', 'Roteadores', total, ''],
      ['online', 'Online agora', online, 'ok'],
      ['alerta', 'Sem dono', resumo.semDono.total, resumo.semDono.total ? 'atencao' : ''],
    ];
    $('[data-kpis]').innerHTML = itens.map(([i, r, v, t]) => `<div class="kpi ${t}"><span class="chip-icone">${ic(i)}</span><div class="txt"><div class="rot reticencias">${r}</div><div class="val">${v}</div></div></div>`).join('');
    $('[data-kpis] .kpi:last-child').title = 'Roteadores que chegaram por um endereço que não é de nenhum provedor nem cliente avulso';
  }

  // ------------------------------------------------------------ listas
  const listaProvedores = criarLista({
    cartao: $('[data-sec="provedores"]'), busca: buscas.provedores.input, botaoFiltros: buscas.provedores.filtros,
    vazio: { titulo: 'Nenhum provedor ainda', texto: 'Cadastre o primeiro em "Novo provedor" ou libere pela Central do DMK Prisma.' },
    aoAbrir: (p) => fichaProvedor(p),
    colunas: [
      { id: 'nome', titulo: 'Provedor', largura: '26%', valor: (p) => p.nome, celula: (p) => `<div class="celula-dupla"><strong>${esc(p.nome)}</strong><small>${esc(p.id)}</small></div>` },
      { id: 'endereco', titulo: 'Endereço do ACS', largura: '30%', valor: (p) => p.enderecoAcs, celula: (p) => `<span class="mono">${esc(p.enderecoAcs)}</span>` },
      { id: 'total', titulo: 'Roteadores', largura: '11%', num: true, valor: (p) => p.total },
      { id: 'online', titulo: 'Online', largura: '10%', num: true, valor: (p) => p.online },
      { id: 'situacao', titulo: 'Situação', largura: '12%', opcoes: ['Ativo', 'Desativado'], valor: (p) => (p.ativo ? 'Ativo' : 'Desativado'), celula: (p) => `<span class="selo ${p.ativo ? 'ok' : 'desl'}">${p.ativo ? 'Ativo' : 'Desativado'}</span>` },
      { id: 'atualizado', titulo: 'Alterado em', largura: '11%', valor: (p) => p.atualizadoEm, celula: (p) => `<span class="fraco">${esc(dataHora(p.atualizadoEm))}</span>` },
    ],
  });

  const situacaoAvulso = (c) => (!c.ativo ? 'Desativado' : !c.roteador ? 'Aguardando roteador' : c.roteador.online ? 'Online' : 'Offline');
  const seloAvulso = (c) => { const s = situacaoAvulso(c); return `<span class="selo ${s === 'Online' ? 'ok' : s === 'Aguardando roteador' ? 'espera' : 'desl'}">${s}</span>`; };
  const listaAvulsos = criarLista({
    cartao: $('[data-sec="avulsos"]'), busca: buscas.avulsos.input, botaoFiltros: buscas.avulsos.filtros, chave: (c) => c.codigo,
    vazio: { titulo: 'Nenhum cliente avulso ainda', texto: 'Cadastre em "Novo cliente". Ele recebe um endereço de ACS próprio e o acesso ao app DMK Wi-Fi.' },
    aoAbrir: (c) => fichaAvulso(c),
    colunas: [
      { id: 'nome', titulo: 'Cliente', largura: '25%', valor: (c) => c.nome, celula: (c) => `<div class="celula-dupla"><strong>${esc(c.nome)}</strong><small>${esc(c.usuario)}</small></div>` },
      { id: 'codigo', titulo: 'Código', largura: '10%', valor: (c) => c.codigo, celula: (c) => `<span class="mono">${esc(c.codigo)}</span>` },
      { id: 'roteador', titulo: 'Roteador', largura: '18%', valor: (c) => (c.roteador ? `${c.roteador.modelo} ${c.roteador.serial}` : ''), celula: (c) => (c.roteador ? `<div class="celula-dupla"><span>${esc(c.roteador.modelo)}</span><small class="mono">${esc(c.roteador.serial)}</small></div>` : '<span class="fraco">—</span>') },
      { id: 'ssid', titulo: 'Wi-Fi', largura: '16%', valor: (c) => c.roteador?.ssid || '', celula: (c) => esc(c.roteador?.ssid || '—') },
      { id: 'telefone', titulo: 'Telefone', largura: '14%', valor: (c) => c.telefone, celula: (c) => `<span class="fraco">${esc(telefoneBonito(c.telefone) || '—')}</span>` },
      { id: 'situacao', titulo: 'Situação', largura: '17%', opcoes: ['Online', 'Offline', 'Aguardando roteador', 'Desativado'], valor: situacaoAvulso, celula: seloAvulso },
    ],
  });

  async function carregar(manual = false) {
    try {
      resumo = await api('GET', '../api/central/resumo');
      $('[data-usuario]').textContent = resumo.usuario || '';
      kpis();
      listaProvedores.definir(resumo.provedores);
      listaAvulsos.definir(resumo.avulsos);
      if (resumo.acs && !resumo.acs.scriptsOk && resumo.acs.erro) avisar('ACS ainda não respondeu', resumo.acs.erro, 'erro');
      if (manual) avisar('Atualizado');
    } catch (e) { tratarErro(e); }
  }

  function blocoConexao(endereco) {
    const cmd = `/tr069-client set enabled=yes acs-url=${endereco} periodic-inform-enabled=yes periodic-inform-interval=5m`;
    const b = el(`<div>
      <h4 class="secao">Endereço do ACS (URL)</h4>
      <div class="codigo"><code></code><button type="button" class="fantasma" aria-label="Copiar">${ic('copiar')}</button></div>
      <h4 class="secao">No roteador / ONU (uma vez só)</h4>
      <ol class="passos"><li>Abra TR-069 / ACS / Gerenciamento remoto.</li><li>Ligue o TR-069 e cole a URL acima em "ACS URL".</li><li>Inform periódico ligado, 300 segundos. Salve: em até 5 min o roteador aparece.</li></ol>
      <h4 class="secao">RB MikroTik (RouterOS 7, pacote tr069-client)</h4>
      <div class="codigo"><code></code><button type="button" class="fantasma" aria-label="Copiar">${ic('copiar')}</button></div></div>`);
    const [c1, c2] = b.querySelectorAll('code'); c1.textContent = endereco; c2.textContent = cmd;
    const [b1, b2] = b.querySelectorAll('button'); b1.addEventListener('click', () => copiar(endereco)); b2.addEventListener('click', () => copiar(cmd));
    return b;
  }

  function miniLista(rs, vazio) {
    if (!rs.length) return vazioHtml(vazio[0], vazio[1]);
    return `<div class="mini-lista"><table><thead><tr><th>Cliente / PPPoE</th><th>Roteador</th><th>Wi-Fi</th><th>Situação</th></tr></thead><tbody>
      ${rs.map((r) => `<tr><td>${esc(r.cliente || r.pppoe || '—')}</td><td>${esc(r.modelo)} <span class="mono fraco">${esc(r.serial)}</span></td><td>${esc(r.ssid || '—')}</td><td><span class="selo ${r.online ? 'ok' : 'desl'}">${r.online ? 'Online' : 'Offline'}</span></td></tr>`).join('')}
      </tbody></table></div>`;
  }

  // ------------------------------------------------------------ ficha do provedor
  function fichaProvedor(p) {
    const novo = !p;
    const abas = [{ id: 'dados', rotulo: 'Dados', icone: 'provedor', desenhar: dados }];
    if (!novo) abas.push({ id: 'roteadores', rotulo: 'Roteadores', icone: 'roteador', desenhar: roteadores }, { id: 'conexao', rotulo: 'Como conectar', icone: 'link', desenhar: (c) => { j.rodape.innerHTML = ''; c.append(blocoConexao(p.enderecoAcs)); } });
    const j = abrirJanela({ icone: 'provedor', titulo: novo ? 'Novo provedor' : p.nome, sub: novo ? 'Com o módulo ativo, o provedor vê "ACS · Roteadores" no DMK Prisma.' : `${p.total} roteador(es) · ${p.online} online · ${p.ativo ? 'módulo ativo' : 'módulo desativado'}`, abas, rodape: ' ' });

    function dados(corpo) {
      const form = el('<form class="form" autocomplete="off"></form>');
      form.append(
        campo({ rotulo: 'Código', nome: 'id', valor: p?.id || '', somenteLeitura: !novo, placeholder: 'ex.: starnet', max: 40, ajuda: novo ? 'O mesmo código da empresa no DMK Prisma.' : 'Ligação com a empresa no DMK Prisma (não muda).' }),
        campo({ rotulo: 'Nome do provedor', nome: 'nome', valor: p?.nome || '', max: 80 }),
        campo({ rotulo: 'Endereço do ACS deste provedor', nome: 'enderecoAcs', valor: p?.enderecoAcs || '', inteiro: true, placeholder: 'acs.provedor.com.br', ajuda: 'Domínio do provedor apontando para a VPS. Os roteadores com este endereço aparecem só para ele. Sem porta, usa a 7547.' }),
      );
      form.querySelector('[name="nome"]').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
      form.addEventListener('submit', (e) => { e.preventDefault(); salvar.click(); });
      corpo.append(form);
      j.rodape.innerHTML = '';
      if (!novo) {
        const excluir = el(`<button type="button" class="btn perigo">${ic('lixo')}<span>Excluir</span></button>`);
        excluir.addEventListener('click', async () => {
          if (!(await confirmar({ titulo: `Excluir ${p.nome}?`, texto: 'O provedor sai do DMK ACS e perde o módulo. Os roteadores não são alterados e voltam a aparecer se ele for cadastrado de novo com o mesmo endereço.', botao: 'Excluir provedor', perigo: true, icone: 'lixo' }))) return;
          try { await api('DELETE', `../api/central/provedores/${p.id}`); avisar('Provedor excluído'); j.fechar(); carregar(); } catch (e) { tratarErro(e); }
        });
        const alternar = el(`<button type="button" class="btn ${p.ativo ? 'perigo' : ''}">${ic('ligar')}<span>${p.ativo ? 'Desativar módulo' : 'Ativar módulo'}</span></button>`);
        alternar.addEventListener('click', async () => {
          if (p.ativo && !(await confirmar({ titulo: `Desativar o ACS de ${p.nome}?`, texto: 'O provedor deixa de ver o módulo e não manda mais comandos aos roteadores. Nada é apagado.', botao: 'Desativar', perigo: true }))) return;
          try { const r = await api('PUT', `../api/central/provedores/${p.id}`, { ativo: !p.ativo }); avisar(r.ativo ? 'Módulo ativado' : 'Módulo desativado', r.nome); j.fechar(); carregar(); } catch (e) { tratarErro(e); }
        });
        j.rodape.append(excluir, alternar);
      }
      const salvar = el(`<button type="button" class="btn primario">${ic('salvar')}<span>${novo ? 'Cadastrar e ativar' : 'Salvar'}</span></button>`);
      salvar.addEventListener('click', async () => {
        const d = Object.fromEntries(new FormData(form));
        botaoCarregando(salvar, true);
        try {
          const r = novo ? await api('POST', '../api/central/provedores', d) : await api('PUT', `../api/central/provedores/${p.id}`, { nome: d.nome, enderecoAcs: d.enderecoAcs });
          avisar(novo ? 'Provedor cadastrado' : 'Provedor salvo', r.nome); j.fechar(); carregar();
        } catch (e) { botaoCarregando(salvar, false); if (!(e.campo && erroNoCampo(form, e.campo, e.message))) tratarErro(e); }
      });
      j.rodape.append(salvar);
      form.querySelector(novo ? '[name="id"]' : '[name="nome"]').focus();
    }
    async function roteadores(corpo) {
      j.rodape.innerHTML = '';
      corpo.innerHTML = '<p class="fraco">Carregando…</p>';
      try { corpo.innerHTML = `<p class="fraco">Somente leitura: quem troca Wi-Fi e reinicia é o provedor, no módulo dele.</p>${miniLista(await api('GET', `../api/central/provedores/${p.id}/roteadores`), ['Nenhum roteador ainda', 'Quando os roteadores apontarem para o endereço do provedor, aparecem aqui.'])}`; } catch (e) { corpo.innerHTML = ''; tratarErro(e); }
    }
    j.irPara('dados');
  }

  // ------------------------------------------------------------ ficha do cliente avulso
  function formAvulso(c) {
    const form = el('<form class="form" autocomplete="off"></form>');
    const tel = campo({ rotulo: 'Celular (WhatsApp)', nome: 'telefone', valor: telefoneBonito(c?.telefone || ''), max: 16, placeholder: '(00) 00000-0000' });
    mascaraTelefone(tel.querySelector('input'));
    form.append(
      campo({ rotulo: 'Nome completo', nome: 'nome', valor: c?.nome || '', max: 80, inteiro: true }),
      tel,
      campo({ rotulo: 'E-mail', nome: 'email', valor: c?.email || '', max: 120, tipo: 'email' }),
      campo({ rotulo: 'Usuário do app', nome: 'usuario', valor: c?.usuario || '', max: 32, ajuda: 'Com isso o cliente entra no app DMK Wi-Fi.' }),
    );
    form.querySelector('[name="nome"]').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
    form.querySelector('[name="usuario"]').addEventListener('input', (e) => { e.target.value = e.target.value.toLowerCase().replace(/\s/g, ''); });
    form.addEventListener('submit', (e) => e.preventDefault());
    return form;
  }

  function entregarAcesso({ titulo, nome, usuario, senha, endereco }) {
    const linkApp = new URL('../app/', location.href).href;
    const j = abrirJanela({ icone: 'ok', titulo, sub: nome, tamanho: 'medio', corpo: '<div></div>' });
    const corpo = j.corpo.firstChild;
    corpo.innerHTML = `<div class="aviso-caixa">${ic('cadeado')}<span>A senha provisória aparece só agora. O cliente troca por uma dele no primeiro acesso ao app.</span></div>
      <div class="dados dados-entrega">
        <div class="dado">${ic('usuario')}<div><small>Usuário</small><strong class="mono"></strong></div></div>
        <div class="dado">${ic('cadeado')}<div><small>Senha provisória</small><strong class="mono"></strong></div></div>
        <div class="dado inteiro">${ic('link')}<div><small>App DMK Wi-Fi (abrir no celular e "Adicionar à tela inicial")</small><strong class="mono"></strong></div></div>
      </div>`;
    const ss = corpo.querySelectorAll('strong'); ss[0].textContent = usuario; ss[1].textContent = senha; ss[2].textContent = linkApp;
    if (endereco) corpo.append(blocoConexao(endereco));
    const texto = `DMK Wi-Fi - acesso de ${nome}\nApp: ${linkApp}\nUsuário: ${usuario}\nSenha provisória: ${senha}\n(troque a senha no primeiro acesso)`;
    j.rodape.remove();
    const rod = el('<div class="modal-rodape"></div>');
    const cop = el(`<button type="button" class="btn primario">${ic('copiar')}<span>Copiar dados para enviar</span></button>`);
    cop.addEventListener('click', () => copiar(texto));
    rod.append(cop); j.el.querySelector('.modal').append(rod);
  }

  function fichaAvulso(c) {
    if (!c) return novoAvulso();
    const j = abrirJanela({
      icone: 'usuario', titulo: c.nome, sub: `Código ${c.codigo} · ${situacaoAvulso(c).toLowerCase()}`,
      abas: [
        { id: 'roteador', rotulo: 'Roteador', icone: 'roteador', desenhar: roteador },
        { id: 'dados', rotulo: 'Dados', icone: 'usuario', desenhar: dados },
        { id: 'conexao', rotulo: 'Como conectar', icone: 'link', desenhar: (corpo) => { j.rodape.innerHTML = ''; corpo.append(blocoConexao(c.enderecoAcs)); } },
        { id: 'acesso', rotulo: 'Acesso ao app', icone: 'cadeado', desenhar: acesso },
      ],
      rodape: ' ',
    });

    async function roteador(corpo) {
      j.rodape.innerHTML = '';
      corpo.innerHTML = '<p class="fraco">Carregando…</p>';
      let rs;
      try { rs = await api('GET', `../api/central/avulsos/${c.codigo}/roteadores`); } catch (e) { corpo.innerHTML = ''; return tratarErro(e); }
      if (!rs.length) {
        corpo.innerHTML = vazioHtml('Aguardando o roteador', 'Configure o roteador do cliente com o endereço da aba "Como conectar". Em até 5 minutos ele aparece aqui.');
        return;
      }
      const r = rs[0];
      corpo.innerHTML = `<div class="dados">
        <div class="dado">${ic('wifi')}<div><small>Wi-Fi</small><strong></strong></div></div>
        <div class="dado">${ic(r.online ? 'online' : 'offline')}<div><small>Situação</small><strong>${r.online ? 'Online' : 'Offline'} · ${esc(haQuanto(r.ultimoContato))}</strong></div></div>
        <div class="dado">${ic('roteador')}<div><small>Roteador</small><strong>${esc(r.fabricante)} ${esc(r.modelo)}</strong></div></div>
        <div class="dado">${ic('etiqueta')}<div><small>Serial</small><strong class="mono">${esc(r.serial)}</strong></div></div></div>
        <h4 class="secao">Trocar Wi-Fi (suporte)</h4>`;
      corpo.querySelector('strong').textContent = r.ssid || '—';
      const form = el('<form class="form" autocomplete="off"></form>');
      form.append(campo({ rotulo: 'Nome do Wi-Fi', nome: 'ssid', valor: r.ssid, max: 32 }), campo({ rotulo: 'Nova senha do Wi-Fi', nome: 'senha', tipo: 'password', max: 63, placeholder: 'em branco = não muda' }));
      form.addEventListener('submit', (e) => e.preventDefault());
      corpo.append(form);
      const reiniciar = el(`<button type="button" class="btn perigo">${ic('reiniciar')}<span>Reiniciar</span></button>`);
      reiniciar.addEventListener('click', async () => {
        if (!(await confirmar({ titulo: 'Reiniciar o roteador?', texto: `A internet de ${c.nome} cai por 1 a 2 minutos.`, botao: 'Reiniciar agora', perigo: true, icone: 'reiniciar' }))) return;
        try { const x = await api('POST', `../api/central/avulsos/${c.codigo}/roteadores/${encodeURIComponent(r.id)}/reiniciar`); avisar(x.situacao === 'aplicado' ? 'Reinício enviado' : 'Na fila do roteador'); } catch (e) { tratarErro(e); }
      });
      const enviar = el(`<button type="button" class="btn primario">${ic('enviar')}<span>Enviar para o roteador</span></button>`);
      enviar.addEventListener('click', async () => {
        const d = Object.fromEntries(new FormData(form));
        botaoCarregando(enviar, true);
        try { const x = await api('POST', `../api/central/avulsos/${c.codigo}/roteadores/${encodeURIComponent(r.id)}/wifi`, d); avisar(x.situacao === 'aplicado' ? 'Enviado e aplicado' : 'Na fila do roteador', x.situacao === 'aplicado' ? 'O roteador recebeu agora.' : 'Recebe no próximo contato, em até 5 min.'); j.fechar(); carregar(); } catch (e) { botaoCarregando(enviar, false); if (!(e.campo && erroNoCampo(form, e.campo, e.message))) tratarErro(e); }
      });
      j.rodape.append(reiniciar, enviar);
    }

    function dados(corpo) {
      const form = formAvulso(c);
      corpo.append(form);
      j.rodape.innerHTML = '';
      const excluir = el(`<button type="button" class="btn perigo">${ic('lixo')}<span>Excluir</span></button>`);
      excluir.addEventListener('click', async () => {
        if (!(await confirmar({ titulo: `Excluir ${c.nome}?`, texto: 'O cliente perde o acesso ao app. O roteador continua apontando para o endereço dele, mas fica sem dono (aparece em "Sem dono").', botao: 'Excluir cliente', perigo: true, icone: 'lixo' }))) return;
        try { await api('DELETE', `../api/central/avulsos/${c.codigo}`); avisar('Cliente excluído'); j.fechar(); carregar(); } catch (e) { tratarErro(e); }
      });
      const alternar = el(`<button type="button" class="btn ${c.ativo ? 'perigo' : ''}">${ic('ligar')}<span>${c.ativo ? 'Desativar' : 'Ativar'}</span></button>`);
      alternar.addEventListener('click', async () => {
        if (c.ativo && !(await confirmar({ titulo: `Desativar ${c.nome}?`, texto: 'O cliente sai do app na hora e não consegue mais mudar o Wi-Fi. Nada é apagado.', botao: 'Desativar', perigo: true }))) return;
        try { const r = await api('PUT', `../api/central/avulsos/${c.codigo}`, { ativo: !c.ativo }); avisar(r.ativo ? 'Cliente ativado' : 'Cliente desativado', r.nome); j.fechar(); carregar(); } catch (e) { tratarErro(e); }
      });
      const salvar = el(`<button type="button" class="btn primario">${ic('salvar')}<span>Salvar</span></button>`);
      salvar.addEventListener('click', async () => {
        botaoCarregando(salvar, true);
        try { const r = await api('PUT', `../api/central/avulsos/${c.codigo}`, Object.fromEntries(new FormData(form))); avisar('Cliente salvo', r.nome); j.fechar(); carregar(); } catch (e) { botaoCarregando(salvar, false); if (!(e.campo && erroNoCampo(form, e.campo, e.message))) tratarErro(e); }
      });
      j.rodape.append(excluir, alternar, salvar);
    }

    function acesso(corpo) {
      j.rodape.innerHTML = '';
      corpo.innerHTML = `<div class="dados">
        <div class="dado">${ic('usuario')}<div><small>Usuário do app</small><strong class="mono"></strong></div></div>
        <div class="dado">${ic('relogio')}<div><small>Último acesso</small><strong>${esc(c.ultimoAcesso ? dataHora(c.ultimoAcesso) : 'nunca entrou')}</strong></div></div>
        <div class="dado">${ic('cadeado')}<div><small>Senha</small><strong>${c.trocarSenha ? 'provisória (ainda não trocou)' : 'definida pelo cliente'}</strong></div></div>
        <div class="dado">${ic(c.bloqueado ? 'alerta' : 'ok')}<div><small>Bloqueio</small><strong>${c.bloqueado ? 'bloqueado por tentativas erradas' : 'livre'}</strong></div></div></div>
        <p class="fraco">Esqueceu a senha ou está bloqueado? Gere uma senha provisória nova: ela desbloqueia o acesso e o cliente troca no próximo login.</p>`;
      corpo.querySelector('strong').textContent = c.usuario;
      const nova = el(`<button type="button" class="btn primario">${ic('cadeado')}<span>Gerar senha provisória</span></button>`);
      nova.addEventListener('click', async () => {
        if (!(await confirmar({ titulo: 'Gerar senha provisória?', texto: `A senha atual de ${c.nome} deixa de valer e ele sai do app até entrar com a nova.`, botao: 'Gerar' }))) return;
        try { const r = await api('POST', `../api/central/avulsos/${c.codigo}/nova-senha`); j.fechar(); entregarAcesso({ titulo: 'Senha provisória gerada', nome: c.nome, usuario: c.usuario, senha: r.senha }); carregar(); } catch (e) { tratarErro(e); }
      });
      j.rodape.append(nova);
    }

    j.irPara('roteador');
  }

  function novoAvulso() {
    if (!resumo.enderecoAvulsos) {
      avisar('Falta o endereço do ACS', 'Defina primeiro o endereço para clientes avulsos na seção Conexão.', 'erro');
      return irPara('conexao');
    }
    const j = abrirJanela({ icone: 'usuario', titulo: 'Novo cliente avulso', sub: 'Gerenciamento do roteador sem provedor: endereço de ACS próprio + app DMK Wi-Fi.', tamanho: 'medio', corpo: '<div></div>', rodape: ' ' });
    const form = formAvulso(null);
    j.corpo.firstChild.append(form);
    j.rodape.innerHTML = '';
    const salvar = el(`<button type="button" class="btn primario">${ic('salvar')}<span>Cadastrar</span></button>`);
    salvar.addEventListener('click', async () => {
      botaoCarregando(salvar, true);
      try {
        const r = await api('POST', '../api/central/avulsos', Object.fromEntries(new FormData(form)));
        j.fechar(); carregar();
        entregarAcesso({ titulo: 'Cliente cadastrado', nome: r.cliente.nome, usuario: r.cliente.usuario, senha: r.senhaInicial, endereco: r.cliente.enderecoAcs });
      } catch (e) { botaoCarregando(salvar, false); if (!(e.campo && erroNoCampo(form, e.campo, e.message))) tratarErro(e); }
    });
    j.rodape.append(salvar);
    form.querySelector('[name="nome"]').focus();
  }

  // ------------------------------------------------------------ pedir código do autenticador (ações sensíveis)
  function pedirCodigo(titulo, texto, botao, acao) {
    const j = abrirJanela({ icone: 'cadeado', titulo, tamanho: 'pequeno', corpo: '<div></div>', rodape: ' ' });
    const form = el('<form class="form" autocomplete="off"></form>');
    const c = campo({ rotulo: 'Código do app autenticador', nome: 'codigo', max: 6, placeholder: '000000', inteiro: true, ajuda: texto });
    const inp = c.querySelector('input'); inp.inputMode = 'numeric'; inp.classList.add('codigo-6');
    form.append(c);
    j.corpo.firstChild.append(form);
    j.rodape.innerHTML = '';
    const ok = el(`<button type="button" class="btn primario">${ic('ok')}<span></span></button>`);
    ok.querySelector('span').textContent = botao;
    ok.addEventListener('click', async () => {
      botaoCarregando(ok, true);
      try { await acao(inp.value, j); } catch (e) { botaoCarregando(ok, false); if (!(e.campo && erroNoCampo(form, e.campo, e.message))) tratarErro(e); }
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); ok.click(); });
    j.rodape.append(ok);
    inp.focus();
  }

  // ------------------------------------------------------------ Segurança
  async function desenharSeguranca() {
    const alvo = $('[data-sec="seguranca"]');
    let d;
    try { d = await api('GET', '../api/central/seguranca'); } catch (e) { return tratarErro(e); }
    const evento = { entrada: 'Entrou', saida: 'Saiu', 'entrada-recusada': 'Entrada recusada', 'conta-bloqueada': 'Conta bloqueada', 'ip-bloqueado': 'IP bloqueado', 'ip-desbloqueado': 'IP desbloqueado', 'admin-criado': 'Admin criado', 'senha-alterada': 'Senha trocada', 'recuperacao-renovada': 'Códigos de recuperação novos', 'segredo-revelado': 'Segredo do Prisma visto', 'segredo-trocado': 'Segredo do Prisma trocado', 'app-entrada': 'Cliente entrou no app', 'app-entrada-recusada': 'App: entrada recusada', 'app-wifi': 'App: Wi-Fi trocado', 'app-reiniciar': 'App: reiniciou', 'wifi-alterado': 'Wi-Fi trocado', 'roteador-reiniciado': 'Roteador reiniciado', 'provedor-alterado': 'Provedor alterado', 'avulso-criado': 'Cliente avulso criado', 'avulso-nova-senha': 'Senha provisória gerada', 'primeiro-acesso-codigo-errado': 'Primeiro acesso: código errado' };
    const conta = d.conta
      ? `<div class="dados">
          <div class="dado">${ic('usuario')}<div><small>Administrador</small><strong>${esc(d.conta.usuario)}</strong></div></div>
          <div class="dado">${ic('relogio')}<div><small>Último acesso</small><strong>${esc(dataHora(d.conta.ultimoAcesso))}</strong></div></div>
          <div class="dado">${ic('ok')}<div><small>App autenticador</small><strong>ativo</strong></div></div>
          <div class="dado">${ic(d.conta.codigosRestantes < 3 ? 'alerta' : 'cadeado')}<div><small>Códigos de recuperação</small><strong>${d.conta.codigosRestantes} restantes</strong></div></div></div>
         <div class="linha-botoes"><button type="button" class="btn" data-acao="senha">${ic('cadeado')}<span>Trocar senha</span></button><button type="button" class="btn" data-acao="recuperacao">${ic('atualizar')}<span>Novos códigos de recuperação</span></button></div>`
      : `<div class="aviso-caixa">${ic('alerta')}<span>Você entrou pelo DMK Prisma. Para mudar senha e códigos, entre pelo painel com usuário, senha e app autenticador.</span></div>`;
    alvo.innerHTML = `<div class="painel-rolagem">
      <h4 class="secao">Sua conta</h4>${conta}
      <h4 class="secao">Proteções ativas</h4>
      <ul class="lista-protecoes">
        <li>${ic('cadeado')}Senha guardada criptografada (scrypt) e app autenticador na entrada.</li>
        <li>${ic('alerta')}5 erros seguidos bloqueiam a conta por 15 min (dobra a cada novo bloqueio, até 24 h).</li>
        <li>${ic('ip')}10 erros do mesmo IP em 15 min bloqueiam o IP por 1 h (reincidente: 24 h).</li>
        <li>${ic('relogio')}Sessão do painel cai com 30 min sem uso; pedidos de outros sites são recusados.</li>
      </ul>
      <h4 class="secao">IPs bloqueados agora</h4>
      ${d.bloqueados.length ? `<div class="mini-lista"><table><thead><tr><th>IP</th><th>Até</th><th>Motivo</th><th></th></tr></thead><tbody>${d.bloqueados.map((b) => `<tr><td class="mono">${esc(b.ip)}</td><td>${esc(dataHora(b.ate))}</td><td>${esc(b.motivo)}</td><td><button type="button" class="btn" data-desbloquear="${esc(b.ip)}">Desbloquear</button></td></tr>`).join('')}</tbody></table></div>` : vazioHtml('Nenhum IP bloqueado', 'Tudo tranquilo: ninguém insistindo em senha errada.')}
      <h4 class="secao">Registro de acessos (mais recentes)</h4>
      ${d.registros.length ? `<div class="mini-lista"><table><thead><tr><th>Quando</th><th>O que</th><th>Quem / IP</th></tr></thead><tbody>${d.registros.map((r) => `<tr><td>${esc(dataHora(r.quando))}</td><td>${esc(evento[r.evento] || r.evento)}</td><td class="mono">${esc([r.usuario || r.por || r.codigo, r.ip].filter(Boolean).join(' · '))}</td></tr>`).join('')}</tbody></table></div>` : vazioHtml('Sem registros', 'As entradas e ações aparecem aqui.')}
    </div>`;
    alvo.querySelectorAll('[data-desbloquear]').forEach((b) => b.addEventListener('click', async () => {
      try { await api('POST', '../api/central/seguranca/desbloquear', { ip: b.dataset.desbloquear }); avisar('IP desbloqueado', b.dataset.desbloquear); desenharSeguranca(); } catch (e) { tratarErro(e); }
    }));
    alvo.querySelector('[data-acao="senha"]')?.addEventListener('click', trocarSenha);
    alvo.querySelector('[data-acao="recuperacao"]')?.addEventListener('click', () => pedirCodigo('Novos códigos de recuperação', 'Os códigos antigos deixam de valer.', 'Gerar', async (codigo, j) => {
      const r = await api('POST', '../api/central/seguranca/recuperacao', { codigo });
      j.fechar();
      const k = abrirJanela({ icone: 'cadeado', titulo: 'Códigos de recuperação', sub: 'Aparecem só agora. Guarde em lugar seguro.', tamanho: 'pequeno', corpo: `<div class="codigos-rec">${r.codigos.map((x) => `<code>${esc(x)}</code>`).join('')}</div>`, rodape: ' ' });
      k.rodape.innerHTML = '';
      const cp = el(`<button type="button" class="btn primario">${ic('copiar')}<span>Copiar todos</span></button>`);
      cp.addEventListener('click', () => copiar(r.codigos.join('\n')));
      k.rodape.append(cp);
      desenharSeguranca();
    }));
  }

  function trocarSenha() {
    const j = abrirJanela({ icone: 'cadeado', titulo: 'Trocar senha', sub: 'Depois de trocar, todas as sessões saem e você entra de novo.', tamanho: 'medio', corpo: '<div></div>', rodape: ' ' });
    const form = el('<form class="form" autocomplete="off"></form>');
    form.append(
      campo({ rotulo: 'Senha atual', nome: 'atual', tipo: 'password', max: 128, inteiro: true }),
      campo({ rotulo: 'Senha nova', nome: 'nova', tipo: 'password', max: 128, ajuda: 'Mínimo 10, misturando maiúsculas, minúsculas, números e símbolos.' }),
      campo({ rotulo: 'Confirmar senha nova', nome: 'confirmar', tipo: 'password', max: 128 }),
      campo({ rotulo: 'Código do app autenticador', nome: 'codigo', max: 6, placeholder: '000000' }),
    );
    form.querySelector('[name="codigo"]').inputMode = 'numeric';
    form.addEventListener('submit', (e) => e.preventDefault());
    j.corpo.firstChild.append(form);
    j.rodape.innerHTML = '';
    const ok = el(`<button type="button" class="btn primario">${ic('salvar')}<span>Trocar senha</span></button>`);
    ok.addEventListener('click', async () => {
      botaoCarregando(ok, true);
      try { await api('POST', '../api/central/seguranca/senha', Object.fromEntries(new FormData(form))); avisar('Senha trocada', 'Entre de novo com a senha nova.'); setTimeout(() => { location.href = '../admin/'; }, 1500); } catch (e) { botaoCarregando(ok, false); if (!(e.campo && erroNoCampo(form, e.campo, e.message))) tratarErro(e); }
    });
    j.rodape.append(ok);
  }

  // ------------------------------------------------------------ Conexão
  async function desenharConexao() {
    const alvo = $('[data-sec="conexao"]');
    let d;
    try { d = await api('GET', '../api/central/integracao'); } catch (e) { return tratarErro(e); }
    alvo.innerHTML = `<div class="painel-rolagem">
      <h4 class="secao">Endereço do ACS para clientes avulsos</h4>
      <p class="fraco">Domínio da DMK apontando para a VPS (ex.: acs.dmksolutions.io). Cada cliente avulso recebe este endereço + /c/CÓDIGO. Mudar depois obriga a reconfigurar os roteadores dos clientes avulsos.</p>
      <form class="form" data-form-endereco autocomplete="off"></form>
      <div class="linha-botoes"><button type="button" class="btn primario" data-salvar-endereco>${ic('salvar')}<span>Salvar endereço</span></button></div>
      <h4 class="secao">DMK Prisma</h4>
      <p class="fraco">O DMK Prisma usa a chave de integração para liberar provedores e abrir os módulos. Ela fica guardada no servidor (${esc(d.arquivo)}).</p>
      <div class="dados">
        <div class="dado">${ic('cadeado')}<div><small>Chave de integração</small><strong class="mono">••••••••${esc(d.segredoFinal)}</strong></div></div>
        <div class="dado">${ic('link')}<div><small>Endereço interno do painel (para o Prisma)</small><strong class="mono">${esc(d.endereco)}</strong></div></div></div>
      <div class="linha-botoes"><button type="button" class="btn" data-revelar>${ic('olho')}<span>Mostrar chave</span></button><button type="button" class="btn perigo" data-trocar>${ic('atualizar')}<span>Gerar chave nova</span></button></div>
    </div>`;
    const form = alvo.querySelector('[data-form-endereco]');
    form.append(campo({ rotulo: 'Endereço base', nome: 'enderecoAvulsos', valor: resumo?.enderecoAvulsos || '', placeholder: 'acs.dmksolutions.io', inteiro: true }));
    form.addEventListener('submit', (e) => e.preventDefault());
    alvo.querySelector('[data-salvar-endereco]').addEventListener('click', async () => {
      try { const r = await api('PUT', '../api/central/config', Object.fromEntries(new FormData(form))); avisar('Endereço salvo', r.enderecoAvulsos); carregar(); } catch (e) { if (!(e.campo && erroNoCampo(form, e.campo, e.message))) tratarErro(e); }
    });
    const mostrarChave = (titulo, segredo) => {
      const k = abrirJanela({ icone: 'cadeado', titulo, sub: 'Cole na configuração do ACS no DMK Prisma. Não envie por chat.', tamanho: 'medio', corpo: `<div class="codigo"><code></code><button type="button" class="fantasma" aria-label="Copiar">${ic('copiar')}</button></div>` });
      k.corpo.querySelector('code').textContent = segredo;
      k.corpo.querySelector('button').addEventListener('click', () => copiar(segredo));
    };
    alvo.querySelector('[data-revelar]').addEventListener('click', () => pedirCodigo('Mostrar chave de integração', 'Confirme com o app autenticador.', 'Mostrar', async (codigo, j) => {
      const r = await api('POST', '../api/central/integracao/revelar', { codigo }); j.fechar(); mostrarChave('Chave de integração', r.segredo);
    }));
    alvo.querySelector('[data-trocar]').addEventListener('click', async () => {
      if (!(await confirmar({ titulo: 'Gerar chave nova?', texto: 'A chave atual para de valer na hora: o DMK Prisma só volta a abrir o módulo depois que você colar a chave nova nele.', botao: 'Gerar chave nova', perigo: true }))) return;
      pedirCodigo('Gerar chave nova', 'Confirme com o app autenticador.', 'Gerar', async (codigo, j) => {
        const r = await api('POST', '../api/central/integracao/novo', { codigo }); j.fechar(); mostrarChave('Chave nova de integração', r.segredo); desenharConexao();
      });
    });
  }

  // ------------------------------------------------------------ botões da barra
  $('[data-novo]').addEventListener('click', () => (secao === 'avulsos' ? novoAvulso() : fichaProvedor(null)));
  $('[data-atualizar]').addEventListener('click', () => { carregar(true); if (secao === 'seguranca') desenharSeguranca(); if (secao === 'conexao') desenharConexao(); });
  $('[data-sair]').addEventListener('click', async () => { try { await api('POST', '../api/acesso/sair'); } catch { /* sai mesmo assim */ } location.href = '../admin/'; });
  $('[data-ajuda]').addEventListener('click', () => comoFunciona('Como funciona o DMK ACS', `
    <ol class="passos">
      <li><strong>Provedores</strong>: cada um tem o seu endereço de ACS (ex.: acs.starnet.com.br) e só vê os roteadores configurados com ele. Ative ou desative o módulo de cada um.</li>
      <li><strong>Clientes avulsos</strong>: gerenciamento sem provedor. O cliente recebe um endereço com código próprio (…/c/CÓDIGO) e o app DMK Wi-Fi para trocar nome e senha do Wi-Fi.</li>
      <li><strong>Segurança</strong>: sua conta, IPs bloqueados e o registro de acessos.</li>
      <li><strong>Conexão</strong>: endereço dos clientes avulsos e a chave de integração com o DMK Prisma.</li>
      <li><strong>Sem dono</strong>: roteadores que chegaram por um endereço que ninguém usa (configurados errado).</li>
    </ol>`));

  irPara(secao);
  carregar();
  setInterval(() => { if (!document.hidden && !document.querySelector('.fundo-modal')) carregar(); }, 30000);
})();
