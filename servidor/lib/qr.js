'use strict';
/**
 * Gerador de QR Code (modo byte, correção M, versões 1 a 10 = até 213 bytes) sem dependências.
 * Usado para o QR do app autenticador (otpauth://...). Segue a norma ISO/IEC 18004, no mesmo
 * desenho do gerador de referência do Project Nayuki. Saída: matriz booleana ou SVG.
 * Conferido nos testes lendo de volta com um leitor de QR (OpenCV).
 */

const ECC_POR_BLOCO = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];   // nível M
const BLOCOS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];                     // nível M
const BITS_FORMATO_M = 0;

function modulosDeDados(v) {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const n = Math.floor(v / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (v >= 7) r -= 36;
  }
  return r;
}
const codewordsDeDados = (v) => Math.floor(modulosDeDados(v) / 8) - ECC_POR_BLOCO[v] * BLOCOS[v];

// --- Reed-Solomon em GF(256), polinômio 0x11D
function mult(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}
function divisor(grau) {
  const r = new Array(grau).fill(0); r[grau - 1] = 1;
  let raiz = 1;
  for (let i = 0; i < grau; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = mult(r[j], raiz); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    raiz = mult(raiz, 0x02);
  }
  return r;
}
function resto(dados, div) {
  const r = div.map(() => 0);
  for (const b of dados) {
    const f = b ^ r.shift(); r.push(0);
    div.forEach((c, i) => { r[i] ^= mult(c, f); });
  }
  return r;
}

function posicoesAlinhamento(v) {
  if (v === 1) return [];
  const n = Math.floor(v / 7) + 2;
  const passo = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let p = v * 4 + 17 - 7; r.length < n; p -= passo) r.splice(1, 0, p);
  return r;
}

function gerar(texto) {
  const bytes = [...Buffer.from(String(texto), 'utf8')];
  let v = 1;
  for (; v <= 10; v++) {
    const bitsCont = v <= 9 ? 8 : 16;
    if (4 + bitsCont + bytes.length * 8 <= codewordsDeDados(v) * 8) break;
  }
  if (v > 10) throw new Error('Texto grande demais para o QR (máx. versão 10).');

  // Bits: modo byte (0100) + contador + dados + terminador + preenchimento
  const bits = [];
  const por = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  por(4, 4); por(bytes.length, v <= 9 ? 8 : 16);
  for (const b of bytes) por(b, 8);
  const cap = codewordsDeDados(v) * 8;
  por(0, Math.min(4, cap - bits.length));
  por(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) por(pad, 8);
  const dados = [];
  for (let i = 0; i < bits.length; i += 8) dados.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // Blocos + correção, intercalados
  const nBlocos = BLOCOS[v]; const ecc = ECC_POR_BLOCO[v];
  const totalCw = Math.floor(modulosDeDados(v) / 8);
  const curtos = nBlocos - (totalCw % nBlocos);
  const tamCurto = Math.floor(totalCw / nBlocos);
  const div = divisor(ecc);
  const blocos = [];
  for (let i = 0, k = 0; i < nBlocos; i++) {
    const d = dados.slice(k, k + tamCurto - ecc + (i < curtos ? 0 : 1));
    k += d.length;
    const e = resto(d, div);
    if (i < curtos) d.push(0);   // marca de posição (pulada abaixo)
    blocos.push(d.concat(e));
  }
  const final = [];
  for (let i = 0; i < blocos[0].length; i++) blocos.forEach((b, j) => { if (i !== tamCurto - ecc || j >= curtos) final.push(b[i]); });

  // Matriz
  const tam = v * 4 + 17;
  const m = Array.from({ length: tam }, () => new Array(tam).fill(false));
  const fixo = Array.from({ length: tam }, () => new Array(tam).fill(false));
  const pon = (x, y, cor) => { m[y][x] = cor; fixo[y][x] = true; };
  for (let i = 0; i < tam; i++) { pon(6, i, i % 2 === 0); pon(i, 6, i % 2 === 0); }
  const localizador = (x, y) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)); const xx = x + dx; const yy = y + dy;
      if (xx >= 0 && xx < tam && yy >= 0 && yy < tam) pon(xx, yy, d !== 2 && d !== 4);
    }
  };
  localizador(3, 3); localizador(tam - 4, 3); localizador(3, tam - 4);
  const al = posicoesAlinhamento(v);
  al.forEach((ax, i) => al.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) pon(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const desenharFormato = (mask) => {
    const dado = (BITS_FORMATO_M << 3) | mask;
    let r = dado;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((dado << 10) | r) ^ 0x5412;
    const bit = (i) => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) pon(8, i, bit(i));
    pon(8, 7, bit(6)); pon(8, 8, bit(7)); pon(7, 8, bit(8));
    for (let i = 9; i < 15; i++) pon(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) pon(tam - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) pon(8, tam - 15 + i, bit(i));
    pon(8, tam - 8, true);
  };
  desenharFormato(0);   // reserva as áreas
  if (v >= 7) {
    let r = v;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (v << 12) | r;
    for (let i = 0; i < 18; i++) {
      const c = ((b >>> i) & 1) !== 0; const a = tam - 11 + (i % 3); const bb = Math.floor(i / 3);
      pon(a, bb, c); pon(bb, a, c);
    }
  }
  // Dados em zigue-zague
  let i = 0;
  for (let dir = tam - 1; dir >= 1; dir -= 2) {
    if (dir === 6) dir = 5;
    for (let vert = 0; vert < tam; vert++) for (let j = 0; j < 2; j++) {
      const x = dir - j; const subindo = ((dir + 1) & 2) === 0; const y = subindo ? tam - 1 - vert : vert;
      if (!fixo[y][x] && i < final.length * 8) { m[y][x] = ((final[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
    }
  }

  // Máscara com menor penalidade
  const MASCARAS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const aplicar = (k) => { for (let y = 0; y < tam; y++) for (let x = 0; x < tam; x++) if (!fixo[y][x] && MASCARAS[k](x, y)) m[y][x] = !m[y][x]; };
  const penalidade = () => {
    let p = 0;
    const linhas = (get) => {
      for (let a = 0; a < tam; a++) {
        let cor = null; let corrida = 0; const seq = [];
        for (let b = 0; b < tam; b++) {
          const c = get(a, b);
          if (c === cor) corrida++; else { if (corrida >= 5) p += corrida - 2; cor = c; corrida = 1; }
          seq.push(c ? 1 : 0);
        }
        if (corrida >= 5) p += corrida - 2;
        const s = seq.join('');
        for (const pad of ['10111010000', '00001011101']) { let k = s.indexOf(pad); while (k !== -1) { p += 40; k = s.indexOf(pad, k + 1); } }
      }
    };
    linhas((a, b) => m[a][b]); linhas((a, b) => m[b][a]);
    for (let y = 0; y < tam - 1; y++) for (let x = 0; x < tam - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
    let escuros = 0; for (const l of m) for (const c of l) if (c) escuros++;
    p += Math.floor(Math.abs(escuros * 20 - tam * tam * 10) / (tam * tam)) * 10;
    return p;
  };
  let melhor = 0; let menor = Infinity;
  for (let k = 0; k < 8; k++) {
    aplicar(k); desenharFormato(k);
    const p = penalidade();
    if (p < menor) { menor = p; melhor = k; }
    aplicar(k);
  }
  aplicar(melhor); desenharFormato(melhor);
  return m;
}

/** SVG com borda branca de 4 módulos (cores fixas: o leitor precisa de escuro sobre claro). */
function svg(texto, px = 6) {
  const m = gerar(texto); const n = m.length; const b = 4; const t = (n + b * 2) * px;
  let d = '';
  m.forEach((l, y) => l.forEach((c, x) => { if (c) d += `M${(x + b) * px},${(y + b) * px}h${px}v${px}h-${px}z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${t} ${t}" width="${t}" height="${t}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}

module.exports = { gerar, svg };
