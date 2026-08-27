/**
 * Deterministic PRNG helpers shared by the test suite. No Math.random, no
 * Date.now — every test that uses randomness seeds one of these explicitly so
 * failures are reproducible.
 */

// The generator itself is the app's own (src/data/random.ts) so tests and
// synthetic datasets draw from bit-identical streams; only the test-shaped
// helpers below live here.
export { mulberry32 } from '../../src/data/random';

/** Random unsigned 32-bit int in [0, 2^32). */
export function randU32(rand: () => number): number {
  return (rand() * 4294967296) >>> 0;
}

/** Random integer in [0, maxExclusive). */
export function randInt(rand: () => number, maxExclusive: number): number {
  return Math.floor(rand() * maxExclusive);
}

/** Random float in [lo, hi). */
export function randRange(rand: () => number, lo: number, hi: number): number {
  return lo + rand() * (hi - lo);
}

/**
 * A random finite float32, built by assembling a raw IEEE-754 bit pattern
 * (random sign, random exponent in [0,254] so it's never inf/NaN, random
 * mantissa) so the generator covers the full dynamic range: subnormals,
 * very large magnitudes, very small magnitudes, not just "reasonable" numbers.
 */
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function randFiniteFloat32(rand: () => number): number {
  const sign = randInt(rand, 2);
  const exponent = randInt(rand, 255); // 0..254, excludes the reserved 255 (inf/NaN)
  const mantissa = randU32(rand) & 0x7fffff;
  u32[0] = (sign << 31) | (exponent << 23) | mantissa;
  return f32[0];
}
