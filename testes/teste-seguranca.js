'use strict';
/**
 * Teste da SEGURANÇA e dos CLIENTES AVULSOS (GenieACS imitado, sem rede):
 *   node testes/teste-seguranca.js
 * O relógio é avançado à mão (Date.now) para o app autenticador gerar códigos novos.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const relogioReal = Date.now;
let deslocamento = 0;
Date.now = () => relogioReal() + deslocamento;
const avancar = (seg) => { deslocamento += seg * 1000; };

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'dmkacs-seg-'));
const DISP = [];
const tarefas = [];
const valorDe = (d, k) => k.split('.').reduce((n, p) => n?.[p], d)?._value ?? k.split('.').reduce((n, p) => n?.[p], d);
const nbiFalsa = http.createServer((req, res) => {
  let corpo = ''; req.on('data', (c) => { corpo += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'PUT' || req.method === 'DELETE') return res.end();
    if (req.method === 'GET' && /^\/(provisions|presets|faults)\/$/.test(u.pathname)) return res.end('[]');
    if (req.method === 'GET' && u.pathname === '/devices/') {
      const q = JSON.parse(u.searchParams.get('query') || '{}');
      return res.end(JSON.stringify(DISP.filter((d) => Object.entries(q).every(([k, v]) => (k === '_tags' ? d._tags.includes(v) : String(valorDe(d, k)) === String(v))))));
    }
    const m = /^\/devices\/([^/]+)\/tasks$/.exec(u.pathname);
    if (req.method === 'POST' && m) { tarefas.push({ id: decodeURIComponent(m[1]), ...JSON.parse(corpo) }); return res.end('{}'); }
    res.statusCode = 404; res.end();
  });
});

(async () => {
  await new Promise((r) => nbiFalsa.listen(0, '127.0.0.1', r));
  // O teste não herda a configuração da VPS (o atualizador roda os testes com o acs.env carregado)
  for (const k of Object.keys(process.env)) if (k.startsWith('DMK_ACS_')) delete process.env[k];
  Object.assign(process.env, { DMK_ACS_NBI: `http://127.0.0.1:${nbiFalsa.address().port}`, DMK_ACS_DADOS: pasta, DMK_ACS_MODO: 'producao', DMK_ACS_PROXY: '1' });
  const seg = require('../servidor/lib/seguranca');
  const scripts = require('../servidor/lib/scripts-genieacs');
  const { servidor } = require('../servidor/servidor');
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;

  /** Um "navegador" com cookies e IP próprio (X-Real-IP, como atrás do nginx). */
  function navegador(ip) {
    const ck = {};
    return async (metodo, caminho, corpo, cab = {}) => {
      const cookies = Object.entries(ck).map(([k, v]) => `${k}=${v}`).join('; ');
      const r = await fetch(base + caminho, { method: metodo, redirect: 'manual', headers: { ...(ip ? { 'X-Real-IP': ip } : {}), ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(cookies ? { Cookie: cookies } : {}), ...cab }, body: corpo ? JSON.stringify(corpo) : undefined });
      for (const sc of r.headers.getSetCookie?.() || []) { const [kv] = sc.split(';'); const [k, v] = kv.split('='); if (v) ck[k] = v; else delete ck[k]; }
      let json = null; try { json = await r.json(); } catch { /* sem json */ }
      return { status: r.status, json, cab: r.headers };
    };
  }

  // 1) Peças: TOTP (vetor da RFC 6238), senha, regras
  const segRfc = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';   // "12345678901234567890"
  assert.equal(seg.codigoTotp(segRfc, 1), '287082');        // T=59 s
  assert.equal(seg.codigoTotp(segRfc, 37037036), '081804'); // T=1111111109 s
  const h = seg.hashSenha('Forte#Senha2026');
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.ok(seg.conferirSenha('Forte#Senha2026', h) && !seg.conferirSenha('forte#senha2026', h));
  assert.ok(!seg.conferirSenha('x', ''), 'conta inexistente nunca confere');
  assert.ok(seg.problemaSenha('curta1A!'), 'curta');
  assert.ok(seg.problemaSenha('somenteletrasminusculas'), 'poucos tipos');
  assert.ok(seg.problemaSenha('Admin@123456', 'admin'), 'contém usuário');
  assert.equal(seg.problemaSenha('Rio#Verde-2026x', 'danilo'), '');
  console.log('ok  TOTP (RFC 6238), scrypt e regras de senha');

  // 2) Primeiro acesso: só com o código que está no servidor
  const adm = navegador('10.0.0.1');
  let r = await adm('GET', '/api/acesso/estado');
  assert.equal(r.json.temAdmin, false);
  const codigoPA = fs.readFileSync(path.join(pasta, 'primeiro-acesso.txt'), 'utf8').trim();
  r = await adm('POST', '/api/acesso/primeiro/iniciar', { codigo: 'ERRADO-1234', usuario: 'danilo', senha: 'Rio#Verde-2026x', confirmar: 'Rio#Verde-2026x' });
  assert.equal(r.json.campo, 'codigo');
  r = await adm('POST', '/api/acesso/primeiro/iniciar', { codigo: codigoPA, usuario: 'danilo', senha: 'fraca', confirmar: 'fraca' });
  assert.equal(r.json.campo, 'senha');
  r = await adm('POST', '/api/acesso/primeiro/iniciar', { codigo: codigoPA.toLowerCase(), usuario: 'danilo', senha: 'Rio#Verde-2026x', confirmar: 'Rio#Verde-2026x' });
  assert.equal(r.status, 200); assert.match(r.json.qr, /^data:image\/svg\+xml;base64,/);
  const segredo = r.json.segredo;
  const tokenPA = r.json.token;
  r = await adm('POST', '/api/acesso/primeiro/concluir', { token: tokenPA, codigo: '000000' });
  assert.equal(r.json.campo, 'codigo');
  r = await adm('POST', '/api/acesso/primeiro/concluir', { token: tokenPA, codigo: seg.codigoTotp(segredo, seg.passoAtual()) });
  assert.equal(r.status, 200); assert.equal(r.json.codigosRecuperacao.length, 8);
  const recuperacao = r.json.codigosRecuperacao;
  assert.ok(!fs.existsSync(path.join(pasta, 'primeiro-acesso.txt')), 'código de primeiro acesso apagado');
  r = await navegador('10.0.0.9')('POST', '/api/acesso/primeiro/iniciar', { codigo: codigoPA, usuario: 'outro', senha: 'Rio#Verde-2026x', confirmar: 'Rio#Verde-2026x' });
  assert.equal(r.status, 409, 'não cria segundo admin pelo primeiro acesso');
  const contas = JSON.parse(fs.readFileSync(path.join(pasta, 'contas.json'), 'utf8'));
  assert.ok(!JSON.stringify(contas).includes('Rio#Verde-2026x'), 'senha nunca em texto');
  assert.equal((fs.statSync(path.join(pasta, 'contas.json')).mode & 0o777), 0o600);
  console.log('ok  primeiro acesso (código do servidor, QR, recuperação, senha só em scrypt)');

  // 3) Entrada: senha -> autenticador -> sessão; sem sessão não entra
  assert.equal((await adm('GET', '/api/central/resumo')).status, 401);
  async function entrarAdmin(nav, codigoFn) {
    const a = await nav('POST', '/api/acesso/entrar', { usuario: 'danilo', senha: 'Rio#Verde-2026x' });
    assert.equal(a.json.etapa, 'autenticador');
    avancar(30);
    return nav('POST', '/api/acesso/autenticador', { desafio: a.json.desafio, codigo: codigoFn() });
  }
  r = await adm('GET', '/central/');
  assert.equal(r.status, 303); assert.equal(r.cab.get('location'), '../admin/', 'sem sessão o painel manda para a entrada');
  r = await entrarAdmin(adm, () => seg.codigoTotp(segredo, seg.passoAtual()));
  assert.equal(r.status, 200);
  const cookieAdmin = r.cab.get('set-cookie');
  assert.match(cookieAdmin, /HttpOnly/); assert.match(cookieAdmin, /SameSite=Strict/); assert.match(cookieAdmin, /Path=\//);
  assert.equal((await adm('GET', '/api/central/resumo')).status, 200);
  r = await adm('GET', '/admin/');
  assert.equal(r.status, 303); assert.equal(r.cab.get('location'), '../central/', 'já logado, a entrada manda direto para o painel');
  assert.equal((await adm('GET', '/central/')).status, 200);
  console.log('ok  entrada com senha + app autenticador (já logado: /admin/ leva ao painel e vice-versa)');

  // 4) Código do autenticador não pode ser reusado; código de recuperação vale uma vez
  const nav2 = navegador('10.0.0.2');
  let a = await nav2('POST', '/api/acesso/entrar', { usuario: 'danilo', senha: 'Rio#Verde-2026x' });
  r = await nav2('POST', '/api/acesso/autenticador', { desafio: a.json.desafio, codigo: seg.codigoTotp(segredo, seg.passoAtual()) });
  assert.equal(r.status, 401, 'mesmo código de 6 dígitos usado de novo');
  r = await nav2('POST', '/api/acesso/autenticador', { desafio: a.json.desafio, codigo: recuperacao[0].toLowerCase() });
  assert.equal(r.status, 200); assert.equal(r.json.codigosRestantes, 7);
  a = await nav2('POST', '/api/acesso/entrar', { usuario: 'danilo', senha: 'Rio#Verde-2026x' });
  r = await nav2('POST', '/api/acesso/autenticador', { desafio: a.json.desafio, codigo: recuperacao[0] });
  assert.equal(r.status, 401, 'código de recuperação já usado');
  console.log('ok  sem reuso de código; recuperação de uso único');

  // 5) Desafio da 2ª etapa preso ao IP
  a = await navegador('10.0.0.3')('POST', '/api/acesso/entrar', { usuario: 'danilo', senha: 'Rio#Verde-2026x' });
  avancar(30);
  r = await navegador('10.0.0.4')('POST', '/api/acesso/autenticador', { desafio: a.json.desafio, codigo: seg.codigoTotp(segredo, seg.passoAtual()) });
  assert.equal(r.status, 401); assert.equal(r.json.reiniciar, true);
  console.log('ok  2ª etapa só vale no mesmo IP');

  // 6) Bloqueio da conta: 5 erros SEGUIDOS (de IPs diferentes) -> conta bloqueada, até com a senha certa.
  //    A conta já tem 1 erro seguido da etapa 4 (código de recuperação repetido): bloqueia no 4º daqui.
  for (let i = 0; i < 4; i++) {
    r = await navegador(`10.1.0.${i}`)('POST', '/api/acesso/entrar', { usuario: 'danilo', senha: 'errada' + i });
    assert.equal(r.status, 401); assert.equal(r.json.erro, 'Usuário ou senha inválidos.');
  }
  r = await navegador('10.1.0.99')('POST', '/api/acesso/entrar', { usuario: 'danilo', senha: 'Rio#Verde-2026x' });
  assert.equal(r.status, 429); assert.match(r.json.erro, /Conta bloqueada/);
  r = await navegador('10.1.0.98')('POST', '/api/acesso/entrar', { usuario: 'naoexiste', senha: 'x' });
  assert.equal(r.json.erro, 'Usuário ou senha inválidos.', 'mesma mensagem para usuário inexistente');
  avancar(16 * 60);
  r = await navegador('10.1.0.97')('POST', '/api/acesso/entrar', { usuario: 'danilo', senha: 'Rio#Verde-2026x' });
  assert.equal(r.json.etapa, 'autenticador', 'desbloqueia sozinho depois de 15 min');
  console.log('ok  bloqueio de conta (5 erros, 15 min) e mensagem genérica');

  // 7) Bloqueio de IP: 10 erros do mesmo IP -> IP bloqueado (mesmo com senha certa); admin desbloqueia
  const atacante = navegador('203.0.113.7');
  for (let i = 0; i < 10; i++) await atacante('POST', '/api/acesso/entrar', { usuario: `chute${i}`, senha: 'x' });
  r = await atacante('POST', '/api/acesso/entrar', { usuario: 'danilo', senha: 'Rio#Verde-2026x' });
  assert.equal(r.status, 429); assert.match(r.json.erro, /bloqueado/);
  r = await adm('GET', '/api/central/seguranca');
  assert.ok(r.json.bloqueados.some((b) => b.ip === '203.0.113.7'));
  assert.ok(r.json.registros.some((x) => x.evento === 'ip-bloqueado'));
  r = await adm('POST', '/api/central/seguranca/desbloquear', { ip: '203.0.113.7' });
  assert.equal(r.status, 200);
  r = await atacante('POST', '/api/acesso/entrar', { usuario: 'danilo', senha: 'Rio#Verde-2026x' });
  assert.equal(r.json.etapa, 'autenticador');
  console.log('ok  bloqueio de IP (10 erros) e desbloqueio pelo admin');

  // 8) Anti-CSRF: pedido com Origin de outro site é recusado
  r = await adm('POST', '/api/central/provedores', { id: 'x', nome: 'X', enderecoAcs: 'x.com' }, { Origin: 'https://site-malicioso.com' });
  assert.equal(r.status, 403);
  console.log('ok  pedido de outra origem recusado');

  // 9) Ações sensíveis pedem o autenticador; entrada pelo Prisma (ticket) não pode
  r = await adm('POST', '/api/central/integracao/revelar', { codigo: '123456' });
  assert.equal(r.json.campo, 'codigo');
  avancar(30);
  r = await adm('POST', '/api/central/integracao/revelar', { codigo: seg.codigoTotp(segredo, seg.passoAtual()) });
  assert.equal(r.json.segredo, fs.readFileSync(path.join(pasta, 'segredo-integracao.txt'), 'utf8').trim());
  const segredoIntegracao = r.json.segredo;
  const prisma = navegador(null);   // o Prisma chama 127.0.0.1 direto, sem passar pelo nginx
  r = await prisma('POST', '/api/integracao/ticket', { papel: 'central', nome: 'Prisma' }, { Authorization: `Bearer ${segredoIntegracao}` });
  await prisma('GET', '/' + r.json.caminho);
  assert.equal((await prisma('GET', '/api/central/resumo')).status, 200, 'Prisma abre a Central');
  r = await prisma('POST', '/api/central/integracao/revelar', { codigo: seg.codigoTotp(segredo, seg.passoAtual()) });
  assert.equal(r.status, 403, 'sessão do Prisma não revela a chave');
  console.log('ok  ações sensíveis com autenticador; sessão do Prisma não mexe na segurança');

  // 10) Clientes avulsos: endereço base, cadastro, endereço com código
  r = await adm('POST', '/api/central/avulsos', { nome: 'Joao', usuario: 'joao' });
  assert.equal(r.status, 400, 'sem endereço base ainda');
  r = await adm('PUT', '/api/central/config', { enderecoAvulsos: 'acs.dmk.com.br' });
  assert.equal(r.json.enderecoAvulsos, 'http://acs.dmk.com.br:7547');
  r = await prisma('PUT', '/api/integracao/provedores/fibra-sul', { nome: 'Fibra Sul' }, { Authorization: `Bearer ${segredoIntegracao}` });
  assert.equal(r.status, 201); assert.equal(r.json.enderecoAcs, 'http://acs.dmk.com.br:7547/fibra-sul/', 'Prisma cria o provedor no endereço base + /código');
  r = await adm('POST', '/api/central/provedores', { id: 'malandro', nome: 'Malandro', enderecoAcs: 'http://acs.dmk.com.br:7547/c/ABC123' });
  assert.equal(r.json.campo, 'enderecoAcs', 'provedor não pode usar /c/');
  r = await adm('POST', '/api/central/avulsos', { nome: 'Maria da Silva', telefone: '(11) 98888-7777', email: 'maria@ex.com', usuario: 'Maria.Silva' });
  assert.equal(r.status, 201);
  const maria = r.json.cliente; const senhaProv = r.json.senhaInicial;
  assert.equal(maria.nome, 'MARIA DA SILVA'); assert.equal(maria.usuario, 'maria.silva');
  assert.match(maria.codigo, /^[A-Z2-9]{6}$/);
  assert.equal(maria.enderecoAcs, `http://acs.dmk.com.br:7547/c/${maria.codigo}`);
  assert.ok(!('senhaHash' in maria), 'hash não sai na tela');
  r = await adm('POST', '/api/central/avulsos', { nome: 'Outra Maria', usuario: 'maria.silva' });
  assert.equal(r.json.campo, 'usuario', 'usuário repetido');
  r = await adm('POST', '/api/central/avulsos', { nome: 'Pedro Alves', usuario: 'pedro' });
  const pedro = r.json.cliente; const senhaPedro = r.json.senhaInicial;
  // roteadores de cada um (tag do endereço com código, como o provision faz)
  const chave = (c) => scripts.chaveDoEndereco(`http://acs.dmk.com.br:7547/c/${c}`);
  assert.equal(chave(maria.codigo), `dmk_acs_dmk_com_br_c_${maria.codigo.toLowerCase()}`);
  const dev = (id, tag, ssid) => ({ _id: id, _lastInform: new Date(Date.now()).toISOString(), _tags: [tag], _deviceId: { _ProductClass: 'F670L', _Manufacturer: 'ZTE', _SerialNumber: id }, VirtualParameters: { dmk_wifi_ssid: { _value: ssid } } });
  DISP.push(dev('R-MARIA', chave(maria.codigo), 'CASA MARIA'), dev('R-PEDRO', chave(pedro.codigo), 'PEDRO'));
  r = await adm('GET', '/api/central/resumo');
  const m2 = r.json.avulsos.find((c) => c.codigo === maria.codigo);
  assert.equal(m2.total, 1); assert.equal(m2.roteador.ssid, 'CASA MARIA');
  assert.equal(r.json.semDono.total, 0);
  console.log('ok  clientes avulsos: cadastro, endereço com código, roteador ligado sozinho');

  // 11) App do cliente: senha provisória -> troca obrigatória -> só o roteador dele
  const app = navegador('198.51.100.20');
  r = await app('POST', '/api/app/entrar', { usuario: 'maria.silva', senha: 'errada' });
  assert.equal(r.status, 401);
  r = await app('POST', '/api/app/entrar', { usuario: 'MARIA.SILVA', senha: senhaProv });
  assert.equal(r.status, 200); assert.equal(r.json.trocarSenha, true);
  assert.match(r.cab.get('set-cookie'), /^dmkapp=.*Max-Age=2592000/);
  r = await app('GET', '/api/app/eu');
  assert.deepEqual(r.json.roteadores.map((x) => x.id), ['R-MARIA'], 'só o roteador dela');
  r = await app('POST', '/api/app/roteadores/R-MARIA/wifi', { ssid: 'NOVO', senha: '12345678' });
  assert.equal(r.status, 403, 'precisa trocar a senha provisória antes');
  r = await app('POST', '/api/app/senha', { atual: senhaProv, nova: 'abc', confirmar: 'abc' });
  assert.equal(r.json.campo, 'nova');
  r = await app('POST', '/api/app/senha', { atual: senhaProv, nova: 'Casa#Maria2026', confirmar: 'Casa#Maria2026' });
  assert.equal(r.status, 200);
  r = await app('POST', '/api/app/roteadores/R-PEDRO/wifi', { ssid: 'INVADIU', senha: '12345678' });
  assert.equal(r.status, 404, 'não mexe no roteador do Pedro');
  r = await app('POST', '/api/app/roteadores/R-MARIA/wifi', { ssid: 'MARIA 5G', senha: 'novasenha99' });
  assert.equal(r.json.situacao, 'aplicado');
  assert.deepEqual(tarefas.at(-1), { id: 'R-MARIA', name: 'setParameterValues', parameterValues: [['VirtualParameters.dmk_wifi_ssid', 'MARIA 5G', 'xsd:string'], ['VirtualParameters.dmk_wifi_senha', 'novasenha99', 'xsd:string']] });
  assert.equal((await app('GET', '/api/central/resumo')).status, 401, 'cliente não entra no painel');
  assert.equal((await app('GET', '/api/provedor/roteadores')).status, 401, 'cliente não entra no módulo do provedor');
  console.log('ok  app: troca obrigatória da senha provisória, só o próprio roteador');

  // 12) Admin desativa o cliente -> sai do app na hora; nova senha provisória reativa o acesso
  await adm('PUT', `/api/central/avulsos/${maria.codigo}`, { ativo: false });
  r = await app('GET', '/api/app/eu');
  assert.ok(r.status === 401 || r.status === 403, 'desativado sai do app');
  r = await app('POST', '/api/app/entrar', { usuario: 'maria.silva', senha: 'Casa#Maria2026' });
  assert.equal(r.status, 403);
  await adm('PUT', `/api/central/avulsos/${maria.codigo}`, { ativo: true });
  r = await adm('POST', `/api/central/avulsos/${maria.codigo}/nova-senha`);
  assert.match(r.json.senha, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  r = await app('POST', '/api/app/entrar', { usuario: 'maria.silva', senha: 'Casa#Maria2026' });
  assert.equal(r.status, 401, 'senha antiga não vale mais');
  r = await navegador('198.51.100.21')('POST', '/api/app/entrar', { usuario: 'pedro', senha: senhaPedro });
  assert.equal(r.status, 200);
  console.log('ok  desativar cliente e gerar senha provisória');

  // 13) Senha do admin trocada -> todas as sessões do admin caem
  avancar(30);
  r = await adm('POST', '/api/central/seguranca/senha', { atual: 'Rio#Verde-2026x', nova: 'Outra#Senha-2027', confirmar: 'Outra#Senha-2027', codigo: seg.codigoTotp(segredo, seg.passoAtual()) });
  assert.equal(r.status, 200);
  assert.equal((await adm('GET', '/api/central/resumo')).status, 401, 'sessão derrubada');
  // 14) Sessão do admin cai com 30 min sem uso
  const a2 = await adm('POST', '/api/acesso/entrar', { usuario: 'danilo', senha: 'Outra#Senha-2027' });
  avancar(30);
  r = await adm('POST', '/api/acesso/autenticador', { desafio: a2.json.desafio, codigo: seg.codigoTotp(segredo, seg.passoAtual()) });
  assert.equal(r.status, 200);
  avancar(31 * 60);
  assert.equal((await adm('GET', '/api/central/resumo')).status, 401, 'expirou por inatividade');
  console.log('ok  troca de senha derruba sessões; inatividade de 30 min');

  // 15) Auditoria gravada e com permissão restrita
  const log = fs.readFileSync(path.join(pasta, 'auditoria.log'), 'utf8');
  for (const ev of ['admin-criado', 'entrada', 'conta-bloqueada', 'ip-bloqueado', 'app-entrada', 'app-wifi', 'senha-alterada']) assert.ok(log.includes(`"evento":"${ev}"`), 'auditoria: ' + ev);
  assert.ok(!log.includes('Rio#Verde') && !log.includes('Casa#Maria'), 'senha nunca na auditoria');
  console.log('ok  auditoria completa e sem senhas');

  console.log('teste-seguranca: OK (todos os passos)');
  servidor.close(); nbiFalsa.close();
  fs.rmSync(pasta, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
