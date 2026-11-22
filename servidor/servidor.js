'use strict';
/**
 * DMK ACS - painel de gerenciamento de roteadores (TR-069).
 *
 *   DMK Prisma / admin / cliente --> DMK ACS (este servidor) --NBI--> GenieACS --CWMP--> roteadores
 *
 * Quem entra e por onde:
 *   - Admin DMK ......... /admin/  usuário + senha + app autenticador (painel público)  -> /central/
 *                         ou pelo DMK Prisma (ticket assinado)                          -> /central/
 *   - Provedor .......... pelo DMK Prisma (ticket)                                      -> /provedor/
 *   - Cliente avulso .... /app/    usuário + senha (app instalável no celular)
 *
 * Organização do código:
 *   servidor.js ............ núcleo: configuração, HTTP, cookies, sessão, anti-CSRF, roteadores
 *   rotas/acesso.js ........ login do admin (primeiro acesso, senha, autenticador), sair
 *   rotas/central.js ....... painel do admin: provedores, clientes avulsos, segurança, conexão Prisma
 *   rotas/provedor.js ...... módulo do provedor
 *   rotas/app.js ........... app do cliente avulso
 *   rotas/integracao.js .... API servidor-a-servidor do DMK Prisma (+ entrada da simulação)
 *   lib/ ................... GenieACS (nbi, scripts), segurança, contas, provedores, QR, sessão
 *
 * Configuração (variáveis de ambiente):
 *   DMK_ACS_PORTA (7580)  DMK_ACS_INTERFACE (127.0.0.1)  DMK_ACS_NBI (http://127.0.0.1:7557)
 *   DMK_ACS_DADOS (<raiz>/dados)  DMK_ACS_MODO ('producao' | 'simulacao')  DMK_ACS_ONLINE_MIN (11)
 *   DMK_ACS_MOLDURA (origens que podem embutir o painel; padrão 'self')
 *   DMK_ACS_PROXY=1 (atrás do nginx: confia no X-Real-IP / X-Forwarded-* vindos de 127.0.0.1)
 *   DMK_ACS_ENDERECO_AVULSOS (endereço base do ACS para clientes avulsos, ex. http://acs.dmk.com.br:7547)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { criarNbi } = require('./lib/nbi');
const { criarArmazenamento, Erro400 } = require('./lib/armazenamento');
const { criarSessoes } = require('./lib/sessao');
const { criarContas } = require('./lib/contas');
const seg = require('./lib/seguranca');
const scripts = require('./lib/scripts-genieacs');

const RAIZ = path.resolve(__dirname, '..');
const VERSAO = (() => { try { return fs.readFileSync(path.join(RAIZ, 'VERSION'), 'utf8').trim(); } catch { return '0.0.0'; } })();
const CFG = {
  porta: Number(process.env.DMK_ACS_PORTA || 7580),
  interface: process.env.DMK_ACS_INTERFACE || '127.0.0.1',
  nbi: process.env.DMK_ACS_NBI || 'http://127.0.0.1:7557',
  dados: path.resolve(process.env.DMK_ACS_DADOS || path.join(RAIZ, 'dados')),
  simulacao: process.env.DMK_ACS_MODO === 'simulacao',
  onlineMin: Number(process.env.DMK_ACS_ONLINE_MIN || 11),
  moldura: process.env.DMK_ACS_MOLDURA || "'self'",
  proxy: process.env.DMK_ACS_PROXY === '1',
  enderecoAvulsos: process.env.DMK_ACS_ENDERECO_AVULSOS || '',
};
const PUBLICO = path.join(__dirname, 'publico');
fs.mkdirSync(CFG.dados, { recursive: true });

function log(m) { console.log(`${new Date().toISOString()} ${m}`); }

// ---------------------------------------------------------------- segredos guardados em <dados>
function lerOuCriar(nome, gerar) {
  const arq = path.join(CFG.dados, nome);
  try { return fs.readFileSync(arq, 'utf8').trim(); } catch { /* cria abaixo */ }
  const novo = gerar();
  fs.writeFileSync(arq, novo, { mode: 0o600 });
  return novo;
}
const lerSegredo = () => lerOuCriar('segredo-integracao.txt', () => crypto.randomBytes(32).toString('hex'));

const nbi = criarNbi(CFG.nbi);
const banco = criarArmazenamento(CFG.dados);
const contas = criarContas(CFG.dados);
const guarda = seg.criarGuarda(CFG.dados);
const sessoes = criarSessoes(lerSegredo());

// Primeiro acesso: enquanto não existe admin, só quem tem este código (no servidor) cria o primeiro.
// Impede que um estranho que ache o painel na internet crie a conta antes de você.
function codigoPrimeiroAcesso() {
  if (contas.temAdmin()) return null;
  return lerOuCriar('primeiro-acesso.txt', () => `${seg.aleatorio(4)}-${seg.aleatorio(4)}-${seg.aleatorio(4)}`);
}
codigoPrimeiroAcesso();   // já deixa o arquivo pronto ao carregar (enquanto não existe admin)

// ---------------------------------------------------------------- GenieACS: scripts do DMK
const estadoAcs = { scriptsOk: false, erro: '' };
async function instalarScriptsNoAcs() {
  try {
    // Básico do GenieACS: só cria o que falta (VPS nova); nunca sobrescreve
    for (const [nome, s] of Object.entries(scripts.BASE.provisions)) if (!(await nbi.existe('provisions', nome))) { await nbi.gravarProvision(nome, s); log(`GenieACS: provision básica "${nome}" criada.`); }
    for (const [nome, p] of Object.entries(scripts.BASE.presets)) if (!(await nbi.existe('presets', nome))) { await nbi.gravarPreset(nome, p); log(`GenieACS: preset básico "${nome}" criado.`); }
    // Do DMK: sempre regravados (versão nova do painel atualiza os scripts dentro do ACS)
    for (const [nome, s] of Object.entries(scripts.VIRTUAIS)) await nbi.gravarVirtual(nome, s);
    await nbi.gravarProvision('dmk', scripts.PROVISION);
    await nbi.gravarPreset('dmk', scripts.PRESET);
    estadoAcs.scriptsOk = true; estadoAcs.erro = '';
    log('Scripts do DMK gravados no GenieACS.');
  } catch (e) {
    estadoAcs.scriptsOk = false; estadoAcs.erro = e.message;
    log('Aviso: ' + e.message + ' (tento de novo em 30 s)');
    setTimeout(instalarScriptsNoAcs, 30e3).unref();
  }
}

// ---------------------------------------------------------------- roteadores (comum a todos os painéis)
const PROJECAO = [
  '_id', '_lastInform', '_registered', '_tags',
  '_deviceId._Manufacturer', '_deviceId._ProductClass', '_deviceId._SerialNumber',
  'VirtualParameters.dmk_pppoe', 'VirtualParameters.dmk_wifi_ssid',
  'VirtualParameters.dmk_wan_ip', 'VirtualParameters.dmk_canal_24', 'VirtualParameters.dmk_canal_5',
  'InternetGatewayDevice.DeviceInfo.SoftwareVersion', 'Device.DeviceInfo.SoftwareVersion',
  'InternetGatewayDevice.ManagementServer.ConnectionRequestURL', 'Device.ManagementServer.ConnectionRequestURL',
];

function valor(doc, caminho) {
  let n = doc;
  for (const parte of caminho.split('.')) { if (n == null) return ''; n = n[parte]; }
  if (n && typeof n === 'object' && '_value' in n) n = n._value;
  return n == null || typeof n === 'object' ? '' : String(n);
}

/**
 * Nome do cliente pelo login PPPoE (lista dos provedores). O DMK Prisma mantém isso pela integração
 * (PUT /api/integracao/provedores/:id/clientes), guardado por provedor em dados/clientes.json:
 *   { "porProvedor": { "starnet": { "joao.silva": "JOÃO DA SILVA" } } }
 * Entradas soltas no topo do arquivo (formato antigo/simulação) valem para todos.
 */
function lerArquivoClientes() {
  try { return JSON.parse(fs.readFileSync(path.join(CFG.dados, 'clientes.json'), 'utf8')) || {}; } catch { return {}; }
}
function lerClientes(provedor) {
  const d = lerArquivoClientes();
  const soltos = Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v === 'string'));
  return provedor ? { ...soltos, ...((d.porProvedor || {})[provedor] || {}) } : soltos;
}
function gravarClientes(provedor, mapa) {
  const d = lerArquivoClientes();
  d.porProvedor = d.porProvedor || {};
  if (mapa) d.porProvedor[provedor] = mapa; else delete d.porProvedor[provedor];
  const arq = path.join(CFG.dados, 'clientes.json');
  fs.writeFileSync(arq + '.tmp', JSON.stringify(d), { mode: 0o600 });
  fs.renameSync(arq + '.tmp', arq);
}

function paraTela(doc, clientes = {}) {
  const ultimo = doc._lastInform ? new Date(doc._lastInform) : null;
  const cr = valor(doc, 'InternetGatewayDevice.ManagementServer.ConnectionRequestURL') || valor(doc, 'Device.ManagementServer.ConnectionRequestURL');
  let ip = '';
  try { ip = cr ? new URL(cr).hostname : ''; } catch { /* sem IP */ }
  const pppoe = valor(doc, 'VirtualParameters.dmk_pppoe');
  const wanIp = valor(doc, 'VirtualParameters.dmk_wan_ip');
  return {
    id: doc._id,
    serial: valor(doc, '_deviceId._SerialNumber'),
    fabricante: valor(doc, '_deviceId._Manufacturer'),
    modelo: valor(doc, '_deviceId._ProductClass'),
    versao: valor(doc, 'InternetGatewayDevice.DeviceInfo.SoftwareVersion') || valor(doc, 'Device.DeviceInfo.SoftwareVersion'),
    pppoe,
    cliente: (pppoe && clientes[pppoe]) || '',
    ssid: valor(doc, 'VirtualParameters.dmk_wifi_ssid'),
    ip: wanIp || ip,   // IP de internet do roteador (WAN); sem ele, o IP de onde o roteador fala com o ACS
    canal24: lerCanal(valor(doc, 'VirtualParameters.dmk_canal_24')),
    canal5: lerCanal(valor(doc, 'VirtualParameters.dmk_canal_5')),
    ultimoContato: ultimo ? ultimo.toISOString() : '',
    online: !!ultimo && Date.now() - ultimo.getTime() < CFG.onlineMin * 60e3,
  };
}

/** Roteadores com a marca (tag) dada, prontos para a tela. */
async function roteadoresDaChave(chave, clientes = lerClientes()) {
  if (!chave) return [];
  const docs = await nbi.dispositivos({ _tags: chave }, PROJECAO);
  return docs.map((d) => paraTela(d, clientes));
}

/** Confere que o roteador tem MESMO essa marca antes de qualquer comando. */
async function roteadorDaChave(chave, id) {
  const [doc] = chave ? await nbi.dispositivos({ _id: id, _tags: chave }, ['_id']) : [];
  if (!doc) throw Object.assign(new Error('Roteador não encontrado nesta conta.'), { status: 404 });
  return doc._id;
}

function validarWifi(ssid, senha) {
  ssid = String(ssid ?? '').trim();
  senha = String(senha ?? '');
  if (ssid.length < 1 || ssid.length > 32) throw new Erro400('O nome do Wi-Fi precisa ter de 1 a 32 caracteres.', 'ssid');
  if (!/^[\x20-\x7E]+$/.test(ssid)) throw new Erro400('Use no nome do Wi-Fi só letras sem acento, números e símbolos comuns.', 'ssid');
  if (senha && (senha.length < 8 || senha.length > 63)) throw new Erro400('A senha do Wi-Fi precisa ter de 8 a 63 caracteres.', 'senha');
  if (senha && !/^[\x20-\x7E]+$/.test(senha)) throw new Erro400('Use na senha só letras sem acento, números e símbolos comuns.', 'senha');
  return { ssid, senha };
}

// ---------------------------------------------------------------- canal do Wi-Fi
// Valor do parâmetro virtual: "auto|<atual>|<possíveis>" ou "<n>|<n>|<possíveis>"; "" = sem essa faixa.
const CANAIS_PADRAO = {
  24: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  5: [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 149, 153, 157, 161, 165],
};
function listaDeCanais(texto) {
  const r = [];
  for (const parte of String(texto || '').split(/[,\s]+/)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(parte);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let n = a; n <= b && r.length < 64; n++) r.push(n);
  }
  return [...new Set(r)].sort((x, y) => x - y);
}
function lerCanal(v) {
  if (!v) return null;
  // Logo depois de gravar o valor é só "auto" ou "<n>"; o formato completo volta na próxima leitura
  if (!String(v).includes('|')) return { auto: v === 'auto', canal: v === 'auto' ? null : Number(v) || null, possiveis: [] };
  const [cfg, atual, possiveis] = String(v).split('|');
  return { auto: cfg === 'auto', canal: Number(atual) || null, possiveis: listaDeCanais(possiveis) };
}
/** Confere o canal pedido: "auto" ou um canal que o roteador aceita (ou o padrão do Brasil para a faixa). */
function validarCanal(faixa, canal, atual) {
  faixa = String(faixa);
  if (!['24', '5'].includes(faixa)) throw new Erro400('Faixa inválida: use 24 (2,4 GHz) ou 5 (5 GHz).', 'faixa');
  if (String(canal) === 'auto') return 'auto';
  const n = Number(canal);
  const validos = (atual && atual.possiveis.length ? atual.possiveis : CANAIS_PADRAO[faixa]).filter((x) => (faixa === '5' ? x >= 36 : x <= 14));
  if (!Number.isInteger(n) || !validos.includes(n)) throw new Erro400(`Canal inválido para ${faixa === '5' ? '5' : '2,4'} GHz. Use: automático ou ${validos.join(', ')}.`, 'canal');
  return n;
}
async function canalAtual(id, faixa) {
  const [doc] = await nbi.dispositivos({ _id: id }, ['_id', `VirtualParameters.dmk_canal_${faixa}`]);
  return doc ? lerCanal(valor(doc, `VirtualParameters.dmk_canal_${faixa}`)) : null;
}
const trocarCanal = (id, faixa, canal) => nbi.tarefa(id, { name: 'setParameterValues', parameterValues: [[`VirtualParameters.dmk_canal_${faixa}`, String(canal), 'xsd:string']] });

/** Lê do roteador a lista de aparelhos conectados (sob pedido: é pesada) e devolve a lista guardada. */
async function lerAparelhos(id) {
  const situacao = await nbi.tarefa(id, { name: 'getParameterValues', parameterNames: ['VirtualParameters.dmk_aparelhos'] });
  const [doc] = await nbi.dispositivos({ _id: id }, ['_id', 'VirtualParameters.dmk_aparelhos']);
  const n = doc && doc.VirtualParameters && doc.VirtualParameters.dmk_aparelhos;
  let lista = [];
  try { lista = JSON.parse((n && n._value) || '[]'); } catch { lista = []; }
  const CONEXAO = { 24: 'Wi-Fi 2,4 GHz', 5: 'Wi-Fi 5 GHz', wifi: 'Wi-Fi', cabo: 'Cabo' };
  const aparelhos = (Array.isArray(lista) ? lista : []).map((a) => ({
    nome: String(a.n || ''), mac: String(a.m || '').toUpperCase(), ip: String(a.i || ''),
    conexao: CONEXAO[a.c] || 'Wi-Fi', wifi: a.c !== 'cabo',
  })).sort((a, b) => (b.wifi - a.wifi) || (!a.nome - !b.nome) || a.nome.localeCompare(b.nome) || a.ip.localeCompare(b.ip, 'en', { numeric: true }));   // Wi-Fi primeiro; sem nome no fim
  return { situacao, lidoEm: n && n._timestamp ? new Date(n._timestamp).toISOString() : '', aparelhos };
}

async function trocarWifi(id, { ssid, senha }) {
  const valores = [['VirtualParameters.dmk_wifi_ssid', ssid, 'xsd:string']];
  if (senha) valores.push(['VirtualParameters.dmk_wifi_senha', senha, 'xsd:string']);
  return nbi.tarefa(id, { name: 'setParameterValues', parameterValues: valores });
}
const reiniciar = (id) => nbi.tarefa(id, { name: 'reboot' });
async function lerAgora(id, provedor) {
  const situacao = await nbi.tarefa(id, { name: 'getParameterValues', parameterNames: ['VirtualParameters.dmk_pppoe', 'VirtualParameters.dmk_wifi_ssid', 'VirtualParameters.dmk_wan_ip', 'VirtualParameters.dmk_canal_24', 'VirtualParameters.dmk_canal_5'] });
  const [doc] = await nbi.dispositivos({ _id: id }, PROJECAO);
  return { situacao, roteador: doc ? paraTela(doc, lerClientes(provedor)) : null };
}

// Endereço do ACS de um cliente avulso: <base>/c/<CÓDIGO>
function enderecoAvulso(codigo) {
  const base = (contas.config().enderecoAvulsos || CFG.enderecoAvulsos || '').replace(/\/+$/, '');
  return base ? `${base}/c/${codigo}` : '';
}
const chaveAvulso = (codigo) => scripts.chaveDoEndereco(enderecoAvulso(codigo));
const chaveProvedor = (p) => scripts.chaveDoEndereco(p.enderecoAcs);

// ---------------------------------------------------------------- HTTP: respostas, arquivos, corpo
const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const SEGURANCA = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors ${CFG.moldura}; base-uri 'none'; form-action 'self'`,
};

const ehHttps = (req) => (CFG.proxy && req.headers['x-forwarded-proto'] === 'https') || !!req.socket.encrypted;
function cabecalhosSeguranca(req) {
  return ehHttps(req) ? { ...SEGURANCA, 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : SEGURANCA;
}

function enviar(res, status, corpo, cabecalhos = {}) {
  const dados = typeof corpo === 'string' || Buffer.isBuffer(corpo) ? corpo : JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': typeof corpo === 'object' && !Buffer.isBuffer(corpo) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...cabecalhos,
  });
  res.end(dados);
}

function arquivo(req, res, nome) {
  const alvo = path.join(PUBLICO, nome);
  if (!alvo.startsWith(PUBLICO + path.sep)) return enviar(res, 404, 'Não encontrado');
  fs.readFile(alvo, (e, dados) => {
    if (e) return enviar(res, 404, 'Não encontrado');
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(alvo)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...cabecalhosSeguranca(req) });
    res.end(dados);
  });
}

function lerCorpo(req, limite = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let tam = 0; const partes = [];
    req.on('data', (c) => { tam += c.length; if (tam > limite) { reject(new Erro400('Pedido grande demais.')); req.destroy(); } else partes.push(c); });
    req.on('end', () => {
      if (!partes.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(partes).toString('utf8'))); } catch { reject(new Erro400('JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

/** IP real de quem pediu. Atrás do nginx (DMK_ACS_PROXY=1) confia no X-Real-IP só se veio da própria máquina. */
function ipDe(req) {
  const direto = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (CFG.proxy && (direto === '127.0.0.1' || direto === '::1')) {
    const real = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (real) return real;
  }
  return direto;
}

// ---------------------------------------------------------------- cookies e sessão
function cookie(req, nome) {
  const m = new RegExp(`(?:^|;\\s*)${nome}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
/** Caminho base do painel (atrás do proxy do DMK Prisma vem em X-Forwarded-Prefix, ex. /modulos/acs). */
const baseDe = (req) => `${CFG.proxy ? String(req.headers['x-forwarded-prefix'] || '').replace(/\/+$/, '') : ''}/`;
function definirCookie(req, nome, valor, { maxAge = null, sameSite = 'Strict' } = {}) {
  return `${nome}=${valor}; Path=${baseDe(req)}; HttpOnly; SameSite=${sameSite}${ehHttps(req) ? '; Secure' : ''}${maxAge != null ? `; Max-Age=${maxAge}` : ''}`;
}

function exigirSessao(req, papel, nomeCookie = 'dmkacs') {
  const s = sessoes.obter(cookie(req, nomeCookie));
  if (!s || s.papel !== papel) throw Object.assign(new Error('Sessão encerrada. Entre de novo.'), { status: 401 });
  return s;
}

// ---------------------------------------------------------------- roteador de URLs
const rotas = [];
const rota = (metodo, padrao, fn) => rotas.push({ metodo, padrao: new RegExp(`^${padrao}$`), fn });

/**
 * Anti-CSRF: pedido que altera algo (POST/PUT/DELETE) vindo de navegador precisa ter Origin igual
 * ao próprio painel. Pedido sem Origin (servidor-a-servidor, curl) passa: esses usam segredo.
 */
function origemConfere(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origem = req.headers.origin;
  if (!origem) return true;
  const host = (CFG.proxy && req.headers['x-forwarded-host']) || req.headers.host;
  try { return new URL(origem).host === host; } catch { return false; }
}

const ctx = {
  CFG, VERSAO, log, nbi, banco, contas, guarda, sessoes, seg, scripts, estadoAcs, Erro400,
  rota, enviar, arquivo, lerCorpo, ipDe, cookie, definirCookie, exigirSessao, lerSegredo, codigoPrimeiroAcesso,
  roteadoresDaChave, roteadorDaChave, validarWifi, trocarWifi, reiniciar, lerAgora, paraTela, lerClientes, gravarClientes, PROJECAO,
  validarCanal, trocarCanal, lerAparelhos, canalAtual,
  enderecoAvulso, chaveAvulso, chaveProvedor,
};

// ---------------------------------------------------------------- páginas
rota('GET', '/', async (req, res) => (CFG.simulacao ? arquivo(req, res, 'simulacao.html') : res.writeHead(303, { Location: 'admin/' }).end()));
// Já com sessão de administrador, a tela de entrada leva direto ao painel; sem sessão, o painel leva à
// entrada (sem piscar a tela vazia). Endereços relativos: funcionam atrás de qualquer prefixo do proxy.
const temSessaoCentral = (req) => { const s = sessoes.obter(cookie(req, 'dmkacs')); return !!(s && s.papel === 'central'); };
rota('GET', '/admin/', async (req, res) => (temSessaoCentral(req)
  ? res.writeHead(303, { Location: '../central/', 'Cache-Control': 'no-store' }).end()
  : arquivo(req, res, 'admin.html')));
rota('GET', '/central/', async (req, res) => (temSessaoCentral(req)
  ? arquivo(req, res, 'central.html')
  : res.writeHead(303, { Location: '../admin/', 'Cache-Control': 'no-store' }).end()));
rota('GET', '/provedor/', async (req, res) => arquivo(req, res, 'provedor.html'));
rota('GET', '/app/', async (req, res) => arquivo(req, res, 'app.html'));
rota('GET', '/app/manifest.webmanifest', async (req, res) => arquivo(req, res, 'app-manifest.webmanifest'));
rota('GET', '/app/sw.js', async (req, res) => arquivo(req, res, 'app-sw.js'));
rota('GET', '/assets/([a-z0-9-]+\\.(?:css|js|svg|png))', async (req, res, m) => arquivo(req, res, 'assets/' + m[1]));
rota('GET', '/saude', async (req, res) => enviar(res, 200, { ok: true, versao: VERSAO, scriptsNoAcs: estadoAcs.scriptsOk, erroAcs: estadoAcs.erro || undefined }));

for (const m of ['acesso', 'central', 'provedor', 'app', 'integracao']) require(`./rotas/${m}`)(ctx);

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (!origemConfere(req)) return enviar(res, 403, { erro: 'Pedido de outra origem recusado.' });
    for (const r of rotas) {
      if (r.metodo !== req.method) continue;
      const m = r.padrao.exec(url.pathname);
      if (m) return await r.fn(req, res, m, url);
    }
    enviar(res, 404, { erro: 'Não encontrado.' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500 && status !== 502 && status !== 504) log(`ERRO ${req.method} ${url.pathname}: ${e.stack || e.message}`);
    if (!res.headersSent) enviar(res, status, { erro: status >= 500 && !e.status ? 'Erro interno. Tente de novo.' : e.message, campo: e.campo, desativado: e.desativado || undefined, reiniciar: e.reiniciar || undefined });
  }
});

if (require.main === module) {
  servidor.listen(CFG.porta, CFG.interface, () => {
    log(`DMK ACS ${VERSAO} no ar em http://${CFG.interface}:${CFG.porta}/ (ACS NBI ${CFG.nbi}${CFG.simulacao ? ', MODO SIMULAÇÃO' : ''})`);
    const codigo = codigoPrimeiroAcesso();
    if (codigo) log(`PRIMEIRO ACESSO: abra /admin/ e use o código ${codigo} (também em ${path.join(CFG.dados, 'primeiro-acesso.txt')}).`);
    instalarScriptsNoAcs();
  });
}

module.exports = { servidor, CFG, instalarScriptsNoAcs };
