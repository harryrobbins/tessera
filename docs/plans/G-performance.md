# Plan G — The performance pass

Written and implemented 2026-08-27, against the first **real GPU** baseline the
project has had: `bench-results/manual-json-2026-08-27T11-46-49.json` (Windows
Chrome, Intel Arc via ANGLE D3D11, DPR 1, 3608×1987 canvas, 22 cores). Every
"before" number below is either from that file or from an A/B on this machine
with the method stated beside it.

---

## 0. What the baseline actually said

Frames per second are 120 at every size to 500,000 cards and p50 is a flat
8.30 ms. That is the vsync interval, not headroom: **fps cannot go up and is not
a target.** Three things in the file are real:

| Reading | Value | Verdict |
|---|---|---|
| `worst` frame, `tax-cases:900` static | **91.7 ms** | 11× p50. A hitch, and the most visible defect in the file. |
| `worst` frame, `products:1000` static / morph | **50.1 / 50.0 ms** | Same hitch, same cause. |
| `worst` at 10,000 / 100,000 / 500,000 | 9.2 / 11.9 / 9.3 ms | Nothing wrong. |
| `layoutSolveMs` scatter / grid at 500,000 | 20.7 / 9.9 ms | Gates every layout change and every filter tick. |
| `gpuP50` / `gpuP95` | 0.68–4.13 / 1.25–6.00 ms | The only real headroom number. |

The hitch is confined to `tax-cases:900` and `products:1000` and absent from
every larger collection. Those two are exactly the collections whose base atlas
holds **one card per row**, and the only ones whose fitted card size clears
48 device pixels. That pinned the cause before a line was changed.

## 1. Diagnosis: the hitch was the hi-res pass re-painting art it already had

`updateHiRes` fires once the camera and the cards are still. At the fitted view
of `tax-cases:900` on a 3608 px canvas a card is **67 device pixels**, which
clears `UNIQUE_MIN_PX` (48), so the pass planned a tier — `nextPow2(67)` = 128 —
and rasterised the viewport into it.

The base atlas for that collection already holds every one of those 900 rows,
painted by the same painter, at a **128 px** slot. The pass was spending the
whole viewport's worth of Canvas2D to arrive at the texels it started with.

`products:1000` is the same story one step further on: 64.2 device px against a
64 px base slot, `planTier` steps down to 64 because a 4096² texture holds only
900 slots at 128, and a thousand cards are re-rasterised at exactly the base
slot's resolution.

Two supporting faults made one tick carry all of it:

- **`HIRES_PIXEL_BUDGET` (4 Mpx/tick) does not bound the work.** A card's cost
  is shaping and drawing its text, which barely moves with the slot size. 4 Mpx
  is 4 cards at tier 1024 and **256 cards** at tier 128 — two orders of
  magnitude apart in pixels, and a 90 ms frame either way.
- **The viewport scan reran every tick.** `visibleCards` is O(n) and the fill
  takes as many ticks as the budget needs, so the scan was paid per tick.

## 2. What changed

### 2.1 The hi-res pass only runs when it can add texels (`src/gl/hires.ts`, `src/app.ts`)

Two new predicates, both pure and unit-tested in `tests/tiers.test.ts`:

```ts
hiResWorthwhile(cardPx, perItem, baseSlot)  // !perItem || cardPx > baseSlot
tierBeatsBase(tier, perItem, baseSlot)      // !perItem || tier  > baseSlot
```

The first is the cheap test and runs before the scan; the second re-asks the
question of the tier the scan settled on, because `planTier` steps down and the
two can disagree (that is the `products:1000` case). Above the per-item cap the
base atlas holds group covers, so both are unconditionally true and nothing
about the large collections changes.

This is not a quality trade. On a per-item atlas the base slot is a faithful
raster of the same card by the same painter, carrying mips and anisotropy; at or
below that size on screen the hi-res copy has no more information in it.

### 2.2 A wall-clock raster budget (`HIRES_MS_BUDGET`, 5 ms)

`rasterBudgetLeft(painted, elapsedMs)` — always the first card, so a tier whose
single card costs more than the budget still makes progress; never one that
would start after the budget is spent. It bounds the tick whatever the tier
costs per card, which is the thing a pixel budget could not do.

### 2.3 The scan is cached for the life of a plan

`PivotApp.hiPlan` holds the `near`/`inView`/`wanted` sets against the key they
were scanned for, so a fill that now takes tens of ticks still scans once. Slot
eviction likewise runs only on the tick that produced a new plan.

### 2.4 Mips are rebuilt when art becomes visible, not when it is painted

`generateMipmap` covers the whole hi-res texture, so calling it per raster tick
would hand back what the budget saves. The commit is atomic — a slot that has
not been flipped is sampled by nothing — so `finishHi()` now runs on the ticks
that flip instances, and a tick that only paints leaves the frame alone
(no `dirty`, no redraw).

### 2.5 The base atlas is cropped to what it holds (`src/gl/atlas.ts`)

`atlasGrid(size, slot, pad, slots)` sizes the canvas to `ceil(sqrt(slots))`
columns of padded slots rather than to the full square, and `slotRect` takes a
height so a slot stays square on a rectangular atlas. `setAtlas` uploads the
canvas, so this is the upload. Cover atlases are additionally capped at a
**512 px** slot (`COVER_SLOT`): `slotFor` would give six covers 1024 px each,
and the only path that can magnify a cover past 512 is a viewport holding more
cards than the hi-res atlas has slots for — 3,136 cards of 512 device px is a
205 megapixel display.

### 2.6 The solve memo (`src/layout/layouts.ts`)

A `WeakMap<LayoutData, Memo>` per collection, holding the sorted order per
column and the bin set per `(column, bins, spread)`. Both are functions of the
columns alone; the columns never change once the worker has them. What changes
every solve is the mask and the spec, and a facet tick re-solves the same spec
against a new mask ten times a second.

`orderBy` now caches the **whole collection's** order and applies the mask to it
afterwards. That is the same answer — dropping rows from a sorted sequence
leaves it sorted and leaves ties in dataset order — and it replaces a four-pass
radix over n with one pass, then with nothing at all. `tests/layouts.test.ts`
asserts the equivalence against a freshly built collection with no cache behind
it, and that no sequence of interleaved solves can move an answer.

`xyLayout` (the map, and every raster) walks the rows directly instead of
building an identity index list, which at a million rows was the largest single
allocation of the solve.

### 2.7 Two uniform branches in the shader (`src/gl/shaders.ts`)

- `u_hasHi` is 0 whenever no instance is flipped to the hi-res atlas, which is
  most frames and *all* frames above the zoom where a card earns its own raster.
  The second `texture()` fetch is then never issued. `v_hi` itself stays
  unconditional inside the draw — branching on it would leave the mip
  derivatives undefined at the seam between hi-res and base cards.
- `u_glow` guards the night-lights path in both shaders: off the map, the
  `exp()`, the reciprocal and the halo `smoothstep` are not executed at all.
  They were being paid on every fragment of every collection.

Both are uniform, so the branch is taken by the whole draw call or by none of
it. **Proved neutral, not argued:** `verify-map --blend-capture/--blend-compare`
against a build with the unguarded formulations gives *0 differing channels of
5,205,792*, and the map's own light metrics are identical to four figures
(glow 0.0347, plain 0.0113, ratio 3.07×, 2.44 % above 0.8 luminance).

### 2.8 A landed transition swaps buffers instead of shipping 16 MB back

`setTargets` used to snapshot where cards are into `from` and upload both
buffers. When the previous flight has landed — a re-sort, a filter tick or a tab
almost always follows one that has — where the cards are is exactly the `to` the
GPU is already holding. The two attribute bindings are swapped and only the new
targets are uploaded: **32 MB → 16 MB per layout change at a million cards.**

### 2.9 `?preserve=0`

A flag, not a change. `preserveDrawingBuffer: true` is what lets the app skip
idle frames without flicker, and it is not free: the driver keeps the backbuffer
alive across the composite, which on a tiled or shared-memory GPU is a
full-screen copy of every presented frame — 7 megapixels on the baseline canvas.
It cannot be measured on a software rasteriser and the flicker it guards against
cannot be reproduced there either, so the default is unchanged and the flag
exists so the cost can be measured on a real GPU (see §5).

---

## 3. Measured

### 3.1 The hitch — same build, gates and budget switched off vs on

`scripts/perf-probe.mjs` now carries this phase (`FILL_FN`): load, fit, hold
still for 150 frames at the baseline's 3608×1987 canvas, report the worst single
frame. Headless Chromium here is **llvmpipe**, so only the ratios mean anything.

| Collection | before: worst / p50 | after: worst / p50 | hi-res |
|---|---|---|---|
| `tax-cases:900` (67 px card, 128 px slot) | **1000 / 83.3 ms** (12× p50) | **133.3 / 66.7 ms** (2×) | off |
| `products:1000` (64.2 px card, 64 px slot) | **1000 / 83.2 ms** (12×) | **133.3 / 66.6 ms** (2×) | off |

A 2× worst-to-p50 ratio is this machine's ordinary jitter; the spike is gone
because the work is gone. On the Arc the same event was 91.7 ms against an
8.30 ms p50.

### 3.2 Solve time — worker `solveMs`, four repeats of the same spec

Median of repeats 2–4 (repeat 1 is the cold solve that fills the memo):

| | before | after | |
|---|---|---|---|
| `tax-cases:100000` grid | 2.1 ms | 1.2 ms | 1.8× |
| `tax-cases:100000` bars | 3.6 ms | 2.4 ms | 1.5× |
| `tax-cases:100000` scatter | 10.6 ms | 2.1 ms | **5×** |
| `products:500000` grid | 27.0 ms | 6.5 ms | **4×** |
| `products:500000` bars | 17.4 ms | 10.8 ms | 1.6× |
| `products:500000` scatter | 33.9 ms | 14.2 ms | 2.4× |
| `products:500000` filter tick (grid, alternating mask) | 17.1 ms | 10.0 ms | 1.7× |

The cold solve is unchanged by design: the memo makes the *second* solve free,
and the second solve is what a filter drag, a re-sort and a tab actually are.

### 3.3 Bytes uploaded — `perf-probe`, texture bytes per collection load

| Collection | before | after | |
|---|---|---|---|
| `tax-cases:20000`, `tax-cases:100000`, `products:100000/1000000` | 64 MB | **6.2 MB** | 10.2× |
| `products:1000` | 64 MB | 20.3 MB | 3.1× |
| `tax-cases:3000` | 64 MB | 59.8 MB | 1.06× |
| `tax-cases:900` | 64 MB | 63.5 MB | — |

The last two are honest: a per-item atlas at 900 or 3,000 rows really is nearly
full, and `slotFor` fills it on purpose because those texels are the card art.
The 10× cases are every collection past the per-item cap — which is every
collection where GPU headroom decides anything.

Instance-buffer bytes over a `products:1000000` load fell 45.8 → 30.5 MB (§2.8).

### 3.4 Frame and GPU time — `perf-probe`, llvmpipe, ratios only

| | before | after |
|---|---|---|
| `tax-cases:3000` static, gpu p50 | 26.75 ms | **12.62 ms** |
| `tax-cases:3000` static, worst | 50.1 ms | 33.4 ms |
| map `tax-cases:20000` glow, gpu p50 | 30.46 ms | 28.78 ms |
| map `tax-cases:20000` plain, gpu p50 | 28.88 ms | 24.55 ms |
| `products:100000` static, gpu p50 | 106.69 ms | 105.69 ms |

llvmpipe is ALU-bound in a way a real GPU is not, so the 2× on the small
collection will not carry over intact; the shape will. The large collection is
fill-bound even in software and moves least, which is the honest expectation for
a change that removes arithmetic rather than fragments.

---

## 4. Deliberately not done

- **A uniform grid index over `renderer.to`**, to make `renderer.pick` O(1) and
  lift the 200,000-row hover gate (`HOVER_LIMIT`). Named in the handoff, and
  still the right next thing — but it is a *usability* limit, not a frame-time
  one: `pick` runs at most once per frame and only while the pointer moves.
  Nothing in the GPU baseline points at it.
- **`OffscreenCanvas` rasterisation** of the hi-res atlas on a worker. It would
  take the remaining card painting off the main thread entirely. It is a bigger
  change than this pass warranted once §2.1 removed the case where that painting
  was happening at all, and it needs `transferControlToOffscreen` plumbing plus a
  second copy of every painter's font metrics.
- **Packing the style buffer below 16 bytes** (slot indices instead of uv rects,
  with the atlas geometry as uniforms) — 25 % of the style upload, at the cost of
  putting atlas layout in the shader. Not worth it while the atlas upload is
  10× larger than the style upload.
- **Half-float `from`/`to`.** At 500,000 cards the grid runs to ±447 world units,
  where a half float quantises to a quarter of a card. Rejected on precision.
- **Turning `preserveDrawingBuffer` off by default.** See §2.9 and §5.
- **Making `slotFor` less generous for per-item atlases.** Those texels are the
  card art; shrinking them to save upload bytes is exactly the trade this pass
  refuses to make.

---

## 5. What only a real browser can answer

Press **Benchmark** on the machine that produced the baseline and compare
against `bench-results/manual-json-2026-08-27T11-46-49.json`:

1. **`worst` on the two per-item targets.** `tax-cases:900` static should fall
   from 91.7 ms and `products:1000` static/morph from ~50 ms, to something near
   their 8.5 ms p95. This is the headline claim and the one thing here that the
   baseline measures directly.
2. **`gpuP50` / `gpuP95` everywhere.** §2.7 removes an `exp()`, a reciprocal and
   two `smoothstep`s per fragment off the map, and a texture fetch per fragment
   whenever no hi-res plan is committed. Software rendering exaggerates the
   first and understates the second; only the Arc can say which.
3. **`layoutSolveMs`.** The bench solves each spec once per morph phase, so it
   reports the *cold* solve, which this pass does not change. Dragging a facet
   and watching the HUD's solve figure settle is the honest test of §2.6.
4. **`?preserve=0`, twice.** Load the app with and without it and press
   Benchmark each time. If `gpuP50` drops materially with it off, the flag
   should become the default and the idle path should be revisited; if it does
   not, delete the flag. This is the largest untested GPU lever in the file and
   it cannot be measured here at all.
5. **That nothing looks worse.** Specifically: `tax-cases:900` and
   `products:1000` at the fitted view (§2.1 stops re-rasterising them — the
   cards should look exactly as they did), a large collection zoomed until cards
   are ~100 px (§2.5 halved the cover slot), and the map (§2.7).
