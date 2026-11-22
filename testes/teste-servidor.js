'use strict';
/**
 * Teste de ponta a ponta do DMK ACS com um GenieACS IMITADO (NBI falsa em memória).
 * Roda sem rede e sem dependências:  node testes/teste-servidor.js
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'dmkacs-teste-'));
const agora = new Date().toISOString();
const antigo = new Date(Date.now() - 3600e3).toISOString();
const dev = (id, tag, pppoe, ssid, inform = agora) => ({
  _id: id, _lastInform: inform, _tags: tag ? [tag] : [],
  _deviceId: { _Manufacturer: 'Huawei', _ProductClass: 'BM632w', _SerialNumber: id.slice(-6) },
  VirtualParameters: { dmk_pppoe: { _value: pppoe }, dmk_wifi_ssid: { _value: ssid } },
  InternetGatewayDevice: { ManagementServer: { ConnectionRequestURL: { _value: 'http://100.64.0.9:7547/' } } },
});
const DISP = [
  dev('A-1', 'dmk_127_0_0_1_starnet', 'starnet.joao', 'JOAO'),
  dev('A-2', 'dmk_127_0_0_1_starnet', 'starnet.maria', 'MARIA', antigo),
  dev('B-1', 'dmk_127_0_0_1_exemplo', 'exemplo.ana', 'ANA'),
  dev('X-1', 'dmk_127_0_0_1', '', 'SOLTO'),
];
const gravados = {}; const tarefas = []; const apagados = [];
const valorDe = (d, k) => k.split('.').reduce((n, p) => n?.[p], d)?._value ?? k.split('.').reduce((n, p) => n?.[p], d);

const nbiFalsa = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => { corpo += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'PUT') { gravados[u.pathname] = corpo; res.end(); return; }
    if (req.method === 'GET' && u.pathname === '/devices/') {
      const q = JSON.parse(u.searchParams.get('query') || '{}');
      const r = DISP.filter((d) => Object.entries(q).every(([k, v]) => (k === '_tags' ? d._tags.includes(v) : String(valorDe(d, k)) === String(v))));
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(r)); return;
    }
    const m = /^\/devices\/([^/]+)\/tasks$/.exec(u.pathname);
    if (req.method === 'POST' && m) {
      const t = { id: decodeURIComponent(m[1]), ...JSON.parse(corpo) };
      tarefas.push(t);
      // A-2 não atende (fila); reboot no A-1 é RECUSADO (falha 9000, como o simulador)
      const recusa = t.id === 'A-1' && t.name === 'reboot';
      res.statusCode = t.id === 'A-2' || recusa ? 202 : 200;
      res.end(JSON.stringify({ _id: recusa ? 'tf1' : 'ok1' })); return;
    }
    const col = /^\/(provisions|presets)\/$/.exec(u.pathname);
    if (req.method === 'GET' && col) {   // "inform" já existe (não pode ser sobrescrito); o resto falta
      const q = JSON.parse(u.searchParams.get('query'));
      res.end(JSON.stringify(q._id === 'inform' ? [{ _id: 'inform' }] : [])); return;
    }
    if (req.method === 'GET' && u.pathname === '/faults/') {
      const q = JSON.parse(u.searchParams.get('query'));
      res.end(JSON.stringify(q._id === 'A-1:task_tf1' ? [{ _id: 'A-1:task_tf1', code: 'cwmp.9000', message: 'Method not supported' }] : []));
      return;
    }
    if (req.method === 'DELETE') { apagados.push(u.pathname); res.end(); return; }
    res.statusCode = 404; res.end();
  });
});

(async () => {
  await new Promise((r) => nbiFalsa.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { DMK_ACS_NBI: `http://127.0.0.1:${nbiFalsa.address().port}`, DMK_ACS_DADOS: pasta, DMK_ACS_MODO: 'simulacao' });
  const { servidor, instalarScriptsNoAcs } = require('../servidor/servidor');
  const scripts = require('../servidor/lib/scripts-genieacs');
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;

  // Cliente HTTP com cookie (um "navegador" por pessoa)
  function navegador() {
    let ck = '';
    return async (metodo, caminho, corpo, cab = {}) => {
      const r = await fetch(base + caminho, { method: metodo, redirect: 'manual', headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(ck ? { Cookie: ck } : {}), ...cab }, body: corpo ? JSON.stringify(corpo) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
      let json = null; try { json = await r.json(); } catch { /* sem json */ }
      return { status: r.status, json, location: r.headers.get('location') };
    };
  }
  async function entrar(nav, papel, provedor) {
    const { json } = await nav('POST', '/simulacao/entrar', { papel, provedor });
    const r = await nav('GET', '/' + json.caminho);
    assert.equal(r.status, 303); return json.caminho;
  }

  // 1) chave do endereço (mesma regra no painel e no provision)
  const ch = scripts.chaveDoEndereco;
  assert.equal(ch('http://acs.starnet.com.br:7547/'), 'dmk_acs_starnet_com_br');
  assert.equal(ch('HTTP://ACS.Starnet.com.br'), 'dmk_acs_starnet_com_br');
  assert.equal(ch('http://127.0.0.1:7547/starnet/'), 'dmk_127_0_0_1_starnet');
  assert.equal(ch('http://user:pw@acs.x.com:7547/a/b'), 'dmk_acs_x_com_a_b');
  assert.equal(ch(''), ''); assert.equal(ch('lixo'), '');

  // 2) scripts compilam e o provision marca a tag certa (declare imitado)
  const igual = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
  const declarados = [];
  const declareFalso = (caminho, quando, def) => {
    declarados.push([caminho, def]);
    if (caminho === 'InternetGatewayDevice.ManagementServer.URL') return [{ path: caminho, value: ['http://127.0.0.1:7547/starnet'] }];
    if (caminho === 'Tags.*') return [{ path: 'Tags.dmk_velho', value: [true] }, { path: 'Tags.outra', value: [true] }];
    return Object.assign([], { size: 0 });
  };
  vm.runInNewContext(scripts.PROVISION, { declare: declareFalso, Date: { now: () => 1 } });
  igual(declarados.find(([c]) => c === 'Tags.dmk_velho')[1], { value: false }, 'tag antiga sai');
  assert.ok(!declarados.some(([c, d]) => c === 'Tags.outra' && d), 'tag de outro sistema fica');
  igual(declarados.find(([c]) => c === 'Tags.dmk_127_0_0_1_starnet')[1], { value: true }, 'tag nova entra');
  for (const [nome, s] of Object.entries(scripts.VIRTUAIS)) new vm.Script(`(function(args, declare){${s}\n})`, { filename: nome });

  // dmk_wifi_senha: grava no 1º campo existente das redes escolhidas (principal + mesmo nome)
  const sets = [];
  const declSenha = (c, q, def) => {
    if (def) { sets.push([c, def.value]); return []; }
    if (c === 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.*.SSID') return [
      { path: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', value: ['CASA'] },
      { path: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID', value: ['CASA'] },
      { path: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID', value: ['VISITA'] }];
    if (c.endsWith('.1.KeyPassphrase') && !c.includes('PreSharedKey')) return Object.assign([{}], { size: 1 });
    if (c.endsWith('.5.PreSharedKey.1.PreSharedKey')) return Object.assign([{}], { size: 1 });
    return Object.assign([], { size: 0 });
  };
  const fnSenha = vm.runInNewContext(`(function(args, declare){${scripts.VIRTUAIS.dmk_wifi_senha}\n})`, { Date: { now: () => 1 } });
  const ret = fnSenha([{}, { value: ['segredo123', 'xsd:string'] }], declSenha);
  igual(sets, [['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', 'segredo123'], ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.PreSharedKey', 'segredo123']]);
  igual(ret.value, ['segredo123', 'xsd:string']);
  igual(fnSenha([{}, {}], declSenha).value, ['', 'xsd:string'], 'leitura da senha é vazia');

  // 3) scripts gravados no "GenieACS"
  await instalarScriptsNoAcs();
  for (const k of ['/provisions/dmk', '/presets/dmk', '/virtual_parameters/dmk_pppoe', '/virtual_parameters/dmk_wifi_ssid', '/virtual_parameters/dmk_wifi_senha']) assert.ok(gravados[k], 'gravou ' + k);
  assert.equal(JSON.parse(gravados['/presets/dmk']).configurations[0].name, 'dmk');
  assert.ok(gravados['/provisions/bootstrap'] && gravados['/presets/default'], 'básico que faltava foi criado');
  assert.ok(!gravados['/provisions/inform'] && !gravados['/presets/inform'], 'o que já existia não foi sobrescrito');

  // 4) Central: sem sessão não entra; cadastra provedores; endereço repetido é recusado
  const central = navegador();
  assert.equal((await central('GET', '/api/central/resumo')).status, 401);
  assert.equal(await entrar(central, 'central').then(() => 'ok'), 'ok');
  let r = await central('POST', '/api/central/provedores', { id: 'starnet', nome: 'Starnet', enderecoAcs: 'http://127.0.0.1:7547/starnet' });
  assert.equal(r.status, 201); assert.equal(r.json.nome, 'STARNET'); assert.equal(r.json.enderecoAcs, 'http://127.0.0.1:7547/starnet/');
  r = await central('POST', '/api/central/provedores', { id: 'exemplo', nome: 'Provedor Exemplo', enderecoAcs: '127.0.0.1:7547/exemplo' });
  assert.equal(r.status, 201);
  r = await central('POST', '/api/central/provedores', { id: 'copia', nome: 'Copia', enderecoAcs: 'http://127.0.0.1/starnet' });
  assert.equal(r.status, 400); assert.equal(r.json.campo, 'enderecoAcs');
  r = await central('POST', '/api/central/provedores', { id: 'Mal Formado', nome: 'X', enderecoAcs: 'a.com' });
  assert.equal(r.json.campo, 'id');
  r = await central('GET', '/api/central/resumo');
  const st = r.json.provedores.find((p) => p.id === 'starnet');
  assert.equal(st.total, 2); assert.equal(st.online, 1);
  assert.equal(r.json.semDono.total, 1, 'roteador com endereço sem dono');

  // 5) Provedor: só vê os dele; não mexe em roteador de outro provedor
  const starnet = navegador();
  await entrar(starnet, 'provedor', 'starnet');
  assert.equal((await starnet('GET', '/api/central/resumo')).status, 401, 'provedor não entra na Central');
  r = await starnet('GET', '/api/provedor/roteadores');
  assert.deepEqual(r.json.map((x) => x.id).sort(), ['A-1', 'A-2']);
  assert.equal(r.json.find((x) => x.id === 'A-1').ip, '100.64.0.9');
  r = await starnet('POST', '/api/provedor/roteadores/B-1/wifi', { ssid: 'INVASAO', senha: '12345678' });
  assert.equal(r.status, 404, 'roteador de outro provedor');
  assert.equal(tarefas.length, 0);
  r = await starnet('POST', '/api/provedor/roteadores/A-1/wifi', { ssid: 'ação', senha: '12345678' });
  assert.equal(r.json.campo, 'ssid');
  r = await starnet('POST', '/api/provedor/roteadores/A-1/wifi', { ssid: 'NOVO', senha: '123' });
  assert.equal(r.json.campo, 'senha');
  r = await starnet('POST', '/api/provedor/roteadores/A-1/wifi', { ssid: 'CASA DO JOAO', senha: 'senhaforte1' });
  assert.equal(r.json.situacao, 'aplicado');
  assert.deepEqual(tarefas.at(-1), { id: 'A-1', name: 'setParameterValues', parameterValues: [['VirtualParameters.dmk_wifi_ssid', 'CASA DO JOAO', 'xsd:string'], ['VirtualParameters.dmk_wifi_senha', 'senhaforte1', 'xsd:string']] });
  r = await starnet('POST', '/api/provedor/roteadores/A-2/reiniciar');
  assert.equal(r.json.situacao, 'na-fila', 'roteador que não atende fica na fila');
  r = await starnet('POST', '/api/provedor/roteadores/A-1/reiniciar');
  assert.equal(r.status, 422, 'roteador recusou');
  assert.match(r.json.erro, /recusou.*não aceita esse comando \(código 9000\)/);
  assert.deepEqual(apagados, ['/tasks/tf1', '/faults/A-1%3Atask_tf1'], 'tarefa e falha limpas');

  // 6) Central desativa o provedor -> provedor bloqueado na hora
  await central('PUT', '/api/central/provedores/starnet', { ativo: false });
  r = await starnet('GET', '/api/provedor/roteadores');
  assert.equal(r.status, 403); assert.equal(r.json.desativado, true);
  r = await starnet('POST', '/api/provedor/roteadores/A-1/reiniciar');
  assert.equal(r.status, 403);
  await central('PUT', '/api/central/provedores/starnet', { ativo: true });
  assert.equal((await starnet('GET', '/api/provedor/roteadores')).status, 200);

  // 7) Tickets: reuso e adulteração recusados
  const outro = navegador();
  const { json: t } = await outro('POST', '/simulacao/entrar', { papel: 'central' });
  assert.equal((await outro('GET', '/' + t.caminho)).status, 303);
  assert.equal((await navegador()('GET', '/' + t.caminho)).status, 401, 'ticket usado de novo');
  const adulterado = t.caminho.replace(/ticket=./, 'ticket=Z');
  assert.equal((await navegador()('GET', '/' + adulterado)).status, 401);

  // 8) Integração servidor-a-servidor (DMK Prisma): segredo obrigatório; Wi-Fi pelo login PPPoE
  const segredo = fs.readFileSync(path.join(pasta, 'segredo-integracao.txt'), 'utf8').trim();
  const prisma = navegador();
  assert.equal((await prisma('GET', '/api/integracao/provedores', null, { Authorization: 'Bearer errado' })).status, 401);
  r = await prisma('GET', '/api/integracao/provedores', null, { Authorization: `Bearer ${segredo}` });
  assert.deepEqual(r.json.map((p) => p.id).sort(), ['exemplo', 'starnet']);
  r = await prisma('POST', '/api/integracao/wifi', { provedor: 'exemplo', pppoe: 'starnet.joao', ssid: 'X', senha: '12345678' }, { Authorization: `Bearer ${segredo}` });
  assert.equal(r.status, 404, 'PPPoE de outro provedor não é achado');
  r = await prisma('POST', '/api/integracao/wifi', { provedor: 'exemplo', pppoe: 'exemplo.ana', ssid: 'ANA 5G', senha: '' }, { Authorization: `Bearer ${segredo}` });
  assert.equal(r.json.situacao, 'aplicado');
  assert.deepEqual(tarefas.at(-1).parameterValues, [['VirtualParameters.dmk_wifi_ssid', 'ANA 5G', 'xsd:string']], 'sem senha troca só o nome');
  r = await prisma('POST', '/api/integracao/ticket', { papel: 'provedor', provedor: 'exemplo', nome: 'Op' }, { Authorization: `Bearer ${segredo}` });
  assert.match(r.json.caminho, /^entrar\?ticket=/);

  // 9) Páginas e segurança
  r = await fetch(base + '/provedor/');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal((await fetch(base + '/assets/../servidor.js')).status, 404);

  console.log('teste-servidor: OK (todos os passos)');
  servidor.close(); nbiFalsa.close();
  fs.rmSync(pasta, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
