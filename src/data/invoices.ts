import { Dataset, Column, numeric, categoryFromCodes, derivedText } from './columnar';
import { mulberry32, gaussian, cumulative, pickCum, hashU32 } from './random';

/** D4 — Supplier invoices. */
export const INVOICE_SIZES = [900, 10_000, 100_000] as const;

export const DEPARTMENTS = [
  'Finance', 'Operations', 'Engineering', 'Marketing', 'People', 'Legal', 'Facilities', 'Customer Service',
];
export const SPEND_CATEGORIES = ['Software', 'Consultancy', 'Travel', 'Hardware', 'Utilities', 'Office', 'Training', 'Maintenance'];
export const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];
export const INVOICE_STATUSES = ['Paid', 'Outstanding', 'Overdue', 'Disputed'];
export const PAID_LATE = ['No', 'Yes'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Company-name source (the shape of faker's `company`); see taxCases.ts. */
export interface CompanySource {
  seed(seed: number): unknown;
  company: { name(): string };
}
const SUPPLIER_COUNT = 36;
// Each supplier is pinned to one spend category by an integer hash of its index.
const SUPPLIER_CATEGORY = Array.from({ length: SUPPLIER_COUNT }, (_, k) => (hashU32(k, 4) * SPEND_CATEGORIES.length) | 0);
// Cumulative supplier tables per spend category (supplier weights hashed, fixed).
const SUPPLIER_CUM = new Float32Array(SPEND_CATEGORIES.length * SUPPLIER_COUNT);
for (let c = 0; c < SPEND_CATEGORIES.length; c++) {
  const w = Array.from({ length: SUPPLIER_COUNT }, (_, k) => (SUPPLIER_CATEGORY[k] === c ? 0.5 + hashU32(k, 6) : 0));
  if (!w.some((x) => x > 0)) w[c % SUPPLIER_COUNT] = 1; // every category needs at least one supplier
  SUPPLIER_CUM.set(cumulative(w), c * SUPPLIER_COUNT);
}
/** 36 synthetic supplier names from a seeded faker; plain placeholders without one. */
export function supplierNames(companies?: CompanySource, seed = 41): string[] {
  const out: string[] = [];
  if (!companies) {
    for (let k = 0; k < SUPPLIER_COUNT; k++) out.push(`Supplier ${String(k + 1).padStart(2, '0')}`);
    return out;
  }
  companies.seed(seed);
  while (out.length < SUPPLIER_COUNT) {
    const name = companies.company.name();
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export const INVOICE_FACETS = [
  'Status', 'Spend category', 'Department', 'Quarter', 'Paid late', 'Supplier', 'Amount', 'Days to pay', 'Month',
];

const DEPT_CUM = cumulative([12, 18, 20, 12, 8, 5, 12, 13]);
// Spend category mix per department.
const CAT_ROWS = [
  [30, 25, 10, 10, 2, 15, 6, 2],   // Finance
  [10, 10, 15, 15, 15, 10, 5, 20], // Operations
  [45, 10, 8, 25, 1, 3, 6, 2],     // Engineering
  [25, 35, 20, 5, 1, 8, 5, 1],     // Marketing
  [20, 20, 10, 5, 1, 9, 34, 1],    // People
  [15, 60, 8, 3, 1, 8, 5, 0],      // Legal
  [5, 5, 3, 10, 40, 12, 2, 23],    // Facilities
  [35, 10, 5, 15, 2, 15, 15, 3],   // Customer Service
];
const CAT_CUM = new Float32Array(DEPARTMENTS.length * SPEND_CATEGORIES.length);
for (let d = 0; d < CAT_ROWS.length; d++) CAT_CUM.set(cumulative(CAT_ROWS[d]), d * SPEND_CATEGORIES.length);
const AMOUNT_MEDIAN = [1800, 6500, 420, 2400, 900, 260, 1100, 1500];
const STATUS_CUM = cumulative([70, 15, 9, 6]);
const PAID = 0;

function gbp(v: number): string {
  return `£${Math.round(v).toLocaleString()}`;
}

export function generateInvoices(n: number, seed = 41, companies?: CompanySource): Dataset {
  const SUPPLIERS = supplierNames(companies, seed);
  const rand = mulberry32(seed);
  const dept = new Int32Array(n);
  const cat = new Int32Array(n);
  const supplier = new Int32Array(n);
  const quarter = new Int32Array(n);
  const status = new Int32Array(n);
  const late = new Int32Array(n);
  const amount = new Float32Array(n);
  const days = new Float32Array(n);
  const month = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    // Draw order: department, category, supplier, month, amount, status, days.
    const d = pickCum(rand, DEPT_CUM);
    const c = pickCum(rand, CAT_CUM, d * SPEND_CATEGORIES.length, SPEND_CATEGORIES.length);
    const s = pickCum(rand, SUPPLIER_CUM, c * SUPPLIER_COUNT, SUPPLIER_COUNT);
    const m = (rand() * 12) | 0;
    // Amount: lognormal per category, clipped to [£20, £50k] for readable bins.
    let a = AMOUNT_MEDIAN[c] * Math.exp(0.9 * gaussian(rand));
    if (a < 20) a = 20;
    if (a > 50_000) a = 50_000;
    a = Math.round(a * 100) / 100;
    let st = pickCum(rand, STATUS_CUM);
    if (m >= 10 && st === PAID && rand() < 0.4) st = 1; // recent invoices more often still outstanding
    // Days to pay: NaN unless paid; 30-day terms, long tail, clipped 0–120.
    let dy = NaN;
    let l = 0;
    if (st === PAID) {
      dy = Math.round(28 + 12 * gaussian(rand) + (a > 10_000 ? 10 : 0));
      if (dy < 0) dy = 0;
      if (dy > 120) dy = 120;
      l = dy > 30 ? 1 : 0;
    }

    dept[i] = d; cat[i] = c; supplier[i] = s; quarter[i] = (m / 3) | 0; status[i] = st; late[i] = l;
    amount[i] = a; days[i] = dy; month[i] = m + 1;
  }

  const columns: Record<string, Column> = {};
  columns.Invoice = derivedText('Invoice', (i) => `INV-2025-${String(i + 1).padStart(6, '0')}`);
  columns.Status = categoryFromCodes('Status', status, INVOICE_STATUSES.slice());
  columns['Spend category'] = categoryFromCodes('Spend category', cat, SPEND_CATEGORIES.slice());
  columns.Department = categoryFromCodes('Department', dept, DEPARTMENTS.slice());
  columns.Quarter = categoryFromCodes('Quarter', quarter, QUARTERS.slice());
  columns['Paid late'] = categoryFromCodes('Paid late', late, PAID_LATE.slice());
  columns.Supplier = categoryFromCodes('Supplier', supplier, SUPPLIERS);
  columns.Amount = numeric('Amount', amount, gbp);
  columns['Days to pay'] = numeric('Days to pay', days, (v) => `${v.toFixed(0)} days`);
  columns.Month = numeric('Month', month, (v) => MONTH_NAMES[Math.max(0, Math.min(11, Math.round(v) - 1))]);

  return {
    name: `Supplier invoices (${n.toLocaleString()})`,
    n,
    columns,
    labelColumn: 'Invoice',
    facets: INVOICE_FACETS.slice(),

    card: {
      topic: 'Spend category',
      mark: 'initials',
      // The supplier is who you would name aloud; the reference belongs on the
      // blurb line with the department that raised it.
      title: 'Supplier',
      blurb: (i: number) => `INV-2025-${String(i + 1).padStart(6, '0')} · ${DEPARTMENTS[dept[i]]}`,
      tags: [
        { value: 'Status', shape: 'pill', tone: { Paid: 'good', Outstanding: 'neutral', Overdue: 'bad', Disputed: 'warn' } },
        // A chip reading "Yes" says nothing; an empty value drops the tag, so
        // the second chip is present only when there is something to report.
        { value: (i: number) => (late[i] ? 'Paid late' : ''), shape: 'dot', tone: 'warn' },
      ],
      metric: { value: 'Amount' },
    },

    detail: {
      sections: [
        { title: 'Invoice', fields: [{ label: 'Reference', value: 'Invoice', as: 'mono' }, 'Supplier', 'Spend category', 'Department'] },
        { title: 'Payment', fields: ['Amount', 'Days to pay', 'Quarter', 'Month', { value: 'Status', as: 'tag' }, { value: 'Paid late', as: 'tag' }] },
      ],
      context: ['Spend category', 'Department', 'Status'],
    },
  };
}
