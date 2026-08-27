import { Dataset, Column, numeric, categoryFromCodes, derivedText } from './columnar';
import { mulberry32, gaussian, cumulative, pickCum } from './random';

/** D3 — Card payments. */
export const PAYMENT_SIZES = [900, 10_000, 100_000, 1_000_000] as const;

export const MERCHANT_CATEGORIES = [
  'Groceries', 'Restaurants', 'Fuel', 'Travel', 'Online retail', 'Utilities', 'Entertainment', 'Health',
];
export const METHODS = ['Contactless', 'Chip & PIN', 'Online', 'Mobile wallet', 'Bank transfer'];
export const COUNTRIES = [
  'United Kingdom', 'Ireland', 'France', 'Spain', 'United States', 'Germany', 'Italy', 'Netherlands',
  'Portugal', 'Greece', 'UAE', 'Other',
];
export const WHERE = ['Domestic', 'Abroad'];
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const OUTCOMES = ['Approved', 'Declined'];
export const FRAUD = ['Legitimate', 'Flagged'];

export const PAYMENT_FACETS = [
  'Merchant category', 'Method', 'Where', 'Fraud', 'Outcome', 'Country', 'Day', 'Amount', 'Risk score', 'Hour',
];

const ONLINE = 2;

const CATEGORY_CUM = cumulative([26, 16, 12, 6, 18, 7, 9, 6]);
// Method mix per merchant category (Contactless, Chip & PIN, Online, Mobile wallet, Bank transfer).
const METHOD_ROWS = [
  [55, 15, 5, 24, 1],  // Groceries
  [45, 25, 8, 21, 1],  // Restaurants
  [40, 40, 2, 17, 1],  // Fuel
  [10, 10, 60, 10, 10], // Travel
  [0, 0, 85, 12, 3],   // Online retail
  [0, 2, 40, 3, 55],   // Utilities
  [20, 5, 55, 18, 2],  // Entertainment
  [25, 30, 20, 15, 10], // Health
];
const METHOD_CUM = new Float32Array(MERCHANT_CATEGORIES.length * METHODS.length);
for (let c = 0; c < METHOD_ROWS.length; c++) METHOD_CUM.set(cumulative(METHOD_ROWS[c]), c * METHODS.length);
const COUNTRY_CUM = cumulative([82, 3, 3, 3, 2, 1.5, 1.2, 1, 0.8, 0.7, 0.6, 1.2]);
const DAY_CUM = cumulative([13, 13, 14, 14, 16, 17, 13]);
// Hour of day: bimodal (lunch and evening), quiet overnight.
const HOUR_W = [1, 0.6, 0.4, 0.3, 0.3, 0.5, 1.2, 2.5, 4, 5, 6, 7.5, 9, 8.5, 7, 6.5, 7, 8.5, 9.5, 9, 7.5, 5.5, 3.5, 2];
const HOUR_CUM = cumulative(HOUR_W);
// Amount: log-median per category, in £.
const AMOUNT_MEDIAN = [28, 32, 45, 180, 42, 85, 22, 35];
const AMOUNT_SIGMA = [0.6, 0.6, 0.4, 0.9, 0.9, 0.5, 0.8, 0.9];

function gbp(v: number): string {
  return `£${v.toFixed(2)}`;
}

export function generatePayments(n: number, seed = 31): Dataset {
  const rand = mulberry32(seed);
  const category = new Int32Array(n);
  const method = new Int32Array(n);
  const country = new Int32Array(n);
  const where = new Int32Array(n);
  const day = new Int32Array(n);
  const outcome = new Int32Array(n);
  const fraud = new Int32Array(n);
  const amount = new Float32Array(n);
  const hour = new Float32Array(n);
  const risk = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    // Draw order: category, method, country, day, hour, amount, fraud, risk, outcome.
    const c = pickCum(rand, CATEGORY_CUM);
    const m = pickCum(rand, METHOD_CUM, c * METHODS.length, METHODS.length);
    const co = pickCum(rand, COUNTRY_CUM);
    const abroad = co === 0 ? 0 : 1;
    const d = pickCum(rand, DAY_CUM);
    const h = pickCum(rand, HOUR_CUM);
    // Amount: lognormal per category, clipped to [£0.50, £1,000] so the 12
    // equal-width bins read (the raw tail runs to thousands).
    let a = AMOUNT_MEDIAN[c] * Math.exp(AMOUNT_SIGMA[c] * gaussian(rand));
    if (a < 0.5) a = 0.5;
    if (a > 1000) a = 1000;
    a = Math.round(a * 100) / 100;

    let pFraud = 0.006;
    if (m === ONLINE) pFraud *= 4;
    if (abroad) pFraud *= 3;
    if (h < 5) pFraud *= 2.5;
    if (a > 500) pFraud *= 2;
    const f = rand() < pFraud ? 1 : 0;

    // Risk score: logistic of the same drivers + noise, pushed up hard when flagged.
    let z = -2.2 + (m === ONLINE ? 0.9 : 0) + (abroad ? 1.1 : 0) + (h < 5 ? 0.8 : 0) + (a > 500 ? 0.7 : 0)
      + (f ? 2.8 : 0) + 0.7 * gaussian(rand);
    let r = Math.round(100 / (1 + Math.exp(-z)));
    if (r < 0) r = 0;
    if (r > 100) r = 100;

    let pDecline = 0.02 + (r > 60 ? 0.4 : r > 35 ? 0.08 : 0);
    if (f) pDecline = 0.55;
    const oc = rand() < pDecline ? 1 : 0;

    category[i] = c; method[i] = m; country[i] = co; where[i] = abroad; day[i] = d; outcome[i] = oc; fraud[i] = f;
    amount[i] = a; hour[i] = h; risk[i] = r;
  }

  const columns: Record<string, Column> = {};
  columns.Transaction = derivedText('Transaction', (i) => `TX-${String(i + 1).padStart(6, '0')}`);
  columns['Merchant category'] = categoryFromCodes('Merchant category', category, MERCHANT_CATEGORIES.slice());
  columns.Method = categoryFromCodes('Method', method, METHODS.slice());
  columns.Where = categoryFromCodes('Where', where, WHERE.slice());
  columns.Fraud = categoryFromCodes('Fraud', fraud, FRAUD.slice());
  columns.Outcome = categoryFromCodes('Outcome', outcome, OUTCOMES.slice());
  columns.Country = categoryFromCodes('Country', country, COUNTRIES.slice());
  columns.Day = categoryFromCodes('Day', day, DAYS.slice());
  columns.Amount = numeric('Amount', amount, gbp);
  columns['Risk score'] = numeric('Risk score', risk, (v) => v.toFixed(0));
  columns.Hour = numeric('Hour', hour, (v) => `${String(v).padStart(2, '0')}:00`);

  return {
    name: `Card payments (${n.toLocaleString()})`,
    n,
    columns,
    labelColumn: 'Transaction',
    facets: PAYMENT_FACETS.slice(),
  };
}
