'use strict';
/**
 * Roda os parâmetros virtuais do DMK (scripts que vão para dentro do GenieACS) contra roteadores
 * simulados TR-098 e TR-181, com um declare() que imita o do GenieACS (curinga "*", leitura e
 * gravação). Confere IP de internet, canais 2,4/5 GHz (ler e gravar) e a lista de aparelhos.
 */
const assert = require('assert');
const { VIRTUAIS } = require('../servidor/lib/scripts-genieacs');

function roteador(params) {
  const gravados = {};
  const casa = (padrao, caminho) => {
    const a = padrao.split('.'), b = caminho.split('.');
    return a.length === b.length && a.every((x, i) => x === '*' || x === b[i]);
  };
  function declare(padrao, _atrib, valores) {
    const achados = Object.keys(params).filter((k) => casa(padrao, k));
    if (valores && 'value' in valores) for (const k of achados) { params[k] = valores.value; gravados[k] = valores.value; }
    const lista = achados.map((k) => ({ path: k, value: [params[k], typeof params[k] === 'number' ? 'xsd:unsignedInt' : 'xsd:string'] }));
    lista.size = lista.length;
    return lista;
  }
  const rodar = (nome, novo) => {
    const DateFalso = { now: () => 1 };
    const args = novo === undefined ? [{ value: 1 }] : [{ value: 1 }, { value: [novo, 'xsd:string'] }];
    return new Function('declare', 'args', 'Date', VIRTUAIS[nome])(declare, args, DateFalso).value[0];
  };
  return { rodar, gravados, params };
}

// ---------------------------------------------------------------- TR-098 (ex.: Huawei, ZTE, TP-Link)
const W = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration';
const r98 = roteador({
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress': '0.0.0.0',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.ExternalIPAddress': '177.10.20.30',
  [`${W}.1.Channel`]: 6, [`${W}.1.AutoChannelEnable`]: true, [`${W}.1.PossibleChannels`]: '1-13', [`${W}.1.Standard`]: 'b,g,n',
  [`${W}.2.Channel`]: 6, [`${W}.2.AutoChannelEnable`]: true, [`${W}.2.PossibleChannels`]: '1-13', [`${W}.2.Standard`]: 'b,g,n',   // rede de visitante, mesmo rádio
  [`${W}.5.Channel`]: 44, [`${W}.5.AutoChannelEnable`]: false, [`${W}.5.PossibleChannels`]: '36,40,44,48,149,153', [`${W}.5.Standard`]: 'a,n,ac',
  [`${W}.1.AssociatedDevice.1.AssociatedDeviceMACAddress`]: 'AA:AA:AA:00:00:01', [`${W}.1.AssociatedDevice.1.AssociatedDeviceIPAddress`]: '192.168.1.10',
  [`${W}.5.AssociatedDevice.1.AssociatedDeviceMACAddress`]: 'AA:AA:AA:00:00:02', [`${W}.5.AssociatedDevice.1.AssociatedDeviceIPAddress`]: '192.168.1.11',
  'InternetGatewayDevice.LANDevice.1.Hosts.Host.1.MACAddress': 'aa:aa:aa:00:00:01', 'InternetGatewayDevice.LANDevice.1.Hosts.Host.1.HostName': 'Celular-Ana',
  'InternetGatewayDevice.LANDevice.1.Hosts.Host.1.IPAddress': '192.168.1.10', 'InternetGatewayDevice.LANDevice.1.Hosts.Host.1.Active': true, 'InternetGatewayDevice.LANDevice.1.Hosts.Host.1.InterfaceType': '802.11',
  'InternetGatewayDevice.LANDevice.1.Hosts.Host.2.MACAddress': 'BB:BB:BB:00:00:03', 'InternetGatewayDevice.LANDevice.1.Hosts.Host.2.HostName': 'PC-Sala',
  'InternetGatewayDevice.LANDevice.1.Hosts.Host.2.IPAddress': '192.168.1.20', 'InternetGatewayDevice.LANDevice.1.Hosts.Host.2.Active': true, 'InternetGatewayDevice.LANDevice.1.Hosts.Host.2.InterfaceType': 'Ethernet',
  'InternetGatewayDevice.LANDevice.1.Hosts.Host.4.MACAddress': 'EE:EE:EE:00:00:06', 'InternetGatewayDevice.LANDevice.1.Hosts.Host.4.HostName': 'Tablet',
  'InternetGatewayDevice.LANDevice.1.Hosts.Host.4.IPAddress': '192.168.1.40', 'InternetGatewayDevice.LANDevice.1.Hosts.Host.4.Active': true,
  'InternetGatewayDevice.LANDevice.1.Hosts.Host.4.Layer2Interface': 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5',   // Huawei: sem InterfaceType
  'InternetGatewayDevice.LANDevice.1.Hosts.Host.3.MACAddress': 'CC:CC:CC:00:00:04', 'InternetGatewayDevice.LANDevice.1.Hosts.Host.3.HostName': 'TV-desligada',
  'InternetGatewayDevice.LANDevice.1.Hosts.Host.3.IPAddress': '192.168.1.30', 'InternetGatewayDevice.LANDevice.1.Hosts.Host.3.Active': false, 'InternetGatewayDevice.LANDevice.1.Hosts.Host.3.InterfaceType': 'Ethernet',
});
assert.equal(r98.rodar('dmk_wan_ip'), '177.10.20.30', 'TR-098: IP do PPPoE (pula o 0.0.0.0)');
assert.equal(r98.rodar('dmk_canal_24'), 'auto|6|1-13');
assert.equal(r98.rodar('dmk_canal_5'), '44|44|36,40,44,48,149,153');
let ap = JSON.parse(r98.rodar('dmk_aparelhos'));
assert.deepEqual(ap.map((a) => [a.n, a.c]), [['Celular-Ana', '24'], ['PC-Sala', 'cabo'], ['Tablet', '5'], ['', '5']], 'TR-098: Wi-Fi com faixa, cabo, desligado fora, associado sem host entra');
assert.equal(ap[3].i, '192.168.1.11');
assert.equal(r98.rodar('dmk_canal_24', '11'), '11', 'gravação devolve o próprio valor (senão o GenieACS repete o commit)');
assert.equal(r98.gravados[`${W}.1.AutoChannelEnable`], false); assert.equal(r98.gravados[`${W}.1.Channel`], 11);
assert.equal(r98.gravados[`${W}.2.Channel`], undefined, 'rede de visitante não é mexida');
assert.equal(r98.rodar('dmk_canal_5', 'auto'), 'auto');
assert.equal(r98.gravados[`${W}.5.AutoChannelEnable`], true);
assert.equal(r98.gravados[`${W}.5.Channel`], undefined, 'automático não grava canal fixo');
console.log('ok  TR-098: IP, canais (ler/gravar) e aparelhos');

// ---------------------------------------------------------------- TR-181 (Device.)
const r181 = roteador({
  'Device.PPP.Interface.1.IPCP.LocalIPAddress': '100.64.1.2',
  'Device.IP.Interface.1.IPv4Address.1.IPAddress': '192.168.0.1',
  'Device.WiFi.Radio.1.Channel': 1, 'Device.WiFi.Radio.1.AutoChannelEnable': false, 'Device.WiFi.Radio.1.PossibleChannels': '1,2,3,4,5,6,7,8,9,10,11', 'Device.WiFi.Radio.1.OperatingFrequencyBand': '2.4GHz',
  'Device.WiFi.Radio.2.Channel': 149, 'Device.WiFi.Radio.2.AutoChannelEnable': true, 'Device.WiFi.Radio.2.PossibleChannels': '36,40,149', 'Device.WiFi.Radio.2.OperatingFrequencyBand': '5GHz',
  'Device.WiFi.SSID.1.LowerLayers': 'Device.WiFi.Radio.1.', 'Device.WiFi.SSID.2.LowerLayers': 'Device.WiFi.Radio.2.',
  'Device.WiFi.AccessPoint.1.SSIDReference': 'Device.WiFi.SSID.1.', 'Device.WiFi.AccessPoint.2.SSIDReference': 'Device.WiFi.SSID.2.',
  'Device.WiFi.AccessPoint.2.AssociatedDevice.1.MACAddress': 'DD:DD:DD:00:00:05',
  'Device.Hosts.Host.1.PhysAddress': 'dd:dd:dd:00:00:05', 'Device.Hosts.Host.1.HostName': 'Notebook', 'Device.Hosts.Host.1.IPAddress': '192.168.0.50',
  'Device.Hosts.Host.1.Active': true, 'Device.Hosts.Host.1.Layer1Interface': 'Device.WiFi.SSID.2.',
});
assert.equal(r181.rodar('dmk_wan_ip'), '100.64.1.2', 'TR-181: IP do PPPoE (CGNAT conta como internet)');
assert.equal(r181.rodar('dmk_canal_24'), '1|1|1,2,3,4,5,6,7,8,9,10,11');
assert.equal(r181.rodar('dmk_canal_5'), 'auto|149|36,40,149');
ap = JSON.parse(r181.rodar('dmk_aparelhos'));
assert.deepEqual(ap, [{ n: 'Notebook', m: 'dd:dd:dd:00:00:05', i: '192.168.0.50', c: '5' }], 'TR-181: faixa pelo AccessPoint -> SSID -> Radio');
r181.rodar('dmk_canal_5', '36');
assert.equal(r181.gravados['Device.WiFi.Radio.2.AutoChannelEnable'], false); assert.equal(r181.gravados['Device.WiFi.Radio.2.Channel'], 36);
console.log('ok  TR-181: IP, canais (ler/gravar) e aparelhos');

// Roteador só 2,4 GHz: canal 5 GHz vazio (o painel esconde)
const so24 = roteador({ [`${W}.1.Channel`]: 3, [`${W}.1.AutoChannelEnable`]: false, [`${W}.1.Standard`]: 'b,g,n' });
assert.equal(so24.rodar('dmk_canal_5'), '');
assert.equal(so24.rodar('dmk_wan_ip'), '');
console.log('teste-scripts: OK (todos os passos)');
