# Tessara

**Live demo:** https://harryrobbins.github.io/tessera/ — frame rates depend on
your GPU (see [Measuring performance honestly](#measuring-performance-honestly)).

A GPU **unit visualisation** engine for the browser. A *tessera* is the single
tile in a mosaic — one row of your data, meaningless alone, legible in the mass.

Every row is a card, and the cards fly between layouts instead of being
redrawn. It is a modern rebuild of Microsoft Live Labs Pivot, with Silverlight
and Deep Zoom replaced by WebGL2 instancing, a Web Worker layout solver, and a
Canvas2D card atlas.

```bash
pnpm install
pnpm dev            # http://localhost:5180
pnpm test           # vitest, 58 unit tests
pnpm bench          # headless benchmark -> bench-results/*.json
```

## What works today

| | |
|---|---|
| **Layouts** | Grid (sorted mosaic), Bars (cards stacked into buckets), Cross-tab (binned X × Y), Scatter (raw numeric axes) |
| **Datasets** | Titanic (891), synthetic products up to 2,000,000 rows, and pixel collections built from a photograph |
| **Interaction** | Wheel zoom about the cursor, drag pan, click for the detail pane, cross-filtering facet sidebar |
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
   Card art comes from a 4096² atlas; colour, atlas rect and stagger delay are
   per-instance attributes.
3. **Automatic LOD in the fragment shader.** Under ~3 device pixels a card is a
   flat rounded dot; the texture fades in between 3 and 9 px. No popping, no
   separate code path for "zoomed out".

Cards are drawn per row up to the atlas capacity (~950). Above that the atlas
holds one card per category and cards are tinted per row — invisible until you
zoom into one card, and it keeps texture memory flat at any collection size.

## Measuring performance honestly

Two traps, both hit and fixed during the first build:

- **`requestAnimationFrame` intervals are not frame times.** The GPU can be
  seconds behind while rAF still ticks at 60 Hz. The renderer issues
  `EXT_disjoint_timer_query_webgl2` queries around the draw and **paces frames**
  to them — if the GPU is two frames behind, the tick is skipped. The HUD's
  headline number is the pessimistic of wall-clock FPS and `1000/gpuMs`.
- **Idle frames must not be counted.** A still collection redraws at 10 Hz to stay
  cool; those frames are excluded from the statistics.

`pnpm bench` runs the same phases on every machine — `static`, `morph` (grid →
bars → cross-tab), `pan`, `zoom` — across a size sweep, and writes
`bench-results/<host>-<timestamp>.json` with the unmasked GPU string, so a laptop
and a workstation can be compared directly. `bench-results/latest.json` always
holds the most recent run. See `scripts/README.md`.

Headless Chromium on WSL2 falls back to **llvmpipe** (software). Those numbers
are a CPU-rasterised floor, not this machine's GPU — run `pnpm dev` and press
**Benchmark** in a real browser window for representative figures.

## Data

`public/data/titanic.csv` is picked up automatically if present (the real 891-row
Kaggle file); otherwise a deterministic synthetic stand-in with the same schema
and plausible marginals is generated. Products are generated in-browser: 1M rows
in well under a second, with no per-row string allocation.

### Pixel collections

Every pixel of a photograph is a row: `X`, `Y`, `R`, `G`, `B`, `Luminance`,
`Hue`, `Saturation`, `Lightness`, CIELAB `L*`/`a*`/`b*`, `Chroma`, plus
categorical `Hue family` and `Tone` bands. Two public-domain paintings ship in
`public/data/` (credits in `public/data/CREDITS.md`).

They open in the **Scatter** layout with `X`/`Y` on the axes, which reproduces
the picture exactly — then any other layout explodes it into a chart while every
pixel keeps its own colour. Two engine features exist for this:

- `Dataset.rgb` — per-row true colour. The Colour menu offers **True colour**,
  which paints each card its own pixel value instead of a categorical hue.
- `Dataset.cards = false` — no atlas at all. Items render as flat quads with
  near-square corners so they tile seamlessly.

**Segmentation.** `loadPixels` looks for `data/<image>.segments.png` alongside
the image plus a `data/<image>.segments.json` label map, and if both are present
adds a `Segment` categorical column. That is the hook for SAM output: export the
masks as a colour-indexed PNG at any resolution and a JSON id→label map, drop
both in `public/data/`, and segments become a facet you can filter and bucket by
like any other. Without them the column is simply absent.

## Deploying

Push to `main` and `.github/workflows/deploy.yml` builds and publishes to
GitHub Pages at the URL above. Typecheck and the vitest suite gate the
`vite build` step — a broken build never reaches Pages. Pages serves from a
sub-path, so `vite.config.ts` sets `base: './'` (relative); runtime
`fetch()`s in `src/data/` already use relative paths, so they resolve the
same way in dev and under the sub-path regardless of the repo name.

## Not built yet

Deep Zoom tile streaming for true 1:1 card resolution, timeline layout, range
sliders on numeric facets, DuckDB-WASM for aggregate-heavy queries, and a WebGPU
backend behind the same renderer interface.
