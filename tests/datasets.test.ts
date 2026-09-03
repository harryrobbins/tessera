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
    // Open is not a coin toss any more: it is what has not finished by the
    // as-of day, so the rate is whatever the duration model leaves behind.
    const open = share(ds, 'Status', 'Open');
    expect(open).toBeGreaterThanOrEqual(0.03); expect(open).toBeLessThanOrEqual(0.10);
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
    // Survey response, not a flat 25% non-response: a third of resolved cases
    // are rated, and which third is not random (see the J-shape test below).
    const resolved = N - Math.round(share(ds, 'Status', 'Open') * N);
    expect(1 - unsurveyed / resolved).toBeGreaterThan(0.2);
    expect(1 - unsurveyed / resolved).toBeLessThan(0.42);
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
    // Names come from a seeded faker: same seed and size, same names. (Not
    // across sizes — a name belongs to a customer, and the customer pool is
    // sized from the row count.)
    const again = generateTaxCases(20_000, 11, faker);
    const five = (d: typeof ds) => [0, 1, 2, 3, 4].map((i) => valueAt(d, 'Customer', i));
    expect(five(again)).toEqual(five(ds));
  });

  it('formats Opened as a day and month', () => {
    expect(formatDayOfYear(1)).toBe('1 Jan');
    expect(formatDayOfYear(71)).toBe('12 Mar');
    expect(formatDayOfYear(365)).toBe('31 Dec');
    expect(getNumeric(ds, 'Opened').format!(71)).toBe('12 Mar');
  });


  // ------------------------------------------------------- structure & shape
  // The generator's fidelity is in its joint distribution, and the joint
  // distribution is exactly what a contract test on column names cannot see.
  // These are the claims the file's comments make, checked.

  it('customers are entities: cases repeat, and their attributes travel with them', () => {
    const name = ds.columns.Customer!, pc = ds.columns.Postcode!;
    if (name.kind !== 'text' || pc.kind !== 'text') throw new Error('Customer and Postcode are text columns');
    const prior = getNumeric(ds, 'Prior cases').values;
    const groups = new Map<string, number[]>();
    for (let i = 0; i < N; i++) {
      const key = `${name.at(i)}|${pc.at(i)}`;
      const g = groups.get(key);
      if (g) g.push(i); else groups.set(key, [i]);
    }
    // A heavy tail, not a fresh person per row.
    expect(groups.size).toBeLessThan(N * 0.8);
    const biggest = Math.max(...[...groups.values()].map((g) => g.length));
    expect(biggest).toBeGreaterThanOrEqual(4);

    const town = getCategory(ds, 'Town').codes;
    const age = getCategory(ds, 'Age band').codes;
    const type = getCategory(ds, 'Customer type').codes;
    const opened = getNumeric(ds, 'Opened').values;
    for (const rows of groups.values()) {
      if (rows.length === 1) continue;
      for (const i of rows) {
        expect(town[i]).toBe(town[rows[0]]);
        expect(age[i]).toBe(age[rows[0]]);
        expect(type[i]).toBe(type[rows[0]]);
      }
      // Prior cases ranks a customer's cases by the day they opened.
      const byDay = [...rows].sort((a, b) => opened[a] - opened[b]);
      expect(byDay.map((i) => prior[i])).toEqual(byDay.map((_, k) => k));
    }
  });

  it('the queue slows cases down: the January peak costs time and satisfaction', () => {
    const opened = getNumeric(ds, 'Opened').values;
    const inDays = (lo: number, hi: number) => (i: number) => opened[i] >= lo && opened[i] <= hi;
    const peak = inDays(15, 36);   // the filing deadline
    const quiet = inDays(152, 181); // June
    expect(meanWhere(ds, 'Resolution hours', peak)).toBeGreaterThan(1.15 * meanWhere(ds, 'Resolution hours', quiet));
    expect(meanWhere(ds, 'Satisfaction', peak)).toBeLessThan(meanWhere(ds, 'Satisfaction', quiet) - 0.15);
  });

  it('Open is censoring, not a coin toss: the backlog is recent and unfinished', () => {
    const open = is(ds, 'Status', 'Open');
    const waiting = getNumeric(ds, 'Days waiting').values;
    const opened = getNumeric(ds, 'Opened').values;
    const openDays: number[] = [];
    for (let i = 0; i < N; i++) {
      expect(Number.isFinite(waiting[i])).toBe(open(i));
      if (open(i)) { expect(waiting[i]).toBeCloseTo(365 - opened[i], 1); openDays.push(opened[i]); }
    }
    const median = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const all = Array.from(opened);
    // A snapshot's open cases are the recent arrivals plus the long tail, so
    // they sit later in the year than the collection as a whole.
    expect(median(openDays)).toBeGreaterThan(median(all) + 30);
  });

  it('channels follow the working week: no post at a weekend, no phone on a Sunday', () => {
    const opened = getNumeric(ds, 'Opened').values;
    const dow = (i: number) => (opened[i] - 1 + 2) % 7;
    const shareOn = (ch: string, days: number[]) => {
      const c = is(ds, 'Channel', ch);
      let hit = 0, total = 0;
      for (let i = 0; i < N; i++) if (c(i)) { total++; if (days.includes(dow(i))) hit++; }
      return hit / total;
    };
    expect(shareOn('Post', [5, 6])).toBeLessThan(0.02);
    expect(shareOn('Phone', [6])).toBeLessThan(0.04);
    expect(shareOn('Webchat', [5, 6])).toBeGreaterThan(0.15);
  });

  it('the digital shift is a trend across the year, not noise', () => {
    const opened = getNumeric(ds, 'Opened').values;
    const q1 = (i: number) => opened[i] <= 90;
    const q4 = (i: number) => opened[i] > 274;
    expect(share(ds, 'Channel', 'Post', q4)).toBeLessThan(share(ds, 'Channel', 'Post', q1));
    expect(share(ds, 'Channel', 'Webchat', q4)).toBeGreaterThan(share(ds, 'Channel', 'Webchat', q1));
  });

  it('who lives where drives how old they are, and both drive the channel', () => {
    expect(share(ds, 'Age band', '75+', is(ds, 'Area type', 'Rural')))
      .toBeGreaterThan(share(ds, 'Age band', '75+', is(ds, 'Area type', 'Urban')) * 1.5);
    expect(share(ds, 'Age band', '18–29', is(ds, 'Area type', 'Urban')))
      .toBeGreaterThan(share(ds, 'Age band', '18–29', is(ds, 'Area type', 'Rural')));
    expect(share(ds, 'Support needs', 'Additional support', is(ds, 'Age band', '75+')))
      .toBeGreaterThan(share(ds, 'Support needs', 'Additional support', is(ds, 'Age band', '18–29')) * 2);
    expect(share(ds, 'Language', 'Welsh', is(ds, 'Region', 'Wales & NI'))).toBeGreaterThan(0.1);
    expect(share(ds, 'Language', 'Welsh', is(ds, 'Region', 'London'))).toBeLessThan(0.02);
  });

  it('satisfaction is J-shaped, the way survey data is', () => {
    const sat = getNumeric(ds, 'Satisfaction').values;
    const hist = new Array(6).fill(0);
    let rated = 0;
    for (let i = 0; i < N; i++) if (Number.isFinite(sat[i])) { hist[sat[i]]++; rated++; }
    const p = hist.map((v) => v / rated);
    expect(p[5]).toBeGreaterThan(0.35);      // a big top box
    expect(p[1]).toBeGreaterThan(0.08);      // and a hard core of ones
    expect(p[1]).toBeGreaterThan(p[3]);      // more ones than threes: a J, not a bell
    expect(p[5]).toBeGreaterThan(p[4]);
  });

  it('the wait drives the chasing, and the two clocks are different clocks', () => {
    const h = getNumeric(ds, 'Resolution hours').values;
    const resolved: number[] = [];
    for (let i = 0; i < N; i++) if (Number.isFinite(h[i])) resolved.push(i);
    resolved.sort((a, b) => h[a] - h[b]);
    const q = resolved.length >> 2;
    const fast = new Set(resolved.slice(0, q));
    const slow = new Set(resolved.slice(-q));
    const mean = (rows: Set<number>, col: string) => meanWhere(ds, col, (i) => rows.has(i));
    expect(mean(slow, 'Contacts')).toBeGreaterThan(mean(fast, 'Contacts') + 0.5);
    // Handling minutes is the work, not the wait: a case can sit for a fortnight
    // and take twenty minutes of anyone's time.
    expect(mean(slow, 'Handling minutes')).toBeLessThan(60);
  });

  it('the SLA state follows from the hours and the channel', () => {
    const target: Record<string, number> = { Phone: 24, Webchat: 24, 'Web form': 120, Post: 216 };
    const h = getNumeric(ds, 'Resolution hours').values;
    const channel = getCategory(ds, 'Channel');
    const sla = getCategory(ds, 'Within SLA');
    const open = is(ds, 'Status', 'Open');
    for (let i = 0; i < N; i++) {
      const state = sla.categories[sla.codes[i]];
      if (open(i)) expect(state === 'Met').toBe(false);
      else expect(state).toBe(h[i] <= target[channel.categories[channel.codes[i]]] ? 'Met' : 'Missed');
    }
  });

  it('cases arrive across the working day, and a letter has no time at all', () => {
    const hour = getNumeric(ds, 'Hour opened').values;
    const post = is(ds, 'Channel', 'Post');
    const phone = is(ds, 'Channel', 'Phone');
    let morning = 0, lunch = 0;
    for (let i = 0; i < N; i++) {
      expect(Number.isFinite(hour[i])).toBe(!post(i));
      if (post(i)) continue;
      if (phone(i)) { expect(hour[i]).toBeGreaterThanOrEqual(8); expect(hour[i]).toBeLessThan(18); }
      if (hour[i] >= 9 && hour[i] < 11) morning++;
      if (hour[i] >= 12.5 && hour[i] < 14.5) lunch++;
    }
    expect(morning).toBeGreaterThan(lunch); // a morning peak and a lunch dip
  });

  it('advisers sit under one team each and are not interchangeable', () => {
    const adviser = getCategory(ds, 'Adviser');
    const team = getCategory(ds, 'Team');
    const sat = getNumeric(ds, 'Satisfaction').values;
    const teamOf = new Map<number, number>();
    const stat = new Map<number, { s: number; k: number }>();
    for (let i = 0; i < N; i++) {
      const a = adviser.codes[i];
      const seen = teamOf.get(a);
      if (seen === undefined) teamOf.set(a, team.codes[i]);
      else expect(seen).toBe(team.codes[i]);
      if (Number.isFinite(sat[i])) {
        const st = stat.get(a) ?? { s: 0, k: 0 };
        st.s += sat[i]; st.k++;
        stat.set(a, st);
      }
    }
    expect(teamOf.size).toBe(72);
    // A per-adviser effect the reporting could actually find.
    const means = [...stat.values()].filter((v) => v.k >= 30).map((v) => v.s / v.k);
    expect(Math.max(...means) - Math.min(...means)).toBeGreaterThan(0.4);
  });

  it('reason codes nest under one topic each and run as a long tail', () => {
    const reason = getCategory(ds, 'Reason');
    const topic = getCategory(ds, 'Topic');
    const topicOf = new Map<number, number>();
    const count = new Array(reason.categories.length).fill(0);
    for (let i = 0; i < N; i++) {
      const r = reason.codes[i];
      count[r]++;
      const seen = topicOf.get(r);
      if (seen === undefined) topicOf.set(r, topic.codes[i]);
      else expect(seen).toBe(topic.codes[i]);
    }
    expect(reason.categories.length).toBe(37);
    const sorted = count.slice().sort((a, b) => b - a);
    expect(sorted[0]).toBeGreaterThan(sorted[sorted.length - 1] * 8);
  });

  it('generates 100k rows quickly (soft)', () => {
    const t0 = performance.now();
    generateTaxCases(100_000);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

// ----------------------------------------------------------------- Titanic

import { parseTitanic, parseCsv, TITANIC_FACETS } from '../src/data/titanic';

describe('parseTitanic', () => {
  const csv = fs.readFileSync(path.join(testsDir, '..', '..', 'public', 'data', 'titanic.csv'), 'utf8');
  const ds = parseTitanic(csv);
  const N = ds.n;

  it('parses quoted fields, doubled quotes and CRLF', () => {
    const { header, rows } = parseCsv('a,b\r\n1,"x, y"\r\n2,"she said ""no"""\r\n');
    expect(header).toEqual(['a', 'b']);
    expect(rows).toEqual([['1', 'x, y'], ['2', 'she said "no"']]);
  });

  it('reads all 1,309 passengers off the committed manifest', () => {
    expect(N).toBe(1309);
    expect(ds.labelColumn).toBe('Name');
    expect(ds.facets).toEqual(TITANIC_FACETS);
    expect(valueAt(ds, 'Name', 0)).toBe('Allen, Miss. Elisabeth Walton');
    for (const c of ['Age', 'Fare', 'Siblings/spouses', 'Parents/children', 'Family size']) {
      expect(ds.columns[c]?.kind).toBe('number');
    }
    for (const c of ['Survived', 'Outcome', 'Class', 'Sex', 'Age band', 'Embarked', 'Title', 'Party', 'Deck', 'Lifeboat']) {
      expect(ds.columns[c]?.kind).toBe('category');
    }
    // Every facet names a column that exists.
    for (const f of ds.facets) expect(ds.columns[f]).toBeTruthy();
  });

  it('orders categories so a reader can reason about them', () => {
    const cat = (name: string) => getCategory(ds, name).categories;
    expect(cat('Survived')).toEqual(['Died', 'Survived']);
    expect(cat('Outcome')).toEqual(['Survived', 'Body recovered', 'Lost at sea']);
    expect(cat('Class')).toEqual(['1st', '2nd', '3rd']);
    expect(cat('Age band')).toEqual(['Child', 'Teen', '20s', '30s', '40s', '50+', 'Unknown']);
    expect(cat('Embarked')).toEqual(['Southampton', 'Cherbourg', 'Queenstown', 'Unknown']);
    // Boats in order, and the 823 who never reached one at the end.
    const boats = cat('Lifeboat');
    expect(boats[0]).toBe('1');
    expect(boats[boats.length - 1]).toBe('None recorded');
    expect(cat('Deck')[cat('Deck').length - 1]).toBe('Unrecorded');
  });

  it('is the history, not a model of it', () => {
    // 500 of 1309 survived; the rates by sex and class are the famous ones.
    expect(share(ds, 'Survived', 'Survived')).toBeCloseTo(0.382, 2);
    const cell = (sex: string, klass: string) => {
      const s = is(ds, 'Sex', sex), c = is(ds, 'Class', klass);
      return share(ds, 'Survived', 'Survived', (i) => s(i) && c(i));
    };
    expect(cell('female', '1st')).toBeCloseTo(0.965, 2);
    expect(cell('female', '3rd')).toBeCloseTo(0.491, 2);
    expect(cell('male', '1st')).toBeCloseTo(0.341, 2);
    expect(cell('male', '2nd')).toBeCloseTo(0.146, 2);
    // Missingness is the record's, not ours: 263 ages and 1,014 cabins blank.
    const age = getNumeric(ds, 'Age').values;
    let noAge = 0;
    for (let i = 0; i < N; i++) if (!Number.isFinite(age[i])) noAge++;
    expect(noAge).toBe(263);
    expect(share(ds, 'Deck', 'Unrecorded')).toBeCloseTo(1014 / 1309, 3);
    // A body number exists only for those who were found.
    expect(share(ds, 'Outcome', 'Body recovered')).toBeCloseTo(121 / 1309, 3);
    const survivedCode = getCategory(ds, 'Survived').categories.indexOf('Survived');
    const outcome = getCategory(ds, 'Outcome');
    const survivedRows = getCategory(ds, 'Survived').codes;
    for (let i = 0; i < N; i++) {
      const lived = survivedRows[i] === survivedCode;
      expect(outcome.categories[outcome.codes[i]] === 'Survived').toBe(lived);
    }
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

// ------------------------------------------------------------------- birds

import { parseBirds, BIRD_FACETS, BIRD_SIZES } from '../src/data/birds';
import { birdsFixture } from './helpers/birds';

/**
 * The birds collection is prebaked by `pipeline/birds.py` and fetched at
 * runtime, so this is a test of the *contract* between the two — the exact
 * column names and kinds, frozen so the pipeline and the engine can be written
 * apart. `tests/helpers/birds.ts` is a synthetic file in that shape; the real
 * asset is a build artefact and nothing here reads `public/data`.
 */
describe('parseBirds — the frozen column contract', () => {
  const { dataset: ds } = parseBirds(birdsFixture(24));

  it('has exactly the columns the pipeline promises, and the kinds it promises', () => {
    const kinds = Object.fromEntries(Object.entries(ds.columns).map(([k, c]) => [k, c.kind]));
    expect(kinds).toEqual({
      'Common name': 'text',
      'Scientific name': 'text',
      Order: 'category',
      Family: 'category',
      Habitat: 'category',
      Diet: 'category',
      'Trophic level': 'category',
      Lifestyle: 'category',
      Migration: 'category',
      'Habitat density': 'category',
      'Mass band': 'category',
      Mass: 'number',
      'Wing length': 'number',
      'Beak length': 'number',
      'Tail length': 'number',
      'Hand-wing index': 'number',
      'Range size': 'number',
      Longitude: 'number',
      Latitude: 'number',
      // Per-image credit, read on demand out of the JSON's credit manifest
      // rather than materialised as three more string columns.
      Photograph: 'text',
      Photographer: 'text',
      'Photo licence': 'text',
    });
  });

  it('offers every trait as a facet, and nothing that is not a column', () => {
    expect(ds.facets).toEqual(BIRD_FACETS);
    for (const f of ds.facets) expect(ds.columns[f], f).toBeTruthy();
    // Free text and the credits are columns, never facets: a facet over 900
    // distinct photographers is a filter list nobody can use.
    for (const f of ['Common name', 'Scientific name', 'Photographer']) {
      expect(ds.facets).not.toContain(f);
    }
  });

  it('units read on the card and in the detail pane', () => {
    expect(getNumeric(ds, 'Mass').format!(35.5)).toBe('36 g');
    expect(getNumeric(ds, 'Mass').format!(4900)).toBe('4.9 kg');
    expect(getNumeric(ds, 'Wing length').format!(255)).toBe('255 mm');
    expect(getNumeric(ds, 'Range size').format!(1_240_000)).toBe('1.2M km²');
    expect(getNumeric(ds, 'Latitude').format!(-12.34)).toBe('-12.3°');
  });

  it('keeps the same shape at every size the pipeline bakes', () => {
    const shapes = BIRD_SIZES.map((n) => {
      const d = parseBirds(birdsFixture(n)).dataset;
      return { n: d.n, cols: Object.keys(d.columns), facets: d.facets, card: d.card?.custom, geo: d.geo };
    });
    for (const s of shapes) {
      expect(s.cols).toEqual(Object.keys(ds.columns));
      expect(s.facets).toEqual(BIRD_FACETS);
      expect(s.card).toBe('photo');
      expect(s.geo).toEqual({ lon: 'Longitude', lat: 'Latitude' });
    }
    expect(shapes.map((s) => s.n)).toEqual([...BIRD_SIZES]);
  });
});
