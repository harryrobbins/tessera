/**
 * Minimal columnar store. Numeric columns are Float32Array, categoricals are
 * dictionary-encoded Int32 codes — both go straight to the layout worker as
 * transferables, and neither allocates per row at query time.
 */
export interface NumericColumn {
  kind: 'number';
  name: string;
  values: Float32Array;
  min: number;
  max: number;
  /** Optional formatter for axis ticks / detail pane. */
  format?: (v: number) => string;
}

export interface CategoryColumn {
  kind: 'category';
  name: string;
  codes: Int32Array;
  categories: string[];
}

export interface TextColumn {
  kind: 'text';
  name: string;
  values: string[];
}

export type Column = NumericColumn | CategoryColumn | TextColumn;

export interface Dataset {
  name: string;
  n: number;
  columns: Record<string, Column>;
  /** Column used for card titles. */
  labelColumn: string;
  /** Columns offered as facets / axes, in menu order. */
  facets: string[];
  /** Optional per-row true colour as RGB triplets (length n*3). When present the
   *  UI offers a "True colour" mode that paints each card its own colour rather
   *  than a categorical hue — the only honest way to show a photograph. */
  rgb?: Uint8Array;
  /** false = draw flat colour quads with no card art (pixels, dense scatter). */
  cards?: boolean;
}

export function numeric(name: string, values: ArrayLike<number>, format?: (v: number) => string): NumericColumn {
  const a = values instanceof Float32Array ? values : Float32Array.from(values);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) { min = 0; max = 0; }
  return { kind: 'number', name, values: a, min, max, format };
}

/** Dictionary-encode an array of strings. */
export function category(name: string, values: ArrayLike<string>): CategoryColumn {
  const dict = new Map<string, number>();
  const categories: string[] = [];
  const codes = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const s = values[i];
    let c = dict.get(s);
    if (c === undefined) {
      c = categories.length;
      dict.set(s, c);
      categories.push(s);
    }
    codes[i] = c;
  }
  return { kind: 'category', name, codes, categories };
}

/** Build a category column directly from codes (skips the hashing pass). */
export function categoryFromCodes(name: string, codes: Int32Array, categories: string[]): CategoryColumn {
  return { kind: 'category', name, codes, categories };
}

export function text(name: string, values: string[]): TextColumn {
  return { kind: 'text', name, values };
}

export function getNumeric(ds: Dataset, name: string): NumericColumn {
  const c = ds.columns[name];
  if (!c || c.kind !== 'number') throw new Error(`${name} is not a numeric column`);
  return c;
}

export function getCategory(ds: Dataset, name: string): CategoryColumn {
  const c = ds.columns[name];
  if (!c || c.kind !== 'category') throw new Error(`${name} is not a categorical column`);
  return c;
}

/** Value of any column at row i, as a display string. */
export function valueAt(ds: Dataset, name: string, i: number): string {
  const c = ds.columns[name];
  if (!c) return '';
  if (c.kind === 'category') return c.categories[c.codes[i]] ?? '';
  if (c.kind === 'text') return c.values[i] ?? '';
  const v = c.values[i];
  if (!Number.isFinite(v)) return '—';
  return c.format ? c.format(v) : shortNumber(v);
}

export function shortNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  if (a >= 10) return v.toFixed(0);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** Counts per category code (length = categories.length). */
export function histogram(col: CategoryColumn, mask?: Uint8Array): Int32Array {
  const out = new Int32Array(col.categories.length);
  for (let i = 0; i < col.codes.length; i++) {
    if (mask && !mask[i]) continue;
    const c = col.codes[i];
    if (c >= 0) out[c]++;
  }
  return out;
}

/** Equal-width binning of a numeric column into `bins` buckets. */
export function binNumeric(col: NumericColumn, bins: number): { codes: Int32Array; edges: Float64Array } {
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
  const edges = new Float64Array(bins + 1);
  for (let i = 0; i <= bins; i++) edges[i] = min + (span * i) / bins;
  return { codes, edges };
}
