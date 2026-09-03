import { Dataset, Column, numeric, category, text, derivedText } from './columnar';

/**
 * The Titanic passenger list — the collection everybody already knows, which
 * makes it the one where you can tell at a glance whether a layout is telling
 * the truth. Bucket by Class, colour by Survived, and the whole argument of the
 * dataset is on the screen in one move.
 *
 * These are the **real 1,309 passengers**, names and all, from the `titanic3`
 * compilation (`public/data/titanic.csv`; provenance in `CREDITS.md`) — a
 * historical record of a disaster, and the point of showing it. It is the one
 * collection in the app that is not synthetic: every other one invents its
 * people, because a taxpayer or a customer with a real drowned passenger's
 * name is a different and much worse idea.
 *
 * Everything here is parsed and derived — nothing is generated — so the file
 * is a reader, not a generator: `parseTitanic` does the work and `loadTitanic`
 * only fetches.
 */
export const TITANIC_SIZES = [1309] as const;

export const SURVIVED = ['Died', 'Survived'];
export const OUTCOMES = ['Survived', 'Body recovered', 'Lost at sea'];
export const CLASSES = ['1st', '2nd', '3rd'];
export const SEXES = ['female', 'male'];
export const PORTS = ['Southampton', 'Cherbourg', 'Queenstown', 'Unknown'];
export const TITLES = ['Mr', 'Mrs', 'Miss', 'Master', 'Officer & clergy'];
export const AGE_BANDS = ['Child', 'Teen', '20s', '30s', '40s', '50+', 'Unknown'];
export const PARTY = ['Alone', 'Pair', 'Small family', 'Large family'];
export const NO_BOAT = 'None recorded';
export const NO_DECK = 'Unrecorded';

export const TITANIC_FACETS = [
  'Survived', 'Outcome', 'Class', 'Sex', 'Age band', 'Embarked', 'Title', 'Party', 'Deck', 'Lifeboat',
  'Age', 'Fare', 'Siblings/spouses', 'Parents/children', 'Family size',
];

/** RFC 4180 enough for this file: quoted fields, doubled quotes, CRLF. */
export function parseCsv(source: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() ?? [];
  return { header, rows };
}

const PORT_OF: Record<string, string> = { S: PORTS[0], C: PORTS[1], Q: PORTS[2] };
/** The rare titles, mapped onto the five the facet shows. */
const TITLE_OF: Record<string, string> = {
  Mr: 'Mr', Mrs: 'Mrs', Miss: 'Miss', Master: 'Master',
  Mme: 'Mrs', Mlle: 'Miss', Ms: 'Miss', Lady: 'Mrs', Sir: 'Mr',
  Dona: 'Mrs', Don: 'Mr', Jonkheer: 'Mr', 'the Countess': 'Mrs',
  Dr: 'Officer & clergy', Rev: 'Officer & clergy', Col: 'Officer & clergy',
  Major: 'Officer & clergy', Capt: 'Officer & clergy',
};

function ageBand(a: number): string {
  if (!Number.isFinite(a)) return 'Unknown';
  if (a < 13) return AGE_BANDS[0];
  if (a < 20) return AGE_BANDS[1];
  if (a < 30) return AGE_BANDS[2];
  if (a < 40) return AGE_BANDS[3];
  if (a < 50) return AGE_BANDS[4];
  return AGE_BANDS[5];
}

/** Boats first, numbered ones in order, then the collapsibles, then the rest. */
function boatOrder(a: string, b: string): number {
  if (a === NO_BOAT) return 1;
  if (b === NO_BOAT) return -1;
  const na = Number.parseFloat(a), nb = Number.parseFloat(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb || a.localeCompare(b);
  if (Number.isFinite(na)) return -1;
  if (Number.isFinite(nb)) return 1;
  return a.localeCompare(b);
}

/**
 * Build the collection from the CSV text. Split out from `loadTitanic` so the
 * tests can read the committed file off disk and check the same code path the
 * browser runs.
 */
export function parseTitanic(source: string): Dataset {
  const { header, rows } = parseCsv(source);
  const col = (name: string) => {
    const k = header.indexOf(name);
    if (k < 0) throw new Error(`titanic.csv: no "${name}" column`);
    return k;
  };
  const I = {
    pclass: col('pclass'), survived: col('survived'), name: col('name'), sex: col('sex'),
    age: col('age'), sibsp: col('sibsp'), parch: col('parch'), ticket: col('ticket'),
    fare: col('fare'), cabin: col('cabin'), embarked: col('embarked'), boat: col('boat'),
    body: col('body'), dest: col('home.dest'),
  };
  const n = rows.length;
  if (n === 0) throw new Error('titanic.csv: no rows');

  const names = new Array<string>(n);
  const tickets = new Array<string>(n);
  const cabins = new Array<string>(n);
  const dests = new Array<string>(n);
  const survived = new Array<string>(n);
  const outcome = new Array<string>(n);
  const klass = new Array<string>(n);
  const sex = new Array<string>(n);
  const port = new Array<string>(n);
  const title = new Array<string>(n);
  const band = new Array<string>(n);
  const party = new Array<string>(n);
  const deck = new Array<string>(n);
  const boat = new Array<string>(n);
  const age = new Float32Array(n);
  const fare = new Float32Array(n);
  const sibsp = new Float32Array(n);
  const parch = new Float32Array(n);
  const family = new Float32Array(n);

  const numberOr = (s: string) => (s.trim() === '' ? NaN : Number(s));

  for (let i = 0; i < n; i++) {
    const r = rows[i];
    names[i] = r[I.name];
    tickets[i] = r[I.ticket];
    cabins[i] = r[I.cabin];
    dests[i] = r[I.dest];

    const lived = r[I.survived] === '1';
    survived[i] = lived ? 'Survived' : 'Died';
    // A body number exists only for the 121 who were found. The three states
    // together are the fact the collection is really about.
    outcome[i] = lived ? OUTCOMES[0] : r[I.body].trim() !== '' ? OUTCOMES[1] : OUTCOMES[2];

    klass[i] = CLASSES[Number(r[I.pclass]) - 1] ?? CLASSES[2];
    sex[i] = r[I.sex];
    port[i] = PORT_OF[r[I.embarked].trim()] ?? PORTS[3];

    // "Surname, Title. Given names" — the manifest's own format.
    const raw = (r[I.name].split(', ')[1] ?? '').split('. ')[0];
    title[i] = TITLE_OF[raw] ?? (sex[i] === 'female' ? 'Miss' : 'Mr');

    const a = numberOr(r[I.age]);
    age[i] = a;
    band[i] = ageBand(a);
    fare[i] = numberOr(r[I.fare]);

    const sib = numberOr(r[I.sibsp]) || 0;
    const par = numberOr(r[I.parch]) || 0;
    sibsp[i] = sib; parch[i] = par; family[i] = sib + par + 1;
    const aboard = sib + par;
    party[i] = aboard === 0 ? PARTY[0] : aboard === 1 ? PARTY[1] : aboard <= 3 ? PARTY[2] : PARTY[3];

    // A cabin like "C22 C26" or "F G73" names its deck in the first letter.
    const c = cabins[i].trim();
    deck[i] = c === '' ? NO_DECK : c[0];
    boat[i] = r[I.boat].trim() === '' ? NO_BOAT : r[I.boat].trim();
  }

  const columns: Record<string, Column> = {};
  columns.Name = text('Name', names);
  columns.Ticket = text('Ticket', tickets);
  columns.Cabin = derivedText('Cabin', (i) => cabins[i]);
  columns['Home / destination'] = derivedText('Home / destination', (i) => dests[i]);
  columns.Survived = category('Survived', survived);
  columns.Outcome = category('Outcome', outcome);
  columns.Class = category('Class', klass);
  columns.Sex = category('Sex', sex);
  columns['Age band'] = category('Age band', band);
  columns.Embarked = category('Embarked', port);
  columns.Title = category('Title', title);
  columns.Party = category('Party', party);
  columns.Deck = category('Deck', deck);
  columns.Lifeboat = category('Lifeboat', boat);
  columns.Age = numeric('Age', age, (v) => (v < 1 ? `${Math.round(v * 12)} mo` : v.toFixed(0)));
  columns.Fare = numeric('Fare', fare, (v) => `£${v.toFixed(2)}`);
  columns['Siblings/spouses'] = numeric('Siblings/spouses', sibsp, (v) => v.toFixed(0));
  columns['Parents/children'] = numeric('Parents/children', parch, (v) => v.toFixed(0));
  columns['Family size'] = numeric('Family size', family, (v) => v.toFixed(0));

  // Category orders that a reader can reason about, rather than first-seen.
  const order = (name: string, want: readonly string[]) => sortCategories(columns[name], (a, b) => want.indexOf(a) - want.indexOf(b));
  order('Survived', SURVIVED);
  order('Outcome', OUTCOMES);
  order('Class', CLASSES);
  order('Sex', SEXES);
  order('Age band', AGE_BANDS);
  order('Embarked', PORTS);
  order('Title', TITLES);
  order('Party', PARTY);
  sortCategories(columns.Deck, (a, b) => (a === NO_DECK ? 1 : b === NO_DECK ? -1 : a.localeCompare(b)));
  sortCategories(columns.Lifeboat, boatOrder);

  return {
    name: `Titanic passengers (${n.toLocaleString()})`,
    n,
    columns,
    labelColumn: 'Name',
    facets: TITANIC_FACETS.slice(),
    kind: 'titanic',
    // The one field a reader looks at before any other, so it does not take
    // its chances with the categorical palette.
    colors: { Survived: { Survived: '#199e70', Died: '#b4413a' },
      Outcome: { Survived: '#199e70', 'Body recovered': '#c98500', 'Lost at sea': '#b4413a' } },

    card: {
      topic: 'Class',
      title: 'Name',
      blurb: (i: number) => `${port[i]} · ${Number.isFinite(age[i]) ? (age[i] < 1 ? `${Math.round(age[i] * 12)} months` : `aged ${age[i].toFixed(0)}`) : 'age unknown'}`,
      tags: [
        { value: 'Survived', shape: 'dot', tone: { Survived: 'good', Died: 'bad' } },
        { value: 'Sex', shape: 'pill', tone: 'neutral' },
      ],
      metric: { value: 'Fare' },
    },

    detail: {
      subtitle: (i: number) => `${klass[i]} class · ${port[i]}`,
      sections: [
        { title: 'Passenger', fields: ['Title', 'Sex', 'Age', { label: 'Home / destination', value: 'Home / destination' }] },
        { title: 'Passage', fields: [{ label: 'Ticket', value: 'Ticket', as: 'mono' }, 'Fare', 'Class', 'Embarked', { label: 'Cabin', value: 'Cabin', as: 'mono' }, 'Deck'] },
        { title: 'Travelling with', fields: ['Party', 'Siblings/spouses', 'Parents/children', 'Family size'] },
        { title: 'That night', fields: [{ label: 'Outcome', value: 'Outcome', as: 'tag' }, 'Lifeboat'] },
      ],
      context: ['Class', 'Sex', 'Survived'],
    },
  };
}

/** Reorder a dictionary-encoded column's categories, remapping its codes. */
function sortCategories(column: Column | undefined, compare: (a: string, b: string) => number): void {
  if (!column || column.kind !== 'category') return;
  const want = column.categories.slice().sort(compare);
  const remap = new Int32Array(column.categories.length);
  column.categories.forEach((label, from) => { remap[from] = want.indexOf(label); });
  for (let i = 0; i < column.codes.length; i++) column.codes[i] = remap[column.codes[i]];
  column.categories = want;
}

export async function loadTitanic(): Promise<Dataset> {
  const res = await fetch('data/titanic.csv');
  if (!res.ok) throw new Error(`failed to fetch data/titanic.csv: ${res.status} ${res.statusText}`);
  const raw = await res.text();
  // A dev server with an SPA fallback answers 200 with index.html for a file
  // that is not there, so check it is really CSV before trusting it.
  if (raw.trimStart().startsWith('<')) throw new Error('data/titanic.csv: not a CSV file');
  return parseTitanic(raw);
}
