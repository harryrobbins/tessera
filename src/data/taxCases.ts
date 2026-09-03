import { Dataset, Column, numeric, categoryFromCodes, derivedText } from './columnar';
import { mulberry32, gaussian, cumulative, pickCum, hashU32, hashGaussian } from './random';
import { UK_PLACES } from './ukPlaces';

/**
 * D1 — Tax customer-service cases. The onboarding dataset: its column names,
 * category orders and facet order are a frozen contract (tests/registry.test.ts)
 * that the walkthrough depends on. Neutral content: no named organisation, no
 * personal data.
 *
 * The generator models a **customer base**, not a bag of rows. A customer is
 * drawn from a pool with a heavy repeat-contact tail; where they live, how old
 * they are, whether they are an individual, an agent or a business — those are
 * properties of the person, fixed across every case they open. The case then
 * follows from the customer, the calendar and the queue it joined. Everything
 * downstream (how long it took, how often they chased, what they said in the
 * survey) is *derived* from those, so the columns agree with each other the way
 * an extract from a real case-management system does.
 *
 * The snapshot is the other half of that: this is one year of arrivals seen
 * from 31 December, so a case is Open because it has not finished yet, not
 * because a coin said so — and the collection carries the survivorship that
 * every real snapshot carries.
 */
export const TAX_CASE_SIZES = [900, 3_000, 20_000, 100_000] as const;

/**
 * The stream seed. It lives here, and the registry and the tour's tests read
 * it, because the guided tour's narration is *recorded audio*: it says twelve
 * urgent cases on paper and five contacts, and those are facts about this
 * seed. Changing the generator means re-choosing a seed the narration is still
 * true of (tests/tour-story.test.ts is the oracle), not re-cutting the audio.
 */
export const TAX_CASE_SEED = 88;

/** Day of 2025 the extract was taken: anything still running on it is Open. */
export const AS_OF_DAY = 365;

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
export const REOPENED = ['No', 'Yes'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const AGE_BANDS = ['18–29', '30–44', '45–59', '60–74', '75+'];
export const AREA_TYPES = ['Urban', 'Suburban', 'Rural'];
export const CUSTOMER_TYPES = ['Individual', 'Agent', 'Business'];
export const LANGUAGES = ['English', 'Welsh'];
export const SUPPORT = ['Standard', 'Additional support'];
/** Against the channel's service target. Open cases that have not blown it yet are neither. */
export const SLA_STATES = ['Met', 'Missed', 'In progress'];
export const TOWNS = UK_PLACES.map((p) => p.name);

/**
 * Reason codes, grouped by topic and ordered commonest first — a real case
 * taxonomy is a long tail, not six equal buckets, so within a topic the weights
 * run as 1/rank.
 */
const REASONS_BY_TOPIC: string[][] = [
  ['Filing a return', 'Registering for Self Assessment', 'Password or login', 'Payments on account', 'Penalty appeal', 'Lost UTR', 'Stopping Self Assessment'],
  ['Tax code wrong', 'Refund after a P800', 'Missing P45 or P60', 'Starting a new job', 'Second job or pension', 'Underpayment coded out'],
  ['Filing a VAT return', 'Registration threshold', 'Making Tax Digital software', 'Repayment delayed', 'Deregistration', 'Flat rate scheme'],
  ['Annual renewal', 'Change of circumstances', 'Overpayment recovery', 'Award review', 'Childcare element', 'Move to Universal Credit'],
  ['Filing deadline', 'New company registration', 'Marginal relief', 'Payment reference', 'Dormant company', 'Group relief'],
  ['Where is my refund', 'Time to pay arrangement', 'Payment not credited', 'Direct debit', 'Bank details changed', 'Debt management letter'],
];
export const REASONS = REASONS_BY_TOPIC.flat();
/** First reason index for each topic, so a code is `REASON_BASE[topic] + rank`. */
const REASON_BASE = REASONS_BY_TOPIC.reduce<number[]>((acc, r) => (acc.push(acc[acc.length - 1] + r.length), acc), [0]);
const REASON_CUM = REASONS_BY_TOPIC.map((r) => cumulative(r.map((_, k) => 1 / (k + 1))));

/**
 * The adviser roster: 72 people, and a case is handled by one of them. They
 * are what makes the collection *hierarchical* — every other effect here is
 * fixed, but an adviser carries a skill drawn from their index (never from the
 * row stream), and it moves both how long their cases take and how their
 * customers rate them. Real operational data is full of this and synthetic
 * data almost never has it.
 */
const ADVISER_FORENAMES = [
  'Aisha', 'Callum', 'Priya', 'Tomasz', 'Grace', 'Idris', 'Nia', 'Ewan', 'Fatima', 'Rory',
  'Chloe', 'Amara', 'Declan', 'Meera', 'Struan', 'Bethan', 'Kwame', 'Orla', 'Hamza', 'Lorna',
  'Jamal', 'Ffion', 'Sean', 'Ayesha', 'Gregor', 'Maryam', 'Niamh', 'Oluwa', 'Iain', 'Sofia',
  'Dafydd', 'Ruth', 'Zainab', 'Malcolm', 'Leila', 'Fraser',
];
const INITIALS = 'ABCDEFGHJKLMNPRSTWY';
export const ADVISERS = ADVISER_FORENAMES.flatMap((f, i) => [
  `${f} ${INITIALS[(i * 5) % INITIALS.length]}.`,
  `${f} ${INITIALS[(i * 5 + 9) % INITIALS.length]}.`,
]);
/** Advisers per team, in `TEAMS` order, carving the roster into contiguous slices. */
const TEAM_ADVISERS = [26, 16, 9, 9, 7, 5];
const TEAM_ADVISER_BASE = TEAM_ADVISERS.reduce<number[]>((acc, k) => (acc.push(acc[acc.length - 1] + k), acc), [0]);
/** Skill, standard normal: positive is faster and better rated. */
const ADVISER_SKILL = Float32Array.from(ADVISERS, (_, i) => hashGaussian(i, 31));

export const TAX_CASE_FACETS = [
  'Topic', 'Reason', 'Channel', 'Priority', 'Region', 'Team', 'Adviser',
  'Status', 'Escalated', 'Reopened', 'Within SLA', 'Month',
  'Customer type', 'Age band', 'Area type', 'Language', 'Support needs', 'Town',
  'Longitude', 'Latitude', 'Resolution hours', 'Days waiting', 'Satisfaction',
  'Contacts', 'Handling minutes', 'Prior cases', 'Opened', 'Hour opened',
];

// Topic indices
const SA = 0, PAYE = 1, VAT = 2, TC = 3, CT = 4, PR = 5;
// Channel indices
const PHONE = 0, WEBCHAT = 1, WEBFORM = 2, POST = 3;
// Team indices
const DIGITAL = 4, COMPLAINTS = 5;
// Customer type index (the other two are never named)
const AGENT = 1;

/** One draw from unnormalised weights — the shape of `pickCum` without the table. */
function pickWeighted(rand: () => number, w: Float32Array): number {
  let sum = 0;
  for (let k = 0; k < w.length; k++) sum += w[k];
  let r = rand() * sum;
  for (let k = 0; k < w.length - 1; k++) {
    r -= w[k];
    if (r <= 0) return k;
  }
  return w.length - 1;
}

// ------------------------------------------------------------- the channels
/**
 * Channel by area type x age band x customer type x day of week, drifting
 * across the year. The base weights are pre-corrected so the overall marginal
 * still lands near 45/25/20/10 once every multiplier has had its say.
 */
const CHANNEL_BASE = [47.5, 21.4, 16.4, 12.7];
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
const TYPE_CHANNEL_MULT = [
  [1, 1, 1, 1],                // Individual
  [1.10, 0.40, 1.90, 0.50],    // Agent — the agent line and the forms
  [1.05, 0.90, 1.30, 0.70],    // Business
];
/**
 * Day of week. A letter is date-stamped when the post room opens it, so post
 * simply does not arrive at a weekend; the helpline is Saturday morning only
 * and shut on Sunday; the digital channels are the ones that stay up. Without
 * this, a tenth of the letters in the collection arrived on a Sunday.
 */
const DOW_CHANNEL_MULT = [
  [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], // Mon–Fri
  [0.45, 0.90, 0.90, 0.03],  // Sat
  [0.05, 0.80, 0.85, 0.01],  // Sun
];
/**
 * Digital shift across the year, as a slope on `(day − mid) / 365`. It averages
 * to one over the year, so it tilts the mix month by month without moving the
 * marginal — the only genuine trend in the collection.
 */
const CHANNEL_DRIFT = [-0.15, 0.55, 0.35, -0.75];
/**
 * How busy a day is, by day of week — which is not a free parameter: it is
 * what is open. A Saturday is half a weekday because the helpline runs a
 * morning; a Sunday is a third of one because only the self-service channels
 * are up. Deriving it here rather than applying a flat weekend factor is what
 * stops Sunday from carrying *more* web forms than Saturday.
 */
const DOW_VOLUME = DOW_CHANNEL_MULT.map((mult) => {
  const open = CHANNEL_BASE.reduce((s, b, c) => s + b * mult[c], 0);
  return open / CHANNEL_BASE.reduce((s, b) => s + b, 0);
});

// ------------------------------------------------------------- the calendar
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
/** 0 = Monday. */
function weekday(d: number): number {
  return (d - 1 + 2) % 7;
}
/** England & Wales bank holidays 2025, as days of the year. */
const BANK_HOLIDAYS = new Set([1, 108, 111, 125, 146, 237, 359, 360]);

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
  // Closed days are the same shape for every topic: nobody rings on Christmas
  // Day, and the week between Christmas and New Year barely happens at all.
  if (BANK_HOLIDAYS.has(d)) w *= 0.06;
  else if (d >= 358 || d <= 2) w *= 0.25;
  return w * DOW_VOLUME[weekday(d)];
}
/** The topic mix as it comes out — the marginal, used to weight the arrival
 *  curve. `TOPIC_BASE` below is the *input* that produces it, and is not the
 *  same numbers: it is pre-corrected for the multipliers applied per row. */
const TOPIC_WEIGHTS = [30, 22, 18, 14, 9, 7];
const DAY_CUM = new Float32Array(TOPICS.length * 365);
for (let t = 0; t < TOPICS.length; t++) {
  const w = new Float32Array(365);
  for (let d = 1; d <= 365; d++) w[d - 1] = seasonal(t, d);
  DAY_CUM.set(cumulative(w), t * 365);
}

/**
 * Queue load: the backlog a case joins, as a multiple of the year's average.
 * It is a trailing 14-day mean of arrivals rather than the day's own count —
 * a queue is what the fortnight before you left behind, which is also why a
 * Sunday is not a quiet day to have a case open. Nothing else in the generator
 * made a January case behave differently from a June one; this is what makes
 * the deadline spike visible in the *duration* and *satisfaction* columns and
 * not only in the arrivals.
 */
const LOAD = new Float32Array(366);
{
  const arrivals = new Float32Array(366);
  for (let d = 1; d <= 365; d++) {
    let a = 0;
    for (let t = 0; t < TOPICS.length; t++) a += TOPIC_WEIGHTS[t] * seasonal(t, d);
    arrivals[d] = a;
  }
  const WINDOW = 14;
  let mean = 0;
  for (let d = 1; d <= 365; d++) mean += arrivals[d] / 365;
  for (let d = 1; d <= 365; d++) {
    let s = 0;
    for (let k = 0; k < WINDOW; k++) s += arrivals[((d - k - 1 + 365) % 365) + 1];
    LOAD[d] = Math.pow(s / WINDOW / mean, 0.85);
  }
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

// ------------------------------------------------------------- the customer
/**
 * Age band by area type. Cities are young and the countryside is old, which is
 * the whole reason `Area type` and `Age band` both push on `Channel`: without
 * this they were independent, and the two effects could never reinforce.
 * The base is the marginal we want, divided back out by the mix so that
 * conditioning on area does not move the overall age profile.
 */
const AGE_BASE = [0.164, 0.303, 0.282, 0.178, 0.073];
const AREA_SHARE = [0.27, 0.56, 0.17]; // approximately what the gazetteer yields
const AREA_AGE_MULT = [
  [1.25, 1.15, 0.95, 0.75, 0.60], // Urban
  [0.95, 1.00, 1.02, 1.05, 1.05], // Suburban
  [0.70, 0.85, 1.05, 1.35, 1.60], // Rural
];
const AGE_CUM_BY_AREA = new Float32Array(AREA_TYPES.length * AGE_BANDS.length);
{
  const correction = AGE_BASE.map((_, g) => AREA_SHARE.reduce((s, p, a) => s + p * AREA_AGE_MULT[a][g], 0));
  for (let a = 0; a < AREA_TYPES.length; a++) {
    const w = AGE_BASE.map((b, g) => (b * AREA_AGE_MULT[a][g]) / correction[g]);
    AGE_CUM_BY_AREA.set(cumulative(w), a * AGE_BANDS.length);
  }
}

const CUSTOMER_TYPE_CUM = cumulative([86, 4.5, 9.5]);
/** Welsh-language customers, by region: a Wales & NI address or next to nobody. */
const WELSH_SHARE = [0.002, 0.002, 0.003, 0.002, 0.002, 0.002, 0.003, 0.20];
/** Needing extra help — hearing, sight, literacy, digital access — rises with age. */
const SUPPORT_SHARE = [0.035, 0.045, 0.065, 0.11, 0.22];

/**
 * How many cases each customer brings. A support line's contact volume is
 * famously top-heavy: most people appear once, a few appear again and again,
 * and the tail is who the operational reporting is really about. The closed
 * form (`m·u^k`) buys that tail in one draw, which matters because a
 * cumulative table over sixty thousand customers would be scanned per row.
 */
const CUSTOMER_POOL_RATIO = 0.62;
const CUSTOMER_SKEW = 1.3;

// ------------------------------------------------------------- the case
/**
 * Topic weights, as a base mix multiplied by what we know about the customer.
 * Six weights per row is cheap, and it means one readable table per driver
 * instead of one pre-baked cube. The base is pre-corrected — every multiplier
 * pulls the mix around, and what has to come out is `TOPIC_WEIGHTS`, which is
 * what `tests/datasets.test.ts` holds it to.
 */
const TOPIC_BASE = Float32Array.from([26.9, 18.2, 29.1, 11.2, 22.8, 5.7]);
const TOPIC_AGE_MULT = [
  [0.80, 1.50, 0.60, 1.50, 0.50, 1.10], // 18–29
  [0.95, 1.10, 1.00, 1.40, 1.00, 0.95], // 30–44
  [1.05, 0.95, 1.15, 0.90, 1.20, 0.90], // 45–59
  [1.20, 0.65, 1.00, 0.35, 1.05, 1.15], // 60–74
  [1.15, 0.40, 0.60, 0.15, 0.55, 1.60], // 75+
];
const TOPIC_TYPE_MULT = [
  [1.00, 1.15, 0.45, 1.30, 0.20, 1.05], // Individual
  [2.20, 0.50, 1.60, 0.20, 2.60, 0.90], // Agent
  [0.50, 1.50, 3.20, 0.05, 3.00, 0.90], // Business
];
/** Regional character: London self-assessed and incorporated, the north on credits. */
const TOPIC_REGION_MULT = [
  [1.25, 0.95, 1.10, 0.85, 1.20, 0.95], // London
  [1.10, 1.00, 1.05, 0.85, 1.05, 0.95], // South East
  [1.05, 0.95, 1.05, 0.95, 0.95, 1.00], // South West
  [0.90, 1.05, 1.00, 1.10, 0.95, 1.00], // Midlands
  [0.85, 1.05, 0.95, 1.15, 0.90, 1.05], // North West
  [0.85, 1.05, 0.95, 1.15, 0.90, 1.05], // North East & Yorkshire
  [0.95, 1.00, 0.95, 1.05, 0.95, 1.05], // Scotland
  [0.85, 1.05, 0.90, 1.20, 0.85, 1.10], // Wales & NI
];

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

const INWARD_LETTERS = 'ABDEFGHJLNPQRSTUWXYZ';

// ------------------------------------------------------------- the outcome
/** Median hours to close, by channel, for the ordinary stream. */
const CHANNEL_MEDIAN_HOURS = [0.8, 0.4, 30, 78];
const TOPIC_HOURS = [1, 1, 1.4, 1.2, 1.5, 1];
const PRIORITY_HOURS = [1.2, 1, 0.6];
const TYPE_HOURS = [1, 0.75, 1.05]; // an agent sends the right thing first time
/**
 * The complex stream: a minority of cases that turn into correspondence
 * chains, disputes and appeals, and run for months. It is small, and it is
 * most of the backlog — which is exactly the shape a real queue has, and the
 * reason a snapshot's open cases are a different animal from its closed ones.
 */
const COMPLEX_SHARE = [0.07, 0.04, 0.18, 0.34];
const COMPLEX_PRIORITY_MULT = [0.8, 1, 1.5];
const COMPLEX_MEDIAN_HOURS = 150 * 24;
/**
 * Service target per channel, in hours: a day for the live channels, five for
 * a web form, nine for a letter. Every target sits below the clip on purpose —
 * `Within SLA` has to be recomputable from `Resolution hours` by whoever reads
 * the collection, and a target above the clip could never be missed.
 */
const SLA_TARGET_HOURS = [24, 24, 120, 216];
/** Hours a case may run before the clip; the card art's log bar ends here too. */
const HOURS_CLIP = 240;

const CHANNEL_SAT = [0, 0.3, 0, -0.4];
/** Survey response by channel — a chat window asks at once, a letter never does. */
const RESPONSE_BASE = [0.22, 0.38, 0.30, 0.14];
/**
 * Score thresholds on the latent. Real satisfaction is J-shaped — a large top
 * box and a hard core of ones — not a bell curve around four, so the latent is
 * deliberately wide and the cuts are placed to pick out the tails.
 */
const SCORE_CUTS = [2.15, 3.05, 3.6, 4.15];

const HANDLING_MEDIAN_MIN = [11, 8, 16, 22];

export function generateTaxCases(n: number, seed = TAX_CASE_SEED, names?: NameSource): Dataset {
  const rand = mulberry32(seed);

  // ---- the customer base. Attributes are materialised the first time a
  // customer is drawn, and every later case of theirs reads the same values.
  const m = Math.max(1, Math.ceil(n * CUSTOMER_POOL_RATIO));
  const seen = new Uint8Array(m);
  const cPlace = new Int32Array(m);
  const cArea = new Int32Array(m);
  const cAge = new Int32Array(m);
  const cType = new Int32Array(m);
  const cLang = new Int32Array(m);
  const cSupport = new Int32Array(m);
  const cLon = new Float32Array(m);
  const cLat = new Float32Array(m);
  const cPostcode = new Array<string>(m);
  // Names come from faker, seeded so they are as deterministic as everything
  // else. They belong to the customer, not the case, so there are `m` of them
  // however many rows the collection has — and `Customer` and `Postcode` are
  // read through the customer index rather than stored per row.
  const cName = names ? new Array<string>(m) : null;
  if (cName) names!.seed(seed);

  const customer = new Int32Array(n);
  const topic = new Int32Array(n);
  const reason = new Int32Array(n);
  const opened = new Float32Array(n);
  const month = new Int32Array(n);
  const prior = new Float32Array(n);

  const channel = new Int32Array(n);
  const priority = new Int32Array(n);
  const team = new Int32Array(n);
  const adviser = new Int32Array(n);
  const status = new Int32Array(n);
  const escalated = new Int32Array(n);
  const reopened = new Int32Array(n);
  const sla = new Int32Array(n);
  const hours = new Float32Array(n);
  const waiting = new Float32Array(n);
  const satisfaction = new Float32Array(n);
  const contacts = new Float32Array(n);
  const handling = new Float32Array(n);
  const hourOpened = new Float32Array(n);

  const topicW = new Float32Array(TOPICS.length);
  const channelW = new Float32Array(CHANNELS.length);

  // ---- pass one: who is asking, about what, and when.
  // Fixed draw order: customer (and, on first sight, their place, area, age,
  // type, language, support needs, postcode and name), topic, reason, day.
  for (let i = 0; i < n; i++) {
    const cu = Math.min(m - 1, (m * Math.pow(rand(), CUSTOMER_SKEW)) | 0);
    customer[i] = cu;

    if (!seen[cu]) {
      seen[cu] = 1;
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

      const g = pickCum(rand, AGE_CUM_BY_AREA, area * AGE_BANDS.length, AGE_BANDS.length);
      const ty = pickCum(rand, CUSTOMER_TYPE_CUM);
      const welsh = rand() < WELSH_SHARE[place.region] ? 1 : 0;
      const support = rand() < SUPPORT_SHARE[g] ? 1 : 0;
      // Outward code: the place's area letters plus a district number fixed per
      // place (integer hash, so it never depends on the row stream); inward random.
      const district = 1 + ((hashU32(pl, 5) * (place.pop >= 100 ? 20 : 8)) | 0);
      const inward = `${(rand() * 10) | 0}${INWARD_LETTERS[(rand() * INWARD_LETTERS.length) | 0]}${INWARD_LETTERS[(rand() * INWARD_LETTERS.length) | 0]}`;

      cPlace[cu] = pl; cArea[cu] = area; cAge[cu] = g; cType[cu] = ty;
      cLang[cu] = welsh; cSupport[cu] = support;
      cLon[cu] = Math.round(x * 1000) / 1000; cLat[cu] = Math.round(y * 1000) / 1000;
      cPostcode[cu] = `${place.pc}${district} ${inward}`;
      if (cName) cName[cu] = `${names!.person.firstName()} ${names!.person.lastName()}`;
    }

    const g = cAge[cu];
    const ty = cType[cu];
    const r = UK_PLACES[cPlace[cu]].region;
    for (let t = 0; t < TOPICS.length; t++) {
      topicW[t] = TOPIC_BASE[t] * TOPIC_AGE_MULT[g][t] * TOPIC_TYPE_MULT[ty][t] * TOPIC_REGION_MULT[r][t];
    }
    const t = pickWeighted(rand, topicW);
    topic[i] = t;
    reason[i] = REASON_BASE[t] + pickCum(rand, REASON_CUM[t]);
    const day = pickCum(rand, DAY_CUM, t * 365, 365) + 1;
    opened[i] = day;
    month[i] = MONTH_OF_DAY[day];
  }

  // ---- between the passes: how many cases this customer had already had when
  // this one opened. The row stream is not in date order, so it is a sort:
  // rows grouped by customer, each group in the order the cases arrived.
  {
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const sorted = Array.from(order).sort((a, b) => customer[a] - customer[b] || opened[a] - opened[b]);
    let run = 0;
    for (let k = 0; k < n; k++) {
      const i = sorted[k];
      run = k > 0 && customer[sorted[k - 1]] === customer[i] ? run + 1 : 0;
      prior[i] = run;
    }
  }

  // ---- pass two: what happened to the case.
  // Fixed draw order: channel, priority, escalated, team, adviser, complex,
  // duration, contacts, handling, reopened, satisfaction, survey, hour.
  const LOG_1_MINUS_P = Math.log(1 - 0.62);
  for (let i = 0; i < n; i++) {
    const cu = customer[i];
    const t = topic[i];
    const g = cAge[cu];
    const area = cArea[cu];
    const ty = cType[cu];
    const support = cSupport[cu];
    const day = opened[i];
    const dow = weekday(day);
    const drift = (day - 183) / 365;

    for (let k = 0; k < CHANNELS.length; k++) {
      channelW[k] = CHANNEL_BASE[k] * AREA_MULT[area][k] * AGE_MULT[g][k] * TYPE_CHANNEL_MULT[ty][k]
        * DOW_CHANNEL_MULT[dow][k] * (1 + CHANNEL_DRIFT[k] * drift);
    }
    const c = pickWeighted(rand, channelW);

    const business = t === VAT || t === CT || t === PR;
    let p = pickCum(rand, business ? PRIORITY_CUM_BUSINESS : PRIORITY_CUM);
    // Someone who needs extra help, or who has been round this loop before,
    // is more likely to be flagged urgent.
    if (p < 2 && support && rand() < 0.25) p = 2;

    let pEsc = 0.05;
    if (p === 2) pEsc *= 2.5;
    if (t === VAT || t === CT) pEsc *= 1.6;
    if (c === WEBCHAT) pEsc *= 0.6;
    if (support) pEsc *= 1.3;
    pEsc *= 1 + 0.18 * Math.min(prior[i], 5);
    const isEscalated = rand() < pEsc ? 1 : 0;

    // Team: escalated → 30% Complaints; digital channels leak 10% to Digital Support; else by topic.
    const rTeam = rand();
    let tm: number;
    if (isEscalated && rTeam < 0.3) tm = COMPLAINTS;
    else if ((c === WEBCHAT || c === WEBFORM) && rTeam >= 0.3 && rTeam < 0.4) tm = DIGITAL;
    else tm = pickCum(rand, TEAM_CUM, t * TEAMS.length, TEAMS.length);
    const ad = TEAM_ADVISER_BASE[tm] + ((rand() * TEAM_ADVISERS[tm]) | 0);
    const skill = ADVISER_SKILL[ad];

    // Duration, in hours and unclipped: the ordinary stream is lognormal about
    // the channel's median, the complex stream runs for months. Both are
    // stretched by the queue the case joined and by who picked it up.
    const complex = rand() < COMPLEX_SHARE[c] * COMPLEX_PRIORITY_MULT[p];
    const shared = LOAD[day] * Math.exp(-0.3 * skill) * (support ? 1.25 : 1) * TOPIC_HOURS[t];
    let duration = complex
      ? COMPLEX_MEDIAN_HOURS * shared * Math.exp(1.15 * gaussian(rand))
      : CHANNEL_MEDIAN_HOURS[c] * PRIORITY_HOURS[p] * TYPE_HOURS[ty] * (isEscalated ? 3 : 1) * shared
        * Math.exp(0.6 * gaussian(rand));
    if (duration < 0.1) duration = 0.1;

    // The snapshot. A case is Open because it has not finished by the as-of
    // day — so the backlog is mostly recent arrivals plus the complex stream's
    // long tail, and the resolved cases carry a snapshot's survivorship.
    const elapsed = (AS_OF_DAY - day) * 24;
    const open = duration > elapsed ? 1 : 0;
    // What the customer has lived through so far, which is what they respond to.
    const felt = open ? Math.max(0.1, elapsed) : duration;

    // Chases: a geometric base plus one for roughly every two doublings of the
    // wait past what the channel normally takes. A case that ran for months and
    // a case that closed in a minute no longer draw from the same distribution.
    const over = Math.max(0, Math.log2(felt / CHANNEL_MEDIAN_HOURS[c]));
    let k = Math.floor(Math.log(1 - rand()) / LOG_1_MINUS_P) + 1 + isEscalated + Math.round(0.35 * over);
    if (k > 8) k = 8;

    // Handling time — the work, as against the wait. The two are barely related
    // in a real system, and that is the point of carrying both.
    let mins = HANDLING_MEDIAN_MIN[c] * TOPIC_HOURS[t] * (1 + 0.35 * (k - 1)) * Math.exp(0.5 * gaussian(rand));
    if (mins < 1) mins = 1;
    if (mins > 600) mins = 600;

    const reopenedCase = !open && rand() < 0.03 + 0.04 * (k >= 4 ? 1 : 0) + 0.10 * isEscalated ? 1 : 0;

    const latent = 4.15
      - 0.5 * Math.log2(felt / CHANNEL_MEDIAN_HOURS[c])
      - 0.85 * isEscalated
      - 0.5 * reopenedCase
      + CHANNEL_SAT[c]
      + 0.35 * skill
      - 0.3 * Math.log2(LOAD[day])
      + (ty === AGENT ? 0.15 : 0)
      + 1.25 * gaussian(rand);
    let score = 1;
    for (const cut of SCORE_CUTS) if (latent > cut) score++;
    // Who answers a survey is not a coin toss: the delighted and the furious
    // both answer, the indifferent do not, and nobody answers one by post.
    const pResponse = RESPONSE_BASE[c] * (0.8 + 0.4 * Math.min(1, Math.abs(latent - 3.6) / 1.6));
    const surveyed = rand() < pResponse;

    // Time of day: a morning peak, an afternoon peak, and an evening tail that
    // only the self-service channels have. A letter has no time at all.
    let hr = rand() < 0.55 ? 10.4 + 1.6 * gaussian(rand) : 15.2 + 2.0 * gaussian(rand);
    if ((c === WEBCHAT || c === WEBFORM) && rand() < 0.12) hr = 21 + 2 * gaussian(rand);
    if (c === PHONE) hr = Math.max(8, Math.min(17.98, hr));
    else hr = Math.max(0, Math.min(23.98, hr));

    const h = open ? NaN : Math.round(Math.min(duration, HOURS_CLIP) * 10) / 10;
    channel[i] = c; priority[i] = p; team[i] = tm; adviser[i] = ad;
    status[i] = open; escalated[i] = isEscalated; reopened[i] = reopenedCase;
    hours[i] = h;
    waiting[i] = open ? Math.round(elapsed / 24 * 10) / 10 : NaN;
    // Judged on the published hours, not on the raw duration, so the column
    // agrees with the column next to it.
    sla[i] = open ? (elapsed > SLA_TARGET_HOURS[c] ? 1 : 2) : (h <= SLA_TARGET_HOURS[c] ? 0 : 1);
    contacts[i] = k;
    handling[i] = Math.round(mins);
    satisfaction[i] = open || !surveyed ? NaN : score;
    hourOpened[i] = c === POST ? NaN : Math.round(hr * 100) / 100;
  }

  const townOf = (i: number) => cPlace[customer[i]];
  const region = Int32Array.from(customer, (cu) => UK_PLACES[cPlace[cu]].region);
  const town = Int32Array.from(customer, (cu) => cPlace[cu]);
  const areaType = Int32Array.from(customer, (cu) => cArea[cu]);
  const ageBand = Int32Array.from(customer, (cu) => cAge[cu]);
  const custType = Int32Array.from(customer, (cu) => cType[cu]);
  const language = Int32Array.from(customer, (cu) => cLang[cu]);
  const supportNeeds = Int32Array.from(customer, (cu) => cSupport[cu]);
  const lon = Float32Array.from(customer, (cu) => cLon[cu]);
  const lat = Float32Array.from(customer, (cu) => cLat[cu]);

  const caseRef = (i: number) => `CS-25-${String(i + 1).padStart(6, '0')}`;
  const SUBJECT_PREFIX = ['Call', 'Chat', 'Form', 'Letter'];

  const columns: Record<string, Column> = {};
  columns.Case = derivedText('Case', caseRef);
  if (cName) columns.Customer = derivedText('Customer', (i) => cName[customer[i]]);
  columns.Postcode = derivedText('Postcode', (i) => cPostcode[customer[i]]);
  columns.Subject = derivedText('Subject', (i) =>
    `${SUBJECT_PREFIX[channel[i]]}: ${REASONS[reason[i]]}${contacts[i] >= 4 ? ' — chasing' : ''}`);
  columns.Topic = categoryFromCodes('Topic', topic, TOPICS.slice());
  columns.Reason = categoryFromCodes('Reason', reason, REASONS.slice());
  columns.Channel = categoryFromCodes('Channel', channel, CHANNELS.slice());
  columns.Priority = categoryFromCodes('Priority', priority, PRIORITIES.slice());
  columns.Region = categoryFromCodes('Region', region, REGIONS.slice());
  columns.Team = categoryFromCodes('Team', team, TEAMS.slice());
  columns.Adviser = categoryFromCodes('Adviser', adviser, ADVISERS.slice());
  columns.Status = categoryFromCodes('Status', status, STATUSES.slice());
  columns.Escalated = categoryFromCodes('Escalated', escalated, ESCALATED.slice());
  columns.Reopened = categoryFromCodes('Reopened', reopened, REOPENED.slice());
  columns['Within SLA'] = categoryFromCodes('Within SLA', sla, SLA_STATES.slice());
  columns.Month = categoryFromCodes('Month', month, MONTHS.slice());
  columns['Customer type'] = categoryFromCodes('Customer type', custType, CUSTOMER_TYPES.slice());
  columns['Age band'] = categoryFromCodes('Age band', ageBand, AGE_BANDS.slice());
  columns['Area type'] = categoryFromCodes('Area type', areaType, AREA_TYPES.slice());
  columns.Language = categoryFromCodes('Language', language, LANGUAGES.slice());
  columns['Support needs'] = categoryFromCodes('Support needs', supportNeeds, SUPPORT.slice());
  columns.Town = categoryFromCodes('Town', town, TOWNS.slice());
  // Longitude/Latitude are the first numeric columns so the raw Scatter opens on the map.
  columns.Longitude = numeric('Longitude', lon, (v) => v.toFixed(3));
  columns.Latitude = numeric('Latitude', lat, (v) => v.toFixed(3));
  columns['Resolution hours'] = numeric('Resolution hours', hours, (v) => `${v.toFixed(1)} h`);
  columns['Days waiting'] = numeric('Days waiting', waiting, (v) => `${v.toFixed(0)} d`);
  columns.Satisfaction = numeric('Satisfaction', satisfaction, (v) => `${v.toFixed(0)} / 5`);
  columns.Contacts = numeric('Contacts', contacts, (v) => v.toFixed(0));
  columns['Handling minutes'] = numeric('Handling minutes', handling, (v) => `${v.toFixed(0)} min`);
  columns['Prior cases'] = numeric('Prior cases', prior, (v) => v.toFixed(0));
  columns.Opened = numeric('Opened', opened, formatDayOfYear);
  columns['Hour opened'] = numeric('Hour opened', hourOpened, (v) => {
    const h = Math.floor(v);
    return `${String(h).padStart(2, '0')}:${String(Math.round((v - h) * 60)).padStart(2, '0')}`;
  });

  // The card title is the person; the case ref is shown separately by the card
  // and the detail view. Without a name source (a caller that did not pass
  // faker — the tests do this) the reference is the identity.
  const labelColumn = cName ? 'Customer' : 'Case';

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
      blurb: (i: number) => `${cPostcode[customer[i]]} · ${TOWNS[townOf(i)]}`,
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
      subtitle: (i: number) => `${caseRef(i)} · ${TOWNS[townOf(i)]}`,
      context: ['Channel', 'Topic', 'Priority'],
      actions: [
        { id: 'review', label: 'Review action', primary: true },
        { id: 'reassign', label: 'Reassign' },
        { id: 'note', label: 'Add note' },
      ],
    },
  };
}
