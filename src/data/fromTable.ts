/**
 * `datasetFromTable`: a plain row-major table (what a data connector returns)
 * into a Tessera `Dataset`, inferring what each column should be.
 *
 * - boolean → category (Yes / No / Unknown)
 * - string with 2–50 distinct values → category, null shown as "Unknown";
 *   any other string → text. An `id` column is always text.
 * - number → numeric (NaN for null). `currency_minor` is divided by 100 and
 *   formatted with `Intl.NumberFormat` in the column's `currency`. A numeric
 *   `id` becomes text: an identifier is not a quantity.
 * - timestamp (ISO string or epoch ms) → numeric epoch days with a date
 *   format, plus derived "<title> year" and "<title> month" categories.
 * - a latitude/longitude pair (by `semantic`) → `geo`, so it opens on the map.
 * - label: a title-like column (`name`, `title`, `label`, or `…_name` …),
 *   else an id-like one, else the first text column, else a row number.
 * - facets: categories in column order, then numerics. `card` and `detail`
 *   are left out, so Tessera derives both.
 */
import {
  category, categoryFromCodes, derivedText, numeric, text,
  type Column, type Dataset,
} from './columnar';

export interface TableColumn {
  /** Key in each row (the row is an array; this names the position). */
  name: string;
  /** Display name. */
  title?: string;
  type: 'string' | 'number' | 'boolean' | 'timestamp';
  semantic?: 'id' | 'latitude' | 'longitude' | 'currency_minor' | string;
  /** With `currency_minor`, e.g. "GBP". */
  currency?: string;
}

export interface TableData {
  /** Collection title shown in the menu. */
  name: string;
  columns: TableColumn[];
  /** Row-major, aligned with `columns`. */
  rows: unknown[][];
  /** True when a row cap cut the table short. */
  truncated?: boolean;
  /** Exact total when the source knows it. */
  totalRows?: number;
}

export interface FromTableOptions {
  /** Most distinct strings a column may have and still be a category. Default 50. */
  maxCategories?: number;
  /** Overrides `table.name` as the dataset name. */
  name?: string;
}

export const UNKNOWN = 'Unknown';
const DAY_MS = 86_400_000;
const TITLE_WORDS = ['name', 'title', 'label'];

const isNull = (v: unknown) => v === null || v === undefined || v === '';

function toMs(v: unknown): number {
  if (isNull(v)) return NaN;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    // A numeric string is epoch ms; anything else is parsed as a date.
    if (/^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
    return Date.parse(v);
  }
  return NaN;
}

function toNum(v: unknown): number {
  if (isNull(v)) return NaN;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function toBool(v: unknown): boolean | null {
  if (isNull(v)) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === '0') return false;
  return null;
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const isTitleLike = (c: TableColumn) => {
  const w = words(c.name);
  return w.length > 0 && TITLE_WORDS.includes(w[w.length - 1]);
};
const isIdLike = (c: TableColumn) => {
  if (c.semantic === 'id') return true;
  const w = words(c.name);
  return w.length > 0 && w[w.length - 1] === 'id';
};

/** Categories from codes, ordered by frequency (most common first, "Unknown" last). */
function frequencyCategory(name: string, values: string[]): Column {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const cats = [...counts.keys()].sort((a, b) => {
    if (a === UNKNOWN) return 1;
    if (b === UNKNOWN) return -1;
    return counts.get(b)! - counts.get(a)! || (a < b ? -1 : a > b ? 1 : 0);
  });
  const index = new Map(cats.map((c, i) => [c, i]));
  const codes = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) codes[i] = index.get(values[i])!;
  return categoryFromCodes(name, codes, cats);
}

/** Categories in natural order (chronological for year/month labels), "Unknown" last. */
function sortedCategory(name: string, values: string[]): Column {
  const c = category(name, values);
  const want = c.categories.slice().sort((a, b) => (a === UNKNOWN ? 1 : b === UNKNOWN ? -1 : a < b ? -1 : a > b ? 1 : 0));
  const remap = new Int32Array(c.categories.length);
  c.categories.forEach((label, from) => { remap[from] = want.indexOf(label); });
  for (let i = 0; i < c.codes.length; i++) c.codes[i] = remap[c.codes[i]];
  c.categories = want;
  return c;
}

function currencyFormat(code: string | undefined): (v: number) => string {
  let fmt: Intl.NumberFormat;
  try {
    fmt = code
      ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: code })
      : new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    // An unknown currency code: plain two-decimal numbers, with the code.
    const plain = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v) => `${plain.format(v)} ${code}`;
  }
  return (v) => fmt.format(v);
}

const dateFormat = (days: number) => {
  const d = new Date(Math.round(days * DAY_MS));
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
};

export function datasetFromTable(table: TableData, opts: FromTableOptions = {}): Dataset {
  const maxCats = opts.maxCategories ?? 50;
  const rows = table.rows ?? [];
  const n = rows.length;
  const columns: Record<string, Column> = {};
  const categories: string[] = [];
  const numerics: string[] = [];
  const used = new Set<string>();
  /** Display key for a column, unique across the dataset. */
  const keyFor = (want: string) => {
    let k = want || 'column';
    for (let i = 2; used.has(k); i++) k = `${want} (${i})`;
    used.add(k);
    return k;
  };

  let lat: string | undefined;
  let lon: string | undefined;
  let titleKey: string | undefined;
  let idKey: string | undefined;
  let firstText: string | undefined;

  table.columns.forEach((col, ci) => {
    const title = col.title || col.name;
    const cell = (i: number) => rows[i]?.[ci];

    if (col.type === 'boolean') {
      const key = keyFor(title);
      const vals = new Array<string>(n);
      for (let i = 0; i < n; i++) {
        const b = toBool(cell(i));
        vals[i] = b === null ? UNKNOWN : b ? 'Yes' : 'No';
      }
      columns[key] = sortedCategory(key, vals);
      // "No" < "Unknown" < "Yes" alphabetically; put them in the obvious order.
      const c = columns[key];
      if (c.kind === 'category') {
        const order = ['Yes', 'No', UNKNOWN].filter((l) => c.categories.includes(l));
        const remap = new Int32Array(c.categories.length);
        c.categories.forEach((l, from) => { remap[from] = order.indexOf(l); });
        for (let i = 0; i < n; i++) c.codes[i] = remap[c.codes[i]];
        c.categories = order;
      }
      categories.push(key);
      return;
    }

    if (col.type === 'number' && col.semantic !== 'id') {
      const key = keyFor(title);
      const vals = new Float32Array(n);
      const money = col.semantic === 'currency_minor';
      for (let i = 0; i < n; i++) {
        const v = toNum(cell(i));
        vals[i] = money ? v / 100 : v;
      }
      columns[key] = numeric(key, vals, money ? currencyFormat(col.currency) : undefined);
      numerics.push(key);
      if (col.semantic === 'latitude') lat = key;
      if (col.semantic === 'longitude') lon = key;
      return;
    }

    if (col.type === 'timestamp') {
      const key = keyFor(title);
      const days = new Float32Array(n);
      const years = new Array<string>(n);
      const months = new Array<string>(n);
      for (let i = 0; i < n; i++) {
        const ms = toMs(cell(i));
        if (!Number.isFinite(ms)) { days[i] = NaN; years[i] = months[i] = UNKNOWN; continue; }
        days[i] = ms / DAY_MS;
        const iso = new Date(ms).toISOString();
        years[i] = iso.slice(0, 4);
        months[i] = iso.slice(0, 7);
      }
      columns[key] = numeric(key, days, dateFormat);
      numerics.push(key);
      const yk = keyFor(`${title} year`);
      const mk = keyFor(`${title} month`);
      columns[yk] = sortedCategory(yk, years);
      columns[mk] = sortedCategory(mk, months);
      categories.push(yk, mk);
      return;
    }

    // Strings (and numeric ids, which are identifiers rather than quantities).
    const key = keyFor(title);
    const raw = new Array<string>(n);
    const distinct = new Set<string>();
    let nonNull = 0;
    for (let i = 0; i < n; i++) {
      const v = cell(i);
      if (isNull(v)) { raw[i] = ''; continue; }
      const s = typeof v === 'string' ? v : String(v);
      raw[i] = s;
      nonNull++;
      if (distinct.size <= maxCats) distinct.add(s);
    }
    const idLike = isIdLike(col);
    // A handful of rows that are all different is a list of names, not a
    // grouping: the category rule also wants most values to repeat.
    const repeats = distinct.size <= Math.max(2, nonNull / 2);
    if (!idLike && distinct.size >= 2 && distinct.size <= maxCats && repeats) {
      for (let i = 0; i < n; i++) if (raw[i] === '') raw[i] = UNKNOWN;
      columns[key] = frequencyCategory(key, raw);
      categories.push(key);
      if (!titleKey && isTitleLike(col)) titleKey = key;
      return;
    }
    columns[key] = text(key, raw);
    if (!titleKey && isTitleLike(col)) titleKey = key;
    if (!idKey && idLike) idKey = key;
    if (!firstText) firstText = key;
  });

  let labelColumn = titleKey ?? idKey ?? firstText;
  if (!labelColumn) {
    labelColumn = keyFor('Row');
    columns[labelColumn] = derivedText(labelColumn, (i) => (i >= 0 && i < n ? `#${(i + 1).toLocaleString()}` : ''));
  }

  const ds: Dataset = {
    name: opts.name ?? table.name,
    n,
    columns,
    labelColumn,
    facets: [...categories, ...numerics],
  };
  if (lat && lon) ds.geo = { lon, lat };
  return ds;
}
