/**
 * Index sorting hot enough to matter at 1M rows, so no comparator callbacks:
 * LSD radix sort over order-preserving uint32 keys (~25ms/1M vs ~600ms for
 * TypedArray.sort with a comparator).
 */
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Map a float to a uint32 that sorts in the same order (NaN -> max). */
export function floatSortKey(v: number): number {
  if (Number.isNaN(v)) return 0xffffffff;
  f32[0] = v;
  const u = u32[0];
  return (u & 0x80000000) !== 0 ? (~u >>> 0) : (u ^ 0x80000000) >>> 0;
}

/** Stable LSD radix sort of `indices` by `keys[index]`. Returns a sorted copy. */
export function radixSortIndices(indices: Uint32Array, keys: Uint32Array): Uint32Array {
  const n = indices.length;
  if (n === 0) return new Uint32Array(0);
  let src = indices.slice(); // never mutate the caller's array
  let dst = new Uint32Array(n);
  const count = new Uint32Array(256);
  for (let shift = 0; shift < 32; shift += 8) {
    count.fill(0);
    for (let i = 0; i < n; i++) count[(keys[src[i]] >>> shift) & 255]++;
    // Skip a pass when every key shares this byte.
    if (count[(keys[src[0]] >>> shift) & 255] === n) continue;
    let sum = 0;
    for (let b = 0; b < 256; b++) { const c = count[b]; count[b] = sum; sum += c; }
    for (let i = 0; i < n; i++) {
      const idx = src[i];
      dst[count[(keys[idx] >>> shift) & 255]++] = idx;
    }
    const t = src; src = dst; dst = t;
  }
  return src;
}

/** Sort indices by a numeric column, ascending. */
export function sortByNumeric(indices: Uint32Array, values: Float32Array): Uint32Array {
  const keys = new Uint32Array(values.length);
  for (let i = 0; i < values.length; i++) keys[i] = floatSortKey(values[i]);
  return radixSortIndices(indices, keys);
}

/** Counting sort of indices by small integer codes (-1 = missing, sorts first). Stable. */
export function sortByCode(indices: Uint32Array, codes: Int32Array, nCodes: number): Uint32Array {
  const buckets = nCodes + 1; // bucket = code + 1, so -1 lands in bucket 0
  const start = new Uint32Array(buckets);
  for (let i = 0; i < indices.length; i++) start[codes[indices[i]] + 1]++;
  let sum = 0;
  for (let b = 0; b < buckets; b++) { const c = start[b]; start[b] = sum; sum += c; }
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    out[start[codes[idx] + 1]++] = idx;
  }
  return out;
}
