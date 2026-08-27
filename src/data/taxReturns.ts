import { Dataset, Column, numeric, categoryFromCodes, derivedText } from './columnar';
import { mulberry32, gaussian, cumulative, pickCum } from './random';

/** D2 — Self-assessment tax returns. */
export const TAX_RETURN_SIZES = [900, 10_000, 100_000, 1_000_000] as const;

export const SECTORS = [
  'Retail', 'Construction', 'Professional services', 'Health & care', 'Hospitality', 'IT & digital', 'Property', 'Transport',
];
export const INCOME_BANDS = [
  'Under £12.5k', '£12.5k–25k', '£25k–50k', '£50k–100k', '£100k–150k', '£150k–500k', 'Over £500k',
];
const BAND_EDGES = [12_500, 25_000, 50_000, 100_000, 150_000, 500_000];
export const FILING_MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
export const FILED = ['On time', 'Late'];
export const FILING_METHODS = ['Online', 'Paper'];
export const AGENT_FILED = ['No', 'Yes'];
export const OUTCOMES = ['Refund', 'Owed', 'Nil'];

export const TAX_RETURN_FACETS = [
  'Filed', 'Sector', 'Income band', 'Filing month', 'Outcome', 'Agent filed', 'Filing method',
  'Income', 'Tax due', 'Balance', 'Penalty', 'Tax year',
];

const SECTOR_CUM = cumulative([18, 14, 15, 10, 11, 12, 11, 9]);
// Log-median income per sector (£28k–£65k).
const SECTOR_MEDIAN = [28_000, 34_000, 65_000, 32_000, 28_000, 58_000, 40_000, 30_000];
// Filing month, Apr..Mar; mass in Dec–Jan. Late months (Feb, Mar) are the last two.
const ON_TIME_MONTH_CUM = cumulative([3, 3, 4, 5, 5, 7, 9, 10, 18, 36]);
const LATE_MONTH_CUM = cumulative([55, 45]); // Feb, Mar

const CONSTRUCTION = 1, HOSPITALITY = 4;

function gbp(v: number): string {
  const sign = v < 0 ? '−' : '';
  return `${sign}£${Math.round(Math.abs(v)).toLocaleString()}`;
}

/** UK-style bands: 0% to £12,570, 20% to £50,270, 40% to £125,140, 45% above. */
function taxOn(income: number): number {
  let t = 0;
  if (income > 12_570) t += 0.2 * (Math.min(income, 50_270) - 12_570);
  if (income > 50_270) t += 0.4 * (Math.min(income, 125_140) - 50_270);
  if (income > 125_140) t += 0.45 * (income - 125_140);
  return t;
}

export function generateTaxReturns(n: number, seed = 23): Dataset {
  const rand = mulberry32(seed);
  const sector = new Int32Array(n);
  const band = new Int32Array(n);
  const month = new Int32Array(n);
  const filed = new Int32Array(n);
  const method = new Int32Array(n);
  const agent = new Int32Array(n);
  const outcome = new Int32Array(n);
  const year = new Float32Array(n);
  const income = new Float32Array(n);
  const taxDue = new Float32Array(n);
  const balance = new Float32Array(n);
  const penalty = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    // Draw order: sector, income, agent, method, year, late, month, balance, penalty.
    const s = pickCum(rand, SECTOR_CUM);
    // Income: lognormal around the sector median, clipped to [0, £250k] so the
    // 12 equal-width bins are not all squeezed into the first two.
    let inc = SECTOR_MEDIAN[s] * Math.exp(0.75 * gaussian(rand));
    if (inc > 250_000) inc = 250_000;
    inc = Math.round(inc / 10) * 10;
    let b = 0;
    while (b < BAND_EDGES.length && inc >= BAND_EDGES[b]) b++;

    const ag = rand() < (inc > 50_000 ? 0.6 : 0.35) ? 1 : 0;
    const me = rand() < 0.04 ? 1 : 0;
    const yr = 2020 + ((rand() * 5) | 0);

    let pLate = 0.09;
    if (s === CONSTRUCTION || s === HOSPITALITY) pLate *= 1.8;
    if (b === 0) pLate *= 1.6;
    if (ag) pLate *= 0.5;
    const late = rand() < pLate ? 1 : 0;
    const m = late ? 10 + pickCum(rand, LATE_MONTH_CUM) : pickCum(rand, ON_TIME_MONTH_CUM);

    // Tax due: progressive schedule ± reliefs/adjustments, clipped to [0, £100k].
    let tax = taxOn(inc) * (1 + 0.12 * gaussian(rand));
    if (tax < 0) tax = 0;
    if (tax > 100_000) tax = 100_000;
    tax = Math.round(tax);

    // Balance after payments on account: negative = refund. Clipped [−£5k, £20k].
    let bal = tax * (0.35 * gaussian(rand)) + (rand() - 0.55) * 1500;
    if (bal < -5000) bal = -5000;
    if (bal > 20_000) bal = 20_000;
    bal = Math.round(bal);
    const oc = bal < -50 ? 0 : bal > 50 ? 1 : 2;

    // Penalty: £0 when on time; late = £100 fixed, plus daily penalties for the
    // later filers, plus 5% tax-geared for the latest. Clipped [0, £3k].
    let pen = 0;
    if (late) {
      pen = 100;
      const r = rand();
      if (r < 0.5) pen += Math.round(r * 2 * 900); // £10/day up to 90 days
      else if (r < 0.75) pen += 900 + 0.05 * tax;   // 6 months: tax-geared
      if (pen > 3000) pen = 3000;
      pen = Math.round(pen);
    }

    sector[i] = s; band[i] = b; month[i] = m; filed[i] = late; method[i] = me; agent[i] = ag; outcome[i] = oc;
    year[i] = yr; income[i] = inc; taxDue[i] = tax; balance[i] = bal; penalty[i] = pen;
  }

  const columns: Record<string, Column> = {};
  columns.Return = derivedText('Return', (i) => `SA-24-${String(i + 1).padStart(6, '0')}`);
  columns.Filed = categoryFromCodes('Filed', filed, FILED.slice());
  columns.Sector = categoryFromCodes('Sector', sector, SECTORS.slice());
  columns['Income band'] = categoryFromCodes('Income band', band, INCOME_BANDS.slice());
  columns['Filing month'] = categoryFromCodes('Filing month', month, FILING_MONTHS.slice());
  columns.Outcome = categoryFromCodes('Outcome', outcome, OUTCOMES.slice());
  columns['Agent filed'] = categoryFromCodes('Agent filed', agent, AGENT_FILED.slice());
  columns['Filing method'] = categoryFromCodes('Filing method', method, FILING_METHODS.slice());
  columns.Income = numeric('Income', income, gbp);
  columns['Tax due'] = numeric('Tax due', taxDue, gbp);
  columns.Balance = numeric('Balance', balance, gbp);
  columns.Penalty = numeric('Penalty', penalty, gbp);
  columns['Tax year'] = numeric('Tax year', year, (v) => `${v.toFixed(0)}/${String(v + 1).slice(2)}`);

  return {
    name: `Tax returns (${n.toLocaleString()})`,
    n,
    columns,
    labelColumn: 'Return',
    facets: TAX_RETURN_FACETS.slice(),
  };
}
