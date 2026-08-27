# Plan E — Customer-journey flagship: UK map, customer card, record view, revised tour

Written 2026-08-26 against the working tree (A landed uncommitted; B's D1 plus
geo columns in progress; C's tour scaffold landed with audio held). Read-only:
every claim below has a file:line; nothing here was edited.

Already landed by impl-B (verified in the tree): `Customer`, `Postcode`,
`Town`, `Longitude`, `Latitude`, `Age band`, `Area type`
(`src/data/taxCases.ts:27-30, 293-308`, gazetteer `src/data/ukPlaces.ts`,
Glasgow at `:222`), with `Longitude`, `Latitude` as the **first two numeric
facets** (`taxCases.ts:306-308`). Labels: `AREA_TYPES = Urban | Suburban |
Rural`, `AGE_BANDS = 18–29 | 30–44 | 45–59 | 60–74 | 75+` (`:23-24`). impl-C
has landed the tour scaffold and `TourHost` in `main.ts:254` with audio held,
and is picking a female Scottish ElevenLabs voice.

Lead decisions folded in (2026-08-26, late): **Titanic is removed** (real
victims' names) and **`tax-cases:5000` becomes the default collection**, opening
on the map. See 1f.

Two small asks of impl-B that this plan depends on (one-liners, in B's files):

- **B-ask-1** `Dataset.kind = 'tax-cases'` on the generated dataset, and
  `Dataset.geo = { lon: 'Longitude', lat: 'Latitude' }` (field definitions go
  in `src/data/columnar.ts:31-45`, see E1 step 1; B sets them in
  `src/data/taxCases.ts:310-320`).
- **B-ask-2** `labelColumn = 'Customer'` when the text columns exist (today
  still `'Case'`, `taxCases.ts:318`) — the card title and the detail header
  should be the person, with the case ref shown separately.
- **B-ask-3** Titanic removal (see 1f) — B owns `registry.ts`, `bench.ts`,
  the data tests and the README data section.

## Findings (file:line)

**Map / scatter**
- `src/layout/layouts.ts:252-323` `xyLayout`: two branches. `isRaster`
  (`:267-271`) → scale 1; otherwise (`:282-290`) `w = sqrt(n·aspect)`,
  `h = w/aspect`, `sx = w/xSpan`, `sy = h/ySpan` — **independent scales**, so
  Longitude × Latitude is stretched to the viewport (a 4.6°-wide × 9°-tall UK
  becomes a 16:10 blob). `isRaster` also uses `order.length` (visible rows), the
  D-01 bug, so any facet filter re-scales the plot — a map must not move when
  filtered.
- Card size in xy is the full pitch (`:303`), and `LayoutSpec` for xy is just
  `{x, y}` (`:19`); the spec is structured-cloned to the worker
  (`src/layout/client.ts`, `worker.ts:36`), so a new optional flag passes
  through untouched.
- Layout defaults come entirely from facet order: `defaultAxisY` = first
  numeric facet (`src/app.ts:170-176`); for xy the axis menus are numeric-only
  and `fillAxisSelects` picks `nums[0]`/`nums[1]` (`src/main.ts:161-170`,
  `keep(...)` with `yOpts[1]`). With B's ordering that is Longitude/Latitude.
- The pixel precedent for "open in Scatter": `src/main.ts:305-318` —
  `if (app.dataset?.rgb && columns.X && columns.Y) { xSel='X'; ySel='Y';
  setLayoutKind('xy'); apply(true) }`. Note `loadDataset` always solves a grid
  first (`app.ts:150-151`, D-09), so the map is reached by a grid→xy flight.
- `cards === false` path: `buildCards` (`app.ts:191-198`) clears the atlas;
  `setLayout` sets `edgeAA = 0` only for `xy && cards === false` (`:420`);
  `cornerRadius` 0.02 vs 0.14 (`:145`). None of that applies to tax-cases,
  which keeps cards — the map must be a *card* layout so zooming reveals them.

**LOD and colour (the "night lights" question)**
- Fragment LOD: `src/gl/shaders.ts:90` `texMix = u_texEnable * smoothstep(3.0,
  9.0, v_px)`; under 3 device px a card is a flat rounded dot of `v_color`
  (`:88`), a sheen and a rim over 6–18 px (`:99-101`). The 3/9 band is a
  literal, not a uniform.
- Blend is classic alpha: `renderer.ts:165` `blendFuncSeparate(SRC_ALPHA,
  ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)`; output is straight alpha
  (`shaders.ts:108`). Overlapping dots therefore *occlude*; they never
  accumulate, which is the opposite of city lights. Switching to
  **premultiplied** blending (`ONE, ONE_MINUS_SRC_ALPHA`) lets one draw call
  mix additive fragments (alpha 0) and normal ones (alpha a) per pixel —
  additive lights that become opaque cards as they grow.
- Per-instance colour is the colour-by tint: categorical `CATEGORICAL.dark`
  (`src/core/palette.ts:9-12`), numeric = `SEQUENTIAL_BLUE` ramp (`:16-20`,
  `app.ts:270-277`). Neither is warm; a warm core must come from the shader.
- The clear colour is `[0.055,0.055,0.051]` (`app.ts:497`) ≈ `--surface-0`.

**Cards**
- `src/gl/atlas.ts:6-12` `CardSpec {title, subtitle, accent, fields, badge}`;
  the only painter is `drawCard` (`:121-185`), called from `CardAtlas.drawSlot`
  (`:107`) and from the hi-res path `PivotApp.rasterise` (`app.ts:403`).
  Palette: `BG '#1c1c1b'`, `INK '#f5f5f2'`, `INK_DIM '#a3a29a'` (`:18-20`).
  Helpers `initials`, `wrap`, `clip`, `mixHex` (`:187-230`) are reusable.
- Slot sizing: `slotFor(900) = 128` (30 cols, `atlas.ts:33-39`); per-item up
  to `hiResCapacity(4096,64,4) = 3136` rows (`app.ts:206`), so `tax-cases:900`
  is per-item at 128 px and `tax-cases:5000+` is **category mode**: one
  template per category of the colour-by column (`app.ts:224-237`), tinted per
  row. Hi-res tiers re-rasterise visible cards at `min(1024, nextPow2(cardPx))`
  once the camera settles (`app.ts:327-391`), ≤ 24 per tick.
- `cardSpec` (`app.ts:244-254`): title = `labelColumn`, subtitle = colour-by
  value, `fields` = first two non-label facets, badge = third; accent =
  `categoricalColor(code)` with **code 0 for a numeric colour-by**, so under
  "colour by Contacts" every card header is the same blue while the instance
  tint is a blue ramp — a visible mismatch once cards are big.
- `setColorBy` rebuilds the whole atlas (`app.ts:294-300`) — the painter must
  stay cheap (900 × 128 px on change; 24 × up to 1024 px per settle).

**Detail pane**
- `src/main.ts:130-152` `showDetail`: generic `<header>` + `<dl>` of every
  non-label column, unescaped (D-25), no dialog semantics (D-31); `#detail` is
  a 292 px absolute panel (`src/ui/style.css:171-186`); `Escape` hides it
  without deselecting (`main.ts:283`, D-13); `toast()` is closure-private
  (`main.ts:59-64`).
- `valueAt` (`src/data/columnar.ts:101-109`) already formats numbers via the
  column `format` (e.g. `Opened` → "12 Mar", hours → "3.4 h").

**Tour (C, as landed)**
- `TourHost` (`src/tour/actions.ts:8-17`): `loadDataset`, `setLayout(kind)`,
  `setSelect(id, value)`, `toggleFacet(field, label)`, `clearFacets`,
  `select(i)`, `el(selector)`, plus `app` itself (camera, renderer, dataset).
- Steps are `NARRATION.map(line => ({...line, ...actions[line.id]}))`
  (`actions.ts:116`), so step ids are the join key between `script.ts` and
  `actions.ts`. `TourStep.run` takes no args (`engine.ts:11`).
- `FacetPanel.toggle/clearAll` and `data-label` on rows exist
  (`src/ui/facets.ts:52-72, 129`); `facetRow()` targets them
  (`actions.ts:37-38`).
- Voice config lives in `script.ts:12-20` (George), hash covers text +
  voice + settings (`hash.ts:25-27`), so every clip regenerates on the voice
  change regardless.
- Selection flight: `main.ts:199-200` focuses at zoom 90 only if below 60.

## Design

### 1. Map rendering (E1)

**1a. Equal-aspect xy.** Extend the spec: `{ type: 'xy'; x; y; equal?: boolean }`
(`layouts.ts:19`). In `xyLayout`, a third branch when `spec.equal`:

```
latMid = (yc.min + yc.max) / 2                     // degrees
kx     = cos(latMid · π/180)                       // lon shrink; 0.57 for the UK
ratio  = (xSpan · kx) / ySpan                       // true map aspect
S      = MAP_SPAN · sqrt(aspect) · pow(n / 900, 0.25)  // MAP_SPAN = 240; n = data.n
w,h    = ratio >= aspect ? [S, S/ratio] : [S·ratio/aspect, S/aspect]
sx     = w / xSpan ;  sy = h / ySpan                // ⇒ sx / sy == kx exactly
size   = MAP_DOT (0.7)                              // not CARD_PITCH
```

Use the **column** extents (`xc.min/max`), never the visible count, so a facet
filter leaves the map where it is (this is D-01's fix applied to the new
branch; leave the raster branch to D). `n` here is `data.n`, not `order.length`,
for the same reason. Bounds/ticks as today (`:307-322`); tick labels via
`fmtTick` give "−6.0 … 2.0" and "50 … 59", acceptable. (The pure `mapScale(xc, yc, n, aspect)` helper returns `{w, h, sx, sy}`.)

Why that `S`: at 900 rows `S ≈ 303`, so the map's height is `S/aspect ≈ 190`
world units; on a 1080p canvas (`fit` pad 72, `camera.ts:97-103`) that is
≈ 4.6 device px per unit → dots ≈ 3 px; at DPR 2 ≈ 6 px. Both sit inside the
flat-dot regime once the LOD band is raised (1c). The quarter-power in `n`
(rather than `sqrt`, which the grid uses) lets the map grow slower than the
data: at the new default 5,000 rows `S ≈ 466`, `h ≈ 291`, dots ≈ 2 px at DPR 1
/ 4 px at DPR 2 with additive overlap doing the work in cities; at 100,000
rows dots are ≈ 1 px and the map reads as a density image. Export `MAP_SPAN`,
`MAP_DOT` and `mapScale()` for the tests.

**1b. Who sets `equal`.** `Dataset.geo?: { lon: string; lat: string }`
(`columnar.ts:31-45`). `currentSpec()` in `main.ts:70-79` sets
`equal: !!ds.geo && x === ds.geo.lon && y === ds.geo.lat`. That keeps the rule
data-driven and leaves hours × satisfaction in fill mode. `PivotApp` exposes
`get isMapView() { return this.spec.type === 'xy' && !!this.spec.equal }` next
to `isRasterView` (`app.ts:434-436`).

**1c. Night-lights look — one draw call, three small renderer changes.**
1. **LOD band as a uniform.** `u_lod: vec2` replacing the literals at
   `shaders.ts:90` (`smoothstep(u_lod.x, u_lod.y, v_px)`); also the rim
   (`:101`, `smoothstep(6,18,…)`) scales with it (`u_lod.x·2, u_lod.y·2`).
   `renderer.lod = [3, 9]` default; `PivotApp.setLayout` sets `[14, 32]` when
   `isMapView`, else default. Effect: on the map a card stays a pure light
   until it is 14 px wide, i.e. until you have zoomed into a town, then turns
   into its card — exactly the tour's "lights become people" beat.
2. **Premultiplied blending + additive lights.** `renderer.ts:165` →
   `blendFuncSeparate(ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)`;
   shader output becomes `vec4(rgb · a, a)` (`shaders.ts:108`) — pixel-identical
   to today for every existing dataset (straight alpha × SRC_ALPHA ≡
   premultiplied × ONE). Then add `u_glow` (0/1). When `u_glow > 0` and
   `texMix < 1`:
   ```
   float r2   = dot(v_local, v_local) * 4.0;              // 0 centre … 1 edge
   float core = exp(-r2 * 3.0);                           // soft radial falloff
   vec3  warm = vec3(1.0, 0.86, 0.62);                    // sodium-lamp white
   vec3  lit  = mix(v_color.rgb, warm, 0.45 * core) * (0.35 + 0.65 * core);
   vec4  add  = vec4(lit * v_color.a * mask, 0.0);        // alpha 0 ⇒ additive
   vec4  card = vec4(rgb * v_color.a * mask, v_color.a * mask);
   outColor   = mix(add, card, texMix);
   ```
   Overlapping lights in a city sum towards white, a lone farmhouse stays a
   dim coloured point; colour-by still reads (Topic hues at the map step,
   the blue ramp at the Contacts step). `glow` follows `isMapView`. A
   `?glow=0` query flag mirrors `?hires=0` (`app.ts:78`) for the baseline
   screenshot.
3. **Size.** No change — `MAP_DOT` comes from the layout. Corner radius stays
   0.14 (invisible at dot size).

Sanity on the SDF path: `mask` (`shaders.ts:85`) still bounds the additive
term, so no square halos; `discard` at `:86` unchanged.

**1d. Default layout for tax-cases.** Generalise the pixel precedent in
`main.ts:305-318`:
```
const geo = app.dataset?.geo;
if (geo && columns[geo.lon] && columns[geo.lat]) { xSel.value = geo.lon; ySel.value = geo.lat; setLayoutKind('xy'); await apply(true); }
else if (rgb && X && Y) { …existing… }
else setLayoutKind('grid');
```
`fillAxisSelects` must run *after* `setLayoutKind('xy')` (it does, at the end of `setLayoutKind`) so
the numeric-only menus contain Longitude/Latitude; the `keep()` at `:169-170`
preserves the values just set. No change to `app.loadDataset`; D-09 (solve once)
is D's, and the grid→map flight on load is harmless — arguably a nice opener.

**1e. Axes on the map.** Keep them (honest, and cheap): the `Longitude`/
`Latitude` titles are the only hint the viewer has that this is lat/lon. Option
for E1 if it reads as chart-junk in the screenshot: `AxisOverlay.set(undefined,
undefined)` when `isMapView`.

**1f. Scatter Y = X bug, Titanic removal, new default collection.**

*Bug (verified; lead's screenshot `screenshots/map-20k-pre-E.png`):*
`app.onDataset` seeds the Y menu with `nums[0]` (`main.ts:179`,
`fillSelect(ySel, [...nums, ...cats], nums[0] ?? …)`). `fillAxisSelects`
(`:161-170`) then *keeps* that value because it is a legal option, and the xy
branch of `currentSpec()` (`:77`) only falls back to `nums[1]` when the value
is not numeric — so with Longitude first, switching tax-cases to Scatter yields
`{x:'Longitude', y:'Longitude'}`: every card on the diagonal, a black canvas.
Fix (E1, in the same `main.ts` edit as 1d): seed Y with `nums[1] ?? nums[0]`
at `:179`; in the xy branch guarantee `y !== x` — `if (y === x) y = nums.find(f
=> f !== x) ?? y` — and write it back to `ySel`. Apply the geo default *after*
these so the map is `{Longitude, Latitude}` by construction, and add a
Playwright assertion (`verify-map.mjs`) that `spec.x !== spec.y` after
clicking the Scatter tab on `tax-cases:20000` (the reported case).

*Titanic removal (B-ask-3, with a one-line `main.ts` change by E3):* every
reference found — `src/data/registry.ts:2,39-44` (family + import; note
`FAMILIES[0]` is the unknown-key fallback in `resolveDataset`, so tax-cases
must move to index 0 and its `load` default becomes `5_000`), `src/main.ts:394`
(boot default `'titanic'` twice → `'tax-cases:5000'`), `src/bench/bench.ts:107`
(`includeTitanic` target → `{ key: 'tax-cases:900', n: 900 }`, keeping the
small-collection bench point), `scripts/verify-hidpi.mjs:85` and
`scripts/tour-e2e.mjs:204` (`?dataset=titanic` → `tax-cases:900`),
`tests/registry.test.ts:75-91` and `tests/datasets.test.ts:4,78` (drop the
titanic cases; keep the products PRNG pin), delete `src/data/titanic.ts`
(`csv.ts` stays — generic), README `:86` data paragraph and the Datasets row.
`public/data/` holds no `titanic.csv` today. `shouldAutoStart` declines only
when `?dataset=` is present (`src/tour/index.ts`), so the bare `/` still
auto-opens the tour, which deep-loads `tax-cases:900` itself (step 2).

*Consequence for the flagship card:* 5,000 rows exceed the per-item ceiling of
3,136 (`app.ts:206`, `hiResCapacity(4096, 64, 4)`), so the **default
collection renders category-template cards** (2c), not the per-customer card
(2b). The per-customer card appears on `tax-cases:900`, which the tour loads.
Two options for the lead: (i) accept — the tour is the showcase and the
default map is a density picture where cards are secondary; or (ii) add a
`3,000` size and make *it* the default (per-item at a 64 px base slot; the
raised LOD band hides that small base art on the map and the hi-res tiers take
over once zoomed). Recommendation: (ii) if the "flagship card" is meant to
greet first-time visitors outside the tour; otherwise (i). Either way the
default opens on the map via 1d.

### 2. Card design (E2)

**2a. Painter hook.** In `src/gl/atlas.ts`:
```
export type CardPainter = (ctx: CanvasRenderingContext2D, w: number, h: number, spec: CardSpec) => void;
export interface CardSpec { …existing…; row?: number; category?: string }
class CardAtlas { painter: CardPainter = drawCard; … drawSlot → this.painter(ctx, slot, slot, spec) }
```
`PivotApp.rasterise` (`app.ts:394-406`) calls `this.atlas.painter` instead of
`drawCard`. New `src/gl/cards/index.ts`: `cardPainterFor(ds: Dataset):
CardPainter` → `ds.kind === 'tax-cases'` (or, fallback, columns `Customer`,
`Postcode`, `Topic` all present) → `taxCasePainter(ds)`, else `drawCard`.
`buildCards` sets `atlas.painter = cardPainterFor(ds)` after `atlas.reset()`
(`app.ts:214`), and `cardSpec` adds `row: i` (`:247`); the template loop adds
`category: cat` (`:224-229`). The painter closes over `ds` and reads values with
`valueAt`/raw typed arrays by `spec.row`. Keep `CardSpec` as the transport so
the generic painter and the hi-res path need no other change.

Also fix the numeric-accent mismatch while there: in `cardSpec`, when the
colour-by column is numeric, `accent = sequential((v − min)/(max − min))`
(`app.ts:245-250`), matching `applyColors` (`:270-277`).

**2b. Customer-record card (per-item, `tax-cases:900`).** All measurements are
fractions of `h` (square slot), rounded to whole px; the same code paints 128,
256, 512 and 1024 because everything is proportional. Two densities:
`compact` when `h < 192` (the 128 px base slot), `full` at 256+ (hi-res tiers).

```
┌────────────────────────────────────────┐  0
│ ▓ accent header  (h·0.26)              │   left: channel glyph tile (h·0.16 square, radius h·0.03,
│ [glyph] Self Assessment      CS-25-000231│   rgba(0,0,0,.28) on the accent); topic name 600 h·0.085 INK;
│                                        │   right: case ref 500 h·0.07 ui-monospace INK 85% (full only)
├────────────────────────────────────────┤  h·0.26
│ Morag Sinclair                (h·0.105)│   name 650 INK, one line, clip
│ G12 8QQ · Glasgow             (h·0.072)│   INK_DIM; postcode tabular-nums
│                                        │
│ ● High   ○ Open      (chip row h·0.09) │   priority chip: pill h·0.09 tall, fill = chip colour @ .18, text = chip colour
│                                        │   status: dot h·0.035 + text INK_DIM
│ ★★★★☆                 3 contacts       │   stars h·0.07 amber, empty = INK_MUTE; NaN → "not surveyed" INK_MUTE
│ Opened 12 Mar         (full only)      │
│ ▁▁▁▁▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃ 36 h  (h·0.045)│   resolution bar: log10 scale 0.1…240 h; accent; Open → dashed track, no fill
├────────────────────────────────────────┤
│ ▓ accent foot rule (max(2, h·0.02))    │  h
└────────────────────────────────────────┘
```

Layout table (fractions of `h`; x from the left inset `h·0.06`):

| element | compact (128) | full (256+) |
|---|---|---|
| header height | 0.26 | 0.26 |
| glyph tile | 0.16 square at (0.06, 0.05) | same |
| topic text | 600 · 0.082 at x 0.26 | 600 · 0.085 |
| case ref | omitted | 500 · 0.07 mono, right-aligned at 0.94 |
| name | 650 · 0.105 baseline 0.26+0.13 | same |
| postcode · town | 400 · 0.072, +0.10 | same |
| chip row | +0.13; chip pad 0.03/0.05 | same |
| stars + contacts | +0.14 | +0.14 |
| opened | omitted | 400 · 0.07 INK_DIM, +0.11 |
| hours bar | h − 0.13, height 0.045, label omitted | label 0.065 right |
| foot rule | max(2, 0.02) | same |

Font floor: `max(9, round(h·f))` — at 128 px the smallest run is 9 px, which
is legible in the atlas at 1:1 (the card is on screen at ≥ 128 device px only
when magnified, and then the hi-res tier takes over at 256+).

Channel glyphs (Canvas2D paths, ≤ 12 segments each, drawn at tile size):
`Phone` handset (rounded rect rotated 35°, two bulbs), `Webchat` speech bubble
with tail, `Web form` document with two lines, `Post` envelope (rect + V).
Stroke `INK`, width `max(1, h·0.012)`.

Colour tokens (add to `atlas.ts` next to `BG/INK/INK_DIM`, reusing
`palette.ts` values so nothing new is invented):

| token | value | from |
|---|---|---|
| `INK_MUTE` | `#6f6e66` | `OTHER.dark` |
| `CHIP_HIGH` | `#e66767` | `CATEGORICAL.dark[7]` |
| `CHIP_STANDARD` | `#3987e5` | `CATEGORICAL.dark[0]` |
| `CHIP_LOW` | `#6f6e66` | `OTHER.dark` |
| `STATUS_OPEN` | `#c98500` | `CATEGORICAL.dark[3]` (amber) |
| `STATUS_RESOLVED` | `#199e70` | `CATEGORICAL.dark[2]` |
| `STAR` | `#c98500` | as above |

Header gradient as today (`atlas.ts:128-132`, accent → `mixHex(accent, BG,
.35)`); body `BG`; all text baselines `Math.round`ed (A's sharpness note).

**2c. Template card (category mode, `tax-cases:5000+`).** One card per
category of the colour-by column (Topic by default). Placeholders look broken,
so the template shows **the category's aggregates**, computed once in the
painter factory (one pass over the typed arrays per rebuild, trivially cheap):

```
header: [initials tile] Topic name            · "Customer service"
body:   "1,530 cases" (650 · 0.105)
        "Phone 48% · Webchat 24%"  top two channels (INK_DIM)
        "Median 0.9 h · 11% high priority"
        hours bar at the median, chip row = share of Open as a status dot
foot:   accent rule
```
When the colour-by is numeric in category mode (`templateField` falls back to
`defaultBucket`, `app.ts:208`), the same layout applies to that field.

**2d. Cost.** 900 × 128 px per rebuild (colour change): ~15 ms measured for the
generic card today; the customer card adds ~6 paths and 5 stars — budget ≤ 40
ms. Hi-res: ≤ 24 cards × 1024 px per tick, same budget A already meets.

### 3. Detail view (E3)

**3a. `src/ui/detail.ts`** — `DetailPane` owning `#detail`:
```
type DetailRenderer = (ds: Dataset, i: number, ctx: { accent: string; esc(s: string): string }) => string;
export function registerDetail(kind: string, r: DetailRenderer): void;
class DetailPane {
  constructor(el: HTMLElement, opts: { onClose(): void; onToast(msg: string): void });
  show(ds: Dataset, i: number, colorBy: string): void;   // picks registry[ds.kind] ?? generic
  hide(): void;
}
```
The generic renderer is today's `showDetail` body moved verbatim, with `esc()`
applied (closes D-25 for this pane; move `esc` from `facets.ts:153` to
`src/core/esc.ts`). `main.ts` keeps `selected`; `onClose` clears the selection
ring (today's close handler inside `showDetail`) and `Escape` (`:283`) calls `detail.hide()` → same
path (closes D-13). Add `role="dialog" aria-labelledby` and focus the close
button on open (D-31).

**3b. Tax-cases renderer** (`src/ui/detail/taxCase.ts`, registered as
`'tax-cases'`), width `.detail.rich { width: 360px }`:

```
header (accent)   Morag Sinclair                       ×
                  G12 8QQ · Glasgow · CS-25-000231
Customer          Postcode G12 8QQ | Town Glasgow | Area type City
                  Age band 60–74 | Region Scotland
Case              Topic Self Assessment | Team Personal Tax | Channel [glyph] Phone
                  Priority [chip High] | Status ● Open | Escalated No
Journey           ○ Opened 12 Mar ── ● 3 contacts ── ● Resolved · 36 h   (or "── ◌ still open")
                  Satisfaction ★★★★☆ (or "not surveyed")
Actions           [Review action]  [Reassign]  [Add note]
```
Timeline: three nodes on a 2 px `--line` track; resolved node filled
`STATUS_RESOLVED`, open node hollow `STATUS_OPEN`; the middle node's label is
`Contacts`. Section headings use the facet `h3` style (`style.css:97-102`).

**3c. Action links must not navigate.** Markup:
`<a href="#" class="action primary" data-action="review">Review action</a>`
(+ `reassign`, `note`). One delegated `click` handler on `#detail`:
`if (a.dataset.action) { e.preventDefault(); onToast('Demo only — "Review
action" goes nowhere here'); }`. `href="#"` keeps them real links (keyboard,
focus ring) while `preventDefault` stops the hash change; the e2e asserts
`location.href` and `framenavigated` are untouched. Also `e.stopPropagation()`
so the tour's capture-phase key handler (`ui.ts:129-143`) is unaffected —
Enter on a focused link is a click, not a "next".

**3d. Toast** — `main.ts` passes its `toast` into `DetailPane`; add
`role="status" aria-live="polite"` to `#toast` (`index.html:67`, D-31).

### 4. Tour revision (impl-C)

Dataset stays `tax-cases:900` (per-item cards, 128 px base, hi-res tiers on
zoom). Sixteen steps, ids new where the beat changed (old ids `dataset`,
`bucket`, `facet2`, `clear` retire; their mp3s are orphaned and removed by the
generator).

`src/tour/columns.ts`:
```
export const TOUR_DATASET = 'tax-cases:900';
export const COL = {
  customer: 'Customer', postcode: 'Postcode', town: 'Town',
  longitude: 'Longitude', latitude: 'Latitude',
  topic: 'Topic', channel: 'Channel', priority: 'Priority', status: 'Status',
  contacts: 'Contacts', ageBand: 'Age band', areaType: 'Area type',
  hours: 'Resolution hours', satisfaction: 'Satisfaction',
} as const;
export const VAL = { selfAssessment: 'Self Assessment', phone: 'Phone', rural: 'Rural', urban: 'Urban', city: 'Glasgow' } as const;
```
(`VAL.city` = `Glasgow`, present in `ukPlaces.ts:222`; the columns test asserts
it and the action falls back to the most-populous town in the data.)

Helpers in `actions.ts` (pure, testable): `rowWhere(ds, field, label, mask)`
→ first row with that category value passing the mask; `worldOf(app, i)` →
`app.renderer.positionOf(i)`; `cardZoom(app, px)` → `px / app.renderer.to[2]`
(zoom that draws one card `px` device pixels wide).

| # | id | target | run (host actions) | minMs |
|---|---|---|---|---|
| 1 | `welcome` | — | — | |
| 2 | `map` | `#layoutSeg [data-layout="xy"]` | `loadDataset(TOUR_DATASET)` if not loaded (opens on the map via 1d); then `setLayout('xy')`, `setSelect('axisX', COL.longitude)`, `setSelect('axisY', COL.latitude)`; `app.fit()` | 1200 |
| 3 | `city` | `#zoomSeg` | `i = rowWhere(Town, VAL.city)`; `app.camera.focus(x, y, cardZoom(app, 44), 1400)` — lights turn into cards as they pass 14 px | 1600 |
| 4 | `grid` | `[data-layout="grid"]` | `setLayout('grid')` (main.ts refits) | |
| 5 | `facet` | `facetRow(COL.topic, VAL.selfAssessment)` | `toggleFacet(COL.topic, VAL.selfAssessment)` | |
| 6 | `sort` | `#sortField` | `setSelect('sortBy', COL.priority)` | |
| 7 | `colour` | `#colorBy` | `setSelect('colorBy', COL.contacts)` | |
| 8 | `bars` | `[data-layout="bars"]` | `setLayout('bars')`; `setSelect('barBy', COL.channel)` | |
| 9 | `area` | `#barField` | `setSelect('colorBy', COL.channel)`; `setSelect('barBy', COL.areaType)` | |
| 10 | `crosstab` | `[data-layout="scatter"]` | `setLayout('scatter')`; `setSelect('axisX', COL.ageBand)`; `setSelect('axisY', COL.channel)` | |
| 11 | `back` | `#facets [data-clear]` | `clearFacets()`; `setSelect('colorBy', COL.topic)`; `setLayout('xy')` (axes still Longitude/Latitude); `app.fit()` | 1200 |
| 12 | `record` | `#gl` | `i = rowWhere(Town, VAL.city)`; `app.camera.focus(x, y, cardZoom(app, 160), 1200)`; `sleep(1250)`; `select(i)` (main.ts opens the pane; zoom ≥ 60 so no second flight) | 1400 |
| 13 | `card` | `#gl` | `app.camera.focus(x, y, cardZoom(app, 520), 900)` — hi-res tier 512/1024 engages on settle | 1200 |
| 14 | `detail` | `#detail [data-action="review"]` | none (pane already open); spotlight the Review action link | |
| 15 | `fit` | `#fitBtn` | `app.fit()` | |
| 16 | `finish` | `#tourBtn` | — | |

Every `run` guards with `has(col)` as today (`actions.ts:35`). `back()` re-runs
the previous step's action (`engine.ts:77-80`), which is safe for all of
these since each sets absolute state.

**Voice.** Female Scottish, chosen from `--list-voices` (filter `labels.accent`
contains "scottish", `gender` female; impl-C records the id and name in
`script.ts` `VOICE`). Settings: `modelId 'eleven_multilingual_v2'`,
`outputFormat 'mp3_44100_64'`, `{ stability: 0.55, similarityBoost: 0.8, style:
0.2, speed: 0.97, useSpeakerBoost: true }`, fixed `seed`. Slightly higher
stability than George's 0.5 keeps the accent consistent across 16 short clips;
0.97 speed because the lines are denser than before.

## Narration script

British English, warm, plain wording that sits naturally in a Scottish voice
(no dialect spelling — the voice carries the accent). **Bold** = exact
`COL`/`VAL` names (the script test asserts this). 15–25 words each.

1. `welcome` — "Welcome to Tessera. Every tile you see is one record, and nothing is ever redrawn — the tiles simply fly to wherever you send them."
2. `map` — "These are **tax customer-service cases**. Plotted by **Longitude** and **Latitude**, our customers light up the map of the UK like towns seen from the sky at night."
3. `city` — "Zoom in on a city and the lights become people: every point is one customer, with their own card, their own postcode, their own case."
4. `grid` — "The grid lays the whole collection out as a mosaic, similar cases side by side — a calmer place to start asking questions."
5. `facet` — "The sidebar filters. Tick **Self Assessment** under **Topic** and you're looking at one kind of case, while every count around it updates."
6. `sort` — "Sort by **Priority**, and the urgent cases move to the front of the queue. Nothing is hidden; the order simply changes."
7. `colour` — "Colour by **Contacts** shows the size of each case — the darker the card, the more times that customer has had to get in touch."
8. `bars` — "Bars stack the cards by **Channel**. Most people still pick up the phone; webchat and forms carry the rest."
9. `area` — "Bucket by **Area type** and colour by **Channel**: in the countryside it's the phone, in the cities it's online. The map already hinted at that."
10. `crosstab` — "Cross-tab **Age band** against **Channel**. Older customers lean on the phone and the post; digital use falls away with age."
11. `back` — "Clear the filter and go back to the map. Every card returns to its place — the analytics were only ever a different arrangement of the same people."
12. `record` — "Pick one customer. Click a light, and the camera takes you to that person's card, with the case summarised on its face."
13. `card` — "Closer still, and the card is a real record: name, postcode, priority, how often they've called, and how long the case has taken."
14. `detail` — "The detail view shows the whole journey, from first contact to resolution, with actions like **Review action** ready to hand — demo buttons here, real ones in yours."
15. `fit` — "Press F, or the Fit button, to see the whole country again whenever you get lost."
16. `finish` — "That's the tour. Replay it any time from the Tour button — then choose a collection, and see what it has to say."

≈ 1,650 characters. Note line 14's bold **Review action** is a UI label, not a
column: add `UI = { review: 'Review action' }` to `columns.ts` and let the
script test accept `COL ∪ VAL ∪ UI`.

## Steps (numbered, files, owner)

**E1 — map layout + lights** (owner: new agent impl-E1)
1. `src/data/columnar.ts:31-45` — add `kind?: string` and `geo?: { lon; lat }` to `Dataset` (2 lines; announce on the bus, B is in that directory).
2. `src/layout/layouts.ts` — `equal?: boolean` on the xy spec; `MAP_SPAN`, `MAP_DOT`, `mapScale()`, the equal branch in `xyLayout` (column extents, `data.n`).
3. `src/gl/shaders.ts` — `u_lod` vec2, `u_glow` float; premultiplied output; glow mix (1c).
4. `src/gl/renderer.ts` — blend func (`:165`), uniforms in the list (`:98`), `lod: [number, number] = [3, 9]`, `glow = 0`, set in `render()` (`:368-374`).
5. `src/app.ts` — `isMapView` getter; in `setLayout` (`:410-426`) set `renderer.lod`/`renderer.glow` from it; `?glow=0` flag next to `hiResEnabled` (`:78`).
6. `src/main.ts` — `equal` in `currentSpec()` (`:70-79`) plus the Y≠X guard (1f); geo default in `load()` (`:305-318`).
7. `tests/layouts.test.ts` — equal-aspect tests (below). `pnpm typecheck`, `pnpm test`.
8. `scripts/verify-map.mjs` (copy the harness of `scripts/verify-hidpi.mjs:1-40`) — DPR-2 map screenshot + assertions.

**E2 — customer card** (owner: impl-E2; starts after E1 step 5 is on the bus, because both touch `app.ts`)
1. `src/gl/atlas.ts` — `CardPainter`, `row`/`category` on `CardSpec`, `painter` on `CardAtlas`, colour tokens, exported `layoutTaxCard(w, h)` (pure geometry table → rects/fonts) used by the painter and the test.
2. `src/gl/cards/index.ts` (`cardPainterFor`) and `src/gl/cards/taxCase.ts` (painter, glyphs, stars, bar, template aggregates).
3. `src/app.ts` — `atlas.painter = cardPainterFor(ds)` in `buildCards` (`:214`); `row`/`category` in `cardSpec`/templates; numeric accent via `sequential`; `rasterise` uses `atlas.painter` (`:403`).
4. `tests/cards.test.ts` — geometry (below). `pnpm test`.
5. Extend `scripts/verify-map.mjs` with the zoomed-card screenshot (or a sibling `verify-card.mjs`).

**E3 — detail view** (owner: impl-E3; starts after impl-C announces `main.ts` done)
1. `src/core/esc.ts` (move from `facets.ts:153-155`; facets imports it).
2. `src/ui/detail.ts` — `DetailPane`, registry, generic renderer (moved from `main.ts:130-152`, escaped).
3. `src/ui/detail/taxCase.ts` — customer renderer, timeline, actions.
4. `src/main.ts` — instantiate `DetailPane`, delete `showDetail`, route `Escape` and close through it; `role="status"` on `#toast` (`index.html:67`).
5. `src/ui/style.css` — append a `/* ---------- detail: customer record ---------- */` block (`.detail.rich`, `.detail section`, `.timeline`, `.chip`, `.actions a`).
6. `scripts/detail-e2e.mjs` (or a phase inside C's `tour-e2e.mjs`) — links do not navigate.

**C — tour** (owner: impl-C, continuing)
1. `columns.ts` (constants above), `script.ts` (16 lines + voice), `actions.ts` (table above + helpers), tests updated.
2. Generate audio only after B's geo columns and E3's `data-action` exist (the `detail` step's target) — text can be frozen earlier; the hash test tells C when clips are stale.

**Sequencing.** B-ask-1/2 (one-liners, B) → E1 → E2 (app.ts after E1);
C's main.ts has landed → E3 can start now (its `main.ts:394` default-key
change rides with the Titanic removal, B-ask-3); C narration/actions any time, audio last. D's groups 5
(renderer/atlas/shaders) and 7 (main.ts/index.html/style.css) start only after
E1/E2 and E3 respectively — update `D-code-review.md` group headers to say so.
Nobody but E1 touches `layouts.ts`/`shaders.ts`/`renderer.ts`; nobody but E2
touches `atlas.ts`; nobody but E3 creates `src/ui/detail*`. Each agent posts
"landed" on the bus with the file list.

## Verification

**vitest (node env, no DOM)**
- `tests/layouts.test.ts`: for lon ∈ [−6, 2], lat ∈ [50, 59], 900 points —
  `sx/sy === cos(54.5°)` within 1e-6; bounds aspect `w/h === (8·cos)/9`;
  bounds fit inside `[S, S/aspect]` with `S = 240·sqrt(1.6)` at n = 900 and
  `×(5000/900)^0.25` at n = 5000; every size `=== MAP_DOT`; a half mask
  gives identical `sx, sy, bounds` (column extents rule); `equal: false`
  reproduces today's numbers; NaN rows get size/alpha 0.
- `tests/cards.test.ts`: `layoutTaxCard(128)` → every rect inside `[0,128]²`,
  no overlaps among text rows (y-sorted, gaps ≥ 0), smallest font ≥ 9;
  `layoutTaxCard(256)` is the `full` variant (case ref + opened present) and
  every coordinate equals `2×` the 128 value ± 1 (proportionality — the hi-res
  tiers must not re-flow); `layoutTaxCard(1024)` smallest font ≥ 72.
- `tests/tour-script.test.ts`: existing rules + bold terms ∈ `COL ∪ VAL ∪ UI`,
  16 ids, orphan mp3 detection. `tests/tour-columns.test.ts`: every `COL`
  exists in `generateTaxCases(900)` with the expected kind; `VAL.city` is a
  `Town` label; `Area type`/`Age band` labels match `VAL` (`Urban | Suburban |
  Rural`, `18–29 … 75+`); no `titanic` key in `menuEntries()` after B-ask-3.
- Regression: `pnpm test`, `pnpm typecheck`.

**Playwright** (per the `playwright-wsl` skill; harness as `verify-hidpi.mjs`)
- `scripts/verify-map.mjs`: `deviceScaleFactor: 2`, 1920×1080,
  `/?dataset=tax-cases:900&tour=0`; wait `pivotBenchReady`; assert
  `window.pivot.spec` is `{type:'xy', x:'Longitude', y:'Latitude', equal:true}`,
  `pivot.bounds` aspect ≈ `(lonSpan·cos(latMid))/latSpan` from the column min/max (±2 %), `lastFrame.atlasSlot === 128`;
  screenshot `screenshots/map-dpr2.png`. Numeric check: mean luminance of the
  centre 60 % of the canvas > 3× the same crop with `?glow=0` (additive lights
  are brighter), and the fraction of pixels above 0.8 luminance < 5 % (not a
  white blob). Repeat at DPR 1 (no assertion on brightness ratio, screenshot
  only).
- Zoomed card: `pivot.camera.focus(x, y, 520/size, 0)` on the Glasgow row,
  wait 700 ms, assert `lastFrame.hiRes.tier >= 512`, screenshot
  `screenshots/tax-card-zoomed.png`; also at zoom giving 128 px for the base
  slot → `screenshots/tax-card-128.png` (manual legibility check).
- `scripts/detail-e2e.mjs`: load, `window.pivot.onSelect(i)`; assert
  `#detail[role=dialog]` visible, three `#detail a[data-action]`; for each:
  record `location.href`, count `page.on('framenavigated')`, click, assert href
  unchanged, count 0, `#toast` visible containing "Demo only"; press Escape →
  pane hidden and `pivot.renderer` selection cleared (style byte via
  `uploadStyleAt` is private — assert through `selected` exposed on `window.pivot`
  or a `detail.hidden` check plus a second `onSelect(-1)` no-throw).
- Tour: extend C's `tour-e2e.mjs` step assertions for the new ids (`spec.type`,
  `colorBy`, facet checkbox, `#detail` visible at `detail`, zoom increases at
  `city`/`card`).
- Blend regression: `tax-cases:900` grid screenshot before/after the premultiplied
  change, mean absolute pixel difference < 1/255 (E1 runs it once, notes the
  number in PROGRESS.md).

## Risks

- **The UK must read as the UK from lights alone.** No coastline is drawn. Needs
  B's `ukPlaces.ts` to be population-weighted with ≥ ~120 settlements plus
  rural jitter ≤ 0.15° so no dot lands far out to sea. Mitigation: E1's DPR-2
  screenshot is the acceptance test; if it doesn't read, ask B for more
  places before touching the renderer.
- **Blend-function change is global.** Mathematically identical for straight
  alpha, but `preserveDrawingBuffer` + `alpha:false` (`renderer.ts:71-81`)
  means any mistake shows everywhere. The Titanic pixel-diff check gates it.
- **Dot size depends on the buffer, not the CSS size** — at DPR 3 the fit view
  draws ~9 px dots, still under the raised 14 px LOD floor; at DPR 1 on a small
  laptop ~2.5 px. Acceptable range; `MAP_SPAN` is one constant if not.
- **`app.ts` is edited by A (done), B (registry), E1, E2** — sequenced above;
  each edit is a few lines in distinct regions (`setLayout`, `buildCards`).
- **Category-mode aggregates** cost one pass per rebuild — negligible at 100k
  (< 5 ms) but must not allocate per row.
- **Tour step 12 relies on `main.ts:200` not re-flying** (zoom ≥ 60 after the
  focus) — if E3 or D changes that rule, the `record` step's own focus must
  land first; the `sleep(1250)` covers the flight.
- **Narration bold terms outside columns** (`Review action`) need the `UI`
  set or the script test fails — called out above.
- **Voice availability**: a Scottish female voice may only exist in the
  ElevenLabs library (not the default list); `--list-voices` may need
  `client.voices.search` with `voiceType: 'community'`; fall back to adding the
  voice to the account first.
- **D-01 remains** for pixel collections; the new branch sidesteps it rather
  than fixing it — D's item, noted so it isn't double-fixed.

### Self-review amendments (applied above)
- Dropped a per-dataset `theme` hint: the map look is a *layout mode*
  (`equal`), not a dataset colour scheme, so colour-by stays honest and the
  same rule serves any future lat/lon dataset.
- Moved the "lights" mechanism from a colour hack to the LOD band + additive
  premultiplied blending after checking `shaders.ts:88-101` — flat dots under
  the band already exist; only the accumulation and the warmth were missing.
- Replaced placeholder dashes on template cards with per-category aggregates.
- Made the card geometry a pure exported function so it is testable under
  vitest's node environment (no canvas there).
- Step 12 selects *after* the flight so `main.ts:200`'s zoom-90 rule cannot
  fight the tour's camera.
- Added `UI` bold-term set after noticing the script test would reject
  "Review action".
- Lead's late notes folded in as 1f: the Scatter `y === x` bug (`main.ts:179`
  seeds Y with the first numeric; `currentSpec()` never checks `y !== x`), the
  Titanic removal with every reference listed, `tax-cases:5000` as the default
  (which is category mode — flagged, with a 3,000-row per-item alternative),
  and the map spread re-derived as `n^0.25` so 5,000+ dots stay lights rather
  than a blob. B's landed labels (`Urban | Suburban | Rural`, `18–29 … 75+`)
  replace the guessed ones; `main.ts` line refs re-anchored after C's landing.
