import { describe, it, expect } from 'vitest';
import { getCategory, getNumeric, valueAt, type Dataset } from '../src/data/columnar';
import { generateProducts } from '../src/data/products';
import { generateTaxCases, formatDayOfYear } from '../src/data/taxCases';
import { mulberry32, cumulative, pickCum, hashU32 } from '../src/data/random';
import { UK_PLACES } from '../src/data/ukPlaces';
import { fs, path, testsDir } from './helpers/nodefs';
import { faker } from '@faker-js/faker/locale/en_GB';

// ----------------------------------------------------------------- helpers

function share(ds: Dataset, col: string, cat: string, mask?: (i: number) => boolean): number {
  const c = getCategory(ds, col);
  const code = c.categories.indexOf(cat);
  let hit = 0, total = 0;
  for (let i = 0; i < ds.n; i++) {
    if (mask && !mask(i)) continue;
    total++;
    if (c.codes[i] === code) hit++;
  }
  return total ? hit / total : NaN;
}
function meanWhere(ds: Dataset, col: string, mask: (i: number) => boolean): number {
  const v = getNumeric(ds, col).values;
  let s = 0, k = 0;
  for (let i = 0; i < ds.n; i++) {
    if (!mask(i) || !Number.isFinite(v[i])) continue;
    s += v[i]; k++;
  }
  return s / k;
}
function is(ds: Dataset, col: string, cat: string): (i: number) => boolean {
  const c = getCategory(ds, col);
  const code = c.categories.indexOf(cat);
  return (i) => c.codes[i] === code;
}
function typedColumns(ds: Dataset): Record<string, ArrayLike<number>> {
  const out: Record<string, ArrayLike<number>> = {};
  for (const [k, c] of Object.entries(ds.columns)) {
    if (c.kind === 'number') out[k] = c.values;
    else if (c.kind === 'category') out[k] = c.codes;
  }
  return out;
}
function expectDeterministic(gen: (seed: number) => Dataset, seedA: number, seedB: number) {
  expect(typedColumns(gen(seedA))).toEqual(typedColumns(gen(seedA)));
  const a = typedColumns(gen(seedA));
  const b = typedColumns(gen(seedB));
  const changed = Object.keys(a).some((k) => !Array.from(a[k] as Float32Array).every((v, i) => Object.is(v, (b[k] as Float32Array)[i])));
  expect(changed).toBe(true);
}

// ------------------------------------------------------------------ random

describe('random helpers', () => {
  it('cumulative ends at exactly 1 and pickCum honours weights', () => {
    const cum = cumulative([1, 3]);
    expect(cum[1]).toBe(1);
    const rand = mulberry32(3);
    let ones = 0;
    for (let i = 0; i < 20_000; i++) if (pickCum(rand, cum) === 1) ones++;
    expect(ones / 20_000).toBeCloseTo(0.75, 1);
  });
  it('pickCum addresses packed tables by offset', () => {
    const packed = new Float32Array([...cumulative([1, 0]), ...cumulative([0, 1])]);
    const rand = mulberry32(1);
    expect(pickCum(rand, packed, 0, 2)).toBe(0);
    expect(pickCum(rand, packed, 2, 2)).toBe(1);
  });
  it('hashU32 is in [0,1), stable, and salt-sensitive', () => {
    expect(hashU32(5, 1)).toBe(hashU32(5, 1));
    expect(hashU32(5, 1)).not.toBe(hashU32(5, 2));
    for (let i = 0; i < 1000; i++) { const h = hashU32(i, 9); expect(h).toBeGreaterThanOrEqual(0); expect(h).toBeLessThan(1); }
  });
});

// -------------------------------------------------------- existing datasets

describe('products stream is unchanged by the shared PRNG', () => {
  it('generateProducts(1000) first ten Value values match the pre-refactor capture', () => {
    const v = getNumeric(generateProducts(1000), 'Value').values.slice(0, 10);
    expect(Array.from(v)).toEqual([
      1598584.5, 3632131.25, 78932.125, 277226, 1499154.125, 826918.3125, 439157.28125, 21026968, 35621.3125, 650456.625,
    ]);
  });
});

// --------------------------------------------------------------- tax cases

describe('generateTaxCases', () => {
  const ds = generateTaxCases(20_000, 11, faker);
  const N = ds.n;

  it('is deterministic per seed', () => expectDeterministic((s) => generateTaxCases(2000, s), 11, 12));

  it('has the specified marginals (±2.5 pts)', () => {
    expect(share(ds, 'Topic', 'Self Assessment')).toBeCloseTo(0.30, 1.3);
    expect(share(ds, 'Topic', 'PAYE')).toBeCloseTo(0.22, 1.3);
    expect(share(ds, 'Topic', 'VAT')).toBeCloseTo(0.18, 1.3);
    expect(share(ds, 'Channel', 'Phone')).toBeCloseTo(0.45, 1.3);
    expect(share(ds, 'Channel', 'Post')).toBeCloseTo(0.10, 1.3);
    const esc = share(ds, 'Escalated', 'Yes');
    expect(esc).toBeGreaterThanOrEqual(0.05); expect(esc).toBeLessThanOrEqual(0.10);
    const open = share(ds, 'Status', 'Open');
    expect(open).toBeGreaterThanOrEqual(0.12); expect(open).toBeLessThanOrEqual(0.24);
  });

  it('hours NaN iff Open; satisfaction integer 1..5 or NaN iff Open/unsurveyed; Opened in 1..365; Month matches', () => {
    const open = is(ds, 'Status', 'Open');
    const hours = getNumeric(ds, 'Resolution hours').values;
    const sat = getNumeric(ds, 'Satisfaction').values;
    const opened = getNumeric(ds, 'Opened').values;
    const month = getCategory(ds, 'Month').codes;
    const contacts = getNumeric(ds, 'Contacts').values;
    const monthEnds = [31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
    let unsurveyed = 0;
    for (let i = 0; i < N; i++) {
      expect(Number.isNaN(hours[i])).toBe(open(i));
      if (!open(i)) { expect(hours[i]).toBeGreaterThanOrEqual(0.1); expect(hours[i]).toBeLessThanOrEqual(240); }
      if (open(i)) expect(Number.isNaN(sat[i])).toBe(true);
      else if (Number.isNaN(sat[i])) unsurveyed++;
      else { expect(Number.isInteger(sat[i])).toBe(true); expect(sat[i]).toBeGreaterThanOrEqual(1); expect(sat[i]).toBeLessThanOrEqual(5); }
      expect(opened[i]).toBeGreaterThanOrEqual(1); expect(opened[i]).toBeLessThanOrEqual(365);
      expect(month[i]).toBe(monthEnds.findIndex((e) => opened[i] <= e));
      expect(contacts[i]).toBeGreaterThanOrEqual(1); expect(contacts[i]).toBeLessThanOrEqual(8);
    }
    const resolved = N - Math.round(share(ds, 'Status', 'Open') * N);
    expect(unsurveyed / resolved).toBeCloseTo(0.25, 1);
  });

  it('has the intended correlations', () => {
    const h = (ch: string) => meanWhere(ds, 'Resolution hours', is(ds, 'Channel', ch));
    expect(h('Post')).toBeGreaterThan(h('Web form'));
    expect(h('Web form')).toBeGreaterThan(h('Phone'));
    expect(h('Phone')).toBeGreaterThan(h('Webchat'));
    const satNo = meanWhere(ds, 'Satisfaction', is(ds, 'Escalated', 'No'));
    const satYes = meanWhere(ds, 'Satisfaction', is(ds, 'Escalated', 'Yes'));
    expect(satNo - satYes).toBeGreaterThanOrEqual(0.5);
    const saJan = share(ds, 'Topic', 'Self Assessment', is(ds, 'Month', 'Jan'));
    const saJun = share(ds, 'Topic', 'Self Assessment', is(ds, 'Month', 'Jun'));
    expect(saJan).toBeGreaterThanOrEqual(1.5 * saJun);
    expect(share(ds, 'Team', 'Benefits & Credits', is(ds, 'Topic', 'Tax Credits'))).toBeGreaterThanOrEqual(0.8);
  });

  it('geography: coordinates on the UK, postcodes match towns, area/age drive channel', () => {
    const lon = getNumeric(ds, 'Longitude').values;
    const lat = getNumeric(ds, 'Latitude').values;
    for (let i = 0; i < N; i++) {
      expect(lon[i]).toBeGreaterThanOrEqual(-8.2); expect(lon[i]).toBeLessThanOrEqual(1.8);
      expect(lat[i]).toBeGreaterThanOrEqual(49.9); expect(lat[i]).toBeLessThanOrEqual(60.9);
    }
    const pc = ds.columns.Postcode;
    const town = getCategory(ds, 'Town');
    expect(pc?.kind).toBe('text');
    if (pc?.kind === 'text') {
      for (let i = 0; i < 500; i++) {
        expect(pc.at(i)).toMatch(/^[A-Z]{1,2}\d{1,2} \d[A-Z]{2}$/);
        const area = UK_PLACES.find((p) => p.name === town.categories[town.codes[i]])!.pc;
        expect(pc.at(i).startsWith(area)).toBe(true);
      }
    }
    // Region follows the customer's town.
    const region = getCategory(ds, 'Region');
    for (let i = 0; i < 500; i++) {
      expect(region.codes[i]).toBe(UK_PLACES.find((p) => p.name === town.categories[town.codes[i]])!.region);
    }
    const phone = (mask: (i: number) => boolean) => share(ds, 'Channel', 'Phone', mask);
    expect(phone(is(ds, 'Area type', 'Rural'))).toBeGreaterThan(phone(is(ds, 'Area type', 'Urban')));
    const digital = (mask: (i: number) => boolean) => share(ds, 'Channel', 'Webchat', mask) + share(ds, 'Channel', 'Web form', mask);
    expect(digital(is(ds, 'Age band', '75+'))).toBeLessThan(digital(is(ds, 'Age band', '18–29')));
    expect(share(ds, 'Area type', 'Rural')).toBeGreaterThan(0.08);
    expect(share(ds, 'Area type', 'Urban')).toBeGreaterThan(0.15);
    const customer = ds.columns.Customer;
    expect(customer?.kind === 'text' && /^\S+.* \S+$/.test(customer.at(0))).toBe(true);
    // Names come from a seeded faker: same seed, same names.
    const again = generateTaxCases(50, 11, faker);
    const five = (d: typeof ds) => [0, 1, 2, 3, 4].map((i) => valueAt(d, 'Customer', i));
    expect(five(again)).toEqual(five(ds));
  });

  it('formats Opened as a day and month', () => {
    expect(formatDayOfYear(1)).toBe('1 Jan');
    expect(formatDayOfYear(71)).toBe('12 Mar');
    expect(formatDayOfYear(365)).toBe('31 Dec');
    expect(getNumeric(ds, 'Opened').format!(71)).toBe('12 Mar');
  });

  it('generates 100k rows quickly (soft)', () => {
    const t0 = performance.now();
    generateTaxCases(100_000);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

// ------------------------------------------------------------- tax returns

import { generateTaxReturns } from '../src/data/taxReturns';
import { generatePayments } from '../src/data/payments';

function spearman(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  const rank = (x: ArrayLike<number>) => {
    const idx = Array.from({ length: n }, (_, i) => i).sort((p, q) => x[p] - x[q]);
    const r = new Float64Array(n);
    for (let k = 0; k < n; k++) r[idx[k]] = k;
    return r;
  };
  const ra = rank(a), rb = rank(b);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += ra[i]; mb += rb[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = ra[i] - ma, db = rb[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return sab / Math.sqrt(saa * sbb);
}

describe('generateTaxReturns', () => {
  const ds = generateTaxReturns(20_000);

  it('is deterministic per seed', () => expectDeterministic((s) => generateTaxReturns(2000, s), 23, 24));

  it('has the contract shape', () => {
    expect(ds.name).toBe('Tax returns (20,000)');
    expect(ds.labelColumn).toBe('Return');
    expect(ds.facets).toEqual(['Filed', 'Sector', 'Income band', 'Filing month', 'Outcome', 'Agent filed', 'Filing method', 'Income', 'Tax due', 'Balance', 'Penalty', 'Tax year']);
    expect(getCategory(ds, 'Income band').categories[0]).toBe('Under £12.5k');
    expect(getCategory(ds, 'Filing month').categories).toEqual(['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar']);
    // The shape does not change with the size: the reference is derived, so
    // a million rows cost nothing to label.
    const big = generateTaxReturns(60_000);
    expect(big.labelColumn).toBe('Return');
    expect(Object.keys(big.columns)).toEqual(Object.keys(ds.columns));
    expect(valueAt(big, 'Return', 59_999)).toBe('SA-24-060000');
  });

  it('late 7–14%, penalty > 0 iff Late, Late iff filed after Jan, band matches income', () => {
    const late = share(ds, 'Filed', 'Late');
    expect(late).toBeGreaterThanOrEqual(0.07); expect(late).toBeLessThanOrEqual(0.14);
    const isLate = is(ds, 'Filed', 'Late');
    const pen = getNumeric(ds, 'Penalty').values;
    const month = getCategory(ds, 'Filing month').codes;
    const inc = getNumeric(ds, 'Income').values;
    const band = getCategory(ds, 'Income band').codes;
    const edges = [12_500, 25_000, 50_000, 100_000, 150_000, 500_000];
    for (let i = 0; i < ds.n; i++) {
      expect(pen[i] > 0).toBe(isLate(i));
      expect(month[i] >= 10).toBe(isLate(i));
      expect(pen[i]).toBeLessThanOrEqual(3000);
      expect(inc[i]).toBeGreaterThanOrEqual(0); expect(inc[i]).toBeLessThanOrEqual(250_000);
      let b = 0; while (b < edges.length && inc[i] >= edges[b]) b++;
      expect(band[i]).toBe(b);
    }
  });

  it('income and tax due are strongly rank-correlated', () => {
    expect(spearman(getNumeric(ds, 'Income').values, getNumeric(ds, 'Tax due').values)).toBeGreaterThan(0.9);
  });
});

describe('generatePayments', () => {
  const ds = generatePayments(50_000);

  it('is deterministic per seed', () => expectDeterministic((s) => generatePayments(2000, s), 31, 32));

  it('has the contract shape', () => {
    expect(ds.name).toBe('Card payments (50,000)');
    expect(ds.labelColumn).toBe('Transaction');
    expect(ds.facets).toEqual(['Merchant category', 'Method', 'Where', 'Fraud', 'Outcome', 'Country', 'Day', 'Amount', 'Risk score', 'Hour']);
    expect(valueAt(ds, 'Transaction', 0)).toBe('TX-000001');
  });

  it('fraud marginals and drivers', () => {
    const flagged = share(ds, 'Fraud', 'Flagged');
    expect(flagged).toBeGreaterThanOrEqual(0.008); expect(flagged).toBeLessThanOrEqual(0.025);
    const abroad = share(ds, 'Fraud', 'Flagged', is(ds, 'Where', 'Abroad'));
    const domestic = share(ds, 'Fraud', 'Flagged', is(ds, 'Where', 'Domestic'));
    expect(abroad).toBeGreaterThanOrEqual(2 * domestic);
    const rf = meanWhere(ds, 'Risk score', is(ds, 'Fraud', 'Flagged'));
    const rl = meanWhere(ds, 'Risk score', is(ds, 'Fraud', 'Legitimate'));
    expect(rf).toBeGreaterThan(rl + 25);
    expect(share(ds, 'Country', 'United Kingdom')).toBeCloseTo(0.82, 1.3);
    const amt = getNumeric(ds, 'Amount');
    expect(amt.min).toBeGreaterThanOrEqual(0.5); expect(amt.max).toBeLessThanOrEqual(1000);
    const hr = getNumeric(ds, 'Hour');
    expect(hr.min).toBe(0); expect(hr.max).toBe(23);
  });

  it('generates 1M rows in reasonable time (soft)', () => {
    const t0 = performance.now();
    generatePayments(1_000_000);
    expect(performance.now() - t0).toBeLessThan(8000);
  });
});

// ---------------------------------------------------------------- invoices

import { generateInvoices } from '../src/data/invoices';

describe('generateInvoices', () => {
  const ds = generateInvoices(20_000, 41, faker);

  it('is deterministic per seed', () => expectDeterministic((s) => generateInvoices(2000, s), 41, 42));

  it('has the contract shape and consistent columns', () => {
    expect(ds.name).toBe('Supplier invoices (20,000)');
    expect(ds.labelColumn).toBe('Invoice');
    expect(ds.facets).toEqual(['Status', 'Spend category', 'Department', 'Quarter', 'Paid late', 'Supplier', 'Amount', 'Days to pay', 'Month']);
    expect(getCategory(ds, 'Supplier').categories.length).toBe(36);
    expect(getCategory(ds, 'Supplier').categories[0]).not.toMatch(/^Supplier \d+$/);
    expect(getCategory(generateInvoices(100), 'Supplier').categories[0]).toBe('Supplier 01');
    const paid = is(ds, 'Status', 'Paid');
    const daysCol = getNumeric(ds, 'Days to pay').values;
    const late = getCategory(ds, 'Paid late').codes;
    const month = getNumeric(ds, 'Month').values;
    const quarter = getCategory(ds, 'Quarter').codes;
    const amt = getNumeric(ds, 'Amount');
    expect(amt.min).toBeGreaterThanOrEqual(20); expect(amt.max).toBeLessThanOrEqual(50_000);
    for (let i = 0; i < ds.n; i++) {
      expect(Number.isNaN(daysCol[i])).toBe(!paid(i));
      if (paid(i)) { expect(daysCol[i]).toBeGreaterThanOrEqual(0); expect(daysCol[i]).toBeLessThanOrEqual(120); expect(late[i]).toBe(daysCol[i] > 30 ? 1 : 0); }
      else expect(late[i]).toBe(0);
      expect(quarter[i]).toBe(Math.floor((month[i] - 1) / 3));
    }
    expect(getNumeric(ds, 'Month').format!(3)).toBe('Mar');
    const paidShare = share(ds, 'Status', 'Paid');
    expect(paidShare).toBeGreaterThan(0.5); expect(paidShare).toBeLessThan(0.8);
  });
});

// ------------------------------------------------------------------ pixels

describe('pixel collections', () => {
  /**
   * `cards: false` short-circuits the whole card path in `buildCards` before a
   * template is ever consulted, and every quad stays a flat colour. Declaring a
   * card here would be dead weight at best and a 250,000-slot atlas at worst.
   * `loadPixels` needs a canvas and a fetch, so the assertion is on the source.
   */
  it('declares no card or detail template', () => {
    const src = fs.readFileSync(path.join(testsDir, '..', '..', 'src', 'data', 'pixels.ts'), 'utf8');
    expect(src).toMatch(/\bcards:\s*false/);
    expect(src).not.toMatch(/^\s{4}card:/m);
    expect(src).not.toMatch(/^\s{4}detail:/m);
  });
});
