# A — Cards blurry on HiDPI screens when zoomed in

## Diagnosis

The drawing buffer is *not* the problem; the atlas is.

1. **Fixed 128-texel card slot, regardless of collection size or zoom** (root cause).
   `src/gl/atlas.ts:31` `constructor(size = 4096, slot = 128, pad = 4)` and `src/app.ts:175` `new CardAtlas(4096, 128, 4)`. Every card, forever, is a 128x128 raster. Card pitch is 1 world unit and `CARD_SIZE = 0.86` (`src/layout/layouts.ts:11`); `maxZoom = 600` (`src/gl/camera.ts:12`), so a card can reach 516 device px. Anything past `zoom ≈ 149` (128 / 0.86) is magnifying the texture, and on a 4k/DPR-2 display that happens at half the CSS-pixel size it does on a 1x screen, which is why it is reported as "4k".

2. **Canvas backing store is correct**, not a cause. `src/app.ts:91-104` sizes the buffer at `clientWidth * devicePixelRatio` uncapped, the viewport uses `drawingBufferWidth` (`renderer.ts:294`), and `u_res` is device px (`renderer.ts:303`, `shaders.ts:36`). Text is rasterised into atlas texels, not CSS px, so "text at 1x" is the same cause: 128 texels means ~12.5 px title type (`atlas.ts:103`, `h*0.098`) being stretched.

3. **Filtering only hides magnification, cannot cure it.** `MAG_FILTER = LINEAR` (`renderer.ts:139`) bilinearly smears once card px > slot texels; mipmaps (`renderer.ts:276-279`) and anisotropy only help *minification*. NEAREST would trade blur for blockiness. No change needed here.

4. **Texel alignment** is a minor contributor. UVs quantised to u16 (`renderer.ts:179-182`) is negligible. Text baselines are placed at fractional y (`atlas.ts:105,120`) so glyphs are pre-blurred by Canvas2D AA; `Math.round` on y is a cheap sharpness win.

5. **Side bug:** `src/gl/camera.ts:22` caps `dpr` at 2 for pointer mapping, while `app.ts:95` and `app.ts:325-326` use the uncapped value. On DPR-3 displays wheel-zoom-about-cursor and drag pan drift. One-line fix.

6. **Category mode wastes the atlas.** For n > capacity (`app.ts:182,191-207`) the atlas holds one card per category — typically 3-8 slots — still at 128 px inside a 4096² texture that could give each 1024 px.

## Approach

Two layers, both keeping exactly one draw call:

**Layer 1 — size the base slot to the collection.** `slotFor(n)` = largest power of two such that a `ceil(sqrt(n))`-column grid of `(slot + 2*pad)` fits in 4096, clamped to [64, 1024]. Titanic (891 → 30 cols → 136 px pitch) still gets 128, but category mode and small collections become sharp for free.

**Layer 2 — a second "hi-res" atlas for the cards currently in view when magnified.** Same 4096² size. When the camera settles with `cardPx > baseSlot`, re-rasterise the visible cards at tier `S = min(1024, nextPow2(cardPx))` into the hi-res atlas via `texSubImage2D` per slot, and flip those instances' UV rect + a per-instance "use hi-res" flag (the unused `a_meta.w`, `shaders.ts:12`) through the existing `uploadStyleAt` path (`renderer.ts:199`). The fragment shader mixes the two samplers by that flag. Cards leaving the set revert to base UVs. One instanced draw, two bound textures.

Rejected alternatives:
- *8192² single atlas*: 256 MB RGBA plus mips, exceeds `MAX_TEXTURE_SIZE` on many GPUs, still caps at 256 px for ~900 cards.
- *Rebuilding the single atlas at a higher slot for visible cards only*: off-screen cards lose art and pop in when panned; every pan forces a rebuild.
- *Mip-chain "multi-level" atlas*: mips only address minification.
- *Vector/SDF cards*: sharp at any zoom but a rewrite of card design and text; out of scope.

## Steps

1. **Pure sizing math** — `src/gl/atlas.ts`
   - Export `slotFor(n, size = 4096, pad = 4, min = 64, max = 1024): number`.
   - Export `hiResTier(cardPx, base): number | null` → `null` when `cardPx <= base`, else `min(1024, nextPow2(ceil(cardPx)))`.
   - Export `hiResCapacity(size, slot, pad)`.
   - `CardAtlas`: add `drawSlot(spec, i)` (draw at index `i` without touching `used`) and `rectOf(i)` returning `{x, y, uv}`. Round text `y` positions in `drawCard`.

2. **Renderer: second texture + flag** — `src/gl/renderer.ts`, `src/gl/shaders.ts`
   - Create `hiTex` lazily (LINEAR / LINEAR_MIPMAP_LINEAR, same clamp), uniform `u_hi` on `TEXTURE1`.
   - `setHiSlot(x, y, source: HTMLCanvasElement)` → `texSubImage2D`; `finishHi()` → `generateMipmap` once per batch.
   - `setStyle(..., hi = 0)` writes `styleU8[o8 + 7]` (the unused `a_meta.w`); add `setHi(i, on)` mirroring `setSelected`; add `setUv(i, uv)`.
   - Vertex: `out float v_hi = a_meta.w;`. Fragment: `vec4 tex = mix(texture(u_atlas, v_uv), texture(u_hi, v_uv), v_hi);` inside the existing `texMix > 0` block. Both fetches always taken so derivatives stay uniform.

3. **App: use `slotFor` for the base atlas** — `src/app.ts:175`
   - Replace the hard-coded `new CardAtlas(4096, 128, 4)` with a per-dataset atlas built from `slotFor(perItem ? n : categories.length)`. `perItem` must be decided using capacity at the *minimum* slot (64 → 3844 cards) first, then choose slot. Recreate the `CardAtlas` when the slot changes.

4. **App: hi-res manager** — new `src/gl/hires.ts` + `src/app.ts`
   - `hires.ts` (pure, testable): `visibleCards(to, count, cam, w, h, margin)` returns indices whose rect intersects the viewport expanded by `margin` (0.25 of viewport), sorted by distance to centre; `planHiRes(visible, capacity)` truncates.
   - In `PivotApp`: `HiResState { tier, slots: Map<cardIdx, slotIdx>, free: number[] }`. In `loop` after `camera.update`: when `!camMoving && !animating && dataset.cards !== false`, compute `cardPx = to[2] * zoom`, `tier = hiResTier(cardPx, atlas.slot)`. If null and active → revert all. If tier changed → clear and refill. Otherwise diff visible vs slots: evict, rasterise newcomers with `cardSpec` (per-item) or the category template into a scratch canvas, `setHiSlot`, then `setUv/setHi/uploadStyleAt` per changed card, `finishHi()`, `dirty = true`.
   - Budget: ≤ ~24 rasterisations per tick; carry the remainder over.
   - `setColorBy`/`loadDataset`/`buildCards` clear the hi-res state.

5. **DPR pointer fix** — `src/gl/camera.ts:22`: drop the `Math.min(..., 2)` cap.

6. **HUD/metrics (small)** — `FrameModel`: add `atlasSlot` and `hiRes: { tier, cards } | null` for the readout and the Playwright assertion.

7. **Docs** — README "Automatic LOD" bullet: one sentence on the hi-res atlas; `docs/PROGRESS.md`.

## Verification

- **Unit (vitest, `tests/atlas.test.ts`, node env — must not touch `document`):**
  - `slotFor(891) === 128`, `slotFor(8) === 1024`, `slotFor(100) === 256`, `slotFor(3844) === 64`, `slotFor(1) === 1024`; monotone non-increasing; `(slot + 8) * ceil(sqrt(n)) <= 4096` for n in 1..4000.
  - `hiResTier(100, 128) === null`, `hiResTier(129, 128) === 256`, `hiResTier(700, 128) === 1024`, `hiResTier(2000, 128) === 1024`.
  - `visibleCards` on a synthetic 10x10 grid with a camera showing the centre 3x3 returns 9 (+margin) indices nearest-first.
- **Browser (Playwright, per the `playwright-wsl` skill):** `scripts/verify-hidpi.mjs`, starting vite like `bench-headless.mjs`.
  - `newContext({ viewport: {1920,1080}, deviceScaleFactor: 2 })` → buffer 3840x2160.
  - `goto('/?dataset=titanic')`, wait for `window.pivotBenchReady`.
  - Fly to card 0 at zoom 500, wait ~600 ms for settle, screenshot `screenshots/hidpi-zoomed.png`.
  - Assert frame model reports `hiRes.tier >= 512` and `hiRes.cards > 0`.
  - Numeric sharpness: mean absolute horizontal luminance gradient of the centre 400x400 device px ≥ 1.8x the value with hi-res disabled (`?hires=0`). Print both.
  - Also pass at `deviceScaleFactor: 1`.
- **Regression:** `pnpm test`, `pnpm typecheck`, `pnpm bench --swiftshader` — zoom phase p95 within noise (hi-res only rasterises on settle).
- **Manual:** Titanic zoomed to one card at 4k — crisp text; pan — newcomers sharpen within a frame or two; Products 100k — category cards sharp (slot 1024).

## Risks

- **Texture memory:** +64 MB (+21 MB mips). Mitigate: lazy allocation; size to smallest power of two whose area ≥ 2x drawing buffer (2048² on ≤1080p), capped at `MAX_TEXTURE_SIZE`; free on dataset change.
- **Rasterisation hitch on settle:** 24-per-tick budget.
- **Sampler mixing:** never branch on `v_hi` around `texture()` (undefined derivatives with mipmaps).
- **Stale hi-res art after filter/colour change:** cleared in `buildCards`/`setColorBy`.
- **`perItem` threshold change:** datasets 900–3844 rows switch from category-tinted to per-item cards at 64–128 px. Note in PROGRESS.md; bench "1000 products" now builds a per-item atlas.

### Self-review amendments applied
- Dropped per-card variable-size hi-res packing: a single tier per settle is simpler since all cards share one size in every layout.
- Removed the `MAG_FILTER` change; it cannot help and would regress the 3–9 px LOD band.
- Added the `perItem`-decision ordering note in step 3.
- Made the sharpness assertion numeric rather than visual.
