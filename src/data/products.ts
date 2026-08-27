import { Dataset, Column, numeric, categoryFromCodes, derivedText, shortNumber } from './columnar';
import { mulberry32, gaussian } from './random';

export const PRODUCT_SIZES = [1000, 10_000, 100_000, 500_000, 1_000_000] as const;

/** Deterministic pseudo-random hash in [0,1) — used to shape fixed per-type/per-country structure. */
function hash01(x: number): number {
  const s = Math.sin(x) * 43758.5453;
  return s - Math.floor(s);
}

const TYPES = [
  'Semiconductors', 'Pharmaceuticals', 'Cheese', 'Automobiles', 'Textiles', 'Furniture',
  'Steel', 'Petrochemicals', 'Coffee', 'Wine', 'Consumer Electronics', 'Toys',
  'Aircraft Parts', 'Fertilizer', 'Seafood', 'Cosmetics', 'Industrial Machinery',
  'Ceramics', 'Glassware', 'Plastics', 'Jewelry', 'Paper Products', 'Batteries', 'Solar Panels',
];

const COUNTRIES = [
  'United States', 'China', 'Germany', 'Japan', 'United Kingdom', 'France', 'India', 'Italy',
  'Brazil', 'Canada', 'South Korea', 'Russia', 'Australia', 'Spain', 'Mexico', 'Indonesia',
  'Netherlands', 'Saudi Arabia', 'Switzerland', 'Turkey', 'Poland', 'Sweden', 'Belgium',
  'Thailand', 'Ireland', 'Austria', 'Norway', 'Israel', 'Denmark', 'Vietnam',
];

const REGIONS = [
  'North America', 'Europe', 'East Asia', 'South & SE Asia / Oceania', 'Latin America', 'Middle East',
];

// Index-aligned with COUNTRIES.
const REGION_OF_COUNTRY = [
  0, 2, 1, 2, 1, 1, 3, 1, 4, 0, 2, 1, 3, 1, 4, 3, 1, 5, 1, 5, 1, 1, 1, 3, 1, 1, 1, 5, 1, 3,
];

/**
 * Large-scale synthetic trade-style dataset. Category columns are built as
 * Int32Array codes directly (categoryFromCodes) — no per-row string
 * allocation. Correlation structure (which countries dominate which product
 * types, per-type value/margin scale) is fixed by deterministic hashes of
 * the type/country index, independent of `seed`; only the per-row noise
 * depends on the seed.
 */
export function generateProducts(n: number, seed = 7): Dataset {
  const typeCount = TYPES.length;
  const countryCount = COUNTRIES.length;

  // Non-uniform type popularity, normalized to a cumulative distribution.
  const typeCum = new Float32Array(typeCount);
  {
    const w = new Float32Array(typeCount);
    let sum = 0;
    for (let t = 0; t < typeCount; t++) {
      w[t] = 1 + 2 * Math.abs(Math.sin(t * 12.9898 + 4));
      sum += w[t];
    }
    let acc = 0;
    for (let t = 0; t < typeCount; t++) {
      acc += w[t] / sum;
      typeCum[t] = acc;
    }
    typeCum[typeCount - 1] = 1;
  }

  // Base economic weight per country (bigger economies show up more often).
  const countryBaseWeight = new Float32Array(countryCount);
  for (let c = 0; c < countryCount; c++) {
    countryBaseWeight[c] = 1 + 4 * Math.abs(Math.sin(c * 7.31 + 1));
  }

  // Per-type country affinity: two "home" countries dominate each type.
  const countryCumByType = new Float32Array(typeCount * countryCount);
  for (let t = 0; t < typeCount; t++) {
    const home1 = (t * 7 + 3) % countryCount;
    const home2 = (t * 11 + 17) % countryCount;
    const rowWeights = new Float32Array(countryCount);
    let sum = 0;
    for (let c = 0; c < countryCount; c++) {
      let w = countryBaseWeight[c];
      if (c === home1) w *= 6;
      else if (c === home2) w *= 3;
      rowWeights[c] = w;
      sum += w;
    }
    let acc = 0;
    const base = t * countryCount;
    for (let c = 0; c < countryCount; c++) {
      acc += rowWeights[c] / sum;
      countryCumByType[base + c] = acc;
    }
    countryCumByType[base + countryCount - 1] = 1;
  }

  // Per-type value scale, unit price and margin baseline.
  const typeValueMult = new Float32Array(typeCount);
  const typeUnitPrice = new Float32Array(typeCount);
  const typeMarginBase = new Float32Array(typeCount);
  for (let t = 0; t < typeCount; t++) {
    typeValueMult[t] = Math.pow(10, hash01(t * 17.3 + 1) * 3 - 1); // 0.1x .. 100x
    typeUnitPrice[t] = 5 + hash01(t * 23.1 + 7) * 500; // 5 .. 505
    typeMarginBase[t] = 1 + hash01(t * 31.7 + 3) * 40; // 1 .. 41
  }

  const rand = mulberry32(seed);
  const typeCodes = new Int32Array(n);
  const countryCodes = new Int32Array(n);
  const regionCodes = new Int32Array(n);
  const years = new Float32Array(n);
  const values = new Float32Array(n);
  const units = new Float32Array(n);
  const margins = new Float32Array(n);

  // Titles are only worth materialising for datasets small enough that a
  // per-row string column doesn't dominate memory/build time.

  for (let i = 0; i < n; i++) {
    const rt = rand();
    let t = 0;
    while (t < typeCount - 1 && rt > typeCum[t]) t++;
    typeCodes[i] = t;

    const rc = rand();
    const base = t * countryCount;
    let c = 0;
    while (c < countryCount - 1 && rc > countryCumByType[base + c]) c++;
    countryCodes[i] = c;
    regionCodes[i] = REGION_OF_COUNTRY[c];

    const year = 2010 + ((rand() * 16) | 0);
    years[i] = year > 2025 ? 2025 : year;

    const yearFactor = Math.pow(1.06, years[i] - 2010);
    const countryFactor = 0.4 + countryBaseWeight[c] / 6;
    let v = Math.exp(12.5) * typeValueMult[t] * countryFactor * yearFactor * Math.exp(0.85 * gaussian(rand));
    if (v < 1e3) v = 1e3;
    if (v > 1e9) v = 1e9;
    values[i] = v;

    let u = (v / typeUnitPrice[t]) * (0.7 + rand() * 0.6);
    if (u < 1) u = 1;
    units[i] = Math.round(u);

    let m = typeMarginBase[t] + (rand() - 0.5) * 8;
    if (m < 1) m = 1;
    if (m > 45) m = 45;
    margins[i] = m;

  }

  const columns: Record<string, Column> = {
    Type: categoryFromCodes('Type', typeCodes, TYPES.slice()),
    Country: categoryFromCodes('Country', countryCodes, COUNTRIES.slice()),
    Region: categoryFromCodes('Region', regionCodes, REGIONS.slice()),
    Year: numeric('Year', years),
    Value: numeric('Value', values, (v) => `$${shortNumber(v)}`),
    Units: numeric('Units', units),
    Margin: numeric('Margin', margins, (v) => `${v.toFixed(1)}%`),
  };
  // Derived, not stored: at two million rows the same strings would cost
  // ~140 MB, and every part of them is already in memory.
  columns.Product = derivedText('Product', (i) => `${TYPES[typeCodes[i]]} — ${COUNTRIES[countryCodes[i]]} ${years[i]}`);

  return {
    name: `Products (${n.toLocaleString()})`,
    n,
    columns,
    labelColumn: 'Product',
    facets: ['Type', 'Country', 'Region', 'Year', 'Value', 'Units', 'Margin'],
  };
}
