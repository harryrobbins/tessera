import { describe, it, expect } from 'vitest';
import { floatSortKey, radixSortIndices, sortByNumeric, sortByCode } from '../src/layout/sort';
import { mulberry32, randFiniteFloat32, randInt, randRange } from './helpers/prng';

describe('floatSortKey', () => {
  it('is order-preserving across a few hundred deterministic pseudo-random pairs', () => {
    const rand = mulberry32(0xC0FFEE);
    let pairsChecked = 0;
    for (let i = 0; i < 400; i++) {
      const a = randFiniteFloat32(rand);
      const b = randFiniteFloat32(rand);
      // Skip pairs that are numerically equal (e.g. -0 vs 0): the key mapping
      // is only required to preserve strict order, not to be injective on
      // values that JS considers `===`.
      if (a === b) continue;
      pairsChecked++;
      if (a < b) {
        expect(floatSortKey(a), `expected key(${a}) < key(${b})`).toBeLessThan(floatSortKey(b));
      } else {
        expect(floatSortKey(a), `expected key(${a}) > key(${b})`).toBeGreaterThan(floatSortKey(b));
      }
    }
    expect(pairsChecked).toBeGreaterThan(300);
  });

  it('orders negatives, zero, and positives correctly relative to each other', () => {
    const rand = mulberry32(1);
    const negatives: number[] = [];
    const positives: number[] = [];
    for (let i = 0; i < 50; i++) {
      negatives.push(-Math.abs(randRange(rand, 1e-6, 1e6)));
      positives.push(Math.abs(randRange(rand, 1e-6, 1e6)));
    }
    const allNegKeys = negatives.map(floatSortKey);
    const allPosKeys = positives.map(floatSortKey);
    const zeroKey = floatSortKey(0);
    for (const k of allNegKeys) expect(k).toBeLessThan(zeroKey);
    for (const k of allPosKeys) expect(k).toBeGreaterThan(zeroKey);
  });

  it('orders infinities correctly: -Infinity < any finite < Infinity', () => {
    const rand = mulberry32(2);
    const negInfKey = floatSortKey(-Infinity);
    const posInfKey = floatSortKey(Infinity);
    for (let i = 0; i < 100; i++) {
      const v = randFiniteFloat32(rand);
      const k = floatSortKey(v);
      expect(negInfKey).toBeLessThan(k);
      expect(k).toBeLessThan(posInfKey);
    }
  });

  it('maps NaN to the maximum key, sorting after +Infinity', () => {
    expect(floatSortKey(NaN)).toBe(0xffffffff);
    expect(floatSortKey(NaN)).toBeGreaterThan(floatSortKey(Infinity));
  });

  it('is a pure function: same input always yields the same key', () => {
    const rand = mulberry32(3);
    for (let i = 0; i < 50; i++) {
      const v = randFiniteFloat32(rand);
      expect(floatSortKey(v)).toBe(floatSortKey(v));
    }
  });
});

describe('radixSortIndices', () => {
  it('sorts indices ascending by key', () => {
    const rand = mulberry32(10);
    const n = 500;
    const keys = new Uint32Array(n);
    for (let i = 0; i < n; i++) keys[i] = randU32range(rand);
    const indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;
    const sorted = radixSortIndices(indices, keys);
    expect(sorted.length).toBe(n);
    for (let i = 1; i < n; i++) {
      expect(keys[sorted[i - 1]]).toBeLessThanOrEqual(keys[sorted[i]]);
    }
    // Same multiset of indices.
    const asSet = new Set(sorted);
    expect(asSet.size).toBe(n);
    for (let i = 0; i < n; i++) expect(asSet.has(i)).toBe(true);
  });

  it('is stable: equal keys keep their input relative order', () => {
    const rand = mulberry32(11);
    const n = 300;
    // Force lots of duplicate keys: only 5 distinct values.
    const keys = new Uint32Array(n);
    for (let i = 0; i < n; i++) keys[i] = randInt(rand, 5);
    const indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;
    const sorted = radixSortIndices(indices, keys);

    // For each key value, the indices sharing it must appear in the sorted
    // output in the same relative order they had in the input.
    const byKey = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const k = keys[indices[i]];
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(indices[i]);
    }
    const seenByKey = new Map<number, number[]>();
    for (const idx of sorted) {
      const k = keys[idx];
      if (!seenByKey.has(k)) seenByKey.set(k, []);
      seenByKey.get(k)!.push(idx);
    }
    for (const [k, expected] of byKey) {
      expect(seenByKey.get(k)).toEqual(expected);
    }
  });

  it('does not mutate the input indices array', () => {
    const rand = mulberry32(12);
    const n = 64;
    const indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) indices[i] = n - 1 - i; // reverse order
    const keys = new Uint32Array(n);
    for (let i = 0; i < n; i++) keys[i] = randU32range(rand);
    const before = indices.slice();
    radixSortIndices(indices, keys);
    expect(indices).toEqual(before);
  });

  it('handles n=0', () => {
    const out = radixSortIndices(new Uint32Array(0), new Uint32Array(0));
    expect(out.length).toBe(0);
  });

  it('handles n=1', () => {
    const indices = new Uint32Array([7]);
    const keys = new Uint32Array(20); // index 7 needs to exist
    keys[7] = 123;
    const out = radixSortIndices(indices, keys);
    expect(Array.from(out)).toEqual([7]);
  });

  it('handles all-equal keys (every radix pass skipped)', () => {
    const n = 40;
    const indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;
    const keys = new Uint32Array(n).fill(42);
    const out = radixSortIndices(indices, keys);
    expect(Array.from(out)).toEqual(Array.from(indices));
  });
});

function randU32range(rand: () => number): number {
  return Math.floor(rand() * 4294967296) >>> 0;
}

describe('sortByNumeric', () => {
  it('matches Array.prototype.sort on 10k seeded random floats including NaN, with NaN last', () => {
    const rand = mulberry32(0xBEEF);
    const n = 10000;
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // ~5% NaN, rest a wide random finite range.
      values[i] = rand() < 0.05 ? NaN : randRange(rand, -1e6, 1e6);
    }
    const indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;

    const actual = Array.from(sortByNumeric(indices, values));

    const reference = Array.from(indices).sort((ia, ib) => {
      const a = values[ia];
      const b = values[ib];
      const aNaN = Number.isNaN(a);
      const bNaN = Number.isNaN(b);
      if (aNaN && bNaN) return 0; // stable sort keeps input order
      if (aNaN) return 1;
      if (bNaN) return -1;
      return a - b;
    });

    expect(actual).toEqual(reference);

    // Explicitly confirm NaNs are all at the tail.
    const firstNaNPos = actual.findIndex((idx) => Number.isNaN(values[idx]));
    if (firstNaNPos !== -1) {
      for (let i = firstNaNPos; i < actual.length; i++) {
        expect(Number.isNaN(values[actual[i]])).toBe(true);
      }
    }
  });
});

describe('sortByCode', () => {
  it('is stable and puts code -1 (missing) first', () => {
    const rand = mulberry32(0x5EED);
    const n = 400;
    const nCodes = 6;
    const codes = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      // ~10% missing
      codes[i] = rand() < 0.1 ? -1 : randInt(rand, nCodes);
    }
    const indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;

    const sorted = sortByCode(indices, codes, nCodes);

    // Non-decreasing codes.
    for (let i = 1; i < n; i++) {
      expect(codes[sorted[i - 1]]).toBeLessThanOrEqual(codes[sorted[i]]);
    }
    // -1s all at the front.
    let i = 0;
    while (i < n && codes[sorted[i]] === -1) i++;
    for (let j = i; j < n; j++) expect(codes[sorted[j]]).toBeGreaterThanOrEqual(0);

    // Same multiset as input.
    expect([...sorted].sort((a, b) => a - b)).toEqual([...indices].sort((a, b) => a - b));

    // Stability: within each code, relative input order preserved.
    const byCode = new Map<number, number[]>();
    for (const idx of indices) {
      const c = codes[idx];
      if (!byCode.has(c)) byCode.set(c, []);
      byCode.get(c)!.push(idx);
    }
    const seenByCode = new Map<number, number[]>();
    for (const idx of sorted) {
      const c = codes[idx];
      if (!seenByCode.has(c)) seenByCode.set(c, []);
      seenByCode.get(c)!.push(idx);
    }
    for (const [c, expected] of byCode) {
      expect(seenByCode.get(c)).toEqual(expected);
    }
  });

  it('produces the same multiset of indices as its input, for a small hand-checkable case', () => {
    const indices = new Uint32Array([0, 1, 2, 3, 4]);
    const codes = new Int32Array([2, -1, 0, -1, 1]);
    const sorted = sortByCode(indices, codes, 3);
    // Expected order: code -1 first (indices 1,3 in input order), then code 0
    // (idx 2), code 1 (idx 4), code 2 (idx 0).
    expect(Array.from(sorted)).toEqual([1, 3, 2, 4, 0]);
  });
});
