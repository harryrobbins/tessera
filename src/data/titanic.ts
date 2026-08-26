import { Dataset, numeric, category, text } from './columnar';
import { parseCsv, inferDataset } from './csv';

// Drop the real 891-row Kaggle Titanic CSV at public/data/titanic.csv and
// loadTitanic() will pick it up automatically; otherwise it falls back to
// generateTitanic()'s synthetic-but-plausible stand-in.

/** Deterministic PRNG — same seed always produces the same dataset. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  let u = rand();
  if (u < 1e-9) u = 1e-9;
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Cumulative discrete distribution: [value, cumulative probability]. */
function weightedCount(rand: () => number, table: ReadonlyArray<readonly [number, number]>): number {
  const r = rand();
  for (let i = 0; i < table.length; i++) {
    if (r <= table[i][1]) return table[i][0];
  }
  return table[table.length - 1][0];
}

const SIBSP_WEIGHTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.68], [1, 0.91], [2, 0.945], [3, 0.965], [4, 0.985], [5, 0.995], [8, 1],
];
const PARCH_WEIGHTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.76], [1, 0.895], [2, 0.985], [3, 0.991], [4, 0.996], [5, 1],
];

const SURVIVAL_TABLE: Record<string, Record<string, number>> = {
  female: { '1st': 0.97, '2nd': 0.92, '3rd': 0.5 },
  male: { '1st': 0.37, '2nd': 0.16, '3rd': 0.13 },
};

const SURNAMES = [
  'Braund', 'Cumings', 'Heikkinen', 'Futrelle', 'Allen', 'Moran', 'McCarthy', 'Palsson',
  'Johnson', 'Nasser', 'Sandstrom', 'Bonnell', 'Saundercock', 'Andersson', 'Vestrom',
  'Hewlett', 'Rice', 'Williams', 'Vander Planke', 'Masselmani', 'Fynney', 'Beesley',
  'McGowan', 'Sloper', 'Asplund', 'Emir', 'Fortune', "O'Dwyer", 'Todoroff', 'Uruchurtu',
];
const MALE_NAMES = [
  'James', 'William', 'Owen', 'Thomas', 'Henry', 'Charles', 'George', 'Edward', 'Arthur',
  'Frederick', 'John', 'Joseph', 'Albert', 'Walter', 'Herbert', 'Ernest', 'Percy', 'Harold',
  'Leonard', 'Sidney',
];
const FEMALE_NAMES = [
  'Florence', 'Elizabeth', 'Margaret', 'Mary', 'Alice', 'Edith', 'Emily', 'Annie', 'Rose',
  'Helen', 'Bertha', 'Nellie', 'Agnes', 'Winifred', 'Gertrude', 'Ada', 'Beatrice', 'Dorothy',
  'Eleanor', 'Violet',
];

export async function loadTitanic(): Promise<Dataset> {
  try {
    const res = await fetch('data/titanic.csv');
    if (!res.ok) throw new Error(`titanic.csv: ${res.status}`);
    const raw = await res.text();
    // A dev server with SPA fallback answers 200 with index.html for a missing
    // file, so verify it actually looks like CSV before trusting it.
    if (raw.trimStart().startsWith('<')) throw new Error('titanic.csv: not CSV');
    const { header, rows } = parseCsv(raw);
    if (rows.length === 0 || header.length < 3) throw new Error('titanic.csv: empty');
    return inferDataset('Titanic', header, rows, { labelColumn: 'Name' });
  } catch {
    return generateTitanic();
  }
}

export function generateTitanic(seed = 1): Dataset {
  const rand = mulberry32(seed);
  const n = 891;

  const names = new Array<string>(n);
  const sexValues = new Array<string>(n);
  const pclassValues = new Array<string>(n);
  const embarkedValues = new Array<string>(n);
  const survivedValues = new Array<string>(n);
  const age = new Float32Array(n);
  const sibsp = new Float32Array(n);
  const parch = new Float32Array(n);
  const fare = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const isFemale = rand() < 0.35;
    const sex = isFemale ? 'female' : 'male';
    sexValues[i] = sex;

    const pr = rand();
    const pclass = pr < 0.24 ? '1st' : pr < 0.45 ? '2nd' : '3rd';
    pclassValues[i] = pclass;

    const er = rand();
    embarkedValues[i] = er < 0.72 ? 'Southampton' : er < 0.91 ? 'Cherbourg' : 'Queenstown';

    // Erlang(k=3) via sum of exponential draws — bell-ish with a right tail,
    // roughly matching the real age distribution's mode in the 20s.
    let a = -10 * (Math.log(Math.max(rand(), 1e-9)) + Math.log(Math.max(rand(), 1e-9)) + Math.log(Math.max(rand(), 1e-9)));
    if (a < 0.4) a = 0.4;
    if (a > 74) a = 74;
    const missingAge = rand() < 0.2;
    age[i] = missingAge ? NaN : Math.round(a * 10) / 10;

    sibsp[i] = weightedCount(rand, SIBSP_WEIGHTS);
    parch[i] = weightedCount(rand, PARCH_WEIGHTS);

    const mu = pclass === '1st' ? 4.35 : pclass === '2nd' ? 2.9 : 2.5;
    const sigma = pclass === '1st' ? 0.9 : 0.6;
    let f = Math.exp(mu + sigma * gaussian(rand));
    if (f < 4) f = 4;
    if (f > 512) f = 512;
    fare[i] = Math.round(f * 10) / 10;

    const survProb = SURVIVAL_TABLE[sex][pclass];
    survivedValues[i] = rand() < survProb ? 'Survived' : 'Died';

    const surname = SURNAMES[(rand() * SURNAMES.length) | 0];
    const givenPool = isFemale ? FEMALE_NAMES : MALE_NAMES;
    const given1 = givenPool[(rand() * givenPool.length) | 0];
    let title: string;
    if (!isFemale && a < 13) title = 'Master.';
    else if (!isFemale) title = rand() < 0.97 ? 'Mr.' : rand() < 0.5 ? 'Dr.' : 'Rev.';
    else if (a < 18) title = 'Miss.';
    else title = rand() < 0.55 ? 'Mrs.' : 'Miss.';
    const given2 = rand() < 0.5 ? ` ${givenPool[(rand() * givenPool.length) | 0]}` : '';
    names[i] = `${surname}, ${title} ${given1}${given2}`;
  }

  return {
    name: 'Titanic (synthetic)',
    n,
    columns: {
      Name: text('Name', names),
      Sex: category('Sex', sexValues),
      Pclass: category('Pclass', pclassValues),
      Age: numeric('Age', age),
      SibSp: numeric('SibSp', sibsp),
      Parch: numeric('Parch', parch),
      Fare: numeric('Fare', fare, (v) => `£${v.toFixed(1)}`),
      Embarked: category('Embarked', embarkedValues),
      Survived: category('Survived', survivedValues),
    },
    labelColumn: 'Name',
    facets: ['Survived', 'Sex', 'Pclass', 'Embarked', 'Age', 'Fare', 'SibSp', 'Parch'],
  };
}
