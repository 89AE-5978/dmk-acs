'use strict';
/**
 * Cliente da API NBI do GenieACS (só na própria máquina: 127.0.0.1:7557).
 * Nada daqui fica exposto na internet: o painel é a única porta de entrada.
 */
const http = require('node:http');

// Códigos de falha TR-069 mais comuns, em português
const FALHAS = {
  9000: 'este modelo não aceita esse comando',
  9001: 'pedido negado pelo roteador',
  9002: 'erro interno do roteador',
  9005: 'este modelo não tem esse campo (precisa de perfil para o modelo)',
  9007: 'valor recusado pelo roteador',
  9008: 'campo somente leitura neste modelo',
};
function explicarFalha(f) {
  const n = Number(String(f.code || '').replace(/^cwmp\./, ''));
  return FALHAS[n] ? `${FALHAS[n]} (código ${n}).` : `${f.message || f.code}.`;
}

function criarNbi(base) {
  const alvo = new URL(base);

  function pedir(metodo, caminho, corpo, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      const dados = corpo == null ? null : Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
      const req = http.request({
        hostname: alvo.hostname, port: alvo.port || 80, method: metodo, path: caminho,
        headers: dados ? { 'Content-Type': 'application/json', 'Content-Length': dados.length } : {},
      }, (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => {
          const texto = Buffer.concat(partes).toString('utf8');
          let json = null;
          try { json = texto ? JSON.parse(texto) : null; } catch { /* resposta em texto */ }
          resolve({ status: res.statusCode, json, texto });
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('O ACS não respondeu a tempo.'), { status: 504 })));
      req.on('error', (e) => reject(e.status ? e : Object.assign(new Error(`ACS indisponível (${e.code || e.message}).`), { status: 502 })));
      if (dados) req.write(dados);
      req.end();
    });
  }

  async function exigirOk(resposta, oque) {
    if (resposta.status >= 200 && resposta.status < 300) return resposta;
    throw Object.assign(new Error(`${oque}: o ACS respondeu ${resposta.status}${resposta.texto ? ' - ' + resposta.texto.slice(0, 200) : ''}`), { status: 502 });
  }

  return {
    pedir,

    /** Lista dispositivos. query é um objeto (filtro do GenieACS); projecao, lista de campos. */
    async dispositivos(query, projecao) {
      const qs = new URLSearchParams({ query: JSON.stringify(query || {}) });
      if (projecao && projecao.length) qs.set('projection', projecao.join(','));
      const r = await exigirOk(await pedir('GET', `/devices/?${qs}`), 'Listar roteadores');
      return Array.isArray(r.json) ? r.json : [];
    },

    /**
     * Cria uma tarefa e pede para o roteador se conectar na hora.
     * Volta 'aplicado' (o roteador atendeu e fez) ou 'na-fila' (roteador não atendeu agora,
     * ex.: atrás de CGNAT; a tarefa roda sozinha no próximo contato dele, em até 5 min).
     */
    async tarefa(idDispositivo, tarefa) {
      const caminho = `/devices/${encodeURIComponent(idDispositivo)}/tasks?connection_request&timeout=8000`;
      const r = await pedir('POST', caminho, tarefa, { timeoutMs: 30000 });
      if (r.status === 200) return 'aplicado';
      if (r.status !== 202) { await exigirOk(r, 'Enviar comando ao roteador'); return 'na-fila'; }

      // 202 = não terminou. Pode ser roteador que não atendeu (fica na fila) OU roteador que
      // atendeu e RECUSOU o comando (falha gravada no canal da tarefa). No segundo caso o painel
      // avisa a recusa e limpa tarefa + falha, para o comando não ficar pendurado no ACS.
      const idTarefa = r.json && r.json._id;
      if (idTarefa) {
        const q = encodeURIComponent(JSON.stringify({ _id: `${idDispositivo}:task_${idTarefa}` }));
        const f = await pedir('GET', `/faults/?query=${q}`);
        const falha = Array.isArray(f.json) && f.json[0];
        if (falha) {
          await pedir('DELETE', `/tasks/${encodeURIComponent(idTarefa)}`);
          await pedir('DELETE', `/faults/${encodeURIComponent(falha._id)}`);
          throw Object.assign(new Error(`O roteador recusou o comando: ${explicarFalha(falha)}`), { status: 422 });
        }
      }
      return 'na-fila';
    },

    /** Existe um registro com esse _id na coleção (provisions, presets...)? */
    async existe(colecao, id) {
      const q = encodeURIComponent(JSON.stringify({ _id: id }));
      const r = await exigirOk(await pedir('GET', `/${colecao}/?query=${q}`), `Consultar ${colecao}`);
      return Array.isArray(r.json) && r.json.length > 0;
    },

    async gravarProvision(nome, script) {
      await exigirOk(await pedir('PUT', `/provisions/${encodeURIComponent(nome)}`, script), `Gravar provision ${nome}`);
    },
    async gravarVirtual(nome, script) {
      await exigirOk(await pedir('PUT', `/virtual_parameters/${encodeURIComponent(nome)}`, script), `Gravar parâmetro ${nome}`);
    },
    async gravarPreset(nome, preset) {
      await exigirOk(await pedir('PUT', `/presets/${encodeURIComponent(nome)}`, preset), `Gravar preset ${nome}`);
    },
    async removerPreset(nome) { await pedir('DELETE', `/presets/${encodeURIComponent(nome)}`); },
    async removerProvision(nome) { await pedir('DELETE', `/provisions/${encodeURIComponent(nome)}`); },
    async removerVirtual(nome) { await pedir('DELETE', `/virtual_parameters/${encodeURIComponent(nome)}`); },
  };
}

module.exports = { criarNbi };
