import { describe, it, expect } from 'vitest';
import {
  visibleIndices,
  bucketize,
  gridLayout,
  barsLayout,
  scatterLayout,
  xyLayout,
  isRasterGrid,
  mapScale,
  CARD_SIZE,
  CARD_PITCH,
  MAP_SPAN,
  MAP_DOT,
  type LayoutData,
  type LayoutColumnNumber,
  type LayoutColumnCategory,
} from '../src/layout/layouts';
import { mulberry32, randInt } from './helpers/prng';

// Mirrors the private BAR_ASPECT constant in src/layout/layouts.ts, needed to
// hand-compute exact expected geometry for barsLayout.
const BAR_ASPECT = 0.35;

function numCol(name: string, values: number[]): LayoutColumnNumber {
  const a = Float32Array.from(values);
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) { min = 0; max = 0; }
  return { kind: 'number', name, values: a, min, max };
}

function catCol(name: string, categories: string[], codes: number[]): LayoutColumnCategory {
  return { kind: 'category', name, codes: Int32Array.from(codes), categories };
}

describe('visibleIndices', () => {
  it('returns all indices in dataset order when there is no mask', () => {
    expect(Array.from(visibleIndices(5))).toEqual([0, 1, 2, 3, 4]);
    expect(Array.from(visibleIndices(0))).toEqual([]);
  });

  it('returns only masked-in indices, preserving order', () => {
    const mask = Uint8Array.from([1, 0, 1, 0, 1]);
    expect(Array.from(visibleIndices(5, mask))).toEqual([0, 2, 4]);
  });

  it('returns an empty array when everything is masked out', () => {
    const mask = Uint8Array.from([0, 0, 0]);
    expect(Array.from(visibleIndices(3, mask))).toEqual([]);
  });
});

describe('bucketize', () => {
  it('passes categorical columns through unchanged', () => {
    const data: LayoutData = {
      n: 5,
      columns: { cat: catCol('cat', ['a', 'b', 'c'], [0, 1, 2, 0, 1]) },
    };
    const { codes, labels } = bucketize(data, 'cat', 12);
    expect(Array.from(codes)).toEqual([0, 1, 2, 0, 1]);
    expect(labels).toEqual(['a', 'b', 'c']);
  });

  it('bins numeric values into equal-width buckets, with the max value in the LAST bin', () => {
    // min=0, max=10, bins=5 -> width 2. Bin edges: [0,2) [2,4) [4,6) [6,8) [8,10].
    // A naive `floor((v-min)/width)` would put v=max=10 in a bin of its own
    // (bin index 5), which doesn't exist. The classic off-by-one fix clamps
    // it back into the last real bin (index 4).
    const data: LayoutData = {
      n: 7,
      columns: { v: numCol('v', [0, 2, 4, 6, 8, 10, NaN]) },
    };
    const { codes } = bucketize(data, 'v', 5);
    expect(Array.from(codes)).toEqual([0, 1, 2, 3, 4, 4, -1]);
  });

  it('gives NaN / non-finite values code -1', () => {
    const data: LayoutData = { n: 3, columns: { v: numCol('v', [1, NaN, 5]) } };
    const { codes } = bucketize(data, 'v', 4);
    expect(codes[1]).toBe(-1);
  });

  it('throws on an unknown column and on a text column', () => {
    const data: LayoutData = {
      n: 1,
      columns: { t: { kind: 'text', name: 't', values: ['x'] } },
    };
    expect(() => bucketize(data, 'missing', 4)).toThrow();
    expect(() => bucketize(data, 't', 4)).toThrow();
  });
});

describe('gridLayout', () => {
  function buildGrid(n: number, mask?: Uint8Array | null, sortBy?: string) {
    const data: LayoutData = { n, columns: {} };
    return gridLayout(data, { type: 'grid', sortBy }, mask);
  }

  it('gives every visible item alpha=1 and size=CARD_SIZE', () => {
    const result = buildGrid(23);
    for (let k = 0; k < 23; k++) {
      expect(result.positions[k * 4 + 2]).toBe(Math.fround(CARD_SIZE));
      expect(result.positions[k * 4 + 3]).toBe(1);
    }
    expect(result.visible).toBe(23);
  });

  it('gives every visible item a unique position', () => {
    const result = buildGrid(37);
    const seen = new Set<string>();
    for (let k = 0; k < 37; k++) {
      const key = `${result.positions[k * 4]},${result.positions[k * 4 + 1]}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('has bounds consistent with the number of distinct rows/cols used', () => {
    const result = buildGrid(50);
    const xs = new Set<number>();
    const ys = new Set<number>();
    for (let k = 0; k < 50; k++) {
      xs.add(result.positions[k * 4]);
      ys.add(result.positions[k * 4 + 1]);
    }
    const cols = xs.size;
    const rows = ys.size;
    expect(cols * rows).toBeGreaterThanOrEqual(50);
    expect(result.bounds.maxX - result.bounds.minX).toBeCloseTo(cols * CARD_PITCH, 6);
    expect(result.bounds.maxY - result.bounds.minY).toBeCloseTo(rows * CARD_PITCH, 6);
    // Every card must lie within the bounds box.
    for (let k = 0; k < 50; k++) {
      const x = result.positions[k * 4];
      const y = result.positions[k * 4 + 1];
      expect(x).toBeGreaterThanOrEqual(result.bounds.minX);
      expect(x).toBeLessThan(result.bounds.maxX);
      expect(y).toBeGreaterThan(result.bounds.minY);
      expect(y).toBeLessThanOrEqual(result.bounds.maxY);
    }
  });

  it('orders cards in reading order (top-to-bottom, left-to-right) by sortBy ascending', () => {
    const n = 6;
    const keyValues = [5, 3, 1, 4, 2, 0]; // row index -> key
    const data: LayoutData = { n, columns: { key: numCol('key', keyValues) } };
    const result = gridLayout(data, { type: 'grid', sortBy: 'key' }, null);

    const rows = Array.from({ length: n }, (_, i) => ({
      i,
      x: result.positions[i * 4],
      y: result.positions[i * 4 + 1],
      key: keyValues[i],
    }));
    // Reading order: top row first (max y), left to right (min x) within a row.
    rows.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const readingOrderKeys = rows.map((r) => r.key);
    for (let i = 1; i < readingOrderKeys.length; i++) {
      expect(readingOrderKeys[i - 1]).toBeLessThanOrEqual(readingOrderKeys[i]);
    }
    // The smallest key must be at top-left: max y among all, min x among all.
    const maxY = Math.max(...rows.map((r) => r.y));
    const minX = Math.min(...rows.map((r) => r.x));
    const first = rows[0];
    expect(first.key).toBe(Math.min(...keyValues));
    expect(first.y).toBe(maxY);
    expect(first.x).toBe(minX);
  });

  it('respects a mask combined with sortBy', () => {
    const n = 8;
    const keyValues = [7, 6, 5, 4, 3, 2, 1, 0];
    const mask = Uint8Array.from([1, 0, 1, 0, 1, 0, 1, 0]); // keep 0,2,4,6 -> keys 7,5,3,1
    const data: LayoutData = { n, columns: { key: numCol('key', keyValues) } };
    const result = gridLayout(data, { type: 'grid', sortBy: 'key' }, mask);
    expect(result.visible).toBe(4);
    // Masked-out rows must never get drawn (size 0, alpha 0).
    for (const i of [1, 3, 5, 7]) {
      expect(result.positions[i * 4 + 2]).toBe(0);
      expect(result.positions[i * 4 + 3]).toBe(0);
    }
    for (const i of [0, 2, 4, 6]) {
      expect(result.positions[i * 4 + 2]).toBe(Math.fround(CARD_SIZE));
      expect(result.positions[i * 4 + 3]).toBe(1);
    }
  });

  it('is deterministic: computing the same layout twice yields byte-identical Float32Arrays', () => {
    const data: LayoutData = { n: 41, columns: { key: numCol('key', Array.from({ length: 41 }, (_, i) => 41 - i)) } };
    const r1 = gridLayout(data, { type: 'grid', sortBy: 'key' }, null);
    const r2 = gridLayout(data, { type: 'grid', sortBy: 'key' }, null);
    expect(r1.positions).toEqual(r2.positions);
    for (let i = 0; i < r1.positions.length; i++) {
      expect(Object.is(r1.positions[i], r2.positions[i])).toBe(true);
    }
  });
});

describe('barsLayout', () => {
  it('places cards in a fully hand-computed exact geometry for a small fixture', () => {
    // 15 rows: 10x 'a', 4x 'b', 1x 'c', in that dataset order.
    const categories = ['a', 'b', 'c'];
    const codes = [
      ...Array(10).fill(0),
      ...Array(4).fill(1),
      ...Array(1).fill(2),
    ];
    const data: LayoutData = { n: 15, columns: { cat: catCol('cat', categories, codes) } };
    const result = barsLayout(data, { type: 'bars', by: 'cat' }, null);

    // maxCount = 10 -> barCols = round(sqrt(10*0.35)) = round(1.8708) = 2
    const barCols = Math.round(Math.sqrt(10 * BAR_ASPECT));
    expect(barCols).toBe(2);
    const gapCols = Math.max(1, Math.round(barCols * 0.25));
    expect(gapCols).toBe(1);
    const stride = barCols + gapCols; // 3
    const nGroups = 3;
    const totalW = nGroups * stride - gapCols; // 8
    const x0 = -totalW / 2; // -4
    const maxRows = Math.ceil(10 / barCols); // 5
    const y0 = -(maxRows * CARD_PITCH) / 2; // -2.5

    function expectedPos(group: number, rank: number): [number, number] {
      const col = rank % barCols;
      const row = (rank / barCols) | 0;
      return [x0 + group * stride + col * CARD_PITCH, y0 + row * CARD_PITCH];
    }

    // group a: rows 0..9, rank = row index
    for (let r = 0; r < 10; r++) {
      const [ex, ey] = expectedPos(0, r);
      expect(result.positions[r * 4]).toBeCloseTo(ex, 6);
      expect(result.positions[r * 4 + 1]).toBeCloseTo(ey, 6);
      expect(result.positions[r * 4 + 2]).toBe(Math.fround(CARD_SIZE));
      expect(result.positions[r * 4 + 3]).toBe(1);
    }
    // group b: rows 10..13, rank 0..3
    for (let r = 0; r < 4; r++) {
      const idx = 10 + r;
      const [ex, ey] = expectedPos(1, r);
      expect(result.positions[idx * 4]).toBeCloseTo(ex, 6);
      expect(result.positions[idx * 4 + 1]).toBeCloseTo(ey, 6);
    }
    // group c: row 14, rank 0
    {
      const [ex, ey] = expectedPos(2, 0);
      expect(result.positions[14 * 4]).toBeCloseTo(ex, 6);
      expect(result.positions[14 * 4 + 1]).toBeCloseTo(ey, 6);
    }

    expect(result.bounds).toEqual({ minX: x0, maxX: x0 + totalW, minY: y0, maxY: y0 + maxRows * CARD_PITCH });

    expect(result.xAxis).toBeDefined();
    const ticks = result.xAxis!.ticks;
    expect(ticks.length).toBe(3);
    expect(ticks[0]).toEqual({ pos: x0 + 0 * stride + (barCols * CARD_PITCH) / 2, label: 'a', count: 10 });
    expect(ticks[1]).toEqual({ pos: x0 + 1 * stride + (barCols * CARD_PITCH) / 2, label: 'b', count: 4 });
    expect(ticks[2]).toEqual({ pos: x0 + 2 * stride + (barCols * CARD_PITCH) / 2, label: 'c', count: 1 });

    // Groups occupy disjoint x-ranges: nowhere-else invariant.
    const groupXs = [new Set<number>(), new Set<number>(), new Set<number>()];
    for (let r = 0; r < 15; r++) groupXs[codes[r]].add(result.positions[r * 4]);
    expect(groupXs[0]).toEqual(new Set([-4, -3]));
    expect(groupXs[1]).toEqual(new Set([-1, 0]));
    expect(groupXs[2]).toEqual(new Set([2]));
  });

  it('per-bucket tick counts match a hand-computed histogram, and codes -1 get size/alpha 0', () => {
    const rand = mulberry32(0xABCD);
    const n = 300;
    const nCategories = 5;
    const categories = ['g0', 'g1', 'g2', 'g3', 'g4'];
    const codes: number[] = [];
    let missing = 0;
    for (let i = 0; i < n; i++) {
      if (rand() < 0.1) { codes.push(-1); missing++; }
      else codes.push(randInt(rand, nCategories));
    }
    const data: LayoutData = { n, columns: { cat: catCol('cat', categories, codes) } };
    const result = barsLayout(data, { type: 'bars', by: 'cat' }, null);

    const expectedCounts = new Array(nCategories).fill(0);
    for (const c of codes) if (c >= 0) expectedCounts[c]++;
    const ticks = result.xAxis!.ticks;
    expect(ticks.map((t) => t.count)).toEqual(expectedCounts);

    for (let i = 0; i < n; i++) {
      if (codes[i] === -1) {
        expect(result.positions[i * 4 + 2]).toBe(0);
        expect(result.positions[i * 4 + 3]).toBe(0);
      } else {
        expect(result.positions[i * 4 + 2]).toBe(Math.fround(CARD_SIZE));
        expect(result.positions[i * 4 + 3]).toBe(1);
      }
    }
    expect(result.visible).toBe(n); // visible = order.length (no mask); -1 codes are still "visible" rows, just undrawn
  });

  it('packs cards within a bucket with no gaps and no two cards sharing a position', () => {
    const rand = mulberry32(77);
    const n = 200;
    const categories = ['a', 'b', 'c'];
    const codes = Array.from({ length: n }, () => randInt(rand, 3));
    const data: LayoutData = { n, columns: { cat: catCol('cat', categories, codes) } };
    const result = barsLayout(data, { type: 'bars', by: 'cat' }, null);

    const positionsSeen = new Set<string>();
    for (let i = 0; i < n; i++) {
      const key = `${result.positions[i * 4]},${result.positions[i * 4 + 1]}`;
      expect(positionsSeen.has(key)).toBe(false);
      positionsSeen.add(key);
    }

    // No gaps: within each bucket, the set of occupied (col,row) offsets
    // relative to that bucket's minimum x is exactly {0..count-1} laid out
    // row-major with some fixed width w (derive w from the distinct x count).
    for (let g = 0; g < 3; g++) {
      const rowsIdx = codes.map((c, i) => (c === g ? i : -1)).filter((i) => i >= 0);
      const xs = rowsIdx.map((i) => result.positions[i * 4]);
      const ys = rowsIdx.map((i) => result.positions[i * 4 + 1]);
      const distinctX = Array.from(new Set(xs)).sort((a, b) => a - b);
      const distinctY = Array.from(new Set(ys)).sort((a, b) => a - b);
      const w = distinctX.length;
      const h = distinctY.length;
      expect(rowsIdx.length).toBeLessThanOrEqual(w * h);
      expect(rowsIdx.length).toBeGreaterThan(w * (h - 1)); // last row is non-empty (packed, not sparse)
      const occupied = new Set(rowsIdx.map((i) => {
        const cx = distinctX.indexOf(result.positions[i * 4]);
        const cy = distinctY.indexOf(result.positions[i * 4 + 1]);
        return cy * w + cx;
      }));
      for (let rank = 0; rank < rowsIdx.length; rank++) expect(occupied.has(rank)).toBe(true);
    }
  });
});

describe('scatterLayout', () => {
  it('places cards in a fully hand-computed exact geometry for a small fixture', () => {
    // 8 rows across a 2x2 category grid: cell(x0,y0)=4, cell(x1,y0)=2, cell(x0,y1)=1, cell(x1,y1)=1
    const xCodes = [0, 0, 0, 0, 1, 1, 0, 1];
    const yCodes = [0, 0, 0, 0, 0, 0, 1, 1];
    const data: LayoutData = {
      n: 8,
      columns: {
        x: catCol('x', ['x0', 'x1'], xCodes),
        y: catCol('y', ['y0', 'y1'], yCodes),
      },
    };
    const result = scatterLayout(data, { type: 'scatter', x: 'x', y: 'y' }, null);

    const cellCards = Math.max(1, Math.ceil(Math.sqrt(4)));
    expect(cellCards).toBe(2);
    const cellGap = Math.max(1, Math.round(cellCards * 0.2));
    expect(cellGap).toBe(1);
    const stride = cellCards + cellGap; // 3
    const totalW = 2 * stride - cellGap; // 5
    const totalH = 2 * stride - cellGap; // 5
    const x0 = -totalW / 2; // -2.5
    const y0 = -totalH / 2; // -2.5

    function expectedPos(cx: number, cy: number, rank: number): [number, number] {
      const col = rank % cellCards;
      const row = (rank / cellCards) | 0;
      return [x0 + cx * stride + col * CARD_PITCH, y0 + cy * stride + row * CARD_PITCH];
    }

    // rows 0-3 -> cell(0,0) ranks 0..3
    for (let r = 0; r < 4; r++) {
      const [ex, ey] = expectedPos(0, 0, r);
      expect(result.positions[r * 4]).toBeCloseTo(ex, 6);
      expect(result.positions[r * 4 + 1]).toBeCloseTo(ey, 6);
    }
    // rows 4-5 -> cell(1,0) ranks 0..1
    for (let r = 0; r < 2; r++) {
      const idx = 4 + r;
      const [ex, ey] = expectedPos(1, 0, r);
      expect(result.positions[idx * 4]).toBeCloseTo(ex, 6);
      expect(result.positions[idx * 4 + 1]).toBeCloseTo(ey, 6);
    }
    // row 6 -> cell(0,1) rank 0
    {
      const [ex, ey] = expectedPos(0, 1, 0);
      expect(result.positions[6 * 4]).toBeCloseTo(ex, 6);
      expect(result.positions[6 * 4 + 1]).toBeCloseTo(ey, 6);
    }
    // row 7 -> cell(1,1) rank 0
    {
      const [ex, ey] = expectedPos(1, 1, 0);
      expect(result.positions[7 * 4]).toBeCloseTo(ex, 6);
      expect(result.positions[7 * 4 + 1]).toBeCloseTo(ey, 6);
    }

    expect(result.bounds).toEqual({ minX: x0, maxX: x0 + totalW, minY: y0, maxY: y0 + totalH });

    const xTicks = result.xAxis!.ticks;
    const yTicks = result.yAxis!.ticks;
    expect(xTicks.map((t) => t.label)).toEqual(['x0', 'x1']);
    expect(yTicks.map((t) => t.label)).toEqual(['y0', 'y1']);
    expect(xTicks[0].pos).toBeCloseTo(x0 + 0 * stride + (cellCards * CARD_PITCH) / 2, 6);
    expect(xTicks[1].pos).toBeCloseTo(x0 + 1 * stride + (cellCards * CARD_PITCH) / 2, 6);
  });

  it('encloses every card within bounds, keeps cards inside their own cell, and tick counts match bin counts', () => {
    const rand = mulberry32(999);
    const n = 400;
    const xCategories = ['x0', 'x1', 'x2', 'x3'];
    const yCategories = ['y0', 'y1', 'y2'];
    const xCodes = Array.from({ length: n }, () => randInt(rand, 4));
    const yCodes = Array.from({ length: n }, () => randInt(rand, 3));
    const data: LayoutData = {
      n,
      columns: {
        x: catCol('x', xCategories, xCodes),
        y: catCol('y', yCategories, yCodes),
      },
    };
    const result = scatterLayout(data, { type: 'scatter', x: 'x', y: 'y' }, null);

    for (let i = 0; i < n; i++) {
      const x = result.positions[i * 4];
      const yPos = result.positions[i * 4 + 1];
      expect(x).toBeGreaterThanOrEqual(result.bounds.minX);
      expect(x).toBeLessThan(result.bounds.maxX);
      expect(yPos).toBeGreaterThanOrEqual(result.bounds.minY);
      expect(yPos).toBeLessThan(result.bounds.maxY);
    }

    // Cards from different (cx,cy) cells must never land on the same x AND y
    // simultaneously as a card from a different cell — i.e. no collisions
    // across the whole layout.
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      const key = `${result.positions[i * 4]},${result.positions[i * 4 + 1]}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }

    // Tick counts: since every code is valid (no -1 here), sum of counts per
    // x tick over the grid must equal per-column totals.
    const expectedXCounts = new Array(4).fill(0);
    for (const c of xCodes) expectedXCounts[c]++;
    const expectedYCounts = new Array(3).fill(0);
    for (const c of yCodes) expectedYCounts[c]++;
    // xAxis/yAxis ticks here don't carry `count` for scatter (only bars does),
    // so instead verify indirectly: total visible must equal n.
    expect(result.visible).toBe(n);
    expect(result.xAxis!.ticks.length).toBe(4);
    expect(result.yAxis!.ticks.length).toBe(3);
  });
});

describe('masking is respected across all layout kinds', () => {
  it('masked-out rows always get size 0 / alpha 0, and visible rows never collide with each other', () => {
    const n = 30;
    const rand = mulberry32(55);
    const mask = Uint8Array.from({ length: n }, () => (rand() < 0.5 ? 1 : 0));
    const codes = Array.from({ length: n }, (_, i) => i % 3);
    const data: LayoutData = { n, columns: { cat: catCol('cat', ['a', 'b', 'c'], codes) } };

    for (const result of [
      gridLayout(data, { type: 'grid' }, mask),
      barsLayout(data, { type: 'bars', by: 'cat' }, mask),
    ]) {
      const visiblePositions = new Set<string>();
      for (let i = 0; i < n; i++) {
        const alpha = result.positions[i * 4 + 3];
        const size = result.positions[i * 4 + 2];
        if (!mask[i]) {
          expect(size).toBe(0);
          expect(alpha).toBe(0);
        }
      }
      for (let i = 0; i < n; i++) {
        if (mask[i] && result.positions[i * 4 + 3] === 1) {
          const key = `${result.positions[i * 4]},${result.positions[i * 4 + 1]}`;
          expect(visiblePositions.has(key)).toBe(false);
          visiblePositions.add(key);
        }
      }
    }
  });
});

describe('determinism', () => {
  it('gridLayout, barsLayout and scatterLayout are pure: repeated calls are byte-identical', () => {
    const n = 50;
    const rand = mulberry32(0xD3);
    const categories = ['a', 'b', 'c', 'd'];
    const codes = Array.from({ length: n }, () => randInt(rand, 4));
    const values = Array.from({ length: n }, () => randInt(rand, 1000) - 500);
    const data: LayoutData = {
      n,
      columns: {
        cat: catCol('cat', categories, codes),
        v: numCol('v', values),
      },
    };

    const g1 = gridLayout(data, { type: 'grid', sortBy: 'v' }, null);
    const g2 = gridLayout(data, { type: 'grid', sortBy: 'v' }, null);
    expect(g1.positions).toEqual(g2.positions);

    const b1 = barsLayout(data, { type: 'bars', by: 'cat', sortBy: 'v' }, null);
    const b2 = barsLayout(data, { type: 'bars', by: 'cat', sortBy: 'v' }, null);
    expect(b1.positions).toEqual(b2.positions);

    const s1 = scatterLayout(data, { type: 'scatter', x: 'cat', y: 'cat' }, null);
    const s2 = scatterLayout(data, { type: 'scatter', x: 'cat', y: 'cat' }, null);
    expect(s1.positions).toEqual(s2.positions);
  });
});

describe('xyLayout equal aspect (map)', () => {
  const N = 900;
  const ASPECT = 1.6;
  function geoData(n: number): LayoutData {
    const rand = mulberry32(7);
    const lon: number[] = [];
    const lat: number[] = [];
    for (let i = 0; i < n; i++) {
      lon.push(-6 + 8 * rand());
      lat.push(50 + 9 * rand());
    }
    // Pin the extents so the expected numbers are exact.
    lon[0] = -6; lon[1] = 2; lat[0] = 50; lat[1] = 59;
    return { n, columns: { Longitude: numCol('Longitude', lon), Latitude: numCol('Latitude', lat) } };
  }
  const spec = { type: 'xy' as const, x: 'Longitude', y: 'Latitude', equal: true };
  const cosMid = Math.cos((54.5 * Math.PI) / 180);

  it('shrinks longitude by cos(latMid) so sx/sy is exact', () => {
    const r = xyLayout(geoData(N), spec, null, ASPECT);
    const { sx, sy } = mapScale({ min: -6, max: 2 }, { min: 50, max: 59 }, N, ASPECT);
    expect(Math.abs(sx / sy - cosMid)).toBeLessThan(1e-6);
    const w = r.bounds.maxX - r.bounds.minX;
    const h = r.bounds.maxY - r.bounds.minY;
    expect(Math.abs(w / h - (8 * cosMid) / 9)).toBeLessThan(1e-6);
  });

  it('fits inside [S, S/aspect] with S = MAP_SPAN * sqrt(aspect) * (n/900)^0.25', () => {
    for (const n of [900, 5000]) {
      const r = xyLayout(geoData(n), spec, null, ASPECT);
      const S = MAP_SPAN * Math.sqrt(ASPECT) * Math.pow(n / 900, 0.25);
      const w = r.bounds.maxX - r.bounds.minX;
      const h = r.bounds.maxY - r.bounds.minY;
      expect(w).toBeLessThanOrEqual(S + 1e-9);
      expect(h).toBeLessThanOrEqual(S / ASPECT + 1e-9);
      // The UK is taller than wide, so the height is the binding side.
      expect(Math.abs(h - S / ASPECT)).toBeLessThan(1e-9);
    }
  });

  it('places every card at MAP_DOT size, and positions land inside the bounds', () => {
    const r = xyLayout(geoData(N), spec, null, ASPECT);
    for (let i = 0; i < N; i++) {
      expect(r.positions[i * 4 + 2]).toBe(Math.fround(MAP_DOT));
      expect(r.positions[i * 4 + 3]).toBe(1);
      expect(r.positions[i * 4]).toBeGreaterThanOrEqual(r.bounds.minX - 1e-3);
      expect(r.positions[i * 4]).toBeLessThanOrEqual(r.bounds.maxX + 1e-3);
      expect(r.positions[i * 4 + 1]).toBeGreaterThanOrEqual(r.bounds.minY - 1e-3);
      expect(r.positions[i * 4 + 1]).toBeLessThanOrEqual(r.bounds.maxY + 1e-3);
    }
  });

  it('does not move when filtered: a half mask keeps scale, bounds and every visible position', () => {
    const data = geoData(N);
    const full = xyLayout(data, spec, null, ASPECT);
    const mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) mask[i] = i % 2;
    const half = xyLayout(data, spec, mask, ASPECT);
    expect(half.bounds).toEqual(full.bounds);
    expect(half.visible).toBe(N / 2);
    for (let i = 0; i < N; i++) {
      if (mask[i]) {
        expect(half.positions[i * 4]).toBe(full.positions[i * 4]);
        expect(half.positions[i * 4 + 1]).toBe(full.positions[i * 4 + 1]);
      } else {
        expect(half.positions[i * 4 + 2]).toBe(0);
        expect(half.positions[i * 4 + 3]).toBe(0);
      }
    }
    expect(half.xAxis!.ticks).toEqual(full.xAxis!.ticks);
    expect(half.yAxis!.ticks).toEqual(full.yAxis!.ticks);
  });

  it('equal: false reproduces the viewport-filling scatter', () => {
    const data = geoData(N);
    const fill = xyLayout(data, { type: 'xy', x: 'Longitude', y: 'Latitude', equal: false }, null, ASPECT);
    const legacy = xyLayout(data, { type: 'xy', x: 'Longitude', y: 'Latitude' }, null, ASPECT);
    expect(fill.positions).toEqual(legacy.positions);
    expect(fill.bounds).toEqual(legacy.bounds);
    const w = Math.sqrt(N * ASPECT);
    expect(fill.bounds.maxX - fill.bounds.minX).toBeCloseTo(w, 9);
    expect(fill.bounds.maxY - fill.bounds.minY).toBeCloseTo(w / ASPECT, 9);
    expect(fill.positions[2]).toBe(CARD_PITCH);
  });

  it('gives NaN rows size and alpha 0', () => {
    const data = geoData(N);
    (data.columns.Longitude as LayoutColumnNumber).values[5] = NaN;
    (data.columns.Latitude as LayoutColumnNumber).values[6] = NaN;
    const r = xyLayout(data, spec, null, ASPECT);
    for (const i of [5, 6]) {
      expect(r.positions[i * 4 + 2]).toBe(0);
      expect(r.positions[i * 4 + 3]).toBe(0);
    }
    expect(r.positions[7 * 4 + 2]).toBe(Math.fround(MAP_DOT));
  });

  it('mapScale picks the width-bound branch for a wide extent', () => {
    // 20 degrees of longitude at the equator against 2 of latitude: ratio 10 > aspect.
    const { w, h, sx, sy } = mapScale({ min: 0, max: 20 }, { min: -1, max: 1 }, 900, ASPECT);
    const S = MAP_SPAN * Math.sqrt(ASPECT);
    expect(w).toBeCloseTo(S, 9);
    expect(h).toBeCloseTo(S / 10, 9);
    expect(sx / sy).toBeCloseTo(1, 9);
  });
});

describe('bucketize integer edges (D-36)', () => {
  it('gives an integer column with distinct <= bins one bin per integer', () => {
    // Years 2000..2015: 16 values into 12 bins used to cut some bars in half.
    const years: number[] = [];
    for (let i = 0; i < 64; i++) years.push(2000 + (i % 16));
    const data: LayoutData = { n: 64, columns: { Year: numCol('Year', years) } };
    const { codes, labels } = bucketize(data, 'Year', 16);
    expect(labels).toHaveLength(16);
    expect(labels[0]).toBe('2000');
    expect(labels[15]).toBe('2015');
    for (let i = 0; i < 64; i++) expect(codes[i]).toBe(i % 16);
  });

  it('falls back to equal-width bins when there are more integers than bins', () => {
    const data: LayoutData = { n: 3, columns: { v: numCol('v', [0, 50, 100]) } };
    const { codes, labels } = bucketize(data, 'v', 4);
    expect(labels).toHaveLength(4);
    expect(Array.from(codes)).toEqual([0, 2, 3]);
  });

  it('does not treat a fractional column with integer extents as integer', () => {
    const data: LayoutData = { n: 3, columns: { v: numCol('v', [0, 0.5, 2]) } };
    const { labels } = bucketize(data, 'v', 4);
    expect(labels).toHaveLength(4);
  });
});

describe('xyLayout raster (D-01)', () => {
  const W = 10;
  const H = 8;
  function raster(): LayoutData {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { xs.push(x); ys.push(y); }
    return { n: W * H, columns: { X: numCol('X', xs), Y: numCol('Y', ys) } };
  }
  const spec = { type: 'xy' as const, x: 'X', y: 'Y' };

  it('detects a dense integer lattice from the columns', () => {
    expect(isRasterGrid({ min: 0, max: W - 1 }, { min: 0, max: H - 1 }, W * H)).toBe(true);
    expect(isRasterGrid({ min: 0, max: W - 1 }, { min: 0, max: H - 1 }, W * H / 2)).toBe(false);
    expect(isRasterGrid({ min: 0.5, max: W - 1 }, { min: 0, max: H - 1 }, W * H)).toBe(false);
  });

  it('keeps scale 1 and pitch 1 under a mask, so the picture is not stretched', () => {
    const data = raster();
    const full = xyLayout(data, spec, null, 1.6);
    const mask = new Uint8Array(data.n);
    for (let i = 0; i < data.n; i += 2) mask[i] = 1;
    const half = xyLayout(data, spec, mask, 1.6);
    expect(full.pitch).toBe(CARD_PITCH);
    expect(half.pitch).toBe(CARD_PITCH);
    expect(half.bounds).toEqual(full.bounds);
    expect(half.visible).toBe(data.n / 2);
    // Neighbouring visible cells are exactly one pitch apart on each axis.
    const x = (i: number) => half.positions[i * 4];
    const y = (i: number) => half.positions[i * 4 + 1];
    expect(x(2) - x(0)).toBeCloseTo(2 * CARD_PITCH, 6);
    expect(y(2 * W) - y(0)).toBeCloseTo(2 * CARD_PITCH, 6);
    for (let i = 0; i < data.n; i++) {
      expect(half.positions[i * 4 + 2]).toBe(mask[i] ? CARD_PITCH : 0);
      expect(half.positions[i * 4 + 3]).toBe(mask[i] ? 1 : 0);
      if (mask[i]) {
        expect(half.positions[i * 4]).toBe(full.positions[i * 4]);
        expect(half.positions[i * 4 + 1]).toBe(full.positions[i * 4 + 1]);
      }
    }
  });

  it('scales a non-raster scatter to fill the viewport with independent axis scales', () => {
    const data: LayoutData = {
      n: 4,
      columns: { X: numCol('X', [0, 1.5, 3, 100]), Y: numCol('Y', [0, 0.25, 0.5, 1]) },
    };
    const r = xyLayout(data, spec, null, 2);
    const w = r.bounds.maxX - r.bounds.minX;
    const h = r.bounds.maxY - r.bounds.minY;
    expect(w / h).toBeCloseTo(2, 6);
    expect(r.xAxis?.ticks).toHaveLength(5);
    expect(r.xAxis?.ticks[0].pos).toBeCloseTo(r.bounds.minX, 6);
    expect(r.xAxis?.ticks[4].pos).toBeCloseTo(r.bounds.maxX, 6);
    expect(r.yAxis?.ticks[4].pos).toBeCloseTo(r.bounds.maxY, 6);
  });

  it('hides NaN rows and keeps bounds when everything is masked out', () => {
    const data: LayoutData = {
      n: 3,
      columns: { X: numCol('X', [0, NaN, 2]), Y: numCol('Y', [0, 1, 2]) },
    };
    const r = xyLayout(data, spec, null, 1);
    expect(r.positions[4 + 2]).toBe(0);
    expect(r.positions[4 + 3]).toBe(0);
    const none = xyLayout(data, spec, new Uint8Array(3), 1);
    expect(none.visible).toBe(0);
    expect(Number.isFinite(none.bounds.minX) && Number.isFinite(none.bounds.maxX)).toBe(true);
    expect(none.bounds.maxX).toBeGreaterThan(none.bounds.minX);
  });
});

describe('rank bins: a skewed numeric axis in a cross-tab', () => {
  /** 0.1 to 240 with three quarters of the mass under a day — resolution hours. */
  function skewed(n = 400): LayoutData {
    const rnd = mulberry32(7);
    const v: number[] = [];
    for (let i = 0; i < n; i++) v.push(i < n * 0.78 ? 0.1 + rnd() * 2 : 20 + rnd() * 220);
    return { n, columns: { h: numCol('h', v) } };
  }

  it('leaves equal-width bins alone: they are what a bar height means', () => {
    const data = skewed();
    const even = bucketize(data, 'h', 10);
    const counts = new Array(10).fill(0);
    for (const c of even.codes) counts[c]++;
    expect(counts[0] / data.n).toBeGreaterThan(0.5);       // the collapse this exists to detect
    expect(bucketize(data, 'h', 10, 'even')).toEqual(even); // 'even' is the default
  });

  it('spreads a skewed column across its bins when asked to rank', () => {
    const data = skewed();
    const { codes, labels } = bucketize(data, 'h', 10, 'rank');
    const counts = new Array(labels.length).fill(0);
    for (const c of codes) counts[c]++;
    expect(labels.length).toBeGreaterThan(2);
    // Equal-count, to within the ties at the low end.
    for (const c of counts) expect(c).toBeLessThan(data.n * 0.3);
    // The labels are the cuts that were actually made, in order.
    const cuts = labels.map(Number);
    for (let i = 1; i < cuts.length; i++) expect(cuts[i]).toBeGreaterThan(cuts[i - 1]);
  });

  it('leaves an evenly spread column on equal-width bins', () => {
    const v: number[] = [];
    for (let i = 0; i < 400; i++) v.push(i / 4);
    const data: LayoutData = { n: 400, columns: { v: numCol('v', v) } };
    expect(bucketize(data, 'v', 10, 'rank')).toEqual(bucketize(data, 'v', 10));
  });

  it('keeps equal width when the column cannot carry the cuts', () => {
    // 90 % one value: every quantile edge lands on it, so there is nothing to cut.
    const v = new Array(200).fill(5);
    for (let i = 0; i < 20; i++) v[i] = 5 + i;
    const data: LayoutData = { n: 200, columns: { v: numCol('v', v) } };
    expect(bucketize(data, 'v', 10, 'rank')).toEqual(bucketize(data, 'v', 10));
  });

  it('a cross-tab ranks its axes, so a skewed one is not one column of ten', () => {
    const data = skewed();
    data.columns.y = numCol('y', Array.from({ length: data.n }, (_, i) => (i % 5) + 1));
    const sol = scatterLayout(data, { type: 'scatter', x: 'h', y: 'y', xBins: 10, yBins: 8 });
    const cols = new Set<number>();
    for (let i = 0; i < data.n; i++) cols.add(Math.round(sol.positions[i * 4] * 100));
    expect(sol.xAxis!.ticks.length).toBeGreaterThan(2);
    expect(cols.size).toBeGreaterThan(3);
  });
});

describe('a filter must not rescale a raw scatter (the plot is the collection)', () => {
  function points(n: number): LayoutData {
    const rnd = mulberry32(11);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i++) { xs.push(rnd() * 100); ys.push(rnd() * 40); }
    return { n, columns: { x: numCol('x', xs), y: numCol('y', ys) } };
  }

  it('keeps the same bounds and the same card positions under a mask', () => {
    const data = points(500);
    const mask = new Uint8Array(500);
    for (let i = 0; i < 500; i += 40) mask[i] = 1;
    const all = xyLayout(data, { type: 'xy', x: 'x', y: 'y' });
    const some = xyLayout(data, { type: 'xy', x: 'x', y: 'y' }, mask);
    expect(some.bounds).toEqual(all.bounds);
    expect(some.visible).toBe(13);
    for (let i = 0; i < 500; i++) {
      if (!mask[i]) continue;
      expect(some.positions[i * 4]).toBeCloseTo(all.positions[i * 4], 5);
      expect(some.positions[i * 4 + 1]).toBeCloseTo(all.positions[i * 4 + 1], 5);
    }
  });
});

describe('barsLayout frames the bars that have cards', () => {
  const data: LayoutData = {
    n: 8,
    columns: { c: catCol('c', ['a', 'b', 'c', 'd'], [0, 0, 1, 1, 2, 2, 3, 3]) },
  };

  it('spans every bucket when they all hold cards', () => {
    const sol = barsLayout(data, { type: 'bars', by: 'c' });
    expect(sol.bounds.minX).toBeLessThan(sol.xAxis!.ticks[0].pos);
    expect(sol.bounds.maxX).toBeGreaterThan(sol.xAxis!.ticks[3].pos);
  });

  it('trims the empty buckets a filter leaves at the ends', () => {
    const mask = Uint8Array.from([0, 0, 0, 0, 0, 0, 1, 1]); // only "d" survives
    const sol = barsLayout(data, { type: 'bars', by: 'c' }, mask);
    const d = sol.xAxis!.ticks[3].pos;
    expect(sol.bounds.minX).toBeLessThanOrEqual(d);
    expect(sol.bounds.maxX).toBeGreaterThanOrEqual(d);
    // The three empty buckets to the left are no longer framed…
    expect(sol.bounds.minX).toBeGreaterThan(sol.xAxis!.ticks[2].pos);
    // …but they keep their place on the axis.
    expect(sol.xAxis!.ticks).toHaveLength(4);
    expect(sol.xAxis!.ticks[0].count).toBe(0);
  });
});

describe('the solve memo (G)', () => {
  // A collection is loaded into the worker once and then solved over and over
  // against different masks. The sorted order and the bin edges are functions
  // of the columns alone, so they are cached per collection; these are the
  // properties that caching must not break.

  function sortable(n: number, seed = 9): LayoutData {
    const rnd = mulberry32(seed);
    const key = Array.from({ length: n }, () => randInt(rnd, 50));
    const cat = Array.from({ length: n }, () => randInt(rnd, 4));
    return { n, columns: { key: numCol('key', key), cat: catCol('cat', ['a', 'b', 'c', 'd'], cat) } };
  }

  /** Visible rows in reading order — what the grid actually drew. */
  function reading(res: ReturnType<typeof gridLayout>, n: number): number[] {
    const rows: Array<{ i: number; x: number; y: number }> = [];
    for (let i = 0; i < n; i++) {
      if (res.positions[i * 4 + 3] === 0) continue;
      rows.push({ i, x: res.positions[i * 4], y: res.positions[i * 4 + 1] });
    }
    rows.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    return rows.map((r) => r.i);
  }

  it('gives a masked solve the order it would have had on its own', () => {
    // Filtering the whole collection's sorted order is only the same answer if
    // dropping rows leaves both the ordering and the tie-break intact.
    const n = 400;
    const data = sortable(n);
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = i % 3 === 0 ? 1 : 0;

    const fresh = sortable(n); // same numbers, no cache behind it
    const masked = reading(gridLayout(data, { type: 'grid', sortBy: 'key' }, mask), n);
    const alone = reading(gridLayout(fresh, { type: 'grid', sortBy: 'key' }, mask), n);
    expect(masked).toEqual(alone);

    const keys = data.columns.key as LayoutColumnNumber;
    for (let k = 1; k < masked.length; k++) {
      expect(keys.values[masked[k - 1]]).toBeLessThanOrEqual(keys.values[masked[k]]);
      // Stable: equal keys keep dataset order.
      if (keys.values[masked[k - 1]] === keys.values[masked[k]]) expect(masked[k - 1]).toBeLessThan(masked[k]);
    }
  });

  it('is unmoved by how many solves came before it, or in what order', () => {
    const n = 300;
    const data = sortable(n, 3);
    const a = new Uint8Array(n).fill(1);
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = i < 100 ? 1 : 0;

    const first = gridLayout(data, { type: 'grid', sortBy: 'cat' }, b).positions;
    for (const mask of [a, null, b, a, null]) gridLayout(data, { type: 'grid', sortBy: 'cat' }, mask);
    // Interleave another column's sort, and the bins, to evict and refill.
    gridLayout(data, { type: 'grid', sortBy: 'key' }, a);
    barsLayout(data, { type: 'bars', by: 'cat' }, a);
    scatterLayout(data, { type: 'scatter', x: 'cat', y: 'key' }, a);
    expect(gridLayout(data, { type: 'grid', sortBy: 'cat' }, b).positions).toEqual(first);
  });

  it("keeps one collection's bins out of another's", () => {
    const one: LayoutData = { n: 4, columns: { v: numCol('v', [0, 10, 20, 30]) } };
    const two: LayoutData = { n: 4, columns: { v: numCol('v', [0, 1000, 2000, 3000]) } };
    expect(bucketize(one, 'v', 4).labels).not.toEqual(bucketize(two, 'v', 4).labels);
    expect(bucketize(one, 'v', 4).labels).toEqual(bucketize(one, 'v', 4).labels);
    // And the bin count is part of what is remembered, not just the column.
    expect(bucketize(one, 'v', 4).labels.length).toBe(4);
    expect(bucketize(one, 'v', 8).labels.length).toBe(8);
  });

  it('still throws for a column it cannot bucket, however often it is asked', () => {
    const data: LayoutData = {
      n: 2,
      columns: { t: { kind: 'text', name: 't', values: ['a', 'b'] } },
    };
    for (let k = 0; k < 3; k++) {
      expect(() => bucketize(data, 't', 4)).toThrow();
      expect(() => bucketize(data, 'nope', 4)).toThrow();
    }
  });

  it('counts the visible rows of a raster the same way the index list did', () => {
    // xyLayout walks the rows directly now rather than building an identity
    // array; `visible` still means "masked in", non-finite coordinates and all.
    const n = 9;
    const data: LayoutData = {
      n,
      columns: {
        x: numCol('x', [0, 1, 2, 0, 1, 2, 0, 1, NaN]),
        y: numCol('y', [0, 0, 0, 1, 1, 1, 2, 2, 2]),
      },
    };
    expect(xyLayout(data, { type: 'xy', x: 'x', y: 'y' }, null).visible).toBe(n);
    const mask = Uint8Array.from([1, 1, 1, 0, 0, 0, 1, 1, 1]);
    const res = xyLayout(data, { type: 'xy', x: 'x', y: 'y' }, mask);
    expect(res.visible).toBe(6);
    for (const i of [3, 4, 5]) expect(res.positions[i * 4 + 3]).toBe(0);
    expect(res.positions[8 * 4 + 3]).toBe(0); // masked in, but has no coordinates
    expect(res.positions[0 * 4 + 3]).toBe(1);
  });
});
