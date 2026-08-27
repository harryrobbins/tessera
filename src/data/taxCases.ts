import { Dataset, Column, numeric, categoryFromCodes, derivedText, text } from './columnar';
import { mulberry32, gaussian, cumulative, pickCum, hashU32 } from './random';
import { UK_PLACES } from './ukPlaces';

/**
 * D1 — Tax customer-service cases. The onboarding dataset: its column names,
 * category orders and facet order are a frozen contract (tests/registry.test.ts)
 * that the walkthrough depends on. Neutral content: no named organisation, no
 * personal data.
 */
export const TAX_CASE_SIZES = [900, 3_000, 20_000, 100_000] as const;

/**
 * Source of synthetic people names — the shape of `@faker-js/faker`'s `faker`
 * object, passed in by the registry (which dynamic-imports the en_GB locale so
 * faker stays out of the main bundle). Without one, no `Customer` column.
 */
export interface NameSource {
  seed(seed: number): unknown;
  person: { firstName(): string; lastName(): string };
}

export const TOPICS = ['Self Assessment', 'PAYE', 'VAT', 'Tax Credits', 'Corporation Tax', 'Payments & Refunds'];
export const CHANNELS = ['Phone', 'Webchat', 'Web form', 'Post'];
export const PRIORITIES = ['Low', 'Standard', 'High'];
export const REGIONS = [
  'London', 'South East', 'South West', 'Midlands', 'North West', 'North East & Yorkshire', 'Scotland', 'Wales & NI',
];
export const TEAMS = ['Personal Tax', 'Business Tax', 'Benefits & Credits', 'Debt & Payments', 'Digital Support', 'Complaints'];
export const STATUSES = ['Resolved', 'Open'];
export const ESCALATED = ['No', 'Yes'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const AGE_BANDS = ['18–29', '30–44', '45–59', '60–74', '75+'];
export const AREA_TYPES = ['Urban', 'Suburban', 'Rural'];
export const TOWNS = UK_PLACES.map((p) => p.name);

export const TAX_CASE_FACETS = [
  'Topic', 'Channel', 'Priority', 'Region', 'Team', 'Status', 'Escalated', 'Month',
  'Age band', 'Area type', 'Town',
  'Longitude', 'Latitude', 'Resolution hours', 'Satisfaction', 'Contacts', 'Opened',
];

// Topic indices
const SA = 0, PAYE = 1, VAT = 2, TC = 3, CT = 4, PR = 5;
// Channel indices
const WEBCHAT = 1, WEBFORM = 2, POST = 3;
// Team indices
const DIGITAL = 4, COMPLAINTS = 5;

const TOPIC_CUM = cumulative([30, 22, 18, 14, 9, 7]);
const PRIORITY_CUM = cumulative([55, 35, 10]);
const PRIORITY_CUM_BUSINESS = cumulative([45, 35, 20]); // VAT / CT / Payments & Refunds

// Team by topic (when neither escalated nor leaked to Digital Support).
const TEAM_CUM = new Float32Array(TOPICS.length * TEAMS.length);
{
  const rows: number[][] = [
    [80, 5, 0, 10, 5, 0], // SA → Personal Tax 80%
    [80, 5, 0, 10, 5, 0], // PAYE
    [5, 85, 0, 10, 0, 0], // VAT → Business Tax 85%
    [5, 5, 90, 0, 0, 0],  // Tax Credits → Benefits & Credits 90%
    [5, 85, 0, 10, 0, 0], // CT
    [10, 10, 0, 80, 0, 0], // Payments & Refunds → Debt & Payments 80%
  ];
  for (let t = 0; t < TOPICS.length; t++) TEAM_CUM.set(cumulative(rows[t]), t * TEAMS.length);
}

// Day-of-year 2025 → month code and day-of-month. 2025-01-01 is a Wednesday.
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_OF_DAY = new Int8Array(366);
const DAY_OF_MONTH = new Int8Array(366);
{
  let d = 1;
  for (let m = 0; m < 12; m++) {
    for (let k = 1; k <= MONTH_DAYS[m]; k++, d++) { MONTH_OF_DAY[d] = m; DAY_OF_MONTH[d] = k; }
  }
}
export function formatDayOfYear(d: number): string {
  const i = Math.max(1, Math.min(365, Math.round(d)));
  return `${DAY_OF_MONTH[i]} ${MONTHS[MONTH_OF_DAY[i]]}`;
}
function isWeekend(d: number): boolean {
  return ((d - 1 + 2) % 7) >= 5; // 0 = Monday
}

/** Per-topic seasonal weight for a day of the year. */
function seasonal(topic: number, d: number): number {
  let w = 1;
  switch (topic) {
    case SA:
      if (d >= 15 && d <= 36) w = 4;       // 15 Jan – 5 Feb: filing deadline
      else if (d >= 278 && d <= 295) w = 2; // mid-October
      break;
    case TC:
      if (d >= 182 && d <= 212) w = 2.5;    // July renewals
      break;
    case PAYE:
      if (d >= 91 && d <= 110) w = 2.5;     // 1–20 April: new tax year
      break;
    case VAT:
      if ((d >= 1 && d <= 10) || (d >= 91 && d <= 100) || (d >= 182 && d <= 191) || (d >= 274 && d <= 283)) w = 2.5;
      break;
  }
  return w * (isWeekend(d) ? 0.35 : 1);
}
const DAY_CUM = new Float32Array(TOPICS.length * 365);
for (let t = 0; t < TOPICS.length; t++) {
  const w = new Float32Array(365);
  for (let d = 1; d <= 365; d++) w[d - 1] = seasonal(t, d);
  DAY_CUM.set(cumulative(w), t * 365);
}

// ------------------------------------------------------------- geography
// Customers sit on a population-weighted gazetteer with a gaussian jitter
// whose radius grows with the place's size, so Scatter Longitude x Latitude
// draws the country as its populated areas. A small share is drawn uniformly
// from the small places instead, jittered wider, for a rural background that
// stays on land (no uniform bounding-box sampling: that puts people in the sea).
const PLACE_CUM = cumulative(UK_PLACES.map((p) => p.pop));
const SMALL_PLACES: number[] = [];
UK_PLACES.forEach((p, i) => { if (p.pop < 60) SMALL_PLACES.push(i); });
const SMALL_CUM = cumulative(SMALL_PLACES.map(() => 1));
const PLACE_SIGMA_KM = Float32Array.from(UK_PLACES, (p) => 1.2 + 2.4 * Math.log10(Math.max(1, p.pop)));
const RURAL_SHARE = 0.12;
const RURAL_SIGMA_KM = 9;
const KM_PER_DEG_LAT = 111;
const URBAN = 0, SUBURBAN = 1, RURAL = 2;

// Age band by topic (18–29, 30–44, 45–59, 60–74, 75+).
const AGE_CUM = new Float32Array(TOPICS.length * AGE_BANDS.length);
{
  const rows: number[][] = [
    [14, 27, 28, 21, 10], // Self Assessment
    [24, 30, 26, 14, 6],  // PAYE
    [10, 30, 32, 21, 7],  // VAT
    [22, 42, 26, 8, 2],   // Tax Credits
    [8, 30, 34, 22, 6],   // Corporation Tax
    [18, 26, 24, 20, 12], // Payments & Refunds
  ];
  for (let t = 0; t < rows.length; t++) AGE_CUM.set(cumulative(rows[t]), t * AGE_BANDS.length);
}

// Channel by area type x age band. Base mix (Phone 45 / Webchat 25 / Web form 20 /
// Post 10) scaled by per-area and per-age multipliers: rural and older lean to
// phone and post, urban and younger to webchat and web forms. The base weights
// are pre-corrected so the overall marginal still lands near 45/25/20/10.
const CHANNEL_BASE = [44, 21, 19.5, 10];
const AREA_MULT = [
  [0.85, 1.35, 1.25, 0.6], // Urban
  [1, 1, 1, 1],             // Suburban
  [1.45, 0.5, 0.7, 2.2],    // Rural
];
const AGE_MULT = [
  [0.75, 1.9, 1.15, 0.3],  // 18–29
  [0.9, 1.35, 1.2, 0.5],   // 30–44
  [1, 1, 1, 1],            // 45–59
  [1.3, 0.55, 0.8, 1.6],   // 60–74
  [1.6, 0.2, 0.5, 2.8],    // 75+
];
const CHANNEL_CUM_BY = new Float32Array(AREA_TYPES.length * AGE_BANDS.length * CHANNELS.length);
for (let a = 0; a < AREA_TYPES.length; a++) {
  for (let g = 0; g < AGE_BANDS.length; g++) {
    const w = CHANNEL_BASE.map((b, c) => b * AREA_MULT[a][c] * AGE_MULT[g][c]);
    CHANNEL_CUM_BY.set(cumulative(w), (a * AGE_BANDS.length + g) * CHANNELS.length);
  }
}

const INWARD_LETTERS = 'ABDEFGHJLNPQRSTUWXYZ';

const CHANNEL_MEDIAN_HOURS = [0.8, 0.4, 30, 110];
const TOPIC_HOURS = [1, 1, 1.4, 1.2, 1.5, 1];
const PRIORITY_HOURS = [1.2, 1, 0.6];
const CHANNEL_SAT = [0, 0.3, 0, -0.4];

export function generateTaxCases(n: number, seed = 11, names?: NameSource): Dataset {
  const rand = mulberry32(seed);
  const topic = new Int32Array(n);
  const channel = new Int32Array(n);
  const priority = new Int32Array(n);
  const region = new Int32Array(n);
  const team = new Int32Array(n);
  const status = new Int32Array(n);
  const escalated = new Int32Array(n);
  const month = new Int32Array(n);
  const hours = new Float32Array(n);
  const satisfaction = new Float32Array(n);
  const contacts = new Float32Array(n);
  const opened = new Float32Array(n);
  const ageBand = new Int32Array(n);
  const areaType = new Int32Array(n);
  const town = new Int32Array(n);
  const lon = new Float32Array(n);
  const lat = new Float32Array(n);
  // Postcodes draw from the row stream and names come from faker, so both are
  // materialised — at every size. A collection's *shape* must not depend on how
  // many rows it has: the case reference is the only identity column that is a
  // formula over the row index, and it is derived below rather than stored.
  const postcodes = new Array<string>(n);
  // Customer names are synthetic (faker, en_GB), seeded so they are as
  // deterministic as everything else.
  const customers = names ? new Array<string>(n) : null;
  if (customers) names!.seed(seed);

  const LOG_1_MINUS_P = Math.log(1 - 0.55);

  for (let i = 0; i < n; i++) {
    // Fixed draw order: topic, place (+ jitter), age, channel, priority, opened,
    // escalated, status, team, hours, contacts, satisfaction, then name/postcode.
    const t = pickCum(rand, TOPIC_CUM);

    const rural = rand() < RURAL_SHARE;
    const pl = rural ? SMALL_PLACES[pickCum(rand, SMALL_CUM)] : pickCum(rand, PLACE_CUM);
    const place = UK_PLACES[pl];
    const sigmaKm = rural ? RURAL_SIGMA_KM : PLACE_SIGMA_KM[pl];
    const jx = gaussian(rand);
    const jy = gaussian(rand);
    const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((place.lat * Math.PI) / 180);
    let x = place.lon + (jx * sigmaKm) / kmPerDegLon;
    let y = place.lat + (jy * sigmaKm) / KM_PER_DEG_LAT;
    if (x < -8.2) x = -8.2; if (x > 1.8) x = 1.8;
    if (y < 49.9) y = 49.9; if (y > 60.9) y = 60.9;
    const dist = Math.sqrt(jx * jx + jy * jy); // in sigmas
    let area: number;
    if (rural) area = RURAL;
    else if (place.pop >= 80) area = dist < 0.9 ? URBAN : SUBURBAN;
    else if (place.pop >= 15) area = dist < 0.5 ? URBAN : dist < 1.3 ? SUBURBAN : RURAL;
    else area = dist < 1 ? SUBURBAN : RURAL;
    const r = place.region;

    const g = pickCum(rand, AGE_CUM, t * AGE_BANDS.length, AGE_BANDS.length);
    const c = pickCum(rand, CHANNEL_CUM_BY, (area * AGE_BANDS.length + g) * CHANNELS.length, CHANNELS.length);
    const business = t === VAT || t === CT || t === PR;
    const p = pickCum(rand, business ? PRIORITY_CUM_BUSINESS : PRIORITY_CUM);
    const day = pickCum(rand, DAY_CUM, t * 365, 365) + 1;

    let pEsc = 0.05;
    if (p === 2) pEsc *= 2.5;
    if (t === VAT || t === CT) pEsc *= 1.6;
    if (c === WEBCHAT) pEsc *= 0.6;
    const isEscalated = rand() < pEsc ? 1 : 0;

    let pOpen = 0.15;
    if (c === POST) pOpen *= 1.6;
    if (day > 300) pOpen *= 1.8;
    const open = rand() < pOpen ? 1 : 0;

    // Team: escalated → 30% Complaints; digital channels leak 10% to Digital Support; else by topic.
    const rTeam = rand();
    let tm: number;
    if (isEscalated && rTeam < 0.3) tm = COMPLAINTS;
    else if ((c === WEBCHAT || c === WEBFORM) && rTeam >= 0.3 && rTeam < 0.4) tm = DIGITAL;
    else tm = pickCum(rand, TEAM_CUM, t * TEAMS.length, TEAMS.length);

    // Resolution hours: lognormal, sigma 0.6, clipped to [0.1, 240] so 12
    // equal-width bins read (the raw tail runs to weeks). NaN while Open.
    const median = CHANNEL_MEDIAN_HOURS[c] * TOPIC_HOURS[t] * PRIORITY_HOURS[p] * (isEscalated ? 3 : 1);
    let h = median * Math.exp(0.6 * gaussian(rand));
    if (h < 0.1) h = 0.1;
    if (h > 240) h = 240;
    h = Math.round(h * 10) / 10;

    let k = Math.floor(Math.log(1 - rand()) / LOG_1_MINUS_P) + 1 + isEscalated + (c === POST ? 1 : 0);
    if (k > 8) k = 8;

    const surveyed = rand() >= 0.25;
    let s = 3.9 - 0.45 * Math.log2(h / CHANNEL_MEDIAN_HOURS[c]) - 0.9 * isEscalated + CHANNEL_SAT[c] + 0.7 * gaussian(rand);
    s = Math.round(s);
    if (s < 1) s = 1;
    if (s > 5) s = 5;

    topic[i] = t; channel[i] = c; priority[i] = p; region[i] = r; team[i] = tm;
    status[i] = open; escalated[i] = isEscalated; month[i] = MONTH_OF_DAY[day];
    opened[i] = day;
    hours[i] = open ? NaN : h;
    satisfaction[i] = open || !surveyed ? NaN : s;
    contacts[i] = k;
    ageBand[i] = g; areaType[i] = area; town[i] = pl;
    lon[i] = Math.round(x * 1000) / 1000; lat[i] = Math.round(y * 1000) / 1000;
    if (customers) customers[i] = `${names!.person.firstName()} ${names!.person.lastName()}`;
    // Outward code: the place's area letters plus a district number fixed per
    // place (integer hash, so it never depends on the row stream); inward random.
    const district = 1 + ((hashU32(pl, 5) * (place.pop >= 100 ? 20 : 8)) | 0);
    const inward = `${(rand() * 10) | 0}${INWARD_LETTERS[(rand() * INWARD_LETTERS.length) | 0]}${INWARD_LETTERS[(rand() * INWARD_LETTERS.length) | 0]}`;
    postcodes[i] = `${place.pc}${district} ${inward}`;
  }

  const columns: Record<string, Column> = {};
  columns.Case = derivedText('Case', (i) => `CS-25-${String(i + 1).padStart(6, '0')}`);
  if (customers) columns.Customer = text('Customer', customers);
  columns.Postcode = text('Postcode', postcodes);
  columns.Topic = categoryFromCodes('Topic', topic, TOPICS.slice());
  columns.Channel = categoryFromCodes('Channel', channel, CHANNELS.slice());
  columns.Priority = categoryFromCodes('Priority', priority, PRIORITIES.slice());
  columns.Region = categoryFromCodes('Region', region, REGIONS.slice());
  columns.Team = categoryFromCodes('Team', team, TEAMS.slice());
  columns.Status = categoryFromCodes('Status', status, STATUSES.slice());
  columns.Escalated = categoryFromCodes('Escalated', escalated, ESCALATED.slice());
  columns.Month = categoryFromCodes('Month', month, MONTHS.slice());
  columns['Age band'] = categoryFromCodes('Age band', ageBand, AGE_BANDS.slice());
  columns['Area type'] = categoryFromCodes('Area type', areaType, AREA_TYPES.slice());
  columns.Town = categoryFromCodes('Town', town, TOWNS.slice());
  // Longitude/Latitude are the first numeric columns so the raw Scatter opens on the map.
  columns.Longitude = numeric('Longitude', lon, (v) => v.toFixed(3));
  columns.Latitude = numeric('Latitude', lat, (v) => v.toFixed(3));
  columns['Resolution hours'] = numeric('Resolution hours', hours, (v) => `${v.toFixed(1)} h`);
  columns.Satisfaction = numeric('Satisfaction', satisfaction, (v) => `${v.toFixed(0)} / 5`);
  columns.Contacts = numeric('Contacts', contacts, (v) => v.toFixed(0));
  columns.Opened = numeric('Opened', opened, formatDayOfYear);

  // The card title is the person; the case ref is shown separately by the card
  // and the detail view. Without a name source (a caller that did not pass
  // faker — the tests do this) the reference is the identity.
  const labelColumn = customers ? 'Customer' : 'Case';

  return {
    name: `Tax customer service (${n.toLocaleString()})`,
    n,
    columns,
    labelColumn,
    facets: TAX_CASE_FACETS.slice(),
    kind: 'tax-cases',
    geo: { lon: 'Longitude', lat: 'Latitude' },

    card: {
      // The dense record card, at every size. It used to be reserved for
      // collections small enough to read one card, because above the atlas cap
      // every card in a category was the *same* texture and the dense design
      // made that painfully obvious. Cards are per-row art at any size now, so
      // the design is a preference (the Cards popover) rather than a function
      // of the row count.
      custom: 'taxCase' as const,
      topic: 'Topic',
      mark: { glyph: 'Channel' },
      title: labelColumn,
      blurb: (i: number) => `${postcodes[i]} · ${TOWNS[town[i]]}`,
      tags: [
        // 55% of cases are Standard priority, so printing it prints "normal" on
        // half the board; dropping it is what makes a coloured chip mean something.
        { value: 'Priority', shape: 'pill', tone: { High: 'bad', Standard: 'accent', Low: 'neutral' }, hideWhen: ['Standard'] },
        { value: 'Status', shape: 'dot', tone: { Open: 'warn', Resolved: 'good' } },
      ],
      metric: { value: 'Contacts', label: (i: number) => (contacts[i] === 1 ? 'contact' : 'contacts') },
    },

    detail: {
      custom: 'tax-cases',            // keeps today's timeline renderer
      subtitle: (i: number) => `CS-25-${String(i + 1).padStart(6, '0')} · ${TOWNS[town[i]]}`,
      context: ['Channel', 'Topic', 'Priority'],
      actions: [
        { id: 'review', label: 'Review action', primary: true },
        { id: 'reassign', label: 'Reassign' },
        { id: 'note', label: 'Add note' },
      ],
    },
  };
}
