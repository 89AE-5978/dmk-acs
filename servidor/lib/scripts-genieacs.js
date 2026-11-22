'use strict';
/**
 * Scripts que o DMK ACS grava dentro do GenieACS (pela API NBI) ao ligar.
 *
 * - provision "dmk" + preset "dmk": rodam em toda conexão do roteador. Marcam o roteador com a
 *   chave do provedor (tirada do endereço do ACS gravado NO roteador) e mantêm atualizados os
 *   dados que o painel mostra.
 * - parâmetros virtuais dmk_*: o painel só conhece "nome do Wi-Fi", "senha do Wi-Fi" e "login
 *   PPPoE". Cada script traduz isso para o lugar certo do modelo (TR-098 InternetGatewayDevice ou
 *   TR-181 Device), então um modelo novo de roteador não exige mudar o painel.
 *
 * Os scripts rodam no sandbox do GenieACS (declare/Date.now(intervalo)/args), não no Node.
 */

/**
 * Chave do provedor a partir do endereço do ACS: host (sem porta) + caminho, só [a-z0-9_].
 *   http://acs.starnet.com.br:7547/      -> dmk_acs_starnet_com_br
 *   http://127.0.0.1:7547/starnet        -> dmk_127_0_0_1_starnet
 * É a MESMA função no painel e dentro do provision (vai como texto, ver PROVISION), então as
 * duas pontas nunca divergem. Escrita em ES5 simples de propósito.
 */
function chaveDoEndereco(url) {
  var s = String(url || '').trim().toLowerCase();
  var m = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#]+)([^?#]*)/.exec(s);
  if (!m) return '';
  var host = m[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  var caminho = m[2].replace(/\/+$/, '');
  var chave = (host + caminho).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return chave ? 'dmk_' + chave.slice(0, 60) : '';
}

const PROVISION = `// DMK ACS - gerado pelo painel DMK ACS (nao editar aqui: o painel regrava ao ligar).
// Roda em toda conexao do roteador (preset "dmk").
const cinco = Date.now(300000);

// 1) Endereco do ACS gravado no roteador -> chave do provedor -> tag dmk_*
let endereco = "";
for (const p of declare("InternetGatewayDevice.ManagementServer.URL", {value: cinco})) if (p.value && p.value[0]) endereco = p.value[0];
if (!endereco) for (const p of declare("Device.ManagementServer.URL", {value: cinco})) if (p.value && p.value[0]) endereco = p.value[0];
const chave = (${chaveDoEndereco.toString()})(endereco);

// Tira marcas dmk_ antigas (roteador mudou de provedor) e poe a atual
for (const t of declare("Tags.*", {value: 1})) {
  const nome = t.path.slice(5);
  if (nome.indexOf("dmk_") === 0 && nome !== chave) declare(t.path, null, {value: false});
}
if (chave) declare("Tags." + chave, null, {value: true});

// 2) Dados que o painel mostra, renovados a cada 5 minutos
declare("VirtualParameters.dmk_pppoe", {value: cinco});
declare("VirtualParameters.dmk_wifi_ssid", {value: cinco});
// A senha gravada fica no banco so ate a proxima renovacao: a leitura dela devolve vazio.
declare("VirtualParameters.dmk_wifi_senha", {value: cinco});
`;

// Redes Wi-Fi "principais": a de menor numero com nome e as outras com o MESMO nome
// (dual band 2,4 + 5 GHz com nome igual). Rede de visitante, com outro nome, fica de fora.
const REDES = `
function redesWifi(quando) {
  const h = Date.now(3600000);
  const todas = [];
  for (const p of declare("InternetGatewayDevice.LANDevice.1.WLANConfiguration.*.SSID", {path: h, value: quando})) todas.push(p);
  for (const p of declare("Device.WiFi.SSID.*.SSID", {path: h, value: quando})) todas.push(p);
  todas.sort(function (a, b) { return a.path.localeCompare(b.path, "en", {numeric: true}); });
  let principal = null;
  for (const p of todas) if (p.value && p.value[0]) { principal = p; break; }
  if (!principal) principal = todas[0] || null;
  const nome = principal && principal.value ? principal.value[0] : null;
  const escolhidas = [];
  for (const p of todas) if (p === principal || (nome && p.value && p.value[0] === nome)) escolhidas.push(p);
  return {principal: principal, escolhidas: escolhidas};
}
`;

const VIRTUAIS = {
  dmk_pppoe: `// DMK ACS - login PPPoE do cliente (liga o roteador ao cadastro do cliente)
const h = Date.now(3600000);
const quando = (args[0] && args[0].value) || Date.now();
let v = "";
for (const p of declare("InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Username", {path: h, value: quando})) if (!v && p.value && p.value[0]) v = p.value[0];
if (!v) for (const p of declare("Device.PPP.Interface.*.Username", {path: h, value: quando})) if (!v && p.value && p.value[0]) v = p.value[0];
return {writable: false, value: [v, "xsd:string"]};
`,

  dmk_wifi_ssid: `// DMK ACS - nome do Wi-Fi (le da rede principal; grava na principal e nas de mesmo nome)
${REDES}
const quando = (args[0] && args[0].value) || Date.now();
const r = redesWifi(quando);
if (args[1] && args[1].value) {
  const novo = args[1].value[0];
  for (const p of r.escolhidas) declare(p.path, null, {value: novo});
  return {writable: true, value: [novo, "xsd:string"]};
}
return {writable: true, value: [r.principal && r.principal.value ? r.principal.value[0] : "", "xsd:string"]};
`,

  dmk_wifi_senha: `// DMK ACS - senha do Wi-Fi. Roteador nao devolve senha: a leitura e sempre vazia
// (assim a senha tambem nao fica guardada no banco do ACS).
${REDES}
if (!(args[1] && args[1].value)) return {writable: true, value: ["", "xsd:string"]};
const nova = args[1].value[0];
const h = Date.now(3600000);
const r = redesWifi(1);
for (const p of r.escolhidas) {
  const partes = p.path.split(".");
  let candidatos;
  if (partes[0] === "InternetGatewayDevice") {
    const base = partes.slice(0, 5).join(".");   // InternetGatewayDevice.LANDevice.1.WLANConfiguration.N
    candidatos = [base + ".KeyPassphrase", base + ".PreSharedKey.1.KeyPassphrase", base + ".PreSharedKey.1.PreSharedKey"];
  } else {
    candidatos = ["Device.WiFi.AccessPoint." + partes[3] + ".Security.KeyPassphrase"];   // AccessPoint N = SSID N
  }
  // Grava so no primeiro campo que o modelo tem (gravar campo inexistente derruba o comando inteiro)
  for (const c of candidatos) if (declare(c, {path: h}).size) { declare(c, null, {value: nova}); break; }
}
return {writable: true, value: [nova, "xsd:string"]};
`,
};

const PRESET = {
  weight: 0,
  channel: 'dmk',
  precondition: '',
  events: {},
  configurations: [{ type: 'provision', name: 'dmk', args: null }],
};

/**
 * Configuração BÁSICA do GenieACS (a mesma que o assistente "INITIALIZE" do painel técnico cria).
 * Numa VPS nova ninguém abre esse assistente; sem o "inform" o ACS não consegue chamar o roteador
 * na hora (connection request). O painel cria só o que FALTA: nunca sobrescreve o que já existe.
 */
const BASE = {
  provisions: {
    bootstrap: `const now = Date.now();

// Clear cached data model to force a refresh
clear("Device", now);
clear("InternetGatewayDevice", now);`,
    default: `const hourly = Date.now(3600000);

// Refresh basic parameters hourly
declare("InternetGatewayDevice.DeviceInfo.HardwareVersion", {path: hourly, value: hourly});
declare("InternetGatewayDevice.DeviceInfo.SoftwareVersion", {path: hourly, value: hourly});
declare("InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.MACAddress", {path: hourly, value: hourly});
declare("InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.ExternalIPAddress", {path: hourly, value: hourly});
declare("InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.SSID", {path: hourly, value: hourly});
declare("InternetGatewayDevice.LANDevice.*.Hosts.Host.*.HostName", {path: hourly, value: hourly});
declare("InternetGatewayDevice.LANDevice.*.Hosts.Host.*.IPAddress", {path: hourly, value: hourly});
declare("InternetGatewayDevice.LANDevice.*.Hosts.Host.*.MACAddress", {path: hourly, value: hourly});`,
    inform: `// Device ID as user name
const username = declare("DeviceID.ID", {value: 1}).value[0]

// Password will be fixed for a given device because Math.random() is seeded with device ID by default.
const password = Math.trunc(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);

const informInterval = 300;

// Refresh values daily
const daily = Date.now(86400000);

// Unique inform offset per device for better load distribution
const informTime = daily % 86400000;

declare("InternetGatewayDevice.ManagementServer.ConnectionRequestUsername", {value: daily}, {value: username});
declare("InternetGatewayDevice.ManagementServer.ConnectionRequestPassword", {value: daily}, {value: password});
declare("InternetGatewayDevice.ManagementServer.PeriodicInformEnable", {value: daily}, {value: true});
declare("InternetGatewayDevice.ManagementServer.PeriodicInformInterval", {value: daily}, {value: informInterval});
declare("InternetGatewayDevice.ManagementServer.PeriodicInformTime", {value: daily}, {value: informTime});

declare("Device.ManagementServer.ConnectionRequestUsername", {value: daily}, {value: username});
declare("Device.ManagementServer.ConnectionRequestPassword", {value: daily}, {value: password});
declare("Device.ManagementServer.PeriodicInformEnable", {value: daily}, {value: true});
declare("Device.ManagementServer.PeriodicInformInterval", {value: daily}, {value: informInterval});
declare("Device.ManagementServer.PeriodicInformTime", {value: daily}, {value: informTime});`,
  },
  presets: {
    bootstrap: { weight: 0, channel: 'bootstrap', events: { '0 BOOTSTRAP': true }, precondition: '', configurations: [{ type: 'provision', name: 'bootstrap', args: null }] },
    default: { weight: 0, channel: 'default', precondition: '', events: {}, configurations: [{ type: 'provision', name: 'default', args: null }] },
    inform: { weight: 0, channel: 'inform', precondition: '', events: {}, configurations: [{ type: 'provision', name: 'inform', args: null }] },
  },
};

module.exports = { chaveDoEndereco, PROVISION, VIRTUAIS, PRESET, BASE };
