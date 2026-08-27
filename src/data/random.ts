/**
 * Deterministic random helpers shared by every synthetic generator. One copy,
 * so every dataset draws from bit-identical streams (products and the
 * tax/finance families all import from here).
 */

/** mulberry32 — small, fast, fully deterministic. Same seed → same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller; consumes exactly two draws. */
export function gaussian(rand: () => number): number {
  let u = rand();
  if (u < 1e-9) u = 1e-9;
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Lognormal with log-median `mu` and log-sigma `sigma`; consumes two draws. */
export function lognormal(rand: () => number, mu: number, sigma: number): number {
  return Math.exp(mu + sigma * gaussian(rand));
}

/** Weights → cumulative distribution ending exactly at 1. */
export function cumulative(weights: ArrayLike<number>): Float32Array {
  const n = weights.length;
  const cum = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += weights[i];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += weights[i] / sum;
    cum[i] = acc;
  }
  if (n > 0) cum[n - 1] = 1;
  return cum;
}

/**
 * Draw an index from a cumulative table (`cum[offset .. offset+count)`),
 * consuming one draw. Tables for several conditioning values can be packed
 * into one Float32Array and addressed by `offset`.
 */
export function pickCum(rand: () => number, cum: ArrayLike<number>, offset = 0, count = cum.length - offset): number {
  const r = rand();
  let k = 0;
  while (k < count - 1 && r > cum[offset + k]) k++;
  return k;
}

/**
 * Integer hash of (i, salt) to [0,1). Pure 32-bit integer maths, so it is
 * bit-identical across JS engines (unlike anything built on Math.sin). Use it
 * for fixed structure tables — per-category scales, affinities — that must not
 * depend on the row stream.
 */
export function hashU32(i: number, salt = 0): number {
  let h = (Math.imul(i | 0, 0x9e3779b1) ^ Math.imul((salt | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}
