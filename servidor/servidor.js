'use strict';
/**
 * DMK ACS - painel de gerenciamento de roteadores (TR-069) por provedor.
 *
 * Fica entre o DMK Prisma e o GenieACS:
 *   DMK Prisma (Central/provedor) --ticket--> DMK ACS (este servidor) --NBI--> GenieACS --CWMP--> roteadores
 *
 * - A Central (admin DMK) cadastra provedores, define o endereço do ACS de cada um e ativa/desativa.
 * - O provedor só enxerga os roteadores que se conectaram no endereço DELE (tag dmk_* posta pelo
 *   provision "dmk" dentro do GenieACS) e só troca Wi-Fi/reinicia esses.
 * - Sem dependências externas: só Node.js (>= 18).
 *
 * Configuração (variáveis de ambiente):
 *   DMK_ACS_PORTA (7580)  DMK_ACS_INTERFACE (127.0.0.1)  DMK_ACS_NBI (http://127.0.0.1:7557)
 *   DMK_ACS_DADOS (<raiz>/dados)  DMK_ACS_MODO ('producao' | 'simulacao')
 *   DMK_ACS_ONLINE_MIN (11)  DMK_ACS_MOLDURA (origens que podem embutir o painel; padrão 'self')
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { criarNbi } = require('./lib/nbi');
const { criarArmazenamento, normalizarEndereco, Erro400 } = require('./lib/armazenamento');
const { criarSessoes } = require('./lib/sessao');
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
};
const PUBLICO = path.join(__dirname, 'publico');

// Segredo de integração (DMK Prisma <-> DMK ACS): gerado uma vez, só nesta máquina.
function lerSegredo() {
  const arq = path.join(CFG.dados, 'segredo-integracao.txt');
  fs.mkdirSync(CFG.dados, { recursive: true });
  try { return fs.readFileSync(arq, 'utf8').trim(); } catch { /* cria abaixo */ }
  const novo = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(arq, novo, { mode: 0o600 });
  return novo;
}

const nbi = criarNbi(CFG.nbi);
const banco = criarArmazenamento(CFG.dados);
const sessoes = criarSessoes(lerSegredo());

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

// ---------------------------------------------------------------- Roteadores
const PROJECAO = [
  '_id', '_lastInform', '_registered', '_tags',
  '_deviceId._Manufacturer', '_deviceId._ProductClass', '_deviceId._SerialNumber',
  'VirtualParameters.dmk_pppoe', 'VirtualParameters.dmk_wifi_ssid',
  'InternetGatewayDevice.DeviceInfo.SoftwareVersion', 'Device.DeviceInfo.SoftwareVersion',
  'InternetGatewayDevice.ManagementServer.ConnectionRequestURL', 'Device.ManagementServer.ConnectionRequestURL',
];

function valor(doc, caminho) {
  let n = doc;
  for (const parte of caminho.split('.')) { if (n == null) return ''; n = n[parte]; }
  if (n && typeof n === 'object' && '_value' in n) n = n._value;
  return n == null || typeof n === 'object' ? '' : String(n);
}

function lerClientes() {
  // Nome do cliente pelo login PPPoE. Na simulação vem de dados/clientes.json; em produção o
  // DMK Prisma manda essa lista pela integração (mesmo arquivo, atualizado por ele).
  try { return JSON.parse(fs.readFileSync(path.join(CFG.dados, 'clientes.json'), 'utf8')); } catch { return {}; }
}

function paraTela(doc, clientes) {
  const ultimo = doc._lastInform ? new Date(doc._lastInform) : null;
  const cr = valor(doc, 'InternetGatewayDevice.ManagementServer.ConnectionRequestURL') || valor(doc, 'Device.ManagementServer.ConnectionRequestURL');
  let ip = '';
  try { ip = cr ? new URL(cr).hostname : ''; } catch { /* sem IP */ }
  const pppoe = valor(doc, 'VirtualParameters.dmk_pppoe');
  return {
    id: doc._id,
    serial: valor(doc, '_deviceId._SerialNumber'),
    fabricante: valor(doc, '_deviceId._Manufacturer'),
    modelo: valor(doc, '_deviceId._ProductClass'),
    versao: valor(doc, 'InternetGatewayDevice.DeviceInfo.SoftwareVersion') || valor(doc, 'Device.DeviceInfo.SoftwareVersion'),
    pppoe,
    cliente: (pppoe && clientes[pppoe]) || '',
    ssid: valor(doc, 'VirtualParameters.dmk_wifi_ssid'),
    ip,
    ultimoContato: ultimo ? ultimo.toISOString() : '',
    online: !!ultimo && Date.now() - ultimo.getTime() < CFG.onlineMin * 60e3,
  };
}

const chaveDe = (p) => scripts.chaveDoEndereco(p.enderecoAcs);

async function roteadoresDoProvedor(p) {
  const docs = await nbi.dispositivos({ _tags: chaveDe(p) }, PROJECAO);
  const clientes = lerClientes();
  return docs.map((d) => paraTela(d, clientes));
}

/** Confere que o roteador é MESMO deste provedor antes de qualquer comando. */
async function roteadorDoProvedor(p, id) {
  const [doc] = await nbi.dispositivos({ _id: id, _tags: chaveDe(p) }, ['_id']);
  if (!doc) throw Object.assign(new Error('Roteador não encontrado neste provedor.'), { status: 404 });
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

async function trocarWifi(id, { ssid, senha }) {
  const valores = [['VirtualParameters.dmk_wifi_ssid', ssid, 'xsd:string']];
  if (senha) valores.push(['VirtualParameters.dmk_wifi_senha', senha, 'xsd:string']);
  return nbi.tarefa(id, { name: 'setParameterValues', parameterValues: valores });
}

// ---------------------------------------------------------------- HTTP
function log(m) { console.log(`${new Date().toISOString()} ${m}`); }

function enviar(res, status, corpo, cabecalhos = {}) {
  const dados = typeof corpo === 'string' || Buffer.isBuffer(corpo) ? corpo : JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': typeof corpo === 'object' && !Buffer.isBuffer(corpo) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...cabecalhos,
  });
  res.end(dados);
}

const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SEGURANCA = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors ${CFG.moldura}; base-uri 'none'; form-action 'self'`,
};

function arquivo(res, nome) {
  const alvo = path.join(PUBLICO, nome);
  if (!alvo.startsWith(PUBLICO + path.sep)) return enviar(res, 404, 'Não encontrado');
  fs.readFile(alvo, (e, dados) => {
    if (e) return enviar(res, 404, 'Não encontrado');
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(alvo)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEGURANCA });
    res.end(dados);
  });
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tam = 0; const partes = [];
    req.on('data', (c) => { tam += c.length; if (tam > 64 * 1024) { reject(new Erro400('Pedido grande demais.')); req.destroy(); } else partes.push(c); });
    req.on('end', () => {
      if (!partes.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(partes).toString('utf8'))); } catch { reject(new Erro400('JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

function cookie(req, nome) {
  const m = new RegExp(`(?:^|;\\s*)${nome}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

function exigirSessao(req, papel) {
  const s = sessoes.obter(cookie(req, 'dmkacs'));
  if (!s || s.papel !== papel) throw Object.assign(new Error('Sessão expirada. Abra o módulo de novo pelo DMK Prisma.'), { status: 401 });
  return s;
}

function provedorAtivo(sessao) {
  const p = banco.obter(sessao.provedor);
  if (!p) throw Object.assign(new Error('Provedor não cadastrado no DMK ACS.'), { status: 403, desativado: true });
  if (!p.ativo) throw Object.assign(new Error('O módulo ACS está desativado para este provedor. Fale com a DMK.'), { status: 403, desativado: true });
  return p;
}

function instrucoes(p) {
  const u = new URL(p.enderecoAcs);
  return {
    enderecoAcs: p.enderecoAcs,
    host: u.hostname,
    porta: u.port || (u.protocol === 'https:' ? '443' : '80'),
    mikrotik: `/tr069-client set enabled=yes acs-url=${p.enderecoAcs} periodic-inform-enabled=yes periodic-inform-interval=5m`,
  };
}

const rotas = [];
const rota = (metodo, padrao, fn) => rotas.push({ metodo, padrao: new RegExp(`^${padrao}$`), fn });

// --- páginas
rota('GET', '/', async (req, res) => (CFG.simulacao ? arquivo(res, 'simulacao.html') : enviar(res, 200, 'DMK ACS ativo. Abra o módulo pelo DMK Prisma.')));
rota('GET', '/central/', async (req, res) => arquivo(res, 'central.html'));
rota('GET', '/provedor/', async (req, res) => arquivo(res, 'provedor.html'));
rota('GET', '/assets/([a-z0-9-]+\\.(?:css|js|svg))', async (req, res, m) => arquivo(res, 'assets/' + m[1]));
rota('GET', '/saude', async (req, res) => enviar(res, 200, { ok: true, versao: VERSAO, scriptsNoAcs: estadoAcs.scriptsOk, erroAcs: estadoAcs.erro || undefined }));

rota('GET', '/entrar', async (req, res, m, url) => {
  const d = sessoes.lerTicket(url.searchParams.get('ticket'));
  if (!d) return enviar(res, 401, 'Link de acesso inválido ou vencido. Abra o módulo de novo pelo DMK Prisma.');
  const token = sessoes.criar(d);
  res.writeHead(303, {
    Location: d.papel === 'central' ? 'central/' : 'provedor/',
    'Set-Cookie': `dmkacs=${token}; HttpOnly; SameSite=Lax${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`,
    'Cache-Control': 'no-store',
  });
  res.end();
});

rota('POST', '/api/sair', async (req, res) => { sessoes.encerrar(cookie(req, 'dmkacs')); enviar(res, 200, { ok: true }, { 'Set-Cookie': 'dmkacs=; Max-Age=0; HttpOnly; SameSite=Lax' }); });

// --- Central (admin DMK)
rota('GET', '/api/central/resumo', async (req, res) => {
  const s = exigirSessao(req, 'central');
  const provedores = banco.listar();
  const docs = await nbi.dispositivos({}, ['_id', '_lastInform', '_tags']);
  const limite = Date.now() - CFG.onlineMin * 60e3;
  const porChave = new Map(provedores.map((p) => [chaveDe(p), { total: 0, online: 0 }]));
  const sem = { total: 0, online: 0 };
  for (const d of docs) {
    const online = d._lastInform && new Date(d._lastInform).getTime() > limite;
    const conta = (d._tags || []).map((t) => porChave.get(t)).find(Boolean) || sem;
    conta.total++; if (online) conta.online++;
  }
  enviar(res, 200, {
    usuario: s.nome, versao: VERSAO, acs: estadoAcs,
    provedores: provedores.map((p) => ({ ...p, chave: chaveDe(p), ...porChave.get(chaveDe(p)) })),
    semProvedor: sem,
  });
});
rota('POST', '/api/central/provedores', async (req, res) => { exigirSessao(req, 'central'); enviar(res, 201, banco.criar(await lerCorpo(req))); });
rota('PUT', '/api/central/provedores/([a-z0-9-]+)', async (req, res, m) => {
  exigirSessao(req, 'central');
  const p = banco.alterar(m[1], await lerCorpo(req));
  if (!p) return enviar(res, 404, { erro: 'Provedor não encontrado.' });
  log(`Central: provedor ${p.id} ${p.ativo ? 'ativo' : 'desativado'} (${p.enderecoAcs})`);
  enviar(res, 200, p);
});
rota('DELETE', '/api/central/provedores/([a-z0-9-]+)', async (req, res, m) => {
  exigirSessao(req, 'central');
  enviar(res, banco.remover(m[1]) ? 200 : 404, { ok: true });
});
rota('GET', '/api/central/provedores/([a-z0-9-]+)/roteadores', async (req, res, m) => {
  exigirSessao(req, 'central');
  const p = banco.obter(m[1]);
  if (!p) return enviar(res, 404, { erro: 'Provedor não encontrado.' });
  enviar(res, 200, await roteadoresDoProvedor(p));
});

// --- Provedor
rota('GET', '/api/provedor/info', async (req, res) => {
  const s = exigirSessao(req, 'provedor');
  const p = provedorAtivo(s);
  enviar(res, 200, { id: p.id, nome: p.nome, usuario: s.nome, versao: VERSAO, ...instrucoes(p), onlineMin: CFG.onlineMin });
});
rota('GET', '/api/provedor/roteadores', async (req, res) => {
  const p = provedorAtivo(exigirSessao(req, 'provedor'));
  enviar(res, 200, await roteadoresDoProvedor(p));
});
rota('POST', '/api/provedor/roteadores/([^/]+)/wifi', async (req, res, m) => {
  const s = exigirSessao(req, 'provedor');
  const p = provedorAtivo(s);
  const id = await roteadorDoProvedor(p, decodeURIComponent(m[1]));
  const corpo = await lerCorpo(req);
  const dados = validarWifi(corpo.ssid, corpo.senha);
  log(`Provedor ${p.id} (${s.nome}): Wi-Fi do roteador ${id} -> "${dados.ssid}"${dados.senha ? ' + senha nova' : ''}`);
  enviar(res, 200, { situacao: await trocarWifi(id, dados) });
});
rota('POST', '/api/provedor/roteadores/([^/]+)/reiniciar', async (req, res, m) => {
  const p = provedorAtivo(exigirSessao(req, 'provedor'));
  const id = await roteadorDoProvedor(p, decodeURIComponent(m[1]));
  enviar(res, 200, { situacao: await nbi.tarefa(id, { name: 'reboot' }) });
});
rota('POST', '/api/provedor/roteadores/([^/]+)/atualizar', async (req, res, m) => {
  const p = provedorAtivo(exigirSessao(req, 'provedor'));
  const id = await roteadorDoProvedor(p, decodeURIComponent(m[1]));
  const situacao = await nbi.tarefa(id, { name: 'getParameterValues', parameterNames: ['VirtualParameters.dmk_pppoe', 'VirtualParameters.dmk_wifi_ssid'] });
  const [doc] = await nbi.dispositivos({ _id: id }, PROJECAO);
  enviar(res, 200, { situacao, roteador: doc ? paraTela(doc, lerClientes()) : null });
});

// --- Integração servidor-a-servidor (DMK Prisma). Authorization: Bearer <segredo de integração>
function exigirIntegracao(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m || !sessoes.segredoConfere(m[1])) throw Object.assign(new Error('Integração não autorizada.'), { status: 401 });
}
rota('GET', '/api/integracao/provedores', async (req, res) => {
  exigirIntegracao(req);
  enviar(res, 200, banco.listar().map((p) => ({ id: p.id, nome: p.nome, ativo: p.ativo })));
});
rota('POST', '/api/integracao/ticket', async (req, res) => {
  exigirIntegracao(req);
  const d = await lerCorpo(req);
  if (d.papel === 'provedor' && !banco.obter(d.provedor)?.ativo) return enviar(res, 403, { erro: 'Módulo ACS desativado para este provedor.' });
  if (d.papel !== 'central' && d.papel !== 'provedor') throw new Erro400('papel deve ser central ou provedor.');
  enviar(res, 200, { caminho: 'entrar?ticket=' + encodeURIComponent(sessoes.gerarTicket({ papel: d.papel, provedor: d.provedor, nome: d.nome })) });
});
// Central do assinante / robô de atendimento: troca o Wi-Fi do cliente pelo login PPPoE dele.
rota('POST', '/api/integracao/wifi', async (req, res) => {
  exigirIntegracao(req);
  const d = await lerCorpo(req);
  const p = banco.obter(String(d.provedor || ''));
  if (!p || !p.ativo) return enviar(res, 403, { erro: 'Módulo ACS desativado para este provedor.' });
  const pppoe = String(d.pppoe || '').trim();
  if (!pppoe) throw new Erro400('Informe o login PPPoE do cliente.', 'pppoe');
  const [doc] = await nbi.dispositivos({ _tags: chaveDe(p), 'VirtualParameters.dmk_pppoe': pppoe }, ['_id']);
  if (!doc) return enviar(res, 404, { erro: 'Nenhum roteador deste provedor com esse login PPPoE.' });
  enviar(res, 200, { situacao: await trocarWifi(doc._id, validarWifi(d.ssid, d.senha)) });
});

// --- Simulação: entra como Central ou como provedor sem passar pelo DMK Prisma (só em DMK_ACS_MODO=simulacao)
if (CFG.simulacao) {
  rota('POST', '/simulacao/entrar', async (req, res) => {
    const d = await lerCorpo(req);
    const papel = d.papel === 'provedor' ? 'provedor' : 'central';
    const ticket = sessoes.gerarTicket({ papel, provedor: papel === 'provedor' ? String(d.provedor || '') : undefined, nome: papel === 'central' ? 'Admin DMK (simulação)' : 'Operador (simulação)' });
    enviar(res, 200, { caminho: 'entrar?ticket=' + encodeURIComponent(ticket) });
  });
  rota('GET', '/simulacao/provedores', async (req, res) => enviar(res, 200, banco.listar().map((p) => ({ id: p.id, nome: p.nome, ativo: p.ativo }))));
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    for (const r of rotas) {
      if (r.metodo !== req.method) continue;
      const m = r.padrao.exec(url.pathname);
      if (m) return await r.fn(req, res, m, url);
    }
    enviar(res, 404, { erro: 'Não encontrado.' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) log(`ERRO ${req.method} ${url.pathname}: ${e.stack || e.message}`);
    if (!res.headersSent) enviar(res, status, { erro: e.message, campo: e.campo, desativado: e.desativado || undefined });
  }
});

if (require.main === module) {
  servidor.listen(CFG.porta, CFG.interface, () => {
    log(`DMK ACS ${VERSAO} no ar em http://${CFG.interface}:${CFG.porta}/ (ACS NBI ${CFG.nbi}${CFG.simulacao ? ', MODO SIMULAÇÃO' : ''})`);
    instalarScriptsNoAcs();
  });
}

module.exports = { servidor, CFG, instalarScriptsNoAcs, normalizarEndereco };
