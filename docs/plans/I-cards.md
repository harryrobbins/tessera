# Plan I — Cards: one record per card, a quieter face, an expanded modal

Written 2026-08-27 against the working tree (A–H landed, uncommitted; G's perf
pass in flight). Read-only research: every claim about today's behaviour carries
a `file:line`. Nothing was edited to write this.

The complaint, verbatim:

> Each card on the board should be a unique case — currently there is a lot of
> duplication and a lot of noise. A data set should be able to define just a few
> key things for each record — Title, topic, description and a couple of tags
> maybe — once you click on a card the fuller pop out bit should be an expanded
> version of the card […] Perhaps a dataset should provide a template for both
> the small card and expanded modal, and perhaps a custom card should be allowed
> (maybe keep one of these noisy ones which works for smaller datasets).

Two separate faults, one visible symptom. Both are fixed here.

---

## 0. Root cause

**The duplication.** `PivotApp.buildCards` (`src/app.ts:273`) decides at
`src/app.ts:293`:

```ts
const perItem = ds.n <= hiResCapacity(atlasSize, 64, ATLAS_PAD);   // 3,136 at 4096²
```

Above that ceiling it stops drawing one card per row. `src/app.ts:313-319`
builds **one `CardSpec` per category** of the colour-by field, `src/app.ts:325`
points every instance's `slotOf` at its category's slot, and `src/app.ts:327`
sets `specOf = (i) => templates[this.slotOf[i]]`. Every PAYE row therefore
samples the identical PAYE texture. The screenshot is `tax-cases:100000`
(100,000 × 22 % PAYE ≈ 21,874 — the number printed on both PAYE cards).

**Why zooming in does not rescue it.** The hi-res pass exists precisely to
re-rasterise what is on screen (`src/app.ts:441` `updateHiRes`), but two things
stop it here:

1. `hiResTier(cardPx, atlas.slot)` (`src/gl/atlas.ts:62`) returns `null` until
   `cardPx > base`. In category mode the base slot is `slotFor(cats.length)`
   (`src/app.ts:298`) — **1024** for six topics — so the pass never engages
   below 1024 device pixels.
2. Even if it did, it rasterises `this.specOf(card)` (`src/app.ts:481`), which
   in category mode *is the template*. It would redraw the same aggregate card,
   larger.

**The noise.** `taxCasePainter` (`src/gl/cards/taxCase.ts:186-190`) branches on
`spec.row !== undefined`. With no row it calls `templateContent`
(`src/gl/cards/taxCase.ts:150`), which fills all nine painted elements with the
*category's* aggregates: count, top-two channel shares, % high, % open, mean
satisfaction, mean contacts, median hours, % escalated, and a bar at the median.
That is a defensible thing to have written — it beats placeholder dashes — but
it is a dashboard tile wearing a card's clothes, and there are 100,000 of them.

Separately, even the *correct* per-row card is too dense: at `full` density
`src/gl/cards/layout.ts:102-125` lays out topic, case ref, name, address, chips,
five stars, contacts, opened line, hours bar and bar label — ten elements for
one record.

**One line:** above 3,136 rows the atlas holds one card per *category*, so every
card in a group is the same texture, and the painter fills it with the group's
statistics because there is no row to show.

---

## 1. Uniqueness

### 1.1 The decision

Every card on the board is its own record **from the moment per-row art is
resolvable at all**, and never before. Three tiers, keyed to on-screen size:

| card width (device px) | what is drawn | where it comes from |
|---|---|---|
| `< 3` (map: `< 14`) | flat tinted quad, no texture at all | fragment shader LOD, `src/gl/shaders.ts:103`, `src/app.ts:544` |
| `3 – T` | **base atlas art**: the row's own card when `n ≤ 3,136`, otherwise a *group cover* (§1.5) | base `CardAtlas`, painted once per rebuild |
| `≥ T` | **the row's own card**, rasterised on demand | hi-res atlas LRU (`src/gl/hires.ts` + `src/app.ts:441`), extended |

`T` is **not a constant**. It is derived per frame as the smallest card size at
which the hi-res atlas can hold *every card in the viewport at once* (§1.3). On
a 3840×2160 drawing buffer with a 4096² hi-res texture, `T ≈ 52` device px; on a
1280×720 buffer with a 2048² texture, `T ≈ 69`. A hard floor of
`UNIQUE_MIN_PX = 48` short-circuits the arithmetic on tiny buffers.

This reuses the existing hi-res mechanism rather than inventing a second one.
The changes to it are: the tier decision (§1.3), row-identified specs (§1.4),
an atomic commit (§1.6) and a pixel budget instead of a card budget (§1.7).

### 1.2 Why per-row art below `T` is not worth having

The fragment shader mixes the atlas in with
`texMix = smoothstep(u_lod.x, u_lod.y, v_px)` (`src/gl/shaders.ts:103`), and
`u_lod` is `[3, 9]` off the map, `[14, 32]` on it (`src/app.ts:544`). So:

- Below 3 device px there is **no texture sampled at all**. Uniqueness is
  literally unrepresentable; the card is `v_color`, which is already per-row.
- Between 3 and 9 px the texture is blended in at 0–100 % over a card 3–9 pixels
  wide. Nothing but the accent band and the overall value can survive.
- At `T ≈ 52` device px, the base slot art (64 px, `slotFor` floor at
  `src/gl/atlas.ts:52-58`) is being shown at 0.8×. Its smallest run is the 9 px
  floor (`FONT_FLOOR`, `src/gl/cards/layout.ts:66`), landing at ~7 device px on
  screen — right at the edge of where a glyph resolves. Above `T`, text starts
  to read, and identity starts to matter.

So the fallback template is only ever visible where **no line of text on it can
be read**. That is the honest answer to "never show two identical cards side by
side": between 3 and `T` device px, two neighbours in the same category are two
tiles of the same colour with the same letterform — which is *true*, because
they are in the same category — and nothing on them claims to be a record.

### 1.3 The capacity-fitted tier (the load-bearing bit)

Today the tier is `min(1024, nextPow2(ceil(cardPx)))` (`src/gl/atlas.ts:62-65`)
with no reference to how many cards need one. That is safe when the fallback is
the row's own base art (per-item collections) and unsafe when the fallback is a
group cover, because a partially-filled plan puts unique cards next to duplicate
ones — worse than either.

Slot counts, from `hiResCapacity(size, slot, 4)` (`src/gl/atlas.ts:42`):

| tier | 4096² texture | 2048² texture |
|---|---|---|
| 64 | 56² = **3,136** | 28² = 784 |
| 128 | 30² = **900** | 15² = 225 |
| 256 | 15² = **225** | 7² = 49 |
| 512 | 7² = 49 | 3² = 9 |
| 1024 | 3² = 9 | 1 |

Cards on a 3840×2160 buffer at width `p`: `8,294,400 / p²`. At `p = 96` that is
900 — exactly the tier-128 capacity. At `p = 129` it is 499, and today's rule
would ask for tier 256, which holds 225. **Today's rule is over capacity for
most of the zoom range**; it only works because the leftovers keep unique base
art.

New rule, a pure function so vitest can own it:

```ts
// src/gl/hires.ts
export const UNIQUE_MIN_PX = 48;

/**
 * The raster tier for a plan that must cover `visible` cards, or null when no
 * tier can. Never larger than the card is drawn (no wasted texels) and never
 * larger than the atlas can hold the whole viewport at (no mixed art).
 */
export function planTier(cardPx: number, visible: number, hiSize: number, pad = 4, max = 1024): number | null {
  if (!(cardPx >= UNIQUE_MIN_PX) || visible <= 0) return null;
  let t = Math.min(max, Math.max(64, nextPow2(Math.ceil(cardPx))));
  while (t > 64 && hiResCapacity(hiSize, t, pad) < visible) t >>= 1;
  return hiResCapacity(hiSize, t, pad) >= visible ? t : null;
}
```

Worked, 4096² texture, 3840×2160 buffer:

| `cardPx` | visible | tier chosen | upscale |
|---|---|---|---|
| 48 | 3,600 | none (3,136 < 3,600) → base art | — |
| 52 | 3,067 | 64 | 0.81× |
| 64 | 2,025 | 64 | 1.00× |
| 80 | 1,296 | 64 (128 holds only 900) | 1.25× |
| 96 | 900 | 128 | 0.75× |
| 129 | 499 | 128 | 1.01× |
| 300 | 92 | 256 | 1.17× |
| 1040 | 8 | 1024 | 1.02× |

The cost of the rule is at most a 1.5× upscale in a narrow band above each power
of two. The hi-res texture already carries three mip levels and 4× anisotropy
(`src/gl/renderer.ts:353-364`), so that band is soft, not aliased. **Correct
record, slightly soft, beats crisp and wrong.**

**Per-item collections keep today's rule exactly.** `planTier` is only consulted
when the base atlas is *not* per-row. For `n ≤ 3,136` the existing
`hiResTier(cardPx, atlas.slot)` path is untouched, which is what protects
`scripts/verify-hidpi.mjs` and `scripts/verify-card.mjs`'s sharpness numbers.

### 1.4 Row-identified specs

`specOf` (`src/app.ts:78`, set at `:310` / `:327`) becomes unconditional:

```ts
// src/app.ts, buildCards(), replacing the two assignments at :310 and :327
this.specOf = (i) => this.cardSpec(ds, i);      // always the row, never a template
this.coverOf = (slot) => covers[slot] ?? covers[0];   // base atlas art in category mode
```

`updateHiRes` (`src/app.ts:441`) therefore rasterises `this.specOf(card)` — a
real row — whatever the collection size. `cardSpec` (`src/app.ts:334`) already
sets `row: i`, so `taxCasePainter` (`src/gl/cards/taxCase.ts:188`) takes the
`recordContent` branch and never the template branch.

### 1.5 What happens to the aggregate card

It **goes, as a card**, and its content survives in one place where it is true.

- The base atlas in category mode paints a **group cover**, not a card: the
  category's accent filling the slot, a 2 px inset frame one step darker, the
  category's initials at 40 % of the slot height, and — at slots ≥ 256 px — the
  category name across the foot at 8 %. No counts, no percentages, no bar.
  A cover is a *label*; it cannot be mistaken for a record at any size, which is
  the whole point.
- The aggregates move to the modal's **Context** section (§4.4): "Post — 10 % of
  the 3,000 cases on screen". That is the same information, attached to a record
  it is actually about, computed against the current filter rather than the
  whole collection.
- `templateContent` and `aggregateFor` (`src/gl/cards/taxCase.ts:117-184`) are
  **deleted**. That also removes an `O(n)` pass from every colour change: today
  `aggregateFor` walks all `n` rows the first time a template is painted, which
  on `tax-cases:100000` runs on every `setColorBy` (`src/app.ts:407-414` →
  `buildCards`).

### 1.6 Never two identical cards side by side

The invariant, enforced in `updateHiRes`:

> When the base atlas is not per-row, the hi-res plan is **atomic**: either every
> card whose rect intersects the viewport (margin 0) samples the hi-res atlas, or
> none of them do.

Implementation: keep rasterising into the hi-res texture across ticks as today
(`src/app.ts:488-503`), but **do not flip the instances** while the plan is
incomplete. `setUv`/`setHi`/`uploadStyleAt` move out of the per-card loop into a
commit step that runs once, when every card in `wanted` has a slot. Until then
the board shows uniform group covers; on commit it shows uniform records. The
transition is one frame, and it is a *fade* rather than a pop because the LOD
mix and the mip chain both change smoothly with the same `v_px`.

For per-item collections the plan stays incremental (`atomic = false`): the
fallback there is the row's own base art, so a partial plan means "some cards are
sharper than others", which is what already ships and is fine.

### 1.7 Budgets

| thing | today | after | budget |
|---|---|---|---|
| Canvas2D per tick | `HIRES_BUDGET = 24` cards, i.e. 25 Mpx at tier 1024 (`src/app.ts:39`) | `HIRES_PIXEL_BUDGET = 4_194_304` px (4 cards at 1024, 256 at 128, 1024 at 64) | **≤ 4 ms p50, ≤ 6 ms p95** of main-thread raster per tick |
| full-screen fill at tier 64 | n/a | 2,025 cards × 4,096 px = 8.3 Mpx = 2 ticks | **≤ 12 ms wall** from settle to committed plan |
| commit upload | per-card `uploadStyleAt` (16 B) | one `uploadStyle()` when > 256 cards changed, else per-card (`src/gl/renderer.ts:268,280`) | **≤ 6 ms at 1,000,000 rows** (16 MB orphaned upload), once per settle |
| base atlas rebuild | per-item: `n` cards; category: `cats` cards + an `O(n)` aggregate pass | per-item unchanged; category: `cats` covers, no `O(n)` pass | **≤ 40 ms at 3,000 rows** (plan E's number, unchanged) |
| VRAM | base 4096² + mips ≈ 85 MB; hi-res 4096² + mips ≈ 85 MB when magnified | identical sizes | **no increase in peak.** The change is *frequency*: the hi-res texture is now resident whenever cards are ≥ `T`, not only when magnified past the base slot |
| pick / hover | `renderer.pick` is `O(n)` (`src/gl/renderer.ts:490`) | unchanged; hover gated to `n ≤ 200,000` (§6.1) | **≤ 0.5 ms per pointer move** |

The pixel budget is a *reduction* in worst-case hitch: today's 24 cards at tier
1024 is 25 Mpx in one tick.

### 1.8 Alternatives considered and rejected

- **8192² base atlas.** 12,769 slots at 64 px; 256 MB + mips ≈ 340 MB VRAM for
  4× the rows, still two orders of magnitude short of 1,000,000.
  `renderer.atlasSize = Math.min(4096, maxTextureSize)` (`src/gl/renderer.ts:98`)
  is a deliberate cap. **Rejected: memory, and it does not solve the problem.**
- **`TEXTURE_2D_ARRAY` layers.** WebGL2 guarantees ≥ 256 layers, so the texel
  budget is reachable; a layer index fits in the spare `a_meta.z`
  (`src/gl/renderer.ts:251`). But the atlas still has to be *painted*: 100,000
  cards at 64 px is 400 Mpx of Canvas2D, ~400 ms–2 s of blocking work per
  rebuild, and a rebuild happens on every colour change (`src/app.ts:413`).
  **Rejected on build time, before memory even matters.**
- **GPU-side text from an SDF glyph atlas.** Solves everything and costs a
  rewrite of the painter, the layout table and the shader. **Rejected as
  out of scope; noted as the long-term escape hatch if the pixel budget is ever
  missed on a low-end GPU.**
- **Rasterising in a worker via `OffscreenCanvas`.** Would move the 4 ms off the
  main thread and is a clean follow-up (`ImageBitmap` → `texSubImage2D` works
  unchanged). **Deferred:** the budget is met on the main thread, and the repo
  already has exactly one worker; a second one is a cost with no user-visible
  benefit today.
- **Keeping a per-category card but making it obviously a group** (a stack of
  three offset rectangles, "1,530 cases"). Tempting, and it is what the group
  cover almost is — but at 3–52 device px the stack is indistinguishable from a
  card, and above `T` we have real records anyway. **Rejected in favour of the
  flat cover.**

---

## 2. The small card's content model

Markedly quieter: **four lines of identity instead of seven rows of statistics.**

### 2.1 The slots

| slot | what it is for | max | missing |
|---|---|---|---|
| `topic` | the eyebrow in the accent header — the *kind* of record, and what the header colour means | 24 chars, 1 line | header shows the accent and the mark only |
| `mark` | the header tile: a named glyph (`Phone`, `Post`, …) or the title's initials. A *shape* cue, never text you must read | — | initials of `title`; if no title, omitted |
| `title` | the record's identity — the one thing you would say aloud | 40 chars; 1 line compact, 2 lines full | `#<row>` |
| `blurb` | one line of context: where, when, from whom | 48 chars; 1 line compact, 2 lines full | the line is not drawn and the block closes up |
| `tags` | at most **two** chips. `{ text, tone }`, tone ∈ `neutral \| accent \| good \| warn \| bad` | 14 chars each | fewer chips, left-aligned; zero tags draws nothing |
| `metric` | one number with a short label, right-aligned on the foot line | value ≤ 8 chars, label ≤ 12 | omitted |

**Missing values close up; they never leave a gap and never print a placeholder.**
`layoutQuietCard` returns only the runs it will draw and centres the body block
in what remains. Today's `not surveyed` filler
(`src/gl/cards/taxCase.ts:236`) is exactly the wrong instinct at 64 px — absence
should be silence. `—` belongs in the modal, where a labelled empty cell is
informative.

The caps are guidance to dataset authors, enforced at draw time by the existing
`clip()` (`src/gl/atlas.ts:236`) and asserted for the built-in datasets by
`tests/card-template.test.ts` (§7).

### 2.2 Visual hierarchy

```
┌──────────────────────────────┐  0
│▓ [mark]  TOPIC               │  accent header, h·0.26; topic 600 · h·0.075, ink-on-accent
├──────────────────────────────┤  h·0.26
│  Morag Sinclair              │  title 650 · h·0.115, INK, 1–2 lines
│  G12 8QQ · Glasgow           │  blurb 400 · h·0.072, INK_DIM
│                              │
│  ● High   ○ Open             │  tags, h·0.09 tall
│                     5 chased │  metric 500 · h·0.065 right, INK_DIM (full only)
├──────────────────────────────┤
│▓                             │  accent foot rule, max(2, h·0.02)
└──────────────────────────────┘  h
```

Three weights, two inks, one accent. The accent appears exactly twice (header,
foot rule) and the tags carry the only other colour on the card. Everything else
is `INK` / `INK_DIM` (`src/gl/atlas.ts:30-31`).

### 2.3 Density tiers

`densityFor` for the quiet card lives in a **new** `src/gl/cards/quietLayout.ts`
(`layoutTaxCard` and its `densityFor` in `src/gl/cards/layout.ts` are left
untouched, so `tests/cards.test.ts` stays green verbatim):

| density | height | drawn |
|---|---|---|
| `tiny` | `h < 96` | header (topic only, no mark tile — 15 % of 64 px is 10 px and reads as a smudge), title 1 line, **one** tag, foot rule |
| `compact` | `96 ≤ h < 192` | + mark tile, blurb 1 line, two tags |
| `full` | `h ≥ 192` | + title wraps to 2 lines, blurb 2 lines, metric |

Font floor stays 9 px (`FONT_FLOOR`, `src/gl/cards/layout.ts:66`) and the same
proportional-scaling property is required and tested: `quietLayout(256)` must be
`quietLayout(128)` doubled to within 1 px, so a hi-res tier never re-flows.

### 2.4 What gets cut, and why

From `layoutTaxCard`/`taxCasePainter`, when the quiet card is in use:

| cut | why |
|---|---|
| log-scaled resolution bar + its label | a two-decade log axis is unreadable at 64 px, and it duplicates the metric |
| five stars | 5 glyphs across a 64 px card is 4 px each: texture, not information |
| the case ref in mono | an identifier nobody reads at a glance; it is the modal's subtitle |
| the "Opened 12 Mar · Personal Tax" line | two facts crammed into one line to save space is the definition of noise |
| the third chip (`Escalated`) | two tags is the cap; escalation becomes a `warn` tone on the status tag |
| `spec.subtitle`, `spec.fields`, `spec.badge` on the generic card (`src/gl/atlas.ts:145-209`) | replaced by `topic` / `tags` / `metric`; `drawCard` is rewritten against the same slots so there is one design language, not two |

Ten painted elements → five. The dense design is **not deleted** — it stays
available per §3.4 and is what `tax-cases` chooses for itself at ≤ 3,000 rows.

---

## 3. How a dataset declares it

### 3.1 Where the types live

A new **`src/data/card.ts`** holds the template types — pure data, no canvas, no
GL imports, so `src/gl/cards/*` and `src/ui/detail/*` can both import it without
dragging the columnar store or the renderer along. `src/data/columnar.ts` imports
it and adds two optional fields to `Dataset`.

```ts
// src/data/columnar.ts, appended to the Dataset interface (after `colors`, :189)
import type { CardTemplate, DetailTemplate } from './card';

export interface Dataset {
  // …existing fields…
  /** Declarative content for the small card. Absent = derived (see §3.3). */
  card?: CardTemplate;
  /** Declarative content for the expanded modal. Absent = every column. */
  detail?: DetailTemplate;
}
```

### 3.2 The types, in full

```ts
// src/data/card.ts

/** One card slot's value: a column name, or a function of the row index.
 *  Accessors are called once per card *rasterised*, never once per frame. */
export type SlotRef = string | ((i: number) => string);

export type TagTone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';

export interface TagSpec {
  /** Column name or accessor. Empty string hides this tag entirely. */
  value: SlotRef;
  /** A fixed tone, or a map from the value's text to a tone. Default 'neutral'. */
  tone?: TagTone | Record<string, TagTone>;
  /** 'pill' = filled capsule with coloured text; 'dot' = coloured dot + dim text. */
  shape?: 'pill' | 'dot';
  /** Values that mean "nothing to say" — the tag is dropped (e.g. Escalated: No). */
  hideWhen?: readonly string[];
}

export interface MetricSpec {
  value: SlotRef;
  /** Short unit or noun. Omit to show the value alone. */
  label?: string;
}

/** Header tile: the title's initials, or a glyph named by a column's value.
 *  Glyph names are matched by `src/gl/cards/glyphs.ts`; an unknown name falls
 *  back to initials, so a dataset can name a glyph the app does not have yet. */
export type MarkSpec = 'initials' | { glyph: SlotRef };

/** Hand-painted designs registered in src/gl/cards/index.ts. Extend the union
 *  and register a factory to add one — there is deliberately no way for a
 *  dataset to pass a painter function, because datasets must stay cloneable. */
export type CustomCard = 'taxCase';

export interface CardTemplate {
  /** Eyebrow in the accent header. Default: the current colour-by value. */
  topic?: SlotRef;
  /** Default: 'initials'. */
  mark?: MarkSpec;
  /** Default: `Dataset.labelColumn`. */
  title?: SlotRef;
  /** Default: none. */
  blurb?: SlotRef;
  /** At most two are drawn; a third is ignored and flagged by the test suite. */
  tags?: readonly TagSpec[];
  /** Drawn at 'full' density only. */
  metric?: MetricSpec;
  /**
   * Opt into a bespoke painter. When set, the painter owns the whole face and
   * ignores every slot above — but the slots are still read by the modal
   * header and the hover chip, so a bespoke card and its modal can never
   * disagree about who the record is. Declare both.
   */
  custom?: CustomCard;
}

// -------------------------------------------------------------- expanded view

export interface DetailField {
  /** Row label. Defaults to the column name when `value` is a column name. */
  label?: string;
  value: SlotRef;
  /** Render hint: 'mono' for identifiers, 'tag' for a chip, 'plain' otherwise. */
  as?: 'plain' | 'mono' | 'tag';
}

export interface DetailSection {
  title: string;
  /** A bare string is shorthand for `{ value: <column>, label: <column> }`.
   *  Fields naming a column the dataset does not have are skipped silently. */
  fields: ReadonlyArray<string | DetailField>;
}

export interface DetailAction {
  id: string;
  label: string;
  primary?: boolean;
}

export interface DetailTemplate {
  /** Under the title in the modal header. Default: the card's `blurb`. */
  subtitle?: SlotRef;
  sections?: readonly DetailSection[];
  /** Categorical facets whose share of the filtered set is shown in Context.
   *  Default: the first three categorical facets. `[]` hides the section. */
  context?: readonly string[];
  /** Demo action links. Default: none (no actions, no <section class="actions">). */
  actions?: readonly DetailAction[];
  /** A renderer registered with `registerDetail`. Wins over `sections`. */
  custom?: string;
}
```

### 3.3 The default when a dataset declares nothing

`compileCard(ds, template, colorBy)` (§3.5) falls back to today's `cardSpec`
behaviour (`src/app.ts:334-357`), reshaped into the new slots:

| slot | default |
|---|---|
| `title` | `ds.labelColumn` |
| `topic` | the current colour-by column's value at that row — it is what the accent means |
| `mark` | `'initials'` |
| `blurb` | none |
| `tags` | the first **two** categorical facets that are neither `labelColumn` nor the colour-by, `shape: 'dot'`, tone `neutral` |
| `metric` | the first numeric facet, `label` = its column name |

`products`, `payments`, `tax-returns` and `invoices` all get a usable, quiet card
with no declaration at all — and it is already quieter than today's four rows
(subtitle + two field rows + badge). Datasets that want better declare it.

`pixels` is unaffected: `Dataset.cards === false` (`src/data/pixels.ts:313`)
short-circuits at `src/app.ts:277-284` before any of this, `renderer.clearAtlas()`
runs, and every quad stays a flat colour. **That path must survive untouched**;
`tests/datasets.test.ts` gains an assertion that `pixels` declares no `card`.

### 3.4 Opting into a bespoke painter

`src/gl/cards/index.ts:9` becomes a registry lookup instead of a `kind` sniff:

```ts
// src/gl/cards/index.ts
const CUSTOM: Record<CustomCard, (ds: Dataset) => CardPainter> = {
  taxCase: taxCasePainter,
};

export function cardPainterFor(ds: Dataset, override?: CustomCard | 'quiet'): CardPainter {
  if (override === 'quiet') return quietPainter(ds);
  const pick = override ?? ds.card?.custom;
  if (pick && pick !== 'quiet' && CUSTOM[pick]) return CUSTOM[pick](ds);
  return quietPainter(ds);
}
```

`override` is what the Card settings popover (§5) passes. The
`looksLikeTaxCases` column sniff at `src/gl/cards/index.ts:10` **goes** — a
dataset now says what it wants rather than being guessed at.

`taxCasePainter` keeps its `layoutTaxCard` geometry and every helper, minus
`templateContent`/`aggregateFor` and minus the `spec.row === undefined` branch
(`src/gl/cards/taxCase.ts:188`), which becomes unreachable and is replaced by a
`throw` in dev / `recordContent(spec, 0)` in prod — actually simpler: the
signature tightens to require `spec.row`, and the type system enforces it.

### 3.5 Reaching the painter without allocating per row

The declarative form is **compiled once per (dataset, colour-by, template)** into
a closure that fills a **single reusable object**. Nothing allocates per card at
draw time except the strings that `NumericColumn.format` unavoidably produces.

```ts
// src/gl/cards/model.ts

export interface Chip { text: string; tone: TagTone; shape: 'pill' | 'dot' }

/** Mutable and shared: one instance per compiled model, refilled per card. */
export interface CardContent {
  accent: string;
  topic: string;
  /** '' = draw `initials` instead. */
  glyph: string;
  initials: string;
  title: string;
  blurb: string;
  /** Always length 2; only the first `tagCount` entries are drawn. */
  tags: [Chip, Chip];
  tagCount: number;
  metric: string;
  metricLabel: string;
}

export type CardModel = (spec: CardSpec) => CardContent;

export function compileCard(ds: Dataset, template: CardTemplate | undefined, colorBy: string): CardModel;
```

`compileCard` does the work once:

- each `SlotRef` becomes a `(i: number) => string` reader — for a
  `CategoryColumn` that is `categories[codes[i]]` (interned, zero allocation),
  for a `TextColumn` it is `values[i]`, for a `NumericColumn` it is
  `format?.(values[i]) ?? shortNumber(values[i])`;
- a `tone` map over a category column is flattened to a `TagTone[]` indexed by
  category code, so tone resolution is an array index, not a hash lookup;
- `hideWhen` becomes a `Uint8Array` mask over category codes.

Cost per card rasterised: 1–3 short-lived strings (numeric formats), no objects,
no arrays. At the worst case in §1.7 (2,025 cards on one settle) that is ~4,000
strings — a nursery blip on a settle, not per frame.

`quietPainter(ds)` is then:

```ts
export function quietPainter(ds: Dataset): CardPainter {
  const model = compileCard(ds, ds.card, /* colourBy is set by the caller */ …);
  return (ctx, w, h, spec) => paintQuiet(ctx, quietLayout(w, h), model(spec));
}
```

`buildCards` already rebuilds the painter on every colour change
(`src/app.ts:302`, reached from `setColorBy` at `:407-414`), so `colorBy` can be
closed over — no per-draw parameter.

### 3.6 Worked example — `src/data/taxCases.ts`

Appended to the returned `Dataset` (`src/data/taxCases.ts:310-319`). The
generator has the raw arrays in scope, so the accessors read them directly rather
than going through `valueAt`.

```ts
  return {
    name: `Tax customer service (${n.toLocaleString()})`,
    n,
    columns,
    labelColumn: customers ? 'Customer' : labels ? 'Case' : 'Topic',
    facets: TAX_CASE_FACETS.slice(),
    kind: 'tax-cases',
    geo: { lon: 'Longitude', lat: 'Latitude' },

    card: {
      // The dense record card is the right answer for a collection small enough
      // that you can read one; above that it is nine statistics nobody asked for.
      ...(n <= 3_000 ? { custom: 'taxCase' as const } : {}),
      topic: 'Topic',
      mark: { glyph: 'Channel' },
      title: customers ? 'Customer' : 'Case',
      blurb: postcodes ? (i) => `${postcodes[i]} · ${TOWNS[town[i]]}` : 'Town',
      tags: [
        { value: 'Priority', shape: 'pill', tone: { High: 'bad', Standard: 'accent', Low: 'neutral' }, hideWhen: ['Standard'] },
        { value: 'Status', shape: 'dot', tone: { Open: 'warn', Resolved: 'good' } },
      ],
      metric: { value: 'Contacts', label: 'contacts' },
    },

    detail: {
      custom: 'tax-cases',            // keeps today's timeline renderer
      subtitle: labels ? (i) => `${labels[i]} · ${TOWNS[town[i]]}` : 'Town',
      context: ['Channel', 'Topic', 'Priority'],
      actions: [
        { id: 'review', label: 'Review action', primary: true },
        { id: 'reassign', label: 'Reassign' },
        { id: 'note', label: 'Add note' },
      ],
    },
  };
```

Note `hideWhen: ['Standard']` — 55 % of cases are Standard priority
(`PRIORITY_CUM`, `src/data/taxCases.ts:51`), so printing it is printing "normal"
on half the board. Dropping it means a coloured chip on a card *means something*.

### 3.7 Worked example — `src/data/invoices.ts`

```ts
    card: {
      topic: 'Spend category',
      mark: 'initials',
      title: 'Supplier',
      blurb: labels ? (i) => `${labels[i]} · ${DEPARTMENTS[dept[i]]}` : 'Department',
      tags: [
        { value: 'Status', shape: 'pill', tone: { Paid: 'good', Outstanding: 'neutral', Overdue: 'bad', Disputed: 'warn' } },
        { value: 'Paid late', shape: 'dot', tone: { Yes: 'warn' }, hideWhen: ['No'] },
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
```

Category names taken from `src/data/invoices.ts:10-13` and `:46-48`.

---

## 4. The expanded modal

### 4.1 It is a modal, and it replaces the side pane

Today `#detail` is a 292 px panel pinned to the top-right of the stage
(`src/ui/style.css:172-176`) with `aria-modal="false"`
(`src/ui/detail.ts:60`). It becomes **one thing**: a centred modal dialog that
the card expands into.

DOM change in `index.html`: `#detail` and `#toast` move out of `.stage` (`:65-66`)
into a new overlay that is a **sibling of `#app`**, so `inert` can be applied to
the whole application chrome while the dialog is open:

```html
  </div><!-- /#app -->
  <div id="overlay">
    <div class="scrim" id="scrim" hidden></div>
    <div class="detail" id="detail" hidden></div>
    <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
  </div>
```

`#toast` moves too because the demo-action toast fires from inside the modal and
must sit above the scrim. It keeps its id, `role="status"` and `aria-live`, so
`scripts/detail-e2e.mjs:117` still passes.

Sizing: `min(720px, calc(100vw - 48px))` wide, `min(86vh, 760px)` tall, body
scrolls, header pinned. Two columns (identity | sections) above 900 px of modal
width, one below.

### 4.2 The expansion

FLIP, from the card's on-screen rect into the modal's final rect.

`PivotApp` gains one method — the rect maths already exists in
`src/tour/actions.ts:110` (`cardRect`) and is duplicated nowhere else:

```ts
  /** Where card `i` is drawn on screen right now, in CSS px, viewport-relative;
   *  null when it is off-canvas. Clamped to 24 px so a one-pixel card (a pixel
   *  collection, a fully zoomed-out board) still gives the modal an origin. */
  cardScreenRect(i: number): { left: number; top: number; width: number; height: number } | null;
```

`src/tour/actions.ts:110`'s `cardRect` is reduced to `app.cardScreenRect(i)`.

Sequence on `onSelect(i)` (`src/main.ts:206-216`):

1. The existing camera flight stays: `if (zoom < 60) camera.focus(x, y, 90, tweenMs(650))`
   (`src/main.ts:213`). The modal opens **when the flight lands**, not during it,
   so the FLIP origin is the rect the user is actually looking at.
2. `from = app.cardScreenRect(i)`; render the modal hidden, measure `to`.
3. Apply `transform-origin: 0 0` and
   `transform: translate(dx, dy) scale(sx, sy)` where the scale is the *width*
   ratio (uniform — a non-uniform scale distorts the header text mid-flight),
   with the body at `opacity: 0`.
4. Next frame: add `.opening`, which transitions `transform` to `none` and
   `opacity` to 1 over `Math.min(app.renderer.transitionMs, 260)` ms with
   `cubic-bezier(.2,.8,.2,1)`. The header's accent colour is
   `colorOfRow(ds, colorBy, i)` — the same value the card was painted with
   (`src/ui/detail.ts:74`) — so the accent band appears to *grow out of* the
   card's own header.
5. `prefers-reduced-motion`: `app.renderer.transitionMs === 0` already encodes it
   (`src/app.ts:43,212`); at 0 ms the transform is never applied and the modal
   simply appears. `src/ui/style.css:213` already has a
   `@media (prefers-reduced-motion: reduce)` block — the transition is disabled
   there too, belt and braces.
6. `from === null` (card off-screen, or a filtered-out row): fall back to
   `scale(.96)` + fade from the modal's own centre.

Close reverses it, then `DetailPane.hide()` runs unchanged
(`src/ui/detail.ts:84-96`) — the focus-return logic there is well-tested and is
not touched. The selection ring (`setSelected`, `src/gl/renderer.ts:263`, cleared
by `onClose` at `src/main.ts:76`) is what marks where the modal came from while
it is open. No new GL work.

### 4.3 Dialog semantics

| aspect | decision |
|---|---|
| `role` | `dialog` (unchanged, `src/ui/detail.ts:59`) |
| `aria-modal` | **`true`** (was `false`, `src/ui/detail.ts:60`). It is genuinely modal now. |
| `aria-labelledby` | `detailTitle` (unchanged — `scripts/detail-e2e.mjs:92` asserts it) |
| background | `#app.inert = true` while open, `false` on close. Cheaper and more correct than manual `aria-hidden`, and it kills background tabbing without a hand-rolled trap for the chrome. |
| focus on open | the close button (unchanged) — `tests/detail.test.ts:189` and `scripts/detail-e2e.mjs:94` both assert it. Do not "improve" this. |
| focus trap | Tab/Shift+Tab cycle within `#detail`. `#app` being inert means the trap only has to handle the wrap at the ends. |
| Escape | today's `window` handler (`src/main.ts:319`) already calls `detail.hide()`; add `e.stopPropagation()` so it does not also reach anything else. **During the tour the tour wins**: `src/tour/ui.ts:234` handles Escape in the *capture* phase with `stopImmediatePropagation`, and Escape while the tour runs means "skip the tour". That is existing behaviour and stays. |
| scrim click | closes |
| return focus | unchanged (`src/ui/detail.ts:84-96`) — but see the `#gl[tabindex]` bug in §6.2 |

### 4.4 Sections

The modal is the card, expanded, then everything the card could not say.

1. **Header** — accent band; mark tile; `topic` eyebrow; `title` as `<h2
   id="detailTitle">`; `subtitle` (default: the card's `blurb`); the tags at full
   size. Identical slots, identical order, identical colour to the card. This is
   what makes the expansion legible as an expansion.
2. **Summary** — up to four metric tiles (value over label). For a template
   dataset these are the numeric facets; for `tax-cases` the bespoke renderer
   supplies its own.
3. **Record** — `detail.sections`, or every non-label column as today
   (`genericDetail`, `src/ui/detail.ts:24-36`, kept byte-for-byte).
4. **Context** — *new, and the honest home of the deleted aggregate card.* For
   each field in `detail.context` (default: the first three categorical facets),
   one row: the record's value, its share of the **currently filtered** set, and
   a hairline bar. "Post · 10 % of 3,000 cases". Computed on open from
   `histogram(col, mask)` (`src/data/columnar.ts:266`) — `O(n)` per field per
   open, ~1 ms at 100k and ~10 ms at 1M. **Budget ≤ 12 ms**; memoise on
   `(field, solveSeq)` so re-opening under an unchanged filter is free.
5. **Journey / bespoke block** — `registerDetail('tax-cases', taxCaseDetail)`
   (`src/main.ts:72`) is unchanged and still supplies the timeline
   (`src/ui/detail/taxCase.ts:216-226`).
6. **Actions** — `detail.actions`, rendered exactly as today
   (`<a href="#" data-action=…>`), handled exactly as today
   (`src/ui/detail.ts:98-110`: `preventDefault` + `stopPropagation` + toast).
   Never change this; `scripts/detail-e2e.mjs:104-116` asserts no navigation
   occurs, three times.

### 4.5 Composing with `registerDetail`

Resolution order in `DetailPane.show`, replacing `src/ui/detail.ts:70`:

```ts
const key = ds.detail?.custom ?? ds.kind ?? '';
const render = registry.get(key) ?? (ds.detail ? templateDetail : genericDetail);
```

- `registerDetail(kind, renderer)` keeps working unchanged — `tests/detail.test.ts:171`
  registers `'toy-kind'` by `Dataset.kind` and must keep passing.
- `templateDetail` is a new `DetailRenderer` in `src/ui/detail/template.ts` that
  renders §4.4's sections from `ds.detail`.
- `genericDetail` (`src/ui/detail.ts:24`) is untouched, so
  `tests/detail.test.ts:167` (exactly 3 `<dt>` for the toy dataset) and
  `scripts/detail-e2e.mjs:135` (products gets a `<dl>` and no actions) stay green.
- `rich` class: `render !== genericDetail` (`src/ui/detail.ts:71`) — unchanged,
  which keeps `scripts/detail-e2e.mjs:137` honest.

---

## 5. Card settings

### 5.1 Yes, and it is four controls

A `Cards` ghost button in the top bar between `Metrics` and `Fit`
(`index.html:52-53`), opening a popover anchored under it —
`role="dialog" aria-label="Card settings"`, `aria-expanded` on the button,
Escape and click-outside close, focus returns to the button. Not modal, no
scrim: it is a preference, not a decision.

| control | values | why it earns its place |
|---|---|---|
| **Design** | `Auto` · `Simple` · `Detailed` | The user's explicit ask. `Auto` = the dataset's own choice (`card.custom` where declared). `Simple` = the quiet template. `Detailed` = the bespoke painter, disabled with a hint on datasets that have none. Without this you cannot see the two designs against the same data, which is the whole argument for keeping the dense one. |
| **Labels** | on / off | Off drops to flat tinted quads at every zoom (`renderer.clearAtlas()`, `src/gl/renderer.ts:328`). At 100,000 cards the mosaic reads *better* as pure colour, and this is also the cheapest path on a weak GPU. One line of code, a real answer to "how does the board read at a glance". |
| **Tags** | on / off | Tags are the noisiest element at small sizes and the first thing a viewer wants to mute when they are comparing shapes rather than reading records. |
| **Title** | `<select>` of text/category columns, default `card.title` | The one slot people genuinely want to re-point ("show me the case reference, not the name"). Costs one `<select>`. |

State lives in a small `src/ui/settings.ts`:

```ts
export interface CardSettings {
  design: 'auto' | 'quiet' | CustomCard;
  labels: boolean;
  tags: boolean;
  /** Column name, or '' for the template's own choice. */
  title: string;
}
```

Persistence: `localStorage` under `tessera.cards.v1`, through the existing
`safeStorage()` (`src/tour/store.ts:8`) so private mode never throws — the same
pattern as `pivot.metrics` (`src/main.ts:269-279`). Deep link: **`?cards=` for
the design only** (`?cards=quiet`, `?cards=taxCase`), because that is the one
setting a demo-giver needs to pin in a URL alongside `?dataset=`. The rest are
personal preferences and belong in storage, not in a shareable link.

Applying a change: `design` and `title` call `app.buildCards()` (which already
rebuilds the painter, `src/app.ts:302`) plus `app.clearHiRes(true)`; `labels`
toggles `renderer.hasAtlas`; `tags` is a flag on the compiled model. All four are
sub-40 ms at 3,000 rows and none re-solves the layout.

### 5.2 Deliberately left out

- **A picker per slot** (topic / blurb / tags / metric). That is a schema editor.
  The dataset author is the right person to choose them, and the facet sidebar
  already answers "what else is in this record".
- **Card size or density.** That *is* the zoom. A size slider would fight the
  camera and break the whole-pixel zoom ladder (`src/gl/zoom.ts`,
  `PivotApp.zoomStep`, `src/app.ts:581`).
- **Card colour.** The `Colour` menu already owns it (`index.html:42-45`).
- **Corner radius, theme, font.** Vanity controls; every one of them is a way to
  make the product look worse.
- **Prev/next record arrows in the modal.** Genuinely useful, but "next" is
  ambiguous — data order and the layout's visual order differ, and the visual
  order lives in the worker. Out of scope rather than half-done.

### 5.3 The tour must not inherit them

`TourHost` (`src/tour/actions.ts:9`) gains an **optional** method so existing
fakes in `tests/tour-*.test.ts` keep compiling:

```ts
  /** Put card settings back to Auto/labels-on for the duration of the tour. */
  resetCardSettings?(): void;
```

called from the `map` step's `run` (`src/tour/actions.ts:176-183`), right after
`ensureDataset`. The tour asserts a specific look; it must not be showing
somebody's saved "labels off".

---

## 6. Usability

### 6.1 Hover

On `pointermove`, throttled to one `renderer.pick` per rAF and **only when
`renderer.count <= 200_000`** (`pick` is `O(n)`, `src/gl/renderer.ts:490`; at 1M
that is ~2 ms per move, which is not affordable and buys nothing because the
cards are dots):

- the hovered card gets `a_meta.y = 128` — the currently spare middle value of
  the byte that already carries selection (`src/gl/renderer.ts:263`, shader
  `v_sel`, `src/gl/shaders.ts:56,71`). The shader branches: `v_sel > 0.75` = the
  existing selection ring, `v_sel > 0.25` = a 1 px `INK_DIM` border. **No new
  attribute, no new upload path** — one `uploadStyleAt` (16 bytes) per change.
- `#gl`'s cursor switches from `grab` (`src/ui/style.css:136`) to `pointer` when
  a card is under the pointer.
- **Cursor chip**: when cards are below the LOD band (`v_px < 9`, so the art is
  invisible), a small absolutely-positioned chip follows the pointer with the
  hovered card's `title` and `topic`. At 100,000 cards on screen this is the only
  way to answer "what is that one?" without zooming, and it is the same content
  the card would show if it were big enough. Above the band it is suppressed —
  the card is already saying it.

Follow-up, not in scope: a uniform grid index over `renderer.to` would make
`pick` `O(1)` and lift the 200,000 gate. Note it, do not build it.

### 6.2 Keyboard

**A bug found while reading:** `src/ui/detail.ts:92` returns focus to
`document.querySelector('#gl[tabindex]')`, but `index.html:61` is
`<canvas id="gl" aria-label="Card collection">` with **no `tabindex`**. That
selector has never matched; focus has always fallen through to `#tourBtn`. Fix
it by making the canvas genuinely focusable, which is required anyway:

- `<canvas id="gl" tabindex="0" role="application" aria-label="Card collection"
  aria-describedby="glHelp">` plus a visually-hidden `#glHelp` paragraph:
  "Arrow keys move between cards. Enter opens the selected record. Plus and
  minus zoom; F frames everything."
- A **focused card** distinct from the selected one, using the `128` byte value
  from §6.1. Arrow keys move to the nearest card whose centre lies in that
  direction (a single `O(n)` scan over `renderer.to` per keypress — ~4 ms at 1M,
  which is fine for one keypress and not for one pointer move). `Home` / `End`
  go to the first/last visible card.
- `Enter` / `Space` on the focused card = a click: `app.onSelect(i)`, which opens
  the modal. `Escape` clears the focus ring.
- An `aria-live="polite"` visually-hidden region announces the focused card as
  `"<title>, <topic>, <tag>, <tag>"` — the compiled `CardContent` (§3.5) read as
  text. A canvas can never be accessible; a live region reading the same slots
  is the honest substitute, and it costs one `textContent` write per move.

Keys must not fight the existing global handler (`src/main.ts:313-320`) — the
arrow keys are currently unclaimed there, and the tour's capture-phase handler
(`src/tour/ui.ts:71,237`) only takes ArrowRight/ArrowLeft while the tour is open,
which is correct: during the tour, arrows are the tour's.

### 6.3 Empty and missing values

- **Card**: the slot is not drawn and the block closes up (§2.1). No dashes, no
  "not surveyed", no empty chips.
- **Modal**: a declared field whose column is missing is **skipped**; a declared
  field whose *value* is empty renders as `—` in a labelled row, because in a
  record view "we do not know" is information. This is today's `field()` helper
  (`src/ui/detail/taxCase.ts:172-173`) and it stays.
- A dataset that drops columns at scale (`tax-cases:100000` has no `Customer`,
  `Case` or `Postcode` — `src/data/taxCases.ts:194-198`) therefore degrades
  cleanly: `title` falls back to `labelColumn` (`Topic` at that size,
  `src/data/taxCases.ts:315`), `blurb` to `Town`. **A test must cover exactly
  this**, because it is the collection the complaint came from.

### 6.4 100,000 cards at a glance

At fit, 100,000 cards in a grid are 2–4 device px: dots, no texture, by design.
What carries meaning there is sort order, colour and layout — all of which
already work. The three changes that help:

1. The **Labels off** setting makes that regime explicit and deliberate.
2. The **cursor chip** gives per-card identity without zooming.
3. When cards are below the LOD band the settings popover's Design radio is
   de-emphasised with the hint *"cards are dots at this zoom — press + to see
   them"*, so nobody fiddles with a control that cannot do anything yet.

Nothing else. The HUD already reports `cards` and `shown`
(`src/ui/hud.ts:115-116`) and the legend and facet counts already carry the
group-level numbers the aggregate card was trying to duplicate.

---

## 7. Delivery

Six packages. **File ownership is exclusive** — this repo runs parallel agents
and collisions are the main hazard. Announce start and finish on the agent bus.

### WP1 — Content model and dataset declarations

**Owns** `src/data/card.ts` (new), `src/data/columnar.ts`, `src/data/taxCases.ts`,
`src/data/invoices.ts`, `src/data/payments.ts`, `src/data/products.ts`,
`src/data/taxReturns.ts`, `tests/card-template.test.ts` (new),
`tests/datasets.test.ts`.

Types from §3.2; `Dataset.card` / `Dataset.detail` from §3.1; declarations from
§3.6 and §3.7 for `tax-cases` and `invoices`; the other three datasets rely on
the derived default (§3.3) and declare nothing.

**Must not touch** `facets`, `labelColumn`, column names or category orders —
`tests/registry.test.ts` is a frozen contract for `tax-cases` and the tour is
built on it.

**Verify** `pnpm typecheck && pnpm test`.

**New tests** (`tests/card-template.test.ts`): every built-in dataset's declared
slots name columns that exist; no template declares more than two tags; slot
values at rows 0, `n>>1`, `n-1` are within the §2.1 length caps; `pixels`
declares no `card`; `tax-cases:100000` (no `Customer`/`Case`/`Postcode`) still
resolves a non-empty `title` and `blurb`.

### WP2 — The quiet card painter

**Owns** `src/gl/cards/index.ts`, `src/gl/cards/model.ts` (new),
`src/gl/cards/quietLayout.ts` (new), `src/gl/cards/quiet.ts` (new),
`src/gl/cards/glyphs.ts` (new — the channel glyphs lifted out of
`src/gl/cards/taxCase.ts:377-451` so both painters share them),
`src/gl/cards/taxCase.ts`, `src/gl/atlas.ts`, `tests/cards.test.ts`.

`compileCard` (§3.5); `quietLayout` + `paintQuiet` (§2.2, §2.3); `drawCard`
(`src/gl/atlas.ts:145`) rewritten against the same slots so there is one design
language; `CardSpec.category` (`src/gl/atlas.ts:19`) is replaced by
`CardSpec.cover?: { label: string; accent: string }` for the group cover;
`templateContent` and `aggregateFor` (`src/gl/cards/taxCase.ts:117-184`) deleted.

**Depends on** WP1 landing `src/data/card.ts` (types only) — the two can overlap
after that file exists.

**Must not touch** `src/gl/cards/layout.ts` — leaving `layoutTaxCard` alone is
what keeps all of `tests/cards.test.ts:12-82` green without edits.

**Verify** `pnpm typecheck && pnpm test`.

**New tests** (appended to `tests/cards.test.ts`): `quietLayout` rects inside the
box at 64/128/256/512/1024; bands never overlap; smallest font ≥ 9; `quietLayout(256)`
is `quietLayout(128)` doubled within 1 px; `densityFor` boundaries at 96 and 192;
missing slots remove their band rather than leaving a gap; `compileCard` returns
the *same object identity* on successive calls (the no-allocation contract) and
resolves tones, `hideWhen` and the §3.3 defaults correctly.

### WP3 — Uniqueness and tiering

**Owns** `src/gl/hires.ts`, `src/app.ts`, `tests/atlas.test.ts`,
`tests/hires.test.ts`, `tests/tiers.test.ts` (new), `scripts/verify-card.mjs`.

`planTier` + `UNIQUE_MIN_PX` (§1.3); `specOf` always per row and `coverOf` for
the base atlas (§1.4); the group cover in `buildCards` (`src/app.ts:311-328`);
atomic commit (§1.6); `HIRES_PIXEL_BUDGET` replacing `HIRES_BUDGET`
(`src/app.ts:39`); `FrameModel` gains `cardTier: 'dot' | 'base' | 'unique'` and
`perItem: boolean` (`src/app.ts:18-35`); `PivotApp.cardScreenRect(i)` (§4.2).

**The only package that touches `src/app.ts`.** It must announce
`cardScreenRect` as done before WP4 starts.

**Depends on** WP2 (needs a painter that can paint any row of any collection).

**Verify** `pnpm typecheck && pnpm test`, `node scripts/verify-card.mjs`,
`node scripts/verify-hidpi.mjs`, `pnpm bench`.

**New tests** (`tests/tiers.test.ts`): `planTier` returns null below
`UNIQUE_MIN_PX`; steps down until capacity covers `visible`; returns null when
even tier 64 cannot; the table in §1.3 reproduced as cases at 4096 and 2048;
monotone non-increasing in `visible`. `tests/hires.test.ts` gains: a plan that
cannot cover the viewport commits nothing (the atomicity invariant, as a pure
function over a fake slot map).

**`scripts/verify-card.mjs` changes** — phase 3 currently opens
`tax-cases:20000`, focuses card 0 at 800 px and *logs* the tier without asserting
(`scripts/verify-card.mjs:136-143`). It becomes the uniqueness check:
assert `frame.cardTier === 'unique'`, and screenshot two adjacent cards and
assert their clips **differ** byte-wise. Phase 1's `hi.tier >= 512` on
`tax-cases:900` (`:124`) is a per-item collection and must still pass unchanged.

### WP4 — The modal

**Owns** `src/ui/detail.ts`, `src/ui/detail/taxCase.ts`,
`src/ui/detail/template.ts` (new), `src/ui/detail/flip.ts` (new), `index.html`,
`src/ui/style.css`, `tests/detail.test.ts`, `scripts/detail-e2e.mjs`.

Overlay + `inert` (§4.1); FLIP (§4.2); dialog semantics (§4.3); sections and the
Context block (§4.4); renderer resolution (§4.5).

**Depends on** WP3 announcing `PivotApp.cardScreenRect`, and WP1 for
`DetailTemplate`.

**Verify** `pnpm typecheck && pnpm test`, `node scripts/detail-e2e.mjs`,
`pnpm test:e2e`.

**New tests** (`tests/detail.test.ts`): `aria-modal` is `true` and `#app` gets
`inert` on open and loses it on close; Tab wraps inside the pane; scrim click
closes; `templateDetail` renders declared sections, skips fields whose column is
missing, and escapes values; `registerDetail` by `kind` still wins (the existing
`'toy-kind'` case must pass **unedited**); Context shares sum sanely against a
mask. FLIP itself is verified in `scripts/detail-e2e.mjs`, not jsdom: assert the
modal's rect is close to the card's rect one frame after open, and equal to its
final rect after the transition; and that with `prefers-reduced-motion` emulated
there is no intermediate frame.

### WP5 — Card settings and canvas usability

**Owns** `src/ui/settings.ts` (new), `src/main.ts`, `src/gl/shaders.ts`,
`src/gl/renderer.ts`, `tests/settings.test.ts` (new).

Popover and persistence (§5); hover, cursor chip, keyboard navigation and the
live region (§6.1, §6.2).

**Starts only after WP4 announces `index.html` and `src/ui/style.css` done.**
Both packages want those two files and both must append to their own clearly
delimited block (`/* ---------- card settings ---------- */`). This is the one
serialisation point in the plan; do not overlap it.

**Verify** `pnpm typecheck && pnpm test`, `node scripts/detail-e2e.mjs`,
`pnpm test:e2e`, `pnpm bench`.

**New tests** (`tests/settings.test.ts`, jsdom): defaults; round-trip through a
fake `Storage`; a throwing `localStorage` degrades silently (private mode);
`?cards=quiet` overrides storage; an unknown `?cards=` value falls back to
`auto`; `Detailed` is disabled for a dataset with no `card.custom`.

### WP6 — Tour, verification and docs

**Owns** `src/tour/actions.ts`, `src/tour/script.ts`, `scripts/tour-e2e.mjs`,
`README.md`, `docs/PROGRESS.md`, `docs/HANDOFF.md`.

**Verify** `pnpm test`, `pnpm test:e2e`, and a full re-run of the list in
`docs/HANDOFF.md`.

### 7.1 What the tour needs changed

`docs/HANDOFF.md` lists the 16-step tour as done and green; it ends on "one
customer's card → detail record". Four changes, all small, all in WP6:

1. **`clear` step closes the modal first** (`src/tour/actions.ts:271-275`). With
   `#app` inert while the dialog is open, the tour's `clear` step spotlights
   `#facets [data-clear]` — an element the user could not click. `run` becomes
   `() => { host.el('#detail .close')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); host.clearFacets(); }`.
   The narration ("Clear the filters, and all three thousand return to their
   places") reads better with the modal gone anyway.
2. **`resetCardSettings` on the `map` step** (§5.3).
3. **`cardRect` delegates to `app.cardScreenRect`** (`src/tour/actions.ts:110`) —
   pure deduplication, but it is the tour's file so it is WP6's edit.
4. **One narration line.** `zoom` (`src/tour/script.ts:55-56`) says "each card
   shows its own summary: name, town, topic and priority". After §2 the card
   shows name, town, topic and *status*, and priority only when it is not
   Standard. Change to *"name, town, topic and how the case stands"*.
   `tests/tour-story.test.ts` asserts narration claims against the data — this
   line is not currently asserted, but the fix keeps it true. `TOUR_DATASET` is
   `tax-cases:3000` (3,000 ≤ 3,136), so the tour stays on the **per-item** path
   throughout and none of §1's tiering changes affect it.

Regenerating audio is **not** required: `docs/HANDOFF.md` records that narration
audio was never generated (blocked on the ElevenLabs voice permission), so
changing one line costs nothing today. If audio has been generated by then, the
hash test will flag `zoom` as stale and it must be regenerated.

### 7.2 Order and dependencies

```
WP1 ──┬─▶ WP2 ──▶ WP3 ──┬─▶ WP4 ──▶ WP5 ──┐
      │                 │                  ├─▶ WP6
      └────────────────▶┘                  │
                                           ┘
```

WP2 may start as soon as WP1 has committed `src/data/card.ts`. WP4 needs WP3's
`cardScreenRect`. WP5 is serialised behind WP4 on `index.html` / `style.css`.

### 7.3 Risks to existing green checks

| check | risk | mitigation |
|---|---|---|
| `pnpm test:e2e` (tour, port 5182) | **Highest.** `#app` going inert while the modal is open could block the tour's later steps; the tour's capture-phase key handler (`src/tour/ui.ts:71`) and its own `trapTab` (`:233`) now coexist with the modal's trap. | The tour drives the app through direct calls and synthetic `.click()`, neither of which hit-tests, so `inert` cannot block it. The `clear` step closes the modal first anyway (§7.1). The tour's Escape wins by `stopImmediatePropagation` — existing behaviour, unchanged. Run `pnpm test:e2e` at the end of WP4, WP5 **and** WP6. |
| `node scripts/verify-card.mjs` (5196) | Phase 3's category-template card no longer exists; phase 4's "tiny" screenshot changes design. | Phase 3 becomes the uniqueness assertion (WP3). Phase 4 has no assertion, only a screenshot — regenerate and eyeball. |
| `node scripts/verify-hidpi.mjs` (5191) | Sharpness numbers are measured on `tax-cases:900`, a per-item collection, whose tier rule is deliberately unchanged. | Re-run to confirm the numbers are bit-identical. If they move, `planTier` has leaked into the per-item path — that is a bug, not a new baseline. |
| `node scripts/detail-e2e.mjs` (5195) | `#detail` and `#toast` move in the DOM; the pane becomes modal. | Every assertion in that script is by id, role or `data-action` and survives the move. The three no-navigation checks (`:104-116`) must not change semantics — do not touch `src/ui/detail.ts:98-110`. |
| `pnpm test` — `tests/cards.test.ts` | `layoutTaxCard` geometry is asserted in detail. | WP2 does not touch `src/gl/cards/layout.ts`. |
| `pnpm test` — `tests/detail.test.ts` | The `'toy-kind'` registry case and the 3-`<dt>` generic case. | `genericDetail` and the `registerDetail`-by-`kind` path are kept byte-for-byte (§4.5). |
| `pnpm test` — `tests/registry.test.ts` | Frozen `tax-cases` contract. | WP1 adds only `card` and `detail`; it must not reorder `facets` or rename a column. |
| `pnpm bench` (5181) | The hi-res pass becomes resident whenever cards are ≥ `T`, not only when magnified. Workstream A already hit and fixed one bench regression from the hi-res pass during zoom (`docs/HANDOFF.md`). | The pass still only runs on a **settled** camera (`src/app.ts:447-449`) — a zoom in flight does nothing. The pixel budget (§1.7) *lowers* the worst-case tick from 25 Mpx to 4 Mpx. **Budget: the bench's zoom-phase p95 must not worsen by more than 5 %.** Run `pnpm bench` before WP3 and after, and commit both JSONs to `bench-results/`. |
| VRAM on integrated GPUs | The hi-res 4096² texture is allocated more of the time. | No new peak (§1.7); `hiResTextureSize` already clamps to `maxTextureSize` (`src/gl/hires.ts:47-53`) and falls to 2048 on small buffers, where `planTier` simply raises `T`. |

---

## 8. Summary of the decisions

1. **Uniqueness** — a three-tier ladder keyed to on-screen size, with the top
   tier served by the existing hi-res LRU made row-identified and
   capacity-fitted. Unique art engages exactly when the hi-res atlas can hold the
   whole viewport (≈ 52 device px on a 4K buffer), and it is all-or-nothing, so
   two identical cards never sit side by side above the size where a line of text
   can be read.
2. **The aggregate card** — deleted as a card, kept as a flat *group cover* below
   the unique threshold, with its statistics rehoused in the modal's Context
   section where they are computed against the live filter.
3. **The small card** — six named slots (`topic`, `mark`, `title`, `blurb`, two
   `tags`, `metric`), three densities, missing values close up. Ten painted
   elements down to five.
4. **The declaration** — `Dataset.card?: CardTemplate` and
   `Dataset.detail?: DetailTemplate` in a new `src/data/card.ts`, compiled once
   into a reusable `CardContent` object so nothing allocates per row at draw
   time; a `custom: 'taxCase'` escape hatch keeps the dense design, which
   `tax-cases` chooses for itself at ≤ 3,000 rows.
5. **The modal** — `#detail` becomes a true `aria-modal="true"` dialog in an
   overlay outside `#app`, expanding from the card's own rect by FLIP, honouring
   `prefers-reduced-motion` through the existing `renderer.transitionMs === 0`
   signal, composing with `registerDetail` unchanged.
6. **Card settings** — four controls (Design, Labels, Tags, Title) in a topbar
   popover, persisted in `localStorage`, with `?cards=` pinning the design only.
7. **Delivery** — six packages with exclusive file ownership, serialised only
   where `index.html` and `style.css` are shared, and a named budget on every
   change that could cost frame time.

---

## 9. Addendum — user feedback, 2026-08-27 09:30

Three decisions from the user after seeing the tour with narration and the app
on a large screen. They override the corresponding parts of §7 above.

### 9.1 The tour keeps the dense card, and the narration does not change

Narration audio **has been generated** — 16 clips plus `manifest.json` under
`public/audio/tour/` (2026-08-27 09:22), so the three audio-hash tests are live
and no longer skipped. The user has seen the tour with voiceover, says it
explains the cards well, and wants the walkthrough to keep the dense design.

Therefore **§7.1 item 4 is cancelled**: do *not* rewrite the `zoom` step's
narration. Changing it would invalidate its clip hash and force a regeneration
the user has explicitly deferred. `tax-cases` declaring `custom: 'taxCase'` for
itself at ≤ 3,000 rows (§3.6) already keeps `TOUR_DATASET` (`tax-cases:3000`) on
the dense card end to end, which is what makes the existing narration true —
"name, town, topic and priority" still describes what is on screen.

§7.1 items 1–3 stand. §5.3 (`resetCardSettings` on the `map` step) becomes
*more* important, not less: it is what guarantees a returning user's saved Card
settings cannot put the tour on the quiet card and desynchronise the audio.

### 9.2 Capacity-fitting applies to per-item collections too

> "when very zoomed in on a large screen you can only see 4–6 clear cards and
> the less central ones are still blurred which looks wrong"

Diagnosed. `updateHiRes` picks its tier with `hiResTier(cardPx, atlas.slot)`
(`src/app.ts:452`), which is `min(1024, nextPow2(ceil(cardPx)))`
(`src/gl/atlas.ts:62-65`) and **takes no account of how many cards are visible**.
Zoomed in on a large display, `cardPx` clears 512, so the tier is 1024, and a
4096² hi-res texture holds `floor(4096/1032)² = 9` cards at that tier. The loop
then stops dead on `if (hi.free.length === 0) break;` (`src/app.ts:489`), so the
nine nearest the centre get their own art and every other visible card keeps the
base 64 px slot stretched over several hundred device pixels. That is the blur,
and it is worst exactly where the user noticed it — a big screen, zoomed right
in, where the most cards are simultaneously large.

**So §1.3's `planTier` is not conditional.** Delete the carve-out in §1.3's last
paragraph ("Per-item collections keep today's rule exactly") and §1.6's
`atomic = false` for per-item collections. Every collection gets the
capacity-fitted tier and the atomic commit. Uniformly sharp at a 1.2× upscale
beats nine crisp cards adrift in a field of smeared ones.

This does not endanger the sharpness checks, and WP3 must confirm rather than
assume it: `scripts/verify-hidpi.mjs` and `scripts/verify-card.mjs` phase 1 both
zoom a *single* card to ~800 px on `tax-cases:900`, where the visible count is a
handful and `planTier` returns the same 1024/512 today's rule does. If either
script's numbers move, `planTier` has a bug — re-derive it, do not re-baseline.

Add to `tests/tiers.test.ts`: at `cardPx = 600` with 20 visible on a 4096²
texture, the tier steps down to 512 (capacity 49) rather than 1024 (capacity 9),
and every visible card is covered.

### 9.3 The zoomed-out map is a haze, and the halo floor is why

> "the very zoomed out map view is a bit too blurry"

Diagnosed, and it is a shader bug rather than a mip or filtering problem. In
`VERT` (`src/gl/shaders.ts:44`):

```glsl
float halo = 1.0 + light * (max(3.0, 6.0 / max(px, 1e-3)) - 1.0);
```

The `6.0 / px` term pins every card's halo to **6 device px on screen no matter
how far out you zoom** — at `px = 0.5` the halo is 12× the card, at `px = 0.2`
it is 30×, and both land at 6 px. Zooming out therefore never sharpens the map;
it just packs more 6 px gaussian blobs into the same area until they overlap into
a uniform wash.

Worse, the emitted energy is not conserved. The core is `exp(-r2 * 4.0)` at a
fixed amplitude (`src/gl/shaders.ts:107-110`), so total light per card scales
with halo *area* — each card emits **more** total light the further out you zoom.
That is backwards, and it is why the far view blooms instead of resolving into
points.

The fix, owned by WP5 (it owns `src/gl/shaders.ts`):

1. Lower the on-screen floor from 6 px to **2.5 px** — enough spread that a
   sub-pixel dot cannot drop out of the raster, little enough that a town reads
   as a cluster of points rather than a smear.
2. **Conserve energy**: scale the core's amplitude by `1.0 / (halo * halo)`
   (clamped so a lone card does not vanish) so that a card's total contribution
   is independent of zoom. Crowding then sums towards white *because cards are
   crowded*, which is the effect the design was after, rather than because the
   halo grew.
3. Tighten the gaussian from `exp(-r2 * 4.0)` to roughly `exp(-r2 * 6.0)` so what
   spread remains has a defined bright centre.

Verify with `node scripts/verify-map.mjs --swiftshader`, which already measures
centre-60 % mean luminance above the clear colour with glow on versus `?glow=0`
(3.08× today) and the fraction of pixels above 0.8 luminance (2.02 % today).
Both are measured at one zoom, so **add a far-zoom case**: fit the whole map,
then assert the 0.8-luminance fraction has *fallen* and that the UK's coastline
is still legible. The screenshots `screenshots/map-dpr2.png` and `map-dpr1.png`
must be regenerated and eyeballed — the user's complaint is visual and the
numbers alone will not settle it.

---

## 10. Status — delivered 2026-08-27

All six packages landed, uncommitted, along with the §9 addendum. Where the
implementation departed from the plan:

- **§1.3's carve-out is gone**, as §9.2 requires: `planTier` and the atomic
  commit apply to per-item collections too. `hiResTier` was deleted rather than
  left unused.
- **The tier is fitted to the on-screen set, not the pre-load ring.** The scan
  keeps its 0.25 margin so a small pan does not start from nothing, but a card
  about to scroll in does not get to push every visible card down a tier
  (`onScreenCards`). The commit gate is the on-screen set for the same reason.
- **`hiResKey` lost its `tier` argument.** The tier is derived from the same
  inputs and is only knowable *after* the scan the key exists to skip.
- **§7.1 item 4 cancelled** (§9.1), and one further tour change was needed that
  the plan did not foresee: the `record` step no longer opens the modal, because
  a centred modal covers the card the narration is describing. The `detail` step
  opens it instead. No narration changed.
- **§5's popover is viewport-anchored**, not `position: absolute` inside the top
  bar — that bar is an `overflow-x: auto` scroll container and clipped it. Its
  re-render also had to preserve focus, or Escape stopped working after any
  change.
- **§6.3 turned up a live bug**: at `tax-cases:100000` the title falls back to
  `Topic`, which is also the eyebrow, so a card read "PAYE PAYE". `compileCard`
  and `modalHeader` now drop a topic equal to the title.
- **The bench budget could not be evaluated.** There is no usable GPU baseline
  on this machine (see `docs/HANDOFF.md`); the bench's phases never settle the
  camera, so the hi-res pass does not run in them at all.

`taxCaseDetail`'s own CSS (timeline, chips, stars, key/value grid) did not exist
in `src/ui/style.css` at all before WP4 — the flagship record view had been
rendering unstyled since E3.
