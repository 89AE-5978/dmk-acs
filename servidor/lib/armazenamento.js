'use strict';
/**
 * Provedores do DMK ACS, num JSON pequeno em <dados>/provedores.json.
 * Gravação atômica (arquivo temporário + rename): queda de energia não deixa o arquivo pela metade.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chaveDoEndereco } = require('./scripts-genieacs');

const ID_VALIDO = /^[a-z0-9][a-z0-9-]{1,39}$/;

function normalizarEndereco(texto) {
  let s = String(texto || '').trim();
  if (!s) return '';
  if (!/^[a-z]+:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash) return null;
  // CWMP sem porta informada: 7547 (padrão TR-069), para o roteador não cair na porta 80.
  if (!u.port && u.protocol === 'http:') u.port = '7547';
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}/`;
}

function criarArmazenamento(pastaDados) {
  const arquivo = path.join(pastaDados, 'provedores.json');
  fs.mkdirSync(pastaDados, { recursive: true });

  function ler() {
    try {
      const d = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      return Array.isArray(d.provedores) ? d : { versao: 1, provedores: [] };
    } catch (e) {
      if (e.code === 'ENOENT') return { versao: 1, provedores: [] };
      throw new Error('provedores.json ilegível: ' + e.message);
    }
  }
  function gravar(dados) {
    const tmp = arquivo + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(dados, null, 2));
    fs.renameSync(tmp, arquivo);
  }

  function validar(entrada, existentes, idAtual) {
    const nome = String(entrada.nome ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
    if (nome.length < 2 || nome.length > 80) throw new Erro400('Informe o nome do provedor (2 a 80 letras).', 'nome');
    const endereco = normalizarEndereco(entrada.enderecoAcs);
    if (endereco === null || !endereco) throw new Erro400('Endereço do ACS inválido. Ex.: acs.provedor.com.br ou http://acs.provedor.com.br:7547/', 'enderecoAcs');
    if (/^\/c(\/|$)/i.test(new URL(endereco).pathname)) throw new Erro400('O caminho /c/ é reservado para os clientes avulsos. Use o domínio do provedor (ex.: acs.provedor.com.br).', 'enderecoAcs');
    const chave = chaveDoEndereco(endereco);
    const dono = existentes.find((p) => p.id !== idAtual && chaveDoEndereco(p.enderecoAcs) === chave);
    if (dono) throw new Erro400(`Esse endereço já é do provedor ${dono.nome}. Cada provedor precisa do seu.`, 'enderecoAcs');
    return { nome, enderecoAcs: endereco };
  }

  return {
    listar() { return ler().provedores; },
    obter(id) { return ler().provedores.find((p) => p.id === id) || null; },

    criar(entrada) {
      const dados = ler();
      const id = String(entrada.id || '').trim().toLowerCase();
      if (!ID_VALIDO.test(id)) throw new Erro400('Código do provedor: letras minúsculas, números e hífen (ex.: starnet).', 'id');
      if (dados.provedores.some((p) => p.id === id)) throw new Erro400('Já existe provedor com esse código.', 'id');
      const agora = new Date().toISOString();
      const p = { id, ...validar(entrada, dados.provedores, id), ativo: entrada.ativo !== false, criadoEm: agora, atualizadoEm: agora };
      dados.provedores.push(p);
      gravar(dados);
      return p;
    },

    alterar(id, entrada) {
      const dados = ler();
      const p = dados.provedores.find((x) => x.id === id);
      if (!p) return null;
      const base = { nome: entrada.nome ?? p.nome, enderecoAcs: entrada.enderecoAcs ?? p.enderecoAcs };
      Object.assign(p, validar(base, dados.provedores, id));
      if (typeof entrada.ativo === 'boolean') p.ativo = entrada.ativo;
      p.atualizadoEm = new Date().toISOString();
      gravar(dados);
      return p;
    },

    remover(id) {
      const dados = ler();
      const antes = dados.provedores.length;
      dados.provedores = dados.provedores.filter((p) => p.id !== id);
      if (dados.provedores.length === antes) return false;
      gravar(dados);
      return true;
    },
  };
}

class Erro400 extends Error {
  constructor(mensagem, campo) { super(mensagem); this.status = 400; this.campo = campo; }
}

module.exports = { criarArmazenamento, normalizarEndereco, Erro400 };
