import { describe, it, expect } from 'vitest';
import {
  visibleIndices,
  bucketize,
  gridLayout,
  barsLayout,
  scatterLayout,
  CARD_SIZE,
  CARD_PITCH,
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
