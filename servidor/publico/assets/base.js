/* DMK ACS - componentes compartilhados das telas (padrão DMK Prisma).
   Nada de componente nativo do navegador: seletor, confirmação e avisos são deste arquivo. */
'use strict';

// ------------------------------------------------------------------ utilidades
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

const ICONES = {
  roteador: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 16.5h.01M11 16.5h.01M8 9a6 6 0 0 1 8 0M5.5 6.5a9.5 9.5 0 0 1 13 0"/>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a14.5 14.5 0 0 1 20 0"/><path d="M12 19.5h.01"/>',
  provedor: '<path d="M3 21h18M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/>',
  online: '<path d="M22 12h-4l-3 8L9 4l-3 8H2"/>',
  offline: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  pesquisar: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  filtros: '<path d="M3 5h18l-7 8.5V20l-4-2v-4.5z"/>',
  atualizar: '<path d="M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  ajuda: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5v.7M12 17h.01"/>',
  fechar: '<path d="M6 6l12 12M18 6 6 18"/>',
  abaixo: '<path d="m6 9 6 6 6-6"/>',
  esq: '<path d="m15 18-6-6 6-6"/>',
  dir: '<path d="m9 18 6-6-6-6"/>',
  reiniciar: '<path d="M12 3v6M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  copiar: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  olho: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  cadeado: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  usuario: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  relogio: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  ip: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  etiqueta: '<path d="M20 12 12 20 4 12V4h8z"/><path d="M8 8h.01"/>',
  lixo: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  ligar: '<path d="M12 3v9"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>',
  salvar: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7M8 21v-7h8v7"/>',
  enviar: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  ok: '<path d="m5 12 5 5L20 7"/>',
  alerta: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  sol: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  lua: '<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z"/>',
  sair: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>',
};
const ic = (nome, extra = '') => `<svg class="i ${extra}" viewBox="0 0 24 24" aria-hidden="true">${ICONES[nome] || ''}</svg>`;

// Ilustração de lista vazia ("está tudo certo"). Cores pelo CSS (.ilu .*), acompanham o tema.
const ILU_VAZIO = `<svg class="ilu" viewBox="0 0 132 104" aria-hidden="true">
  <ellipse class="sombra" cx="66" cy="94" rx="46" ry="6"/>
  <rect class="caixa" x="26" y="50" width="80" height="34" rx="8"/>
  <circle class="led" cx="44" cy="67" r="3"/><circle class="led fraco" cx="56" cy="67" r="3"/>
  <path class="ondas" d="M50 38a22 22 0 0 1 32 0M42 30a33 33 0 0 1 48 0"/>
  <circle class="selo" cx="98" cy="30" r="13"/>
  <path class="visto" d="m92 30 4 4 8-8"/>
</svg>`;
// Bloqueio (módulo desativado / sessão encerrada): o mesmo roteador com cadeado no lugar do visto
const ILU_BLOQUEIO = ILU_VAZIO.replace(/<circle class="selo"[^>]*\/>\s*<path class="visto"[^>]*\/>/,
  '<path class="cadeado-arco" d="M93 27v-4a5 5 0 0 1 10 0v4"/><rect class="cadeado" x="89" y="27" width="18" height="14" rx="3"/>');
const vazioHtml = (titulo, texto, tipo = 'ok') => `<div class="vazio"><div>${tipo === 'bloqueio' ? ILU_BLOQUEIO : ILU_VAZIO}<h3>${esc(titulo)}</h3><p>${esc(texto)}</p></div></div>`;

/** Troca os marcadores data-icone da página pelos ícones (chip mantém o fundo, o resto vira o ícone). */
function iconesDaPagina() {
  document.querySelectorAll('[data-icone]').forEach((s) => {
    if (s.classList.contains('chip-icone')) s.innerHTML = ic(s.dataset.icone);
    else s.replaceWith(el(ic(s.dataset.icone)));
  });
}

// ------------------------------------------------------------------ tema claro/escuro
const Tema = {
  iniciar(botao) {
    let salvo = null;
    try { salvo = localStorage.getItem('dmkacs-tema'); } catch { /* sem armazenamento */ }
    const escuro = salvo ? salvo === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    this.aplicar(escuro ? 'dark' : 'light', botao);
    botao?.addEventListener('click', () => {
      const novo = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('dmkacs-tema', novo); } catch { /* ignora */ }
      this.aplicar(novo, botao);
    });
  },
  aplicar(t, botao) {
    document.documentElement.dataset.theme = t;
    if (botao) { botao.innerHTML = ic(t === 'dark' ? 'sol' : 'lua'); botao.title = t === 'dark' ? 'Tema claro' : 'Tema escuro'; }
  },
};

// ------------------------------------------------------------------ sons e avisos
const Som = (() => {
  let ctx = null;
  function tocar(notas) {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      let t = ctx.currentTime;
      for (const [freq, dur] of notas) {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.02); t += dur * 0.85;
      }
    } catch { /* sem áudio */ }
  }
  return { ok: () => tocar([[880, 0.09], [1320, 0.14]]), erro: () => tocar([[330, 0.16], [247, 0.22]]) };
})();

function avisar(titulo, texto = '', tipo = 'ok') {
  let caixa = $('.avisos');
  if (!caixa) { caixa = el('<div class="avisos" role="status" aria-live="polite"></div>'); document.body.append(caixa); }
  const a = el(`<div class="aviso ${tipo === 'erro' ? 'erro' : ''}">${ic(tipo === 'erro' ? 'alerta' : 'ok')}<div><strong>${esc(titulo)}</strong>${texto ? `<span class="fraco">${esc(texto)}</span>` : ''}</div></div>`);
  caixa.append(a);
  (tipo === 'erro' ? Som.erro : Som.ok)();
  setTimeout(() => a.remove(), tipo === 'erro' ? 7000 : 4500);
}

// ------------------------------------------------------------------ API
class ErroApi extends Error {}
async function api(metodo, caminho, corpo) {
  let r;
  try {
    r = await fetch(caminho, { method: metodo, headers: corpo ? { 'Content-Type': 'application/json' } : {}, body: corpo ? JSON.stringify(corpo) : undefined, credentials: 'same-origin' });
  } catch { throw new ErroApi('Sem conexão com o servidor do DMK ACS.'); }
  let dados = null;
  try { dados = await r.json(); } catch { /* sem corpo */ }
  if (!r.ok) {
    const e = new ErroApi(dados?.erro || `Erro ${r.status}`);
    Object.assign(e, { status: r.status, campo: dados?.campo, desativado: dados?.desativado });
    throw e;
  }
  return dados;
}

// ------------------------------------------------------------------ datas
function haQuanto(iso) {
  if (!iso) return 'nunca';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} d`;
}
const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

// ------------------------------------------------------------------ menu flutuante / seletor próprio
// O menu nasce no <body> com posição fixa: nunca é cortado pelo overflow da barra ou do modal.
let menuAberto = null;
function fecharMenu() { menuAberto?.remove(); menuAberto = null; }
document.addEventListener('pointerdown', (e) => { if (menuAberto && !menuAberto.contains(e.target) && !e.target.closest('[data-abre-menu]')) fecharMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharMenu(); });
window.addEventListener('resize', fecharMenu);

function abrirMenu(botao, opcoes, atual, escolher) {
  if (menuAberto && menuAberto._dono === botao) return fecharMenu();
  fecharMenu();
  const m = el('<div class="menu-flutuante" role="listbox"></div>');
  m._dono = botao;
  for (const o of opcoes) {
    const b = el(`<button type="button" role="option" class="${String(o.valor) === String(atual) ? 'ativo' : ''}">${esc(o.rotulo)}</button>`);
    b.addEventListener('click', () => { fecharMenu(); escolher(o.valor); });
    m.append(b);
  }
  document.body.append(m);
  const r = botao.getBoundingClientRect();
  m.style.minWidth = `${r.width}px`;
  const altura = Math.min(m.scrollHeight, 240);
  const embaixo = window.innerHeight - r.bottom > altura + 8;
  m.style.left = `${Math.min(r.left, window.innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${embaixo ? r.bottom + 4 : r.top - altura - 4}px`;
  menuAberto = m;
  (m.querySelector('.ativo') || m.firstElementChild)?.focus();
}

/** Seletor no padrão do sistema. opcoes: [{valor, rotulo}] */
function seletor(opcoes, valor, aoMudar, classe = '') {
  const b = el(`<button type="button" class="btn seletor ${classe}" data-abre-menu aria-haspopup="listbox"><span class="rot"></span>${ic('abaixo')}</button>`);
  const api = {
    el: b, valor,
    definir(v) { api.valor = v; b.querySelector('.rot').textContent = (opcoes.find((o) => String(o.valor) === String(v)) || {}).rotulo ?? ''; },
    opcoes(novas) { opcoes = novas; api.definir(api.valor); },
  };
  api.definir(valor);
  b.addEventListener('click', () => abrirMenu(b, opcoes, api.valor, (v) => { api.definir(v); aoMudar?.(v); }));
  return api;
}

// ------------------------------------------------------------------ janelas
function abrirJanela({ icone = 'roteador', titulo, sub = '', tamanho = '', abas = null, corpo = '', rodape = '', fixa = false }) {
  const f = el(`<div class="fundo-modal"><div class="modal ${tamanho}" role="dialog" aria-modal="true">
    <div class="modal-topo"><span class="chip-icone">${ic(icone)}</span><div class="titulos"><h2></h2><p></p></div>
      <button type="button" class="fantasma" data-fechar aria-label="Fechar">${ic('fechar')}</button></div>
    ${abas ? '<div class="abas" role="tablist"></div>' : ''}
    <div class="modal-corpo"></div>
    <div class="modal-rodape"></div></div></div>`);
  f.querySelector('h2').textContent = titulo;
  f.querySelector('.modal-topo p').textContent = sub;
  if (!sub) f.querySelector('.modal-topo p').remove();
  const corpoEl = f.querySelector('.modal-corpo');
  const rodapeEl = f.querySelector('.modal-rodape');
  if (typeof corpo === 'string') corpoEl.innerHTML = corpo; else corpoEl.append(corpo);
  if (typeof rodape === 'string') rodapeEl.innerHTML = rodape; else rodapeEl.append(rodape);
  if (!rodape) rodapeEl.remove();
  const janela = {
    el: f, corpo: corpoEl, rodape: rodapeEl,
    fechar() { f.remove(); document.removeEventListener('keydown', tecla); janela.aoFechar?.(); },
    titulo(t, s) { f.querySelector('h2').textContent = t; const p = f.querySelector('.modal-topo p'); if (p && s != null) p.textContent = s; },
  };
  // fixa: janela obrigatória (sem X, não fecha no Esc nem clicando fora), ex.: trocar senha provisória
  const tecla = (e) => { if (!fixa && e.key === 'Escape' && !menuAberto && document.querySelector('.fundo-modal:last-of-type') === f) janela.fechar(); };
  document.addEventListener('keydown', tecla);
  f.addEventListener('pointerdown', (e) => { if (!fixa && e.target === f) janela.fechar(); });
  if (fixa) f.querySelector('[data-fechar]').remove();
  else f.querySelector('[data-fechar]').addEventListener('click', () => janela.fechar());
  if (abas) {
    const barra = f.querySelector('.abas');
    janela.abas = {};
    for (const a of abas) {
      const b = el(`<button type="button" class="aba" role="tab">${ic(a.icone)}<span></span></button>`);
      b.querySelector('span').textContent = a.rotulo;
      b.addEventListener('click', () => janela.irPara(a.id));
      barra.append(b);
      janela.abas[a.id] = { botao: b, ...a };
    }
    janela.irPara = (id) => {
      for (const [k, a] of Object.entries(janela.abas)) a.botao.classList.toggle('ativa', k === id);
      janela.abaAtual = id;
      corpoEl.replaceChildren();
      janela.abas[id].desenhar(corpoEl, janela);
    };
  }
  document.body.append(f);
  return janela;
}

function confirmar({ titulo, texto, botao = 'Confirmar', perigo = false, icone = 'alerta' }) {
  return new Promise((resolve) => {
    let ok = false;
    const j = abrirJanela({ icone, titulo, tamanho: 'pequeno', corpo: '<p></p>', rodape: ' ' });
    j.corpo.querySelector('p').textContent = texto;
    j.rodape.innerHTML = '';
    const cancelar = el('<button type="button" class="btn">Cancelar</button>');
    const sim = el(`<button type="button" class="btn ${perigo ? 'perigo' : 'primario'}"></button>`);
    sim.textContent = botao;
    cancelar.addEventListener('click', () => j.fechar());
    sim.addEventListener('click', () => { ok = true; j.fechar(); });
    j.rodape.append(cancelar, sim);
    j.aoFechar = () => resolve(ok);
    sim.focus();
  });
}

/** "Como funciona": cartão por cima da tela; fecha no X, no Esc ou clicando fora. */
function comoFunciona(titulo, html) {
  abrirJanela({ icone: 'ajuda', titulo, tamanho: 'medio', corpo: html });
}

function botaoCarregando(botao, carregando) {
  botao.disabled = carregando;
  botao.dataset.rotulo ??= botao.innerHTML;
  if (carregando) botao.innerHTML = `${ic('relogio')}<span>Enviando…</span>`;
  else botao.innerHTML = botao.dataset.rotulo;
}

async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); avisar('Copiado'); } catch { avisar('Não consegui copiar', 'Selecione o texto e copie com Ctrl+C.', 'erro'); }
}

// ------------------------------------------------------------------ motor de lista
/**
 * Lista padrão: pesquisa (texto em todas as colunas), UM diálogo de Filtros com comparações por
 * coluna, cabeçalho ordenável, paginação (10..100, até 5 números, ‹ ›). Só redesenha quando os
 * dados mudam, sem perder rolagem, ordenação, pesquisa ou página.
 *
 * colunas: [{id, titulo, valor(l) (texto para pesquisar/ordenar/filtrar), celula(l) (html),
 *            largura, num, opcoes:[valores] (filtro por lista fixa)}]
 */
function criarLista({ cartao, busca, botaoFiltros, colunas, aoAbrir, vazio, chave = (l) => l.id, porPagina = 25 }) {
  const est = { dados: [], texto: '', filtros: [], ordem: { col: colunas[0].id, dir: 1 }, pagina: 1, porPagina, assinatura: '' };
  cartao.innerHTML = `<div class="rolagem"></div><div class="rodape"><span class="info"></span><span class="porpag">Por página <span data-pp></span></span><span class="paginas"></span></div>`;
  const rolagem = cartao.querySelector('.rolagem');
  const ppSel = seletor([10, 25, 50, 100].map((n) => ({ valor: n, rotulo: String(n) })), porPagina, (v) => { est.porPagina = Number(v); est.pagina = 1; desenhar(); });
  cartao.querySelector('[data-pp]').append(ppSel.el);

  busca.addEventListener('input', () => { est.texto = busca.value.trim().toLowerCase(); est.pagina = 1; desenhar(); });
  botaoFiltros.addEventListener('click', () => abrirFiltros());

  const COMP = {
    contem: { rotulo: 'contém', f: (v, x) => v.includes(x) },
    nao_contem: { rotulo: 'não contém', f: (v, x) => !v.includes(x) },
    igual: { rotulo: 'é igual a', f: (v, x) => v === x },
    diferente: { rotulo: 'é diferente de', f: (v, x) => v !== x },
    comeca: { rotulo: 'começa com', f: (v, x) => v.startsWith(x) },
    maior: { rotulo: 'maior que', f: (v, x) => Number(v) > Number(x) },
    menor: { rotulo: 'menor que', f: (v, x) => Number(v) < Number(x) },
  };
  const compDe = (c) => (c.opcoes ? ['igual', 'diferente'] : c.num ? ['igual', 'maior', 'menor'] : ['contem', 'nao_contem', 'igual', 'comeca']);
  const val = (c, l) => String(c.valor(l) ?? '').toLowerCase();

  function filtrados() {
    let r = est.dados;
    if (est.texto) r = r.filter((l) => colunas.some((c) => val(c, l).includes(est.texto)));
    for (const f of est.filtros) {
      const c = colunas.find((x) => x.id === f.col); if (!c) continue;
      const x = String(f.valor ?? '').toLowerCase();
      r = r.filter((l) => COMP[f.comp].f(val(c, l), x));
    }
    const c = colunas.find((x) => x.id === est.ordem.col);
    if (c) r = [...r].sort((a, b) => (c.num ? Number(c.valor(a)) - Number(c.valor(b)) : val(c, a).localeCompare(val(c, b), 'pt-BR', { numeric: true })) * est.ordem.dir);
    return r;
  }

  function desenhar() {
    const lista = filtrados();
    const paginas = Math.max(1, Math.ceil(lista.length / est.porPagina));
    est.pagina = Math.min(est.pagina, paginas);
    const ini = (est.pagina - 1) * est.porPagina;
    const pagina = lista.slice(ini, ini + est.porPagina);
    const topo = rolagem.scrollTop;

    if (!lista.length) {
      const filtrando = est.texto || est.filtros.length;
      rolagem.innerHTML = filtrando ? vazioHtml('Nada encontrado', 'Nenhum registro bate com a pesquisa ou os filtros. Limpe para ver tudo.') : vazioHtml(vazio.titulo, vazio.texto);
    } else {
      const ths = colunas.map((c) => `<th class="${c.num ? 'num' : ''}" data-col="${c.id}" ${c.largura ? `data-largura="${c.largura}"` : ''} title="Ordenar por ${esc(c.titulo)}">${esc(c.titulo)}<span class="seta">${est.ordem.col === c.id ? (est.ordem.dir > 0 ? '▲' : '▼') : ''}</span></th>`).join('');
      const trs = pagina.map((l) => `<tr class="linha" tabindex="0" data-chave="${esc(chave(l))}">${colunas.map((c) => `<td class="${c.num ? 'num' : ''}">${c.celula ? c.celula(l) : esc(c.valor(l))}</td>`).join('')}</tr>`).join('');
      rolagem.innerHTML = `<table><colgroup>${colunas.map((c) => `<col data-largura="${c.largura || ''}">`).join('')}</colgroup><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
      // Largura das colunas pelo CSSOM (a política de segurança não deixa usar style="" no HTML)
      rolagem.querySelectorAll('col').forEach((col) => { if (col.dataset.largura) col.style.width = col.dataset.largura; });
      rolagem.scrollTop = topo;
    }

    const fim = Math.min(ini + est.porPagina, lista.length);
    cartao.querySelector('.info').textContent = lista.length ? `${ini + 1}–${fim} de ${lista.length}` : '0 registros';
    const pg = cartao.querySelector('.paginas');
    pg.innerHTML = '';
    const botao = (rot, alvo, atual = false, desab = false, rotulo = '') => {
      const b = el(`<button type="button" class="pag ${atual ? 'atual' : ''}" ${desab ? 'disabled' : ''} aria-label="${rotulo || 'Página ' + alvo}">${rot}</button>`);
      b.addEventListener('click', () => { est.pagina = alvo; desenhar(); rolagem.scrollTop = 0; });
      pg.append(b);
    };
    botao(ic('esq'), est.pagina - 1, false, est.pagina === 1, 'Página anterior');
    let de = Math.max(1, est.pagina - 2); const ate = Math.min(paginas, de + 4); de = Math.max(1, ate - 4);
    for (let i = de; i <= ate; i++) botao(String(i), i, i === est.pagina);
    botao(ic('dir'), est.pagina + 1, false, est.pagina === paginas, 'Próxima página');

    const n = est.filtros.length;
    botaoFiltros.innerHTML = `${ic('filtros')}<span>Filtros</span>${n ? `<span class="contador">${n}</span>` : ''}`;
  }

  rolagem.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-col]');
    if (th) { const c = th.dataset.col; est.ordem = { col: c, dir: est.ordem.col === c ? -est.ordem.dir : 1 }; desenhar(); return; }
    const tr = e.target.closest('tr.linha');
    if (tr) aoAbrir(est.dados.find((l) => String(chave(l)) === tr.dataset.chave));
  });
  rolagem.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr.linha')) e.target.click(); });

  function abrirFiltros() {
    let rascunho = est.filtros.map((f) => ({ ...f }));
    const j = abrirJanela({ icone: 'filtros', titulo: 'Filtros', sub: 'Mostre só os registros que batem com todas as comparações.', tamanho: 'medio', corpo: '<div data-linhas></div>', rodape: ' ' });
    const linhas = j.corpo.querySelector('[data-linhas]');
    const opcoesCol = colunas.map((c) => ({ valor: c.id, rotulo: c.titulo }));
    function desenharLinhas() {
      linhas.innerHTML = '';
      rascunho.forEach((f, i) => {
        const c = colunas.find((x) => x.id === f.col);
        const linha = el('<div class="filtro-linha"></div>');
        linha.append(seletor(opcoesCol, f.col, (v) => { f.col = v; f.comp = compDe(colunas.find((x) => x.id === v))[0]; f.valor = ''; desenharLinhas(); }).el);
        linha.append(seletor(compDe(c).map((k) => ({ valor: k, rotulo: COMP[k].rotulo })), f.comp, (v) => { f.comp = v; }).el);
        if (c.opcoes) {
          if (!c.opcoes.includes(f.valor)) f.valor = c.opcoes[0];
          linha.append(seletor(c.opcoes.map((o) => ({ valor: o, rotulo: o })), f.valor, (v) => { f.valor = v; }).el);
        } else {
          const inp = el('<input class="campo" placeholder="Valor">');
          inp.value = f.valor; inp.addEventListener('input', () => { f.valor = inp.value; });
          linha.append(inp);
        }
        const rem = el(`<button type="button" class="fantasma" aria-label="Remover comparação">${ic('fechar')}</button>`);
        rem.addEventListener('click', () => { rascunho.splice(i, 1); desenharLinhas(); });
        linha.append(rem);
        linhas.append(linha);
      });
      const add = el(`<button type="button" class="add-comparacao">${ic('mais')}<span>Adicionar comparação</span></button>`);
      add.addEventListener('click', () => { const c = colunas[0]; rascunho.push({ col: c.id, comp: compDe(c)[0], valor: '' }); desenharLinhas(); });
      linhas.append(add);
    }
    if (!rascunho.length) { const c = colunas[0]; rascunho.push({ col: c.id, comp: compDe(c)[0], valor: '' }); }
    desenharLinhas();
    j.rodape.innerHTML = '';
    const limpar = el('<button type="button" class="btn">Limpar</button>');
    const aplicar = el(`<button type="button" class="btn primario">${ic('ok')}<span>Aplicar</span></button>`);
    limpar.addEventListener('click', () => { est.filtros = []; est.pagina = 1; j.fechar(); desenhar(); });
    aplicar.addEventListener('click', () => { est.filtros = rascunho.filter((f) => String(f.valor).trim() !== ''); est.pagina = 1; j.fechar(); desenhar(); });
    j.rodape.append(limpar, aplicar);
  }

  return {
    definir(dados) {
      const assinatura = JSON.stringify(dados);
      if (assinatura === est.assinatura) return;   // nada mudou: não redesenha
      est.assinatura = assinatura; est.dados = dados; desenhar();
    },
    redesenhar: desenhar,
    get dados() { return est.dados; },
  };
}

/** Rótulo + campo no padrão do formulário, com mensagem de erro no próprio campo. */
function campo({ rotulo, nome, valor = '', ajuda = '', tipo = 'text', somenteLeitura = false, placeholder = '', max = 200, inteiro = false }) {
  const r = el(`<label class="rotulo ${inteiro ? 'inteiro' : ''}"><span></span><input class="campo" name="${esc(nome)}" type="${tipo}" maxlength="${max}" autocomplete="off" spellcheck="false"><small class="ajuda"></small></label>`);
  r.querySelector('span').textContent = rotulo;
  const i = r.querySelector('input');
  i.value = valor; i.placeholder = placeholder; i.readOnly = somenteLeitura;
  const s = r.querySelector('small');
  s.textContent = ajuda; if (!ajuda) s.classList.add('oculto');
  i.addEventListener('input', () => { i.classList.remove('erro'); r.querySelector('.msg-erro')?.remove(); });
  return r;
}
function erroNoCampo(form, nome, msg) {
  const i = form.querySelector(`[name="${nome}"]`);
  if (!i) return false;
  i.classList.add('erro'); i.focus();
  const lab = i.closest('.rotulo');
  lab.querySelector('.msg-erro')?.remove();
  const s = el('<small class="msg-erro"></small>'); s.textContent = msg;
  lab.append(s);
  return true;
}

/** Telefone brasileiro: (11) 98888-7777 / (11) 3888-7777; aceita com 55 na frente. */
function telefoneBonito(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}
function mascaraTelefone(input) {
  input.inputMode = 'tel';
  input.addEventListener('input', () => {
    const d = input.value.replace(/\D/g, '').slice(0, 13);
    let v = d;
    if (d.length > 2) v = `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length > 7 && d.length <= 10) v = `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    if (d.length === 11) v = `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length > 11) v = `+${d}`;
    input.value = v;
  });
}

window.DMK = { $, esc, el, ic, iconesDaPagina, abrirMenu, telefoneBonito, mascaraTelefone, Tema, Som, avisar, api, haQuanto, dataHora, seletor, abrirJanela, confirmar, comoFunciona, criarLista, campo, erroNoCampo, botaoCarregando, copiar, vazioHtml };
