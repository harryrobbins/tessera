/**
 * Layout solvers. Pure functions over columnar data: given a spec they write
 * n*4 floats (x, y, size, alpha) — the target state the vertex shader tweens to.
 *
 * Card pitch is 1 world unit in every layout, so a re-sort is pure translation
 * (the "object permanence" that made Pivot readable).
 */
import { sortByCode, sortByNumeric } from './sort';

export const CARD_PITCH = 1;
export const CARD_SIZE = 0.86;
/** Extra horizontal room each bar's gap adds, as a multiple of its width. */
const BAR_GAP = 0.25;

export type LayoutSpec =
  | { type: 'grid'; sortBy?: string }
  | { type: 'bars'; by: string; bins?: number; sortBy?: string }
  | { type: 'scatter'; x: string; y: string; xBins?: number; yBins?: number; sortBy?: string }
  | { type: 'xy'; x: string; y: string };

export interface AxisTick { pos: number; label: string; count?: number }
export interface Axis { title: string; ticks: AxisTick[] }
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export interface LayoutResult {
  /** n*4 floats: x, y, size, alpha. */
  positions: Float32Array;
  bounds: Bounds;
  visible: number;
  xAxis?: Axis;
  yAxis?: Axis;
}

export interface LayoutColumnNumber { kind: 'number'; name: string; values: Float32Array; min: number; max: number }
export interface LayoutColumnCategory { kind: 'category'; name: string; codes: Int32Array; categories: string[] }
export interface LayoutColumnText { kind: 'text'; name: string; values: string[] }
export type LayoutColumn = LayoutColumnNumber | LayoutColumnCategory | LayoutColumnText;

export interface LayoutData {
  n: number;
  columns: Record<string, LayoutColumn>;
}

/** Visible row indices, in dataset order. */
export function visibleIndices(n: number, mask?: Uint8Array | null): Uint32Array {
  if (!mask) {
    const all = new Uint32Array(n);
    for (let i = 0; i < n; i++) all[i] = i;
    return all;
  }
  let count = 0;
  for (let i = 0; i < n; i++) if (mask[i]) count++;
  const out = new Uint32Array(count);
  let k = 0;
  for (let i = 0; i < n; i++) if (mask[i]) out[k++] = i;
  return out;
}

function orderBy(data: LayoutData, indices: Uint32Array, sortBy?: string): Uint32Array {
  if (!sortBy) return indices;
  const col = data.columns[sortBy];
  if (!col) return indices;
  if (col.kind === 'number') return sortByNumeric(indices, col.values);
  if (col.kind === 'category') return sortByCode(indices, col.codes, col.categories.length);
  return indices;
}

/** Group every row into a bucket: categorical codes, or equal-width bins of a numeric column. */
export function bucketize(
  data: LayoutData,
  field: string,
  bins = 12,
): { codes: Int32Array; labels: string[] } {
  const col = data.columns[field];
  if (!col) throw new Error(`unknown column ${field}`);
  if (col.kind === 'category') return { codes: col.codes, labels: col.categories };
  if (col.kind === 'text') throw new Error(`cannot bucket text column ${field}`);
  const { values, min, max } = col;
  const span = max - min || 1;
  const codes = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { codes[i] = -1; continue; }
    let b = Math.floor(((v - min) / span) * bins);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    codes[i] = b;
  }
  const labels: string[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = min + (span * b) / bins;
    labels.push(fmtTick(lo));
  }
  return { codes, labels };
}

function fmtTick(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(0) + 'k';
  if (a >= 10 || Number.isInteger(v)) return v.toFixed(0);
  return v.toFixed(1);
}

function empty(n: number): { positions: Float32Array } {
  return { positions: new Float32Array(n * 4) };
}

/** Packed mosaic, reading order, optionally sorted by a column. */
export function gridLayout(data: LayoutData, spec: Extract<LayoutSpec, { type: 'grid' }>, mask?: Uint8Array | null, aspect = 1.6): LayoutResult {
  const { positions } = empty(data.n);
  const order = orderBy(data, visibleIndices(data.n, mask), spec.sortBy);
  const count = order.length;
  const cols = Math.max(1, Math.round(Math.sqrt(count * aspect)));
  const rows = Math.ceil(count / cols);
  const x0 = -(cols * CARD_PITCH) / 2;
  const y0 = (rows * CARD_PITCH) / 2;
  for (let k = 0; k < count; k++) {
    const i = order[k] * 4;
    const col = k % cols;
    const row = (k / cols) | 0;
    positions[i] = x0 + col * CARD_PITCH;
    positions[i + 1] = y0 - row * CARD_PITCH;
    positions[i + 2] = CARD_SIZE;
    positions[i + 3] = 1;
  }
  return {
    positions,
    visible: count,
    bounds: { minX: x0, maxX: x0 + cols * CARD_PITCH, minY: y0 - rows * CARD_PITCH, maxY: y0 },
  };
}

/** Cards stacked into columns per bucket — Pivot's histogram/bar view. */
export function barsLayout(data: LayoutData, spec: Extract<LayoutSpec, { type: 'bars' }>, mask?: Uint8Array | null, aspect = 1.6): LayoutResult {
  const { positions } = empty(data.n);
  const { codes, labels } = bucketize(data, spec.by, spec.bins);
  const nGroups = labels.length;
  const order = orderBy(data, visibleIndices(data.n, mask), spec.sortBy);

  const counts = new Int32Array(nGroups);
  for (let k = 0; k < order.length; k++) {
    const c = codes[order[k]];
    if (c >= 0) counts[c]++;
  }
  let maxCount = 1;
  for (let g = 0; g < nGroups; g++) if (counts[g] > maxCount) maxCount = counts[g];

  // Pick the bar width that makes the whole chart match the viewport's aspect —
  // otherwise 2 buckets give a skyscraper and 24 give a pancake.
  const barCols = Math.max(1, Math.round(Math.sqrt((aspect * maxCount) / ((1 + BAR_GAP) * nGroups))));
  const gapCols = Math.max(1, Math.round(barCols * BAR_GAP));
  const stride = barCols + gapCols;
  const totalW = nGroups * stride - gapCols;
  const x0 = -totalW / 2;
  const maxRows = Math.ceil(maxCount / barCols);
  const y0 = -(maxRows * CARD_PITCH) / 2;

  const filled = new Int32Array(nGroups);
  for (let k = 0; k < order.length; k++) {
    const idx = order[k];
    const g = codes[idx];
    const i = idx * 4;
    if (g < 0) { positions[i + 2] = 0; positions[i + 3] = 0; continue; }
    const rank = filled[g]++;
    const col = rank % barCols;
    const row = (rank / barCols) | 0;
    positions[i] = x0 + g * stride + col * CARD_PITCH;
    positions[i + 1] = y0 + row * CARD_PITCH;
    positions[i + 2] = CARD_SIZE;
    positions[i + 3] = 1;
  }

  const ticks: AxisTick[] = [];
  for (let g = 0; g < nGroups; g++) {
    ticks.push({ pos: x0 + g * stride + (barCols * CARD_PITCH) / 2, label: labels[g], count: counts[g] });
  }
  return {
    positions,
    visible: order.length,
    bounds: { minX: x0, maxX: x0 + totalW, minY: y0, maxY: y0 + maxRows * CARD_PITCH },
    xAxis: { title: spec.by, ticks },
  };
}

/** Cross-tab / binned scatter: cards packed inside each (x,y) cell. */
export function scatterLayout(data: LayoutData, spec: Extract<LayoutSpec, { type: 'scatter' }>, mask?: Uint8Array | null): LayoutResult {
  const { positions } = empty(data.n);
  const xb = bucketize(data, spec.x, spec.xBins ?? 10);
  const yb = bucketize(data, spec.y, spec.yBins ?? 8);
  const nx = xb.labels.length;
  const ny = yb.labels.length;
  // Sorting matters as much here as in the grid: unsorted cells are confetti.
  const order = orderBy(data, visibleIndices(data.n, mask), spec.sortBy);

  const counts = new Int32Array(nx * ny);
  for (let k = 0; k < order.length; k++) {
    const idx = order[k];
    const cx = xb.codes[idx];
    const cy = yb.codes[idx];
    if (cx < 0 || cy < 0) continue;
    counts[cy * nx + cx]++;
  }
  let maxCell = 1;
  for (let c = 0; c < counts.length; c++) if (counts[c] > maxCell) maxCell = counts[c];
  const cellCards = Math.max(1, Math.ceil(Math.sqrt(maxCell)));
  const cellGap = Math.max(1, Math.round(cellCards * 0.2));
  const stride = cellCards + cellGap;

  const totalW = nx * stride - cellGap;
  const totalH = ny * stride - cellGap;
  const x0 = -totalW / 2;
  const y0 = -totalH / 2;

  const filled = new Int32Array(nx * ny);
  for (let k = 0; k < order.length; k++) {
    const idx = order[k];
    const i = idx * 4;
    const cx = xb.codes[idx];
    const cy = yb.codes[idx];
    if (cx < 0 || cy < 0) { positions[i + 2] = 0; positions[i + 3] = 0; continue; }
    const cell = cy * nx + cx;
    const rank = filled[cell]++;
    const col = rank % cellCards;
    const row = (rank / cellCards) | 0;
    positions[i] = x0 + cx * stride + col * CARD_PITCH;
    positions[i + 1] = y0 + cy * stride + row * CARD_PITCH;
    positions[i + 2] = CARD_SIZE;
    positions[i + 3] = 1;
  }

  const xTicks: AxisTick[] = [];
  for (let c = 0; c < nx; c++) xTicks.push({ pos: x0 + c * stride + (cellCards * CARD_PITCH) / 2, label: xb.labels[c] });
  const yTicks: AxisTick[] = [];
  for (let r = 0; r < ny; r++) yTicks.push({ pos: y0 + r * stride + (cellCards * CARD_PITCH) / 2, label: yb.labels[r] });

  return {
    positions,
    visible: order.length,
    bounds: { minX: x0, maxX: x0 + totalW, minY: y0, maxY: y0 + totalH },
    xAxis: { title: spec.x, ticks: xTicks },
    yAxis: { title: spec.y, ticks: yTicks },
  };
}

/**
 * Continuous scatter: two numeric columns mapped straight to world space, with
 * the data's own aspect ratio preserved. For a pixel collection (X, Y of an
 * image) this reproduces the picture exactly — cards land on the integer grid.
 */
export function xyLayout(data: LayoutData, spec: Extract<LayoutSpec, { type: 'xy' }>, mask?: Uint8Array | null): LayoutResult {
  const { positions } = empty(data.n);
  const xc = data.columns[spec.x];
  const yc = data.columns[spec.y];
  if (!xc || xc.kind !== 'number' || !yc || yc.kind !== 'number') {
    throw new Error('xy layout needs two numeric columns');
  }
  const order = visibleIndices(data.n, mask);
  const xSpan = xc.max - xc.min || 1;
  const ySpan = yc.max - yc.min || 1;

  // Size the plot so it holds roughly one card per item at the data's aspect.
  const dataAspect = xSpan / ySpan;
  let w = Math.max(1, Math.sqrt(Math.max(1, order.length) * dataAspect));
  let h = w / dataAspect;
  let sx = w / xSpan;
  // Data already on a unit grid — an image raster, integer coordinates — must be
  // placed at scale 1 exactly. A scale of 1.002 leaves a 0.2% gap at every seam,
  // which beats against the sample grid as a dark line every ~140 cards.
  if (Math.abs(sx - 1) < 0.1) {
    sx = 1;
    w = xSpan;
    h = ySpan;
  }
  const sy = h / ySpan;
  const x0 = -w / 2;
  const y0 = -h / 2;

  for (let k = 0; k < order.length; k++) {
    const idx = order[k];
    const i = idx * 4;
    const xv = xc.values[idx];
    const yv = yc.values[idx];
    if (!Number.isFinite(xv) || !Number.isFinite(yv)) { positions[i + 2] = 0; positions[i + 3] = 0; continue; }
    positions[i] = x0 + (xv - xc.min) * sx;
    positions[i + 1] = y0 + (yv - yc.min) * sy;
    // Full pitch, not CARD_SIZE: a photograph must tile without gaps.
    positions[i + 2] = CARD_PITCH;
    positions[i + 3] = 1;
  }

  const ticks = (col: LayoutColumnNumber, base: number, scale: number, span: number): AxisTick[] => {
    const out: AxisTick[] = [];
    for (let t = 0; t <= 4; t++) {
      const v = col.min + (span * t) / 4;
      out.push({ pos: base + (v - col.min) * scale, label: fmtTick(v) });
    }
    return out;
  };

  return {
    positions,
    visible: order.length,
    bounds: { minX: x0, maxX: x0 + w, minY: y0, maxY: y0 + h },
    xAxis: { title: spec.x, ticks: ticks(xc, x0, sx, xSpan) },
    yAxis: { title: spec.y, ticks: ticks(yc, y0, sy, ySpan) },
  };
}

export function computeLayout(data: LayoutData, spec: LayoutSpec, mask?: Uint8Array | null, aspect = 1.6): LayoutResult {
  switch (spec.type) {
    case 'grid': return gridLayout(data, spec, mask, aspect);
    case 'bars': return barsLayout(data, spec, mask, aspect);
    case 'scatter': return scatterLayout(data, spec, mask);
    case 'xy': return xyLayout(data, spec, mask);
  }
}
