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
declare("VirtualParameters.dmk_wan_ip", {value: cinco});
declare("VirtualParameters.dmk_canal_24", {value: cinco});
declare("VirtualParameters.dmk_canal_5", {value: cinco});
// dmk_aparelhos NAO entra aqui: a lista de aparelhos e lida so quando alguem abre a tela (pesada).
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

// Radios (2,4 e 5 GHz) do roteador: o 1o de cada faixa. TR-098 nao diz a faixa direto: vem dos
// canais possiveis, do canal atual (> 14 = 5 GHz) ou do padrao (a/ac/ax sem b/g = 5 GHz).
const RADIOS = `
function faixaDe(canal, possiveis, padrao, faixa) {
  if (faixa) return String(faixa).indexOf("5") === 0 ? "5" : "24";
  const nums = String(possiveis || "").match(/\\d+/g) || [];
  for (const n of nums) if (Number(n) >= 36) return "5";
  if (Number(canal) > 14) return "5";
  const p = String(padrao || "").toLowerCase();
  if (/(^|[^a-z])a(c|x)?($|[^a-z])/.test(p) && !/[bg]/.test(p)) return "5";
  return "24";
}
function radios(quando) {
  const h = Date.now(3600000);
  const porBase = {};
  const ler = function (padrao, campo) {
    for (const p of declare(padrao + "." + campo, {path: h, value: quando})) {
      const base = p.path.slice(0, p.path.length - campo.length - 1);
      porBase[base] = porBase[base] || {base: base};
      porBase[base][campo] = p.value ? p.value[0] : "";
    }
  };
  for (const c of ["Channel", "AutoChannelEnable", "PossibleChannels", "Standard"]) ler("InternetGatewayDevice.LANDevice.1.WLANConfiguration.*", c);
  for (const c of ["Channel", "AutoChannelEnable", "PossibleChannels", "OperatingFrequencyBand"]) ler("Device.WiFi.Radio.*", c);
  const lista = Object.keys(porBase).map(function (k) { return porBase[k]; });
  lista.sort(function (a, b) { return a.base.localeCompare(b.base, "en", {numeric: true}); });
  const r = {};
  for (const x of lista) {
    if (x.Channel === undefined && x.AutoChannelEnable === undefined) continue;
    const f = faixaDe(x.Channel, x.PossibleChannels, x.Standard, x.OperatingFrequencyBand);
    if (!r[f]) r[f] = x;
  }
  return r;
}
`;

function canalVirtual(faixa) {
  return `// DMK ACS - canal do Wi-Fi ${faixa === '24' ? '2,4' : '5'} GHz. Leitura: "auto|<atual>|<possiveis>" ou "<n>|<n>|<possiveis>"
// ("" quando o roteador nao tem essa faixa). Gravacao: "auto" ou o numero do canal (devolve o proprio valor).
${RADIOS}
const quando = (args[0] && args[0].value) || Date.now();
const r = radios(args[1] && args[1].value ? 1 : quando)["${faixa}"];
if (!r) return {writable: true, value: ["", "xsd:string"]};
const h = Date.now(3600000);
if (args[1] && args[1].value) {
  const novo = String(args[1].value[0]);
  const temAuto = declare(r.base + ".AutoChannelEnable", {path: h}).size;
  if (novo === "auto") {
    if (temAuto) declare(r.base + ".AutoChannelEnable", null, {value: true});
  } else {
    if (temAuto) declare(r.base + ".AutoChannelEnable", null, {value: false});
    declare(r.base + ".Channel", null, {value: Number(novo)});
  }
  // Na gravacao o valor devolvido tem de ser IGUAL ao gravado (senao o GenieACS repete o commit
  // ate desistir: "Too many commit iterations"). O formato completo volta na proxima leitura.
  return {writable: true, value: [novo, "xsd:string"]};
}
const auto = r.AutoChannelEnable === true || r.AutoChannelEnable === "true" || r.AutoChannelEnable === 1 || r.AutoChannelEnable === "1";
return {writable: true, value: [(auto ? "auto" : String(r.Channel || "")) + "|" + String(r.Channel || "") + "|" + String(r.PossibleChannels || ""), "xsd:string"]};
`;
}

const VIRTUAIS = {
  dmk_pppoe: `// DMK ACS - login PPPoE do cliente (liga o roteador ao cadastro do cliente)
const h = Date.now(3600000);
const quando = (args[0] && args[0].value) || Date.now();
let v = "";
for (const p of declare("InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Username", {path: h, value: quando})) if (!v && p.value && p.value[0]) v = p.value[0];
if (!v) for (const p of declare("Device.PPP.Interface.*.Username", {path: h, value: quando})) if (!v && p.value && p.value[0]) v = p.value[0];
return {writable: false, value: [v, "xsd:string"]};
`,

  dmk_wan_ip: `// DMK ACS - IP de internet do roteador (WAN: PPPoE ou IP), o primeiro que nao e de rede local
const h = Date.now(3600000);
const quando = (args[0] && args[0].value) || Date.now();
const local = function (ip) { return !ip || ip === "0.0.0.0" || /^(127\\.|169\\.254\\.|192\\.168\\.)/.test(ip); };
let v = "";
for (const c of [
  "InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.ExternalIPAddress",
  "InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.ExternalIPAddress",
  "Device.PPP.Interface.*.IPCP.LocalIPAddress",
  "Device.IP.Interface.*.IPv4Address.*.IPAddress",
]) {
  if (v) break;
  for (const p of declare(c, {path: h, value: quando})) if (!v && p.value && !local(String(p.value[0]))) v = String(p.value[0]);
}
return {writable: false, value: [v, "xsd:string"]};
`,

  dmk_canal_24: canalVirtual('24'),
  dmk_canal_5: canalVirtual('5'),

  dmk_aparelhos: `// DMK ACS - aparelhos conectados (tabela de hosts + clientes do Wi-Fi), em JSON:
// [{"n": nome, "m": mac, "i": ip, "c": "24" | "5" | "wifi" | "cabo"}]. So lido quando pedido.
${RADIOS}
const quando = (args[0] && args[0].value) || Date.now();
const h = Date.now(3600000);
const mac = function (x) { return String(x || "").toLowerCase(); };
const grupo = function (padrao, campos) {
  const porBase = {};
  for (const campo of campos) for (const p of declare(padrao + "." + campo, {path: quando, value: quando})) {
    const base = p.path.slice(0, p.path.length - campo.length - 1);
    porBase[base] = porBase[base] || {};
    porBase[base][campo] = p.value ? p.value[0] : "";
  }
  return Object.keys(porBase).map(function (k) { porBase[k]._base = k; return porBase[k]; });
};
// Faixa de cada rede Wi-Fi (TR-098: a propria WLANConfiguration; TR-181: AccessPoint -> SSID -> Radio)
const faixaDaRede = {};
const rs = radios(h);
for (const f of Object.keys(rs)) faixaDaRede[rs[f].base] = f;
const wifi = {};
// Faixa de cada WLANConfiguration pelos dados ja lidos (sem ir de novo ao roteador por aparelho)
const confRede = {};
for (const campo of ["Channel", "PossibleChannels", "Standard"]) for (const p of declare("InternetGatewayDevice.LANDevice.1.WLANConfiguration.*." + campo, {path: h, value: h})) {
  const base = p.path.slice(0, p.path.length - campo.length - 1);
  confRede[base] = confRede[base] || {};
  confRede[base][campo] = p.value ? p.value[0] : "";
}
for (const a of grupo("InternetGatewayDevice.LANDevice.1.WLANConfiguration.*.AssociatedDevice.*", ["AssociatedDeviceMACAddress", "AssociatedDeviceIPAddress"])) {
  const rede = a._base.split(".").slice(0, 5).join(".");
  const conf = confRede[rede] || {};
  wifi[mac(a.AssociatedDeviceMACAddress)] = {ip: a.AssociatedDeviceIPAddress, c: faixaDaRede[rede] || faixaDe(conf.Channel, conf.PossibleChannels, conf.Standard)};
}
for (const a of grupo("Device.WiFi.AccessPoint.*.AssociatedDevice.*", ["MACAddress"])) {
  const ap = a._base.split(".").slice(0, 4).join(".");
  let c = "wifi";
  for (const s of declare(ap + ".SSIDReference", {path: h, value: h})) {
    const ssid = String(s.value ? s.value[0] : "").replace(/\\.$/, "");
    for (const l of declare(ssid + ".LowerLayers", {path: h, value: h})) {
      const radio = String(l.value ? l.value[0] : "").replace(/\\.$/, "");
      if (faixaDaRede[radio]) c = faixaDaRede[radio];
    }
  }
  wifi[mac(a.MACAddress)] = {ip: "", c: c};
}
const lista = [];
const vistos = {};
const hosts = grupo("InternetGatewayDevice.LANDevice.1.Hosts.Host.*", ["MACAddress", "HostName", "IPAddress", "Active", "InterfaceType", "Layer2Interface"])
  .concat(grupo("Device.Hosts.Host.*", ["PhysAddress", "HostName", "IPAddress", "Active", "Layer1Interface"]));
for (const x of hosts) {
  const m = mac(x.MACAddress || x.PhysAddress);
  if (!m || vistos[m]) continue;
  const ativo = !(x.Active === false || x.Active === "false" || x.Active === 0 || x.Active === "0");
  if (!ativo && !wifi[m]) continue;
  vistos[m] = true;
  const tipo = String(x.InterfaceType || "") + " " + String(x.Layer2Interface || x.Layer1Interface || "");
  // Sem estar na lista do Wi-Fi: a interface diz (WLANConfiguration N -> faixa daquela rede)
  const rede = (/InternetGatewayDevice\\.LANDevice\\.1\\.WLANConfiguration\\.\\d+/.exec(tipo) || [])[0];
  const c = wifi[m] ? wifi[m].c : rede ? (faixaDaRede[rede] || "wifi") : (/802\\.11|wifi|wlan|wireless/i.test(tipo) ? "wifi" : "cabo");
  lista.push({n: String(x.HostName || ""), m: m, i: String(x.IPAddress || (wifi[m] && wifi[m].ip) || ""), c: c});
}
for (const m of Object.keys(wifi)) if (!vistos[m]) lista.push({n: "", m: m, i: String(wifi[m].ip || ""), c: wifi[m].c});
return {writable: false, value: [JSON.stringify(lista.slice(0, 150)), "xsd:string"]};
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
