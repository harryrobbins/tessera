# Tessera

**Live demo:** https://harryrobbins.github.io/tessera/ — frame rates depend on
your GPU (see [Measuring performance honestly](#measuring-performance-honestly)).

A GPU **unit visualisation** engine for the browser. A *tessera* is the single
tile in a mosaic — one row of your data, meaningless alone, legible in the mass.

Every row is a card, and the cards fly between layouts instead of being
redrawn. It is a modern rebuild of Microsoft Live Labs Pivot, with Silverlight
and Deep Zoom replaced by WebGL2 instancing, a Web Worker layout solver and a
Canvas2D card atlas.

## Quick start

```bash
pnpm install
pnpm dev            # http://localhost:5180
pnpm test           # vitest suite
pnpm test:e2e       # walks the guided tour in headless Chromium (port 5182)
pnpm build          # tsc --noEmit && vite build -> dist/
pnpm bench          # headless benchmark -> bench-results/*.json
pnpm voiceover      # regenerates tour narration audio (needs ELEVENLABS_API_KEY; see below)
```

`pnpm typecheck` and `pnpm preview` (port 4173) are there too. The Playwright
scripts want Linux node and the bundled Chromium; on WSL2 see the
`playwright-wsl` skill.

## What works today

| | |
|---|---|
| **Layouts** | Grid (sorted mosaic), Bars (cards stacked into buckets), Cross-tab (binned X × Y), Scatter (raw numeric axes), and an equal-aspect **map** that geographic collections open on — the UK drawn as night lights from its customers' coordinates |
| **Datasets** | Tax customer-service cases (900 / 3,000 / 20,000 / 100,000; default 3,000, with UK geography and a synthetic customer), tax returns and card payments (to 1,000,000), supplier invoices (to 100,000), products (1,000 to 2,000,000) and pixel collections built from a photograph (250k or 1M pixels) |
| **Cards** | Every card is one record at any collection size; a dataset declares its own slots (topic, title, blurb, two tags, one metric) or opts into a hand-drawn design. **Cards** in the top bar switches design, drops labels for pure colour, mutes tags, or re-points the title |
| **Interaction** | Wheel zoom about the cursor, two-finger pinch, drag pan, `−`/`+` stepped zoom, `F` to fit, click a card for its record in an expanding modal, keyboard walk with the arrow keys, cross-filtering facet sidebar, a narrated guided tour on first visit |
| **Measurement** | Live FPS + GPU-time HUD, and a scripted benchmark that writes comparable JSON per machine |

## Architecture

```
UI (main.ts)  ──filters/layout──▶  Worker (layout/worker.ts)
                                     radix sort + bucket solve
                                     ▼ Float32Array(n×4), transferred
              CardRenderer  ──▶  GPU: one instanced draw call
                 from/to/style buffers      vertex shader tweens from→to
```

Three ideas carry the performance:

1. **Nothing animates on the CPU.** A layout change uploads `from` and `to` once;
   every frame after that changes a single uniform (`u_t`). The vertex shader
   interpolates and eases per card.
2. **One draw call, always.** Every card is an instance of the same unit quad.
   Card art comes from a single atlas texture (4096² where the GPU allows);
   colour, atlas rect and stagger delay are per-instance attributes.
3. **Automatic LOD in the fragment shader.** Under ~3 device pixels a card is a
   flat rounded dot; the texture fades in between 3 and 9 px. No popping, no
   separate code path for "zoomed out".

**Base atlas.** Cards are drawn per row while the collection fits the atlas at a
64 px slot (~3,100 rows on a 4096² texture), with the slot sized to the
collection (`slotFor`: 900 cards get 128 px; a hundred get 256). Above that the
atlas holds one **cover** per category — the category's accent, its initials and
its name, a label that cannot be mistaken for a record at any size — and cards
are tinted per row. Texture memory stays flat at any collection size.

**Hi-res atlas** (`src/gl/hires.ts`, `src/app.ts`) is where uniqueness comes
from above that cap. Once the camera has settled and cards are at least 48
device pixels wide, every card in view is re-rasterised *as its own row* into a
second, lazily allocated atlas and flipped to it by a per-instance flag — still
one draw call. Two rules make it uniform rather than merely sharp:

- **The tier is fitted to the viewport, not to the card.** `planTier` starts at
  the next power of two above the drawn size and steps down until the atlas can
  hold every visible card at it. The old size-only rule asked for 1024 px, of
  which a 4096² texture holds nine — so nine cards were crisp and the rest were
  the 64 px base slot stretched over hundreds of pixels. At most a 1.5× upscale
  in a narrow band above each power of two buys a uniformly sharp board.
- **The commit is atomic.** Rasterising runs to a pixel budget
  (`HIRES_PIXEL_BUDGET`, 4 Mpx per tick — a card budget cannot bound the work,
  since 24 cards is 25 Mpx at tier 1024 and 98 kpx at tier 64) and the
  instances flip only once every card on screen has its own art, so a record is
  never drawn beside a group cover.

**Map and night lights** (`src/layout/layouts.ts`, `src/gl/shaders.ts`). A
dataset that declares `geo: { lon, lat }` opens on `{ type: 'xy', equal: true }`:
the layout scales longitude by `cos(latitude)` so the country keeps its shape,
and sizes the frame from the column extents and the full row count, so a facet
filter never moves the map. On the map the renderer widens the LOD band to
14–32 px and turns on `u_glow`: under that band each card's quad grows into a
halo (three times the card, and never under 2.5 device px on screen) with a
warm gaussian core emitted additively, so towns sum towards white while the
card itself keeps its true size inside the quad. The core's amplitude falls
with the halo's area, so a card's *total* emission is independent of zoom —
without that the far view blooms into a wash instead of resolving into points,
because every card emits more light the further out you go. Output is
premultiplied (`ONE, ONE_MINUS_SRC_ALPHA`), which is pixel-identical to the old
straight-alpha blend for ordinary cards. `?glow=0` gives the plain-dot
baseline.

## Reading one record

Clicking a card opens it as a modal dialog that **expands out of the card's own
rect** (FLIP, `src/ui/detail/flip.ts`): the camera flies in first when the card
is a speck, so the dialog grows from what the viewer is actually looking at.
`#app` is `inert` while it is open, so nothing behind it is tabbable or
clickable, and `prefers-reduced-motion` skips the flight entirely rather than
shortening it.

The modal is the card, expanded, then what the card had no room for: the same
header slots in the same order and colour, metric tiles, the dataset's declared
sections, and a **Context** block giving each facet value's share of the
*currently filtered* set — "Post · 10 % of the 12 records on screen". That is
where the old per-category summary card went: the same statistics, attached to
a record they are actually about, computed against what is on screen rather
than the whole collection. `registerDetail` still wins for a dataset that wants
a bespoke block (`tax-cases` keeps its contact-to-resolution timeline).

**Cards** in the top bar is a popover over four preferences, persisted in
`localStorage` (`src/ui/settings.ts`): *Design* (the collection's own choice,
the simple template, or its hand-drawn card), *Labels* (off drops the atlas
entirely — flat colour at every zoom, which reads better at 100,000 cards and
is the cheapest path on a weak GPU), *Tags*, and *Title*. Only the design is
deep-linkable, as `?cards=quiet`: the rest are personal preferences, not
something a shared link should impose. The tour resets them on its first step
so a saved preference cannot desynchronise it from the narration.

The canvas is a real control: `tabindex="0"`, arrow keys walk between cards,
`Home`/`End` jump to the first and last visible, `Enter` opens the record, and
a visually-hidden live region announces the focused card in the same words the
card paints. Where cards are below the LOD band and no art is legible, a chip
follows the cursor with the hovered card's title and topic — the only way to
answer "what is that one?" without zooming. `renderer.pick` is `O(n)`, so
hover is throttled to one pick per frame and switched off above 200,000 rows.

## Guided tour

First visit opens a welcome card offering a two-minute narrated walkthrough
(`src/tour/`). It is a story told against the data rather than a feature
list: three thousand tax customer-service cases on a map of the UK, coloured
by channel; bars and a cross-tab showing that post belongs to the countryside
and the over-seventy-fives; a scatter in which a letter takes five and a half
days where a webchat takes half an hour; filters down to twelve open,
high-priority cases on paper; a grid sorted by how often each customer has had
to chase; then a flight into one person's card and their detail record. Every
number in the narration is asserted against `tax-cases:3000` in
`tests/tour-story.test.ts`, so a generator change fails the build before a
visitor hears a story the picture no longer tells.

The caption card sits beside whatever is spotlit, with an arrow pointing at
it, and flips above, right or left to stay in the viewport. Keys: `→`/`Space`
next, `←` back, `Esc` skip, `M` mute. The **Tour** button replays it;
`?tour=1` forces it; `?bench=1` or a `?dataset=` deep link suppress it; and
finishing or dismissing sets `localStorage['tessera.tour.v1']` so it does not
open again.

Steps are data-driven: `src/tour/script.ts` holds the narration (title, text
and the ElevenLabs voice settings), `actions.ts` binds each line's id to what
the app does, and `columns.ts` is the only place the tour knows column names
(a test checks that every bold term in the narration is one of them).

**Narration audio** is pre-generated with ElevenLabs and committed under
`public/audio/tour/` (one mp3 per line plus `manifest.json`); nothing is
synthesised at runtime or in CI. When a clip is missing, blocked by autoplay
policy, or muted, the step stays up for a reading-pace timer instead, so the
tour works without audio. To (re)generate:

```bash
# ELEVENLABS_API_KEY in .env.local (gitignored; never a VITE_ var)
pnpm voiceover --add-voice     # once: adds the library voice to the workspace
pnpm voiceover --dry-run       # shows the characters that would be billed
pnpm voiceover                 # only lines whose text/voice hash changed regenerate
```

The voice is Isla Skye (`TVmbglAk3F1GkiCoOq47`), a shared library voice, so it
has to be in the workspace before it can be used. `--add-voice` does that if the
key has the `add_voice_from_voice_library` permission; otherwise add it in the
ElevenLabs UI (Voice Library → Isla Skye → Add to my voices) first. Once the
manifest exists, `tests/tour-script.test.ts` fails whenever a line is edited
without its clip being regenerated, and caps the total at 1.5 MB.

## Data

Every collection except the pixel images is generated in the browser, on
demand, from a seeded PRNG (`src/data/random.ts`): 1M rows in well under a
second. Nothing is downloaded and nothing describes a real person — names come
from a seeded [faker](https://fakerjs.dev) (`en_GB` locale, loaded lazily so it
stays out of the main bundle).

**A collection's shape does not depend on its size.** `tax-cases:100000` has
the same columns, the same label column and the same card as `tax-cases:900`.
The identity columns that make that affordable — `Case`, `Return`,
`Transaction`, `Invoice`, `Product` — are **derived** rather than stored
(`derivedText`, `src/data/columnar.ts`): each is a formula over the row index
or over columns already in memory, so a million of them cost nothing instead of
~80 MB of strings. Only text that genuinely varies per row is materialised: the
customer's name, and a postcode whose inward code is drawn from the row's own
PRNG stream. Families are registered in `src/data/registry.ts`, which
builds the Collection menu and resolves `?dataset=<key>` deep links
(`tax-cases:3000`, `payments:1000000`, `pixels:great-wave:250000`, …); an
unknown key falls back to the default, `tax-cases:3000`.

| Key | Rows | What it shows |
|---|---|---|
| `tax-cases` | 900 / 3k / 20k / 100k | Customer-service cases for a tax authority: topic, channel, priority, team, status, escalation, contacts, resolution hours, satisfaction, plus a synthetic customer with age band, area type, UK town, postcode and coordinates. The default collection and the one the tour uses. |
| `tax-returns` | 900 / 10k / 100k / 1M | Self-assessment returns: sector, income band, filing month, late filing and penalties, progressive tax due. |
| `payments` | 900 / 10k / 100k / 1M | Card payments: merchant category, method, country, hour of day, amount, and a fraud flag with a risk score driven by the same signals. |
| `invoices` | 900 / 10k / 100k | Supplier invoices: department, spend category, supplier (36 faker names at every size, as the layouts group by them), status, days to pay. |
| `products` | 1k / 10k / 100k / 500k / 1M / 2M | Trade-style product lines: type, country, region, year, value, units, margin. The benchmark sweep. |
| `pixels:<image>` | 250k / 1M | Every pixel of a photograph as a row (below). |

**Geography.** `src/data/ukPlaces.ts` is a small gazetteer of populated places
with coordinates and postcode areas; each tax case's customer is placed in one
of them, weighted by population, so the map draws the country from its towns.

**Engineered correlations.** Channel follows area type and age band (post is
rural and elderly, webchat urban and young), resolution hours follow channel,
satisfaction falls with hours, tax due is progressive in income, fraud risk
follows the fraud signals. Every categorical has a fixed order (so `Priority`
reads Low → High and `Month` reads Jan → Dec), heavy-tailed numerics are
clipped at generation so the 12 equal-width bins in Bars and Cross-tab read
well, and the first facets of each family are chosen so the default colour,
sort and axes tell a story without touching a menu. Generators are pure
functions covered by `tests/datasets.test.ts` (determinism, marginals,
correlations); `tests/registry.test.ts` pins the `tax-cases` column contract
the tour depends on.

**Dataset hooks** (`src/data/columnar.ts`). Beyond its columns a `Dataset` may
declare `geo` (the map default), `rgb` (per-row true colour), `cards: false`
(no atlas; flat quads), `colors` (pinned colours per category per column), and
`kind` (a family tag that a bespoke detail renderer can register against).

**What a card says** (`src/data/card.ts`). A dataset declares its own record
in six named slots — `topic`, `mark`, `title`, `blurb`, up to two `tags` and
one `metric` — each naming a column or an accessor:

```ts
card: {
  topic: 'Topic',                       // eyebrow: what the accent means
  mark: { glyph: 'Channel' },           // header tile, else the title's initials
  title: 'Customer',
  blurb: (i) => `${postcodes[i]} · ${TOWNS[town[i]]}`,
  tags: [
    { value: 'Priority', shape: 'pill', tone: { High: 'bad' }, hideWhen: ['Standard'] },
    { value: 'Status', shape: 'dot', tone: { Open: 'warn', Resolved: 'good' } },
  ],
  metric: { value: 'Contacts', label: (i) => (contacts[i] === 1 ? 'contact' : 'contacts') },
  custom: 'taxCase',                    // optional: a hand-painted design instead
}
```

`compileCard` (`src/gl/cards/model.ts`) turns that into one closure that
refills a **single reusable object**, so drawing a card allocates nothing but
the strings a number formatter unavoidably produces. Declare nothing and the
defaults derive a sensible card from the label column, the colour-by field and
the leading facets. `detail` declares the modal the same way — `subtitle`,
`sections`, `context` (which facets get a share bar) and `actions` — and
`detail.custom` names a renderer registered with `registerDetail`, which is how
`tax-cases` keeps its bespoke journey timeline. Both are contract-tested in
`tests/card-template.test.ts`: every declared slot must name a column that
exists, at every size.

**Category colours** (`src/core/palette.ts`). `colorOfRow` is the one source
for a row's colour — card accent, instance tint, legend swatch and detail-pane
header all derive from it. Categorical columns use, in order: explicit
`Dataset.colors` pins; colours auto-detected from the category names when every
label names a colour and at least one carries an unambiguous hue word (`Red`,
`Dark blue`, `Greyish` — so a `Hue family` facet paints itself, and neutrals go
grey); otherwise the fixed-order CVD-safe palette, with a ninth category
folding into "Other". Numeric colour-by samples
a sequential blue ramp.

### Pixel collections

Every pixel of a photograph is a row: `X`, `Y`, `R`, `G`, `B`, `Luminance`,
`Hue`, `Saturation`, `Lightness`, CIELAB `L*`/`a*`/`b*`, `Chroma`, plus
categorical `Hue family` and `Tone` bands. Three public-domain images ship in
`public/data/` (credits in `public/data/CREDITS.md`): two paintings, and
Adolphe Millot's *Papillons* plate — dozens of discrete, differently coloured
butterflies and moths on a plain ground, which is what segmentation below is
for (a painting has no discrete objects to segment).

They open in the **Scatter** layout with `X`/`Y` on the axes, which reproduces
the picture exactly — then any other layout explodes it into a chart while every
pixel keeps its own colour. The Colour menu offers **True colour**, which
paints each card its own pixel value instead of a categorical hue.

**Whole-pixel scales** (`src/gl/zoom.ts`). A raster is free of moiré only when
a cell covers a whole number of device pixels; at 1.42 each cell covers either
one device pixel or two, and that alternation reads as a grid ruled over the
picture. Framing a pixel collection rounds to the nearest whole scale, and the
`−`/`+` buttons step the ladder — … 1:3, 1:2, 1:1, 2:1, 3:1 … — so every stop
is clean. The metrics readout shows the current scale, and flags it when free
zoom has left the ladder. Card collections have no such constraint and step
geometrically.

**Segmentation.** `loadPixels` looks for `data/<image>.segments.png` alongside
the image plus a `data/<image>.segments.json` label map, and if both are present
adds a `Segment` categorical column (plus a numeric `Segment area`, in native-
resolution pixels, NaN where unsegmented). Export masks as a colour-indexed PNG
at native resolution and a JSON id→label map, drop both in `public/data/`, and
segments become a facet you can filter and bucket by like any other. Without
them both columns are simply absent.

`pipeline/` is a self-contained `uv`-managed Python pipeline (separate from the
web app) that runs **FastSAM-s** — a SAM-family automatic mask generator
practical on CPU — over an image, cleans up the raw masks (drops tiny and
duplicate proposals, resolves overlaps so a specimen always beats the coarser
background region it sits inside), and writes the `.segments.png` +
`.segments.json` pair:

```bash
cd pipeline
uv run segment.py ../public/data/millot-papillons.jpg --out-dir ../public/data
```

The committed *Papillons* segmentation has 58 specimen segments; the plain
background is left `Unsegmented`. Bucket that collection by `Segment` in the
Bars layout with Colour = True colour to see it — each bar is one specimen's
pixels, in their own colours. See `pipeline/README.md` for model choice and
the CPU-only dependency pinning.

## Measuring performance honestly

Two traps, both hit and fixed during the first build:

- **`requestAnimationFrame` intervals are not frame times.** The GPU can be
  seconds behind while rAF still ticks at 60 Hz. The renderer issues
  `EXT_disjoint_timer_query_webgl2` queries around the draw and **paces frames**
  to them — if the GPU is two frames behind, the tick is skipped. The HUD's
  headline number is the pessimistic of wall-clock FPS and `1000/gpuMs`.
- **Idle frames must not be counted.** A still collection is not redrawn at all
  (the preserved drawing buffer stays on screen); only rendered frames enter the
  statistics.

`pnpm bench` runs the same phases on every machine — `static`, `morph` (grid →
bars → cross-tab), `pan`, `zoom` — over `tax-cases:900` and a `products` size
sweep (1k to 1M), and writes `bench-results/<label>-<timestamp>.json` with the
unmasked GPU string, so a laptop and a workstation can be compared directly.
`bench-results/latest.json` always holds the most recent run. See
`scripts/README.md`.

Headless Chromium on WSL2 falls back to software rendering (SwiftShader or
llvmpipe). Those numbers are a CPU-rasterised floor, not this machine's GPU —
run `pnpm dev` and press **Benchmark** in a real browser window for
representative figures.

The floor, for reference (`bench-results/after-wp3-*.json`, Core Ultra 7 155H,
llvmpipe, 1048×668 canvas): 60 fps at 900 and 1,000 cards, 42–51 fps at 10,000,
11–18 fps at 100,000, 2–4 fps at 500,000, and 1,000,000 does not complete a
phase. A GPU run has not been captured on this machine, so **no GPU baseline
exists yet** — the earlier `bench-results/before-*.json` is a SwiftShader run
that reports p95 = 0 above 10,000 rows and cannot be compared against.

## Verification scripts

Each boots its own vite on its own port, drives the bundled Chromium, and
kills the server on exit; screenshots land in `screenshots/`. Add
`--swiftshader` for a reproducible CPU-only run.

- `pnpm test:e2e` (`scripts/tour-e2e.mjs`, port 5182) — walks every tour step with the audio stubbed, asserting caption, spotlight placement and app state.
- `node scripts/detail-e2e.mjs` (port 5195) — the record modal is a dialog that makes the app inert, expands out of the card it came from (and does not move at all under `prefers-reduced-motion`), and whose demo action links never navigate.
- `node scripts/verify-hidpi.mjs` (port 5191) — the hi-res tier engages at DPR 2 and 1, and edges are measurably sharper than with `?hires=0`.
- `node scripts/verify-card.mjs` (port 5196) — screenshots the flagship customer card zoomed and in a grid, and asserts that two same-topic neighbours on a 20,000-row collection are different records pixel for pixel.
- `node scripts/verify-cards.mjs` (port 5197) — the Cards popover's four controls, the deep link, and the canvas as a control: the keyboard walk, its live region, and the cursor chip that names a card too small to draw one.
- `node scripts/verify-map.mjs` (port 5194) — the geo collection opens on the equal-aspect map, the lights are brighter than plain dots without saturating, zooming out resolves into points rather than blooming, and the premultiplied blend is pixel-identical for ordinary cards.
- `node scripts/_verify-subpath.mjs` — the built demo boots under a `/tessera/` mount (run by the deploy workflow).
- `pnpm bench` (`scripts/bench-headless.mjs`, port 5181) — see above.

## Deploying

Push to `main` and `.github/workflows/deploy.yml` builds and publishes to
GitHub Pages at the URL above. Typecheck, the vitest suite and a sub-path
smoke test gate the deploy: the workflow serves `dist/` under `/tessera/` with
`vite preview` and runs `scripts/_verify-subpath.mjs` against it, so a wrong
base never reaches Pages. Pull requests build and smoke-test only. Pages
serves from a sub-path, so `vite.config.ts` sets `base: './'`; runtime
`fetch()`s in `src/data/` use relative paths and resolve the same way in dev
and under the sub-path regardless of the repo name.

## Not built yet

Deep Zoom tile streaming for card art beyond 1024 px, timeline layout, range
sliders on numeric facets, DuckDB-WASM for aggregate-heavy queries, and a
WebGPU backend behind the same renderer interface.
