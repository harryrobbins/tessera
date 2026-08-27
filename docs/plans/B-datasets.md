# Plan B — Synthetic tax / financial / customer-service datasets

## Findings (file:line)

- `src/data/columnar.ts:31-45` — `Dataset { name, n, columns, labelColumn, facets, rgb?, cards? }`. Numeric = `Float32Array` (+ optional `format`), category = `Int32Array` codes + `categories[]`, text = `string[]`. `categoryFromCodes` (line 80) preserves the category order you pass — use it for ordered levels (Low/Standard/High, Jan..Dec); `category()` (line 62) orders by first appearance and must not be used for ordered levels.
- `src/data/products.ts:150-334` — the reference generator: `PRODUCT_SIZES` sweep, private `mulberry32`/`gaussian`/`hash01`, cumulative-weight tables built once per category, per-row loop writing typed arrays only, a text label column only when `n <= 50_000`, `name` includes the row count.
- `src/data/titanic.ts:342-358` — duplicates `mulberry32`/`gaussian`; `tests/helpers/prng.ts` duplicates them a third time.
- `src/app.ts:380-387` — `loadByKey` is a three-branch `if` on key prefixes. Replace with a registry.
- `src/app.ts:112-132` — `loadDataset`: default `colorBy = firstCategorical(ds)` (first facet with 2..8 categories, because `categoricalColor` at `src/core/palette.ts:31-34` folds slot >= 8 to grey). `defaultSort` = colorBy; `defaultBucket` = first categorical; `defaultAxisY` = first numeric facet. **Default colour/sort/bucket/axes are entirely determined by facet order.**
- `src/app.ts:165-223` — `buildCards`: per-row cards only when `n <= atlas.capacity`; above that one template card per category of `colorBy`. `cardSpec`: title = `labelColumn`, subtitle = colorBy value, `fields` = first two facets that are not the label, `badge` = the third.
- `src/main.ts:45-51` — dataset `<select>` built inline from `PRODUCT_SIZES` and `PIXEL_IMAGES`; `main.ts:274-289` `load()` with a hard-coded toast; `main.ts:362` boot honours `?dataset=<key>` (workstream C can deep-link).
- `src/layout/layouts.ts:68-92` — Bars/Cross-tab bin numerics into 12 **equal-width** bins over `[min,max]`. Heavy-tailed columns must be clipped to a readable range at generation time.
- `src/ui/facets.ts:94-97` — facet panel shows the top 24 categories per facet.
- `src/bench/bench.ts:107-108` — bench targets are `titanic` + `products:N`; untouched.
- `vitest.config.ts` — node environment; generators are pure TS, test directly. `vite-node` ships with vitest.
- `tsconfig.json` — `noUnusedLocals: true`, `include: ["src","tests","scripts"]`.

## Dataset designs

Common rules: generated in-browser, `generateX(n, seed = <fixed>)`, one `mulberry32(seed)` stream consumed in fixed order per row; structure tables are constants or built from an **integer hash** (not `Math.sin` — not bit-identical across engines); categories via `categoryFromCodes` with a fixed order; text id column only when `n <= 50_000`; bucketable numerics clipped so 12 equal-width bins read well; `name` = `"<Label> (<n>)"`.

Shared helper module `src/data/random.ts`: `mulberry32`, `gaussian`, `lognormal(rand, mu, sigma)`, `pickCum(rand, cum, offset, count)`, `cumulative(weights)`, `hashU32(i, salt) -> [0,1)`. `products.ts` and `titanic.ts` import from it (identical bodies, identical streams).

### D1 — Tax customer-service cases (the onboarding dataset; FROZEN contract for workstream C)

- **Key prefix:** `tax-cases`; **sizes:** `[900, 5_000, 20_000, 100_000]`; **onboarding key: `tax-cases:5000`**; deep link `?dataset=tax-cases:5000`.
- **Module:** `src/data/taxCases.ts`, `generateTaxCases(n, seed = 11)`, `TAX_CASE_SIZES`.
- **`name`:** `Tax customer service (5,000)`. **`labelColumn`:** `Case` when `n <= 50_000`, else `Topic`.

| Column | Kind | Values / distribution |
|---|---|---|
| `Case` | text | `CS-25-000001` … zero-padded 6 digits (only n ≤ 50k) |
| `Topic` | category (6) | `Self Assessment` 30%, `PAYE` 22%, `VAT` 18%, `Tax Credits` 14%, `Corporation Tax` 9%, `Payments & Refunds` 7% |
| `Channel` | category (4) | `Phone` 45%, `Webchat` 25%, `Web form` 20%, `Post` 10% |
| `Priority` | category (3, ordered) | `Low` 55%, `Standard` 35%, `High` 10% (High more likely for VAT/Corporation Tax/Payments & Refunds) |
| `Region` | category (8) | `London`, `South East`, `South West`, `Midlands`, `North West`, `North East & Yorkshire`, `Scotland`, `Wales & NI` — weights 17/17/10/17/13/14/8/4 |
| `Team` | category (6) | `Personal Tax`, `Business Tax`, `Benefits & Credits`, `Debt & Payments`, `Digital Support`, `Complaints` — chosen by Topic (SA/PAYE→Personal Tax 80%; VAT/CT→Business Tax 85%; Tax Credits→Benefits & Credits 90%; Payments & Refunds→Debt & Payments 80%; Web form/Webchat leak 10% to Digital Support; escalated 30%→Complaints) |
| `Status` | category (2) | `Resolved` ~82%, `Open` ~18% (Open more likely for Post and late-year cases) |
| `Escalated` | category (2) | `No`, `Yes` — base 5%, ×2.5 High priority, ×1.6 VAT/CT, ×0.6 Webchat → ~7% |
| `Month` | category (12, ordered) | `Jan` … `Dec` derived from `Opened` |
| `Resolution hours` | number, 1dp, clipped [0.1, 240] | lognormal: median by Channel (Webchat 0.4h, Phone 0.8h, Web form 30h, Post 110h) × Topic factor (VAT 1.4, CT 1.5, Tax Credits 1.2) × Priority (High 0.6, Low 1.2) × Escalated 3.0; σ 0.6; **NaN when Open** |
| `Satisfaction` | number, 1..5 | 3.9 − 0.45·log2(hours/channel median) − 0.9·escalated + channel offset (Webchat +0.3, Post −0.4) + N(0,0.7), rounded/clamped; **NaN for Open and 25% of resolved** |
| `Contacts` | number, 1..8 | geometric(p=0.55) + 1 escalated + 1 Post |
| `Opened` | number, 1..365 | day-of-year 2025, `format: d => "12 Mar"`; seasonality: SA peaks 15 Jan–5 Feb and mid-Oct; Tax Credits peaks Jul; PAYE 1–20 Apr; VAT bumps first 10 days of Jan/Apr/Jul/Oct; weekends ×0.35 |

- **`facets` (order drives defaults):** `['Topic','Channel','Priority','Region','Team','Status','Escalated','Month','Resolution hours','Satisfaction','Contacts','Opened']`.
- **Resulting defaults:** colour = `Topic`, sort = `Topic`, Bars by `Topic`, Cross-tab `Topic` × `Resolution hours`, Scatter `Resolution hours` × `Satisfaction`, card fields `Topic`, `Channel`, badge `Priority`.
- **Stories:** Bars by `Month` → January SA spike; Cross-tab `Channel` × hours → Post far right; Scatter hours vs satisfaction slopes down; colour by `Escalated` clusters in high-hours buckets; facet `Team` filters cleanly by `Topic`.
- Neutral content: no named organisation, no personal data, plain-English names.

### D2 — Self-assessment tax returns

- Key prefix `tax-returns`; sizes `[900, 10_000, 100_000, 1_000_000]`; `src/data/taxReturns.ts`, `generateTaxReturns(n, seed = 23)`, name `Tax returns (…)`, label `Return` = `SA-24-000001` (≤50k) else `Sector`.
- Columns: `Sector` (8: Retail, Construction, Professional services, Health & care, Hospitality, IT & digital, Property, Transport); `Income band` (7 ordered: `Under £12.5k`, `£12.5k–25k`, `£25k–50k`, `£50k–100k`, `£100k–150k`, `£150k–500k`, `Over £500k`); `Filing month` (10 ordered: Apr…Jan, Feb, Mar; mass in Dec–Jan); `Filed` (`On time`, `Late` — Late iff after Jan; base 9%, ×1.8 Construction/Hospitality, ×1.6 lowest band, ×0.5 agent-filed); `Filing method` (`Online` 96%, `Paper` 4%); `Agent filed` (`No`, `Yes` ~45%); `Outcome` (`Refund`, `Owed`, `Nil`); `Tax year` 2020–2024; `Income` £ lognormal per sector (median £28k–£65k) clipped [0, £250k]; `Tax due` £ piecewise progressive (0/20/40/45) ± noise clipped [0, £100k]; `Balance` £ negative = refund, clipped [−£5k, £20k]; `Penalty` £ ∈ {0, 100, daily, 5% tax-geared} clipped [0, £3k], 0 when on time.
- facets: `['Filed','Sector','Income band','Filing month','Outcome','Agent filed','Filing method','Income','Tax due','Balance','Penalty','Tax year']` → colour `Filed`, cross-tab `Filed` × `Income`, scatter `Income` × `Tax due`.

### D3 — Card payments

- Key prefix `payments`; sizes `[900, 10_000, 100_000, 1_000_000]`; `src/data/payments.ts`, `generatePayments(n, seed = 31)`, name `Card payments (…)`, label `Transaction` = `TX-000001`.
- Columns: `Merchant category` (8: Groceries, Restaurants, Fuel, Travel, Online retail, Utilities, Entertainment, Health); `Method` (5: Contactless, Chip & PIN, Online, Mobile wallet, Bank transfer; mix by category); `Country` (12: United Kingdom 82%, Ireland, France, Spain, United States, Germany, Italy, Netherlands, Portugal, Greece, UAE, Other); `Where` (`Domestic`, `Abroad`); `Day` (Mon..Sun); `Outcome` (`Approved`, `Declined`); `Fraud` (`Legitimate`, `Flagged` — base 0.6%, ×4 Online, ×3 Abroad, ×2.5 00:00–05:00, ×2 amount > £500 → ~1.5%); `Amount` £ lognormal per category clipped [0.5, 1000]; `Hour` 0–23 bimodal; `Risk score` 0–100 logistic of the fraud drivers + noise.
- facets: `['Merchant category','Method','Where','Fraud','Outcome','Country','Day','Amount','Risk score','Hour']`.

### D4 — Supplier invoices (optional, last)

- Key prefix `invoices`; sizes `[900, 10_000, 100_000]`; `src/data/invoices.ts`, `generateInvoices(n, seed = 41)`, label `Invoice` = `INV-2025-000001`.
- Columns: `Department` (8), `Spend category` (8: Software, Consultancy, Travel, Hardware, Utilities, Office, Training, Maintenance), `Supplier` (~36 names from two word lists, each pinned to one category), `Quarter` (4), `Status` (Paid, Outstanding, Overdue, Disputed), `Paid late` (2), `Amount` £ clipped [£20, £50k], `Days to pay` 0–120 (NaN unless Paid), `Month` 1–12 formatted as name.
- Only if D1–D3 land cleanly.

## Registry / UI changes

1. **`src/data/registry.ts` (new)**:
   ```ts
   export interface DatasetFamily {
     prefix: string; label: string; sizes: readonly number[];
     load: (size?: number) => Dataset | Promise<Dataset>;
     buildingNoun?: string;
   }
   export const FAMILIES: DatasetFamily[];
   export function menuEntries(): { key: string; label: string; group?: string }[];
   export function resolveDataset(key: string): Promise<Dataset>;
   export function describeKey(key: string): string;
   ```
   Keys stay `prefix` or `prefix:size` (pixels keep `pixels:image:size`; expose `parseKey`). Unknown key → titanic.
2. **`src/app.ts`** — delete `loadByKey`; `loadDataset` calls `resolveDataset(key)`; remove unused imports (keep `PIXEL_IMAGES` re-export for `main.ts`, or move that import).
3. **`src/main.ts`** — build the menu from `menuEntries()` with `<optgroup>` per family; toast from `describeKey(key)`.
4. **`index.html`** — no change.
5. Per-dataset `Dataset.defaults` — considered and rejected; facet ordering yields the intended defaults. Workstream C must not depend on such a field.
6. **README** — extend the Datasets row and Data section.

## Steps

1. `src/data/random.ts` (new); `products.ts` and `titanic.ts` import from it (no behaviour change).
2. `src/data/taxCases.ts` (new): D1 exactly as specified. Precompute cum tables; row loop draws in fixed order: topic, channel, priority, region, opened-day, escalated, status, team, hours, contacts, satisfaction.
3. `src/data/registry.ts` (new) with titanic, products, tax-cases, pixels.
4. `src/app.ts` swap `loadByKey` for `resolveDataset`; `src/main.ts` menu + toast. `pnpm typecheck`.
5. `tests/datasets.test.ts` + `tests/registry.test.ts` (contract test pinning D1 column names/orders for workstream C).
6. `src/data/taxReturns.ts`, `src/data/payments.ts` + entries + tests.
7. `src/data/invoices.ts` (optional).
8. Optional `scripts/export-csv.ts` via `vite-node` if present in `node_modules/.bin`; `"export:csv"` script; refuse pixel keys; don't commit CSVs.
9. README; `docs/PROGRESS.md`.

Critical path for C: 1→2→3→4→5 (C only needs `tax-cases:5000` loading in the UI). Announce on the bus as soon as that lands.

## Verification

- `pnpm typecheck`, `pnpm test` green; add a test pinning `generateProducts(1000)` first-10 `Value` values captured before the refactor.
- Determinism: same seed twice → typed arrays `toEqual`; different seed changes a column.
- Marginals at n = 20,000 (±2.5 pts): D1 Topic/Channel shares, Escalated 5–10%, Open 12–24%; Satisfaction ∈ {1..5} or NaN iff Open/unsurveyed; hours NaN iff Open; Opened ∈ [1,365]; Month code === month of Opened.
- Correlations (D1): mean hours Post > Web form > Phone > Webchat; satisfaction(Escalated) < (No) by ≥ 0.5; SA share in Jan ≥ 1.5× Jun; Benefits & Credits ≥ 80% of Tax Credits cases.
- D2: late 7–14%; Penalty > 0 iff Late; Spearman(Income, Tax due) > 0.9. D3: Flagged 0.8–2.5%; Abroad flagged ≥ 2× Domestic; Risk score mean flagged > legitimate + 25.
- Performance (soft): `generateTaxCases(100_000)` < 150 ms; `generatePayments(1_000_000)` < 1.5 s.
- Manual: `?dataset=tax-cases:5000` — colour Topic, Bars by Month shows January peak, Scatter opens on hours × satisfaction, facet Team; `tax-cases:900` shows per-row cards with `CS-25-…` titles and Priority badge.

## Risks

- Equal-width binning vs heavy tails — clip at generation; comment the clip.
- Palette cap of 8 — default-colour columns ≤ 8 categories; `Country`, `Supplier`, `Month` sit after a ≤8 column.
- Engine-dependent maths — tests assert determinism within one engine and marginals with tolerance; structure tables use integer hashing.
- Workstream C coupling — D1 table frozen, covered by `tests/registry.test.ts`.
- Registry refactor touches `app.ts` (workstream A is also editing it — targeted edits only).
- Menu length — `<optgroup>`.
- Memory at 1M rows — no text columns above 50k.

## Addendum (lead, 2026-08-26 ~23:45) — geography & demographics for D1 (workstream E)

User request: visualise customers by lat/lon so they cluster around UK cities and towns
("the UK at night"); each customer has a postcode; engineer rural→phone / urban→online
and older→less-digital correlations. Additive to the frozen D1 columns.

New D1 columns (implemented in `src/data/taxCases.ts` + `src/data/ukPlaces.ts`):

| Column | Kind | Values |
|---|---|---|
| `Customer` | text (≤50k) | synthetic full name — **faker `en_GB`, seeded** (user: no real people) |
| `Postcode` | text (≤50k) | `G12 8QQ` style; outward area matches the town (G, EH, M, B, …), inward random |
| `Town` | category (many) | the settlement drawn from `ukPlaces.ts` (~150–250 UK places, approx lat/lon, population weight) |
| `Age band` | category, ordered | `18–29`, `30–44`, `45–59`, `60–74`, `75+` |
| `Area type` | category | `Urban`, `Suburban`, `Rural` (from jitter radius + place size) |
| `Longitude`, `Latitude` | number, 3dp | place lat/lon + gaussian jitter, sigma ∝ population; rural points jitter around small places, never uniform over the bounding box (no customers at sea) |

Facet order now: Topic, Channel, Priority, Region, Team, Status, Escalated, Month,
Age band, Area type, Town, **Longitude, Latitude**, Resolution hours, Satisfaction,
Contacts, Opened — so `Longitude × Latitude` are the default Scatter axes (the map).

Correlations: Rural → Phone/Post ↑, Urban → Webchat/Web form ↑; older bands → Phone/Post,
younger → Webchat. Tests: lon ∈ [−8.2, 1.8], lat ∈ [49.9, 60.9]; phone share rural > urban;
digital share 75+ < 18–29.

Also (user feedback): **Titanic removed** — it used real passengers' names. `tax-cases:5000`
becomes the default collection; bench targets switch to `tax-cases:900`.

Equal-aspect map projection, "night lights" styling, the customer card and the detail
view are workstream E (`docs/plans/E-customer-journey.md`).
