import { describe, it, expect } from 'vitest';
import { datasetFromTable, UNKNOWN, type TableData } from '../src/data/fromTable';
import { valueAt } from '../src/data/columnar';

const table = (columns: TableData['columns'], rows: unknown[][], name = 'T'): TableData => ({ name, columns, rows });

describe('datasetFromTable: type inference', () => {
  it('turns booleans into Yes/No/Unknown categories', () => {
    const ds = datasetFromTable(table([{ name: 'paid', type: 'boolean' }], [[true], [false], [null], [true]]));
    const c = ds.columns.paid;
    expect(c.kind).toBe('category');
    if (c.kind !== 'category') return;
    expect(c.categories).toEqual(['Yes', 'No', UNKNOWN]);
    expect([0, 1, 2, 3].map((i) => valueAt(ds, 'paid', i))).toEqual(['Yes', 'No', UNKNOWN, 'Yes']);
    expect(ds.facets).toContain('paid');
  });

  it('makes a repeating string with 2–50 values a category, null as Unknown, most common first', () => {
    const rows = ['a', 'b', 'b', null, 'b', 'a'].map((v) => [v]);
    const ds = datasetFromTable(table([{ name: 'status', type: 'string' }], rows));
    const c = ds.columns.status;
    expect(c.kind).toBe('category');
    if (c.kind !== 'category') return;
    expect(c.categories).toEqual(['b', 'a', UNKNOWN]);
    expect(valueAt(ds, 'status', 3)).toBe(UNKNOWN);
  });

  it('keeps high-cardinality strings, single-valued strings and ids as text', () => {
    const rows = Array.from({ length: 200 }, (_, i) => [`v${i % 60}`, 'same', `ID-${i}`]);
    const ds = datasetFromTable(table([
      { name: 'code', type: 'string' },
      { name: 'const', type: 'string' },
      { name: 'ref', type: 'string', semantic: 'id' },
    ], rows));
    expect(ds.columns.code.kind).toBe('text');
    expect(ds.columns.const.kind).toBe('text');
    expect(ds.columns.ref.kind).toBe('text');
    expect(ds.facets).toEqual([]);
  });

  it('honours the category threshold exactly (50 in, 51 out)', () => {
    const mk = (k: number) => Array.from({ length: k * 3 }, (_, i) => [`c${i % k}`]);
    expect(datasetFromTable(table([{ name: 's', type: 'string' }], mk(50))).columns.s.kind).toBe('category');
    expect(datasetFromTable(table([{ name: 's', type: 'string' }], mk(51))).columns.s.kind).toBe('text');
  });

  it('does not make a few all-distinct names into a category', () => {
    const ds = datasetFromTable(table([{ name: 'name', type: 'string' }], [['Ann'], ['Bob'], ['Cy']]));
    expect(ds.columns.name.kind).toBe('text');
    expect(ds.labelColumn).toBe('name');
  });

  it('reads numbers (and numeric strings) as numeric, null as NaN', () => {
    const ds = datasetFromTable(table([{ name: 'qty', type: 'number' }], [[1], ['2'], [null], [4]]));
    const c = ds.columns.qty;
    expect(c.kind).toBe('number');
    if (c.kind !== 'number') return;
    expect(Array.from(c.values.slice(0, 2))).toEqual([1, 2]);
    expect(Number.isNaN(c.values[2])).toBe(true);
    expect(c.min).toBe(1);
    expect(c.max).toBe(4);
    expect(ds.facets).toEqual(['qty']);
  });

  it('turns a numeric id into text, not a quantity', () => {
    const ds = datasetFromTable(table([{ name: 'id', type: 'number', semantic: 'id' }], [[7], [8]]));
    expect(ds.columns.id.kind).toBe('text');
    expect(valueAt(ds, 'id', 1)).toBe('8');
    expect(ds.labelColumn).toBe('id');
  });

  it('divides currency_minor by 100 and formats it in the column currency', () => {
    const ds = datasetFromTable(table([{ name: 'amount_minor', title: 'Amount', type: 'number', semantic: 'currency_minor', currency: 'GBP' }], [[123456], [99]]));
    const c = ds.columns.Amount;
    expect(c.kind).toBe('number');
    if (c.kind !== 'number') return;
    expect(c.values[0]).toBeCloseTo(1234.56, 2);
    expect(valueAt(ds, 'Amount', 0)).toBe('£1,234.56');
    expect(valueAt(ds, 'Amount', 1)).toBe('£0.99');
  });

  it('survives an unknown currency code', () => {
    const ds = datasetFromTable(table([{ name: 'm', type: 'number', semantic: 'currency_minor', currency: 'NOPE' }], [[150]]));
    expect(valueAt(ds, 'm', 0)).toBe('1.50 NOPE');
  });

  it('turns timestamps (ISO or epoch ms) into epoch days plus year and month categories', () => {
    const ms = Date.UTC(2024, 2, 15);
    const ds = datasetFromTable(table([{ name: 'created', title: 'Created', type: 'timestamp' }], [
      ['2023-11-02T10:00:00Z'], [ms], [null],
    ]));
    const c = ds.columns.Created;
    expect(c.kind).toBe('number');
    if (c.kind !== 'number') return;
    expect(c.values[1]).toBeCloseTo(ms / 86_400_000, 0);
    expect(valueAt(ds, 'Created', 1)).toBe('2024-03-15');
    expect(Number.isNaN(c.values[2])).toBe(true);
    const y = ds.columns['Created year'];
    const m = ds.columns['Created month'];
    expect(y.kind === 'category' && y.categories).toEqual(['2023', '2024', UNKNOWN]);
    expect(m.kind === 'category' && m.categories).toEqual(['2023-11', '2024-03', UNKNOWN]);
    // Categories first, then numerics.
    expect(ds.facets).toEqual(['Created year', 'Created month', 'Created']);
  });

  it('sets geo from a latitude/longitude semantic pair', () => {
    const ds = datasetFromTable(table([
      { name: 'lat', type: 'number', semantic: 'latitude' },
      { name: 'lng', type: 'number', semantic: 'longitude' },
    ], [[51.5, -0.1], [53.4, -2.2]]));
    expect(ds.geo).toEqual({ lon: 'lng', lat: 'lat' });
  });

  it('leaves geo unset with only one half of the pair', () => {
    const ds = datasetFromTable(table([{ name: 'lat', type: 'number', semantic: 'latitude' }], [[1]]));
    expect(ds.geo).toBeUndefined();
  });
});

describe('datasetFromTable: label and facets', () => {
  it('prefers a title-like column over an id', () => {
    const ds = datasetFromTable(table([
      { name: 'order_id', type: 'string' },
      { name: 'customer_name', title: 'Customer', type: 'string' },
    ], [['O1', 'Ann'], ['O2', 'Bob'], ['O3', 'Cy']]));
    expect(ds.labelColumn).toBe('Customer');
  });

  it('falls back to an id-like column, then the first text column', () => {
    const idOnly = datasetFromTable(table([
      { name: 'note', type: 'string' },
      { name: 'order_id', type: 'string' },
    ], [['x1', 'O1'], ['x2', 'O2'], ['x3', 'O3']]));
    expect(idOnly.labelColumn).toBe('order_id');
    const textOnly = datasetFromTable(table([{ name: 'note', type: 'string' }], [['x1'], ['x2'], ['x3']]));
    expect(textOnly.labelColumn).toBe('note');
  });

  it('synthesises a row-number label when there is no text column', () => {
    const ds = datasetFromTable(table([{ name: 'v', type: 'number' }], [[1], [2]]));
    expect(ds.labelColumn).toBe('Row');
    expect(valueAt(ds, 'Row', 1)).toBe('#2');
    expect(ds.facets).toEqual(['v']);
  });

  it('lists categories in column order, then numerics; omits card and detail', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [i, `r${i % 3}`, i * 2, i % 2 === 0]);
    const ds = datasetFromTable(table([
      { name: 'n1', type: 'number' },
      { name: 'region', type: 'string' },
      { name: 'n2', type: 'number' },
      { name: 'flag', type: 'boolean' },
    ], rows, 'Orders'));
    expect(ds.facets).toEqual(['region', 'flag', 'n1', 'n2']);
    expect(ds.name).toBe('Orders');
    expect(ds.n).toBe(30);
    expect(ds.card).toBeUndefined();
    expect(ds.detail).toBeUndefined();
  });

  it('de-duplicates clashing display names', () => {
    const ds = datasetFromTable(table([
      { name: 'a', title: 'Value', type: 'number' },
      { name: 'b', title: 'Value', type: 'number' },
    ], [[1, 2]]));
    expect(Object.keys(ds.columns)).toEqual(expect.arrayContaining(['Value', 'Value (2)']));
  });

  it('handles an empty table and short rows', () => {
    const empty = datasetFromTable(table([{ name: 's', type: 'string' }, { name: 't', type: 'timestamp' }], []));
    expect(empty.n).toBe(0);
    expect(empty.columns.s.kind).toBe('text');
    const short = datasetFromTable(table([{ name: 'a', type: 'number' }, { name: 'b', type: 'string' }], [[1], [2, 'x']]));
    expect(short.n).toBe(2);
    expect(valueAt(short, 'b', 0)).toBe('');
  });

  it('builds 50,000 rows × 12 columns quickly (perf smoke)', () => {
    const cols: TableData['columns'] = [
      { name: 'id', type: 'string', semantic: 'id' },
      { name: 'name', type: 'string' },
      { name: 'region', type: 'string' },
      { name: 'status', type: 'string' },
      { name: 'active', type: 'boolean' },
      { name: 'amount_minor', type: 'number', semantic: 'currency_minor', currency: 'GBP' },
      { name: 'qty', type: 'number' },
      { name: 'score', type: 'number' },
      { name: 'created_at', type: 'timestamp' },
      { name: 'lat', type: 'number', semantic: 'latitude' },
      { name: 'lon', type: 'number', semantic: 'longitude' },
      { name: 'note', type: 'string' },
    ];
    const t0Ms = Date.UTC(2023, 0, 1);
    const rows = Array.from({ length: 50_000 }, (_, i) => [
      `ID-${i}`, `Person ${i}`, `R${i % 12}`, ['open', 'closed', 'pending'][i % 3], i % 2 === 0,
      i * 7, i % 100, Math.sin(i), new Date(t0Ms + i * 3_600_000).toISOString(), 50 + (i % 100) / 50, -3 + (i % 70) / 20,
      i % 5 ? `note ${i}` : null,
    ]);
    const t0 = performance.now();
    const ds = datasetFromTable({ name: 'Big', columns: cols, rows });
    const ms = performance.now() - t0;
    expect(ds.n).toBe(50_000);
    expect(ds.labelColumn).toBe('name');
    expect(ds.geo).toEqual({ lon: 'lon', lat: 'lat' });
    expect(ds.facets.slice(0, 5)).toEqual(['region', 'status', 'active', 'created_at year', 'created_at month']);
    // Generous for CI; locally it is a few hundred ms.
    expect(ms).toBeLessThan(3000);
  });
});

describe('datasetFromTable: review edge cases', () => {
  it('reads nanosecond and microsecond epoch numbers by magnitude, and out-of-range dates as Unknown', () => {
    const ms = Date.UTC(2024, 0, 5);
    const rows = [[ms], [ms * 1000], [ms * 1e6], [1e300], [ms]];
    const ds = datasetFromTable(table([{ name: 'at', type: 'timestamp' }], rows));
    expect([0, 1, 2].map((i) => valueAt(ds, 'at', i))).toEqual(['2024-01-05', '2024-01-05', '2024-01-05']);
    expect(valueAt(ds, 'at year', 3)).toBe(UNKNOWN);
    expect(valueAt(ds, 'at', 3)).toBe('—');
  });

  it('parses short digit strings as dates, not epoch ms', () => {
    const ms = Date.UTC(2024, 0, 5);
    const rows = [['2024'], ['20240105'], [String(ms)], ['2024']];
    const ds = datasetFromTable(table([{ name: 'at', type: 'timestamp' }], rows));
    expect(valueAt(ds, 'at year', 0)).toBe('2024');
    expect(valueAt(ds, 'at', 1)).toBe('2024-01-05');
    expect(valueAt(ds, 'at', 2)).toBe('2024-01-05');
  });

  it('shows currency to the penny even where Float32 cannot hold it', () => {
    const rows = [[123456789], [5]];
    const ds = datasetFromTable(table([{ name: 'amount', type: 'number', semantic: 'currency_minor', currency: 'GBP' }], rows));
    expect(valueAt(ds, 'amount', 0)).toBe('£1,234,567.89');
    expect(valueAt(ds, 'amount', 1)).toBe('£0.05');
  });
});
