'use strict';
/**
 * Entrada no painel por TICKET assinado (é assim que o DMK Prisma abre o módulo).
 *
 * O DMK Prisma já autenticou a pessoa e sabe se ela é da Central (admin DMK) ou de qual provedor.
 * Ele gera um ticket curto (60 s), assinado com o segredo de integração que só ele e o DMK ACS
 * conhecem, e abre /entrar?ticket=... . O DMK ACS confere a assinatura e cria a sessão (cookie).
 * Sem ticket válido não há como entrar: o painel não tem usuário/senha próprios.
 *
 *   ticket = base64url(JSON {papel:'central'|'provedor', provedor?, nome, exp}) + "." + HMAC-SHA256
 */
const crypto = require('node:crypto');

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function criarSessoes(segredo, { duracaoHoras = 12 } = {}) {
  if (!segredo || segredo.length < 32) throw new Error('Segredo de integração ausente ou curto (mínimo 32 caracteres).');
  const sessoes = new Map();
  const usados = new Map();   // ticket só vale uma vez (até expirar)

  const assinar = (corpo) => b64(crypto.createHmac('sha256', segredo).update(corpo).digest());   // usa o segredo atual

  function gerarTicket(dados, validadeSeg = 60) {
    const corpo = b64(JSON.stringify({ ...dados, exp: Math.floor(Date.now() / 1000) + validadeSeg, n: b64(crypto.randomBytes(9)) }));
    return `${corpo}.${assinar(corpo)}`;
  }

  function lerTicket(ticket) {
    const [corpo, assinatura] = String(ticket || '').split('.');
    if (!corpo || !assinatura) return null;
    const esperado = Buffer.from(assinar(corpo));
    const recebido = Buffer.from(assinatura);
    if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;
    let d;
    try { d = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')); } catch { return null; }
    if (!d || typeof d.exp !== 'number' || d.exp * 1000 < Date.now()) return null;
    if (d.papel !== 'central' && !(d.papel === 'provedor' && typeof d.provedor === 'string')) return null;
    if (usados.has(corpo)) return null;
    usados.set(corpo, d.exp * 1000);
    return { papel: d.papel, provedor: d.papel === 'provedor' ? d.provedor : null, nome: String(d.nome || '').slice(0, 80) };
  }

  /**
   * Cria a sessão. dados.duracaoMs = validade máxima (padrão 12 h); dados.inatividadeMs = cai
   * sozinha depois desse tempo sem uso (o login do admin usa 30 min).
   */
  function criar(dados) {
    const token = b64(crypto.randomBytes(32));
    const agora = Date.now();
    sessoes.set(token, { ...dados, criada: agora, ultimoUso: agora, expira: agora + (dados.duracaoMs || duracaoHoras * 3600e3) });
    return token;
  }

  function obter(token) {
    const s = token && sessoes.get(token);
    if (!s) return null;
    const agora = Date.now();
    if (s.expira < agora || (s.inatividadeMs && agora - s.ultimoUso > s.inatividadeMs)) { sessoes.delete(token); return null; }
    s.ultimoUso = agora;
    return s;
  }

  /** Encerra todas as sessões que batem com o filtro (ex.: depois de trocar a senha). */
  function encerrarOnde(filtro) { for (const [k, v] of sessoes) if (filtro(v)) sessoes.delete(k); }

  /** Troca o segredo de integração (tickets antigos deixam de valer na hora). */
  function trocarSegredo(novo) {
    if (!novo || novo.length < 32) throw new Error('Segredo curto.');
    segredo = novo;
  }

  // Limpeza periódica (sessões e tickets vencidos)
  setInterval(() => {
    const agora = Date.now();
    for (const [k, v] of sessoes) if (v.expira < agora) sessoes.delete(k);
    for (const [k, v] of usados) if (v < agora) usados.delete(k);
  }, 600e3).unref();

  /** Comparação de segredo em tempo constante (API servidor-a-servidor do DMK Prisma). */
  function segredoConfere(recebido) {
    const a = Buffer.from(String(recebido || ''));
    const b = Buffer.from(segredo);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  return { gerarTicket, lerTicket, criar, obter, encerrar: (t) => sessoes.delete(t), encerrarOnde, trocarSegredo, segredoConfere };
}

module.exports = { criarSessoes };
