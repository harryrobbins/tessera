# D — Code review and remediation plan

Reviewed at git HEAD `bbd5e09` (2026-08-26), read-only. Every file under `src/`,
`tests/`, `scripts/*.mjs`, `index.html`, `vite.config.ts`, `vitest.config.ts`,
`tsconfig.json`, `.github/workflows/deploy.yml` and `pipeline/segment.py` was
read in full. Claims marked **[verified]** were reproduced by running the code
(vitest probe in the scratchpad, `pnpm test`, `pnpm typecheck`); the rest are
by inspection with file:line evidence.

Baseline: `pnpm typecheck` clean, `pnpm test` 98/98 green (README says 58).

## Summary

The engine core (radix sort, layout solvers, instanced renderer, GPU-paced
frame loop, colour maths) is solid and well-tested. The problems cluster at
the seams between subsystems — camera vs. canvas DPR, drag vs. click, worker
errors vs. UI promises, dataset loads racing each other — and in the newest
feature (pixel collections), where filtering in the Scatter view silently
breaks the raster guarantee the whole zoom ladder is built on.

Top findings:

1. **Filtering a pixel collection in Scatter distorts the picture** (High,
   `layouts.ts:267-271`) — the raster test uses the *visible* count against the
   *full* column extents, so any facet filter flips the layout into
   "fill the viewport" mode with non-square cells while `isRasterView` still
   claims whole-pixel scales. [verified]
2. **Drag-pan ends in a click that selects and zooms** (High,
   `app.ts:322-331`, `camera.ts:41-63`) — no drag threshold; releasing over a
   card after panning selects it and flies the camera to zoom 90.
3. **Camera caps DPR at 2 but the canvas does not** (High on 3x displays,
   `camera.ts:22` vs `app.ts:95`) — pan speed and wheel-zoom anchor are wrong
   on any screen above 200 % scaling.
4. **Worker errors are swallowed and hang the UI promise** (Medium-High,
   `worker.ts:36`, `client.ts:48-55`) — no `onerror`, no rejection; `apply()`
   never resolves.
5. **Concurrent dataset loads race** (Medium-High, `app.ts:112-132`,
   `client.ts:42-46`) — the last *finisher* wins, not the last *request*, and
   the earlier `load()` promise can never resolve.
6. **Per-frame DOM churn in the axis overlay even when idle** (Medium,
   `axes.ts:27-33`, `app.ts:362`) — ~40 SVG nodes rebuilt every rAF.
7. **No WebGL context-loss handling** (Medium, `renderer.ts:68-80`).
8. **DPR changes without a resize never re-size the buffer** (Medium,
   `app.ts:80,91-104`).
9. **Test gaps**: `xyLayout`, `parseCsv`/`inferDataset`, `CameraController`,
   `FrameStats`, `FacetPanel.mask`, `setTargets` have no tests at all.
10. Doc drift: README test count, "10 Hz idle redraw", atlas capacity (~950 →
    actually 900), Titanic-only toast text.

## Findings

Severity: **C**ritical / **H**igh / **M**edium / **L**ow. "Overlap" names the
concurrent workstream that touches the same file (A = HiDPI atlas/renderer,
B = new datasets in `data/*` + `app.ts loadByKey`, C = `src/tour/*` onboarding,
which will hook into `main.ts`/`index.html`).

### Correctness

| id | sev | file:line | description | proposed fix | overlap |
|---|---|---|---|---|---|
| D-01 | H | `src/layout/layouts.ts:267-271` | `isRaster` compares `order.length` (visible rows) against `(xSpan+1)*(ySpan+1)` (full-column extents). Any mask on a pixel collection drops below the 2 % tolerance, so the layout switches to viewport-fill with `sx≠sy` (probe: sx 0.889, sy 0.714 on a 10×8 raster with half masked) while quads keep size `CARD_PITCH`=1 → overlapping, stretched picture. `app.isRasterView` (`app.ts:297`) and the scale readout (`app.ts:302`) still report whole-pixel semantics. [verified] | Decide raster-ness from the *columns*, not the visible count: integer min/max and `data.n ≈ cells` (or an explicit `Dataset.raster` flag set by `loadPixels`). Keep scale 1 under any mask. Add a test. | **Done** (impl-D15: `isRasterGrid(xc, yc, data.n)` in `layouts.ts` decides from column extents and row count, never the visible count; `LayoutResult.pitch` added to every layout and carried through worker/client as `LayoutSolution.pitch` for D-10; tests: half-masked 10×8 raster keeps pitch 1, bounds and every visible position). |
| D-02 | H | `src/app.ts:322-331`, `src/gl/camera.ts:41-63` | Canvas `click` fires after a pointer-captured drag; `onClick` picks and `onSelect` (`main.ts:188-197`) flies the camera to zoom 90. Every pan that ends over a card selects it. | Track pointerdown position in `CameraController` (or app) and ignore clicks that moved > ~4 css px; expose `camera.wasDrag`. | **Done** (impl-D2): `dragThresholdPx`=4 css px + `wasDrag` getter on `CameraController`; tests in `tests/camera.test.ts`. **Consumer wired** (impl-D3): `app.onClick` returns early when `camera.wasDrag`. |
| D-03 | H | `src/gl/camera.ts:22` vs `src/app.ts:95-97` | Camera uses `min(devicePixelRatio, 2)` for drag deltas and wheel anchor, but the canvas buffer (and `screenToWorld`, which divides by `canvas.width`) uses the uncapped DPR. At DPR 3 the drag moves 2/3 of the cursor and wheel zoom pins the wrong world point. `app.onClick` (`app.ts:325`) uses the uncapped value, so click and drag disagree. | Remove the cap; derive DPR from `canvas.width / canvas.clientWidth` in one place and share it. Test with a fake canvas. | **Done** (impl-A dropped the cap; impl-D2 moved `dpr()` to `canvas.width/clientWidth` with a `devicePixelRatio` fallback, tested at DPR 3). |
| D-04 | M-H | `src/layout/worker.ts:36`, `src/layout/client.ts:23-37,48-55` | A throw inside `onmessage` (`layout requested before load`, `bucketize` on a text/unknown column) becomes a worker `error` event nobody listens to; the pending `resolve` is never called, `setLayout`/`apply` hang forever, no toast. | Wrap `computeLayout` in try/catch and post `{type:'error', id, message}`; client rejects the pending promise and adds `worker.onerror`. Surface via toast in `main.ts`. | **Done** (impl-D15: `worker.ts` wraps the solve in try/catch and posts `{type:'error', id, message}`; `client.ts` keeps resolve+reject per id, rejects on the error reply and `worker.onerror` rejects everything pending; tests in `tests/layout-client.test.ts`. The toast in `main.ts` is Group 7's — done, impl-D7: `apply()` toasts the rejection). |
| D-05 | M-H | `src/app.ts:112-132`, `src/layout/client.ts:42-46`, `src/main.ts:274-291` | No load sequence guard. Two quick dataset changes: (a) `loadedResolve` is overwritten, so the first `load()` promise never resolves (the worker's first `loaded` reply resolves the second); (b) if the slow load (pixels, fetch+decode) finishes after the fast one (products, sync), it overwrites `dataset`, `renderer.setCount`, colours and layout while the `<select>` still shows the fast one. `main.ts` also has no guard. | Add a `loadSeq` in `PivotApp.loadDataset` (bail after `await loadByKey` if superseded); make `LayoutEngine.load` id-keyed like `solve`; resolve/reject stale promises. | **Done** (impl-D3): `loadSeq` in `PivotApp.loadDataset` — bails after `resolveDataset`, after `engine.load` and after the first `setLayout` if superseded. `LayoutEngine.load` id-keyed (`load` carries `id`, `loaded` echoes it; `loading` map per id, `solve` waits on the newest) — merged with impl-D15's D-04 work in `src/layout/client.ts`. Tests: `tests/layout-client.test.ts` (FakeWorker). `main.ts` guard is Group 7 — done, impl-D7: `loadSeq` in `load()`. |
| D-06 | M | `src/app.ts:80,91-104` | `ResizeObserver` (content-box) does not fire when only `devicePixelRatio` changes (window dragged between monitors, browser zoom). Buffer stays at the old DPR → blurry / wrong `scale` readout. | Observe with `{ box: 'device-pixel-content-box' }` where supported, plus a `matchMedia('(resolution: …dppx)')` listener fallback. | **Done** (impl-D3): `ResizeObserver` observes `{ box: 'device-pixel-content-box' }` (try/catch fallback to content-box) plus a re-armed `matchMedia('(resolution: Ndppx)')` change listener; both call `resize()`. |
| D-07 | M | `src/gl/renderer.ts:68-80` | No `webglcontextlost` / `webglcontextrestored` handling. After a GPU reset every draw is silently a no-op and the page shows a frozen `preserveDrawingBuffer` frame. | Listen for context loss, `preventDefault`, rebuild program/buffers/atlas on restore (or show a toast asking to reload). | **Done** (impl-D15: `renderer.ts` listens for `webglcontextlost` (preventDefault, drops timer queries, `contextLost` skips draws) and `webglcontextrestored` (`init()` rebuilds program/VAO/buffers/both atlas textures/queries, `reupload()` pushes the CPU mirrors back, then `onContextRestored` fires — impl-D3 wires it to `buildCards()` in `app.ts`, which redraws the base atlas and clears the hi-res bookkeeping). |
| D-08 | M | `src/gl/camera.ts:95-104`, `src/layout/layouts.ts:128-132` | Empty result (everything filtered out) gives grid bounds with zero height (probe: `minY:0,maxY:0`) → `bh=1e-6` → zoom clamps to `maxZoom`=600 on `fit`. Bars/xy empties give tiny boxes with the same effect. [verified] | Early-return in `fit` when `visible === 0` (keep current camera), or clamp `zoom` to the pre-fit value. | **Done** (impl-D2): `fit` returns early on a non-finite or zero-extent box (either axis). A `visible===0` guard in `app.fit` would be belt-and-braces (Group 3). |
| D-09 | M | `src/app.ts:126-131`, `src/main.ts:280-286` | Every pixel load solves a full **grid** layout (`setLayout grid` + 16 MB upload at 1 M) and only then `main.ts` switches to `xy` and solves again; the grid→xy flight also animates from a layout the user never asked for. | Let `loadDataset` take an initial `LayoutSpec` (or a `Dataset.defaultLayout`), solve once. | **Done** (impl-D3): `loadDataset(key, initial?: LayoutSpec)`; default `app.defaultLayout()` = map (`xy` lon/lat `equal`) for geo data, picture (`xy` X/Y) for pixels, sorted grid otherwise. One solve on load. Group 7 note: `main.ts load()` still calls `apply(true)` after load (re-solves the same spec — a no-op morph); it can drop that or pass `currentSpec()` as `initial`. Done, impl-D7: `load()` calls `loadDataset(key)` alone (the default layout, solved once) and sets the layout kind/axis menus from `app.defaultLayout()` afterwards. |
| D-10 | M | `src/app.ts:302-304` | `scale` getter uses `renderer.to[2]` (size of item 0). When item 0 is masked out its size is 0 → falls back to 1; and after D-01 the true pitch is not the size at all. | Read pitch from the last `LayoutResult` (add `pitch` to the result) instead of a card size. | **Done** (impl-D3 + impl-D15): `LayoutResult`/`LayoutSolution.pitch` (D15); `app.pitch` set in `setLayout`, `scale = zoom * pitch`. |
| D-11 | M | `src/main.ts:278` | Loading toast says "the Titanic collection" for every non-products key, including pixel collections. | Use `app.datasetName` / a title map (see D-30). | **Done** (impl-C wrote `Building ${describeKey(key)}…`; impl-D7 verified — no dataset-specific wording left in `main.ts`). |
| D-12 | L | `src/app.ts:380-387` | `loadByKey` silently maps any unknown key to Titanic and `products:abc` to `generateProducts(NaN)` (n=NaN, `Int32Array(NaN)` → empty arrays, `renderer.setCount(NaN)`). URL `?dataset=` is user input. | Validate key; throw on unknown so `boot()` toasts it. | **Done** (impl-B, by design change): `resolveDataset` in `src/data/registry.ts` parses keys with `parseKey` (non-numeric size → family default, never NaN) and maps unknown keys to `DEFAULT_DATASET_KEY` rather than throwing — a deliberate onboarding choice (deep links never dead-end). No toast on fallback; acceptable. |
| D-13 | L | `src/main.ts:251` vs `:141-146` | `Escape` hides the detail pane but leaves the card's selection ring on and `selected` set; the close button clears both. | Route both through one `deselect()`. | **Done** (impl-E3: `DetailPane.hide()` fires `onClose`, which clears the ring and `selected`; Escape and the button both go through it — `detail-e2e` checks it). |
| D-14 | L | `src/app.ts:356` | `!this.idle` is always true inside the `needed` branch (idle = !needed); dead condition. | Drop it. | **Done** (impl-D3): dead `!this.idle` dropped. |
| D-15 | L | `src/bench/bench.ts:174-176` | `solve[app.lastLayoutName] = app.lastSolveMs` runs after a promise that may have been superseded (`setLayout` returns early without updating either field), recording the previous layout's time under the wrong key. | Have `setLayout` resolve to its `LayoutSolution` (or `null` when superseded). | — |
| D-16 | L | `src/gl/renderer.ts:347-357` | On `GPU_DISJOINT_EXT` only the head query is discarded; the others still in flight also carry garbage. | Drain all in-flight queries when disjoint. | **Done** (impl-D15: `pollTimers` returns every in-flight query to the pool unread when `GPU_DISJOINT_EXT` is set). |
| D-17 | L | `src/data/csv.ts:9-66` | A blank line yields a row `[""]` that `inferDataset` counts as a real row (probe: `[["1","x\"y"],[""],["2","3"]]`); a UTF-8 BOM is kept in the first header name. [verified] | Skip empty rows; strip `﻿`. Add tests (there are none for csv). | B **Obsolete** (impl-D46): `src/data/csv.ts` was deleted by workstream B; no csv parsing remains. |
| D-18 | L | `src/data/csv.ts:112,122` | With the real Kaggle file `Survived`/`Pclass` are `0/1`/`1-3` → inferred **numeric**, so they are neither facets with checkboxes nor the default colour; `Number(' ')`/`'0x1f'` also count as numeric. | Treat small-cardinality integer columns (≤ ~10 distinct) as categorical; tighten the numeric test. | B **Obsolete** (impl-D46): csv/titanic deleted by B; synthetic generators declare column kinds explicitly. |

### Performance

| id | sev | file:line | description | proposed fix | overlap |
|---|---|---|---|---|---|
| D-19 | M | `src/ui/axes.ts:27-33`, `src/app.ts:362` | `onFrame` runs every rAF whether or not a frame was drawn; `AxisOverlay.render` builds a fresh DocumentFragment with ~40 SVG elements and `replaceChildren` each tick — steady GC/layout churn while idle. | Only re-render axes when the camera moved or axes changed (pass `needed`/a camera version in the model); reuse elements. | **Done** (impl-D46): `AxisOverlay.render` remembers the last drawn `cam.x/y/zoom`, viewport, dpr and an `axesVersion` bumped by `set()`, and returns early when nothing changed — no `app.ts` change needed. Element reuse not done (idle frames no longer rebuild anything). |
| D-20 | M | `src/app.ts:239-246` | Numeric colouring calls `hexToRgb(sequential(t))` per row: string → `parseInt` 1 M times. | Precompute the 13-entry ramp as RGB once. | **Done** (impl-D3): `SEQUENTIAL_RGB = SEQUENTIAL_BLUE.map(hexToRgb)` once at module load; per-row index uses the same rounding as `sequential()`. |
| D-21 | L | `src/app.ts:263-269`, `src/gl/renderer.ts:271-283` | Changing Colour on a card dataset redraws the whole atlas and re-uploads a 4096² RGBA texture + mipmaps (64 MB) on the main thread. Fine for Titanic; will matter once A raises resolution. | Keep; note for A (upload only the used rows via `texSubImage2D`, or size the atlas to `ceil(sqrt(n))` slots). | **Noted** (impl-D15: comment on `CardRenderer.setAtlas` with the two options; no code change). |
| D-22 | L | `src/app.ts:407-417`, `src/layout/client.ts:42-46` | The worker receives a structured clone of every column (16 numeric columns × 4 MB + rgb at 1 M pixels ≈ 70 MB copy) though layouts only ever touch the facet columns. | Clone only `ds.facets` columns. | **Done** (impl-D3): `toLayoutData` ships only `ds.facets` ∪ `ds.geo` columns (exported for tests). Menus and defaults only ever name facets; a spec naming any other column would now fail in the worker (D-04 surfaces it). |
| D-23 | L | `src/ui/hud.ts:57-63,114-124` | `history()` allocates an array and `rows.innerHTML` is rebuilt every 140 ms. Negligible today; keep off the hot path when adding HUD rows. | Reuse a preallocated array; update text nodes. | **Done** (impl-D46): `FrameStats.history()` fills a preallocated `Float32Array`; `Hud` builds rows once and updates text nodes (`row()` map), `scale` row toggled via `hidden`. |

### Robustness

| id | sev | file:line | description | proposed fix | overlap |
|---|---|---|---|---|---|
| D-24 | M | `src/main.ts:228` | `datasetSel.change → void load(...)`: a failed fetch/decode is an unhandled rejection with no toast, and the select stays on the dataset that failed to load. `boot()` has a try/catch; the change handler does not. | Wrap `load` in try/catch, toast, and revert `datasetSel.value` to the loaded dataset. | **Done** (impl-D7): `load()` wraps the whole sequence in try/catch, toasts `Could not load …: <message>` for 8 s, reverts `datasetSel` to the collection still on screen (`loadedKey`) and rethrows for `boot()`/the tour. Newest-load guard (`loadSeq`) so a stale load cannot touch the chrome. `apply()` catches `setLayout` rejections (D-04) as a `Layout failed: …` toast instead of hanging. |
| D-25 | M | `src/main.ts:131-140,297-322` | Detail pane and bench report inject `valueAt`/renderer strings with template literals, unescaped, while `facets.ts:131` has an `esc()` helper. Fine for shipped data; XSS the moment a user CSV (workstream B) is loaded. | Move `esc` to `core/` and use it in `main.ts`. | **Done** (impl-D7): `src/core/esc.ts` (impl-E3) is now used in `main.ts` for the dataset menu, every `fillSelect`/colour option, the legend labels and the bench report (`run.dataset`, `p.name`, `env.renderer`). Detail panes already used it. |
| D-26 | L | `src/gl/renderer.ts:136-138` | Atlas is always 4096²; `MAX_TEXTURE_SIZE` is never checked (WebGL2 guarantees only 2048). | Query and clamp; pass the size to `CardAtlas`. | **Done** (impl-D15: `CardRenderer.maxTextureSize` + `atlasSize = min(4096, MAX_TEXTURE_SIZE)`; `CardAtlas.size` exposed; impl-D3 switches `app.ts` from the `ATLAS_SIZE` constant to `renderer.atlasSize`. hires.ts already clamps). |
| D-27 | L | `src/app.ts:74-82`, `renderer.ts:388`, `camera.ts:162`, `client.ts:57` | `dispose()` exists on the three subsystems but `PivotApp` has none; `ResizeObserver` and the canvas click listener are never disconnected. Harmless in a single-page app, but the tour (C) or tests that construct/destroy the app will leak. | Add `PivotApp.dispose()`. | **Done** (impl-D3): `PivotApp.dispose()` stops the loop, disconnects the `ResizeObserver` and DPR query, removes the click listener and disposes camera/renderer/engine. |
| D-28 | L | `src/gl/renderer.ts:203` | `uploadStyleAt` uses `bufferSubData` into a buffer the GPU may be reading — the same stall the comment at `:209-212` warns about, just 16 bytes. | Acceptable; document it. Not a bug. | A |

### UX / accessibility

| id | sev | file:line | description | proposed fix | overlap |
|---|---|---|---|---|---|
| D-29 | M | `src/ui/facets.ts:31-42,84-128` | Every checkbox change re-renders the whole sidebar with `innerHTML`, destroying the focused element — keyboard users lose their place after each tick. | Update counts/bars in place; only rebuild on dataset change. | **Done** (impl-D46): `FacetPanel.render()` builds the DOM once per dataset/colour field; filter changes call `update()` which rewrites counts, bar widths, checked state and the clear button in place. Row order is fixed at render time (by unfiltered count). `tests/facets.test.ts` covers `mask()`/`toggle`/`clearAll`. |
| D-30 | M | `src/main.ts:40-44` vs `src/data/pixels.ts:51-55` | Two title maps for the same images with different names ("Millot's Butterflies" vs "Papillons (Larousse pour tous)"). The menu, the dataset name and the toast disagree. | Export one `PIXEL_TITLES` from `pixels.ts`. | B, C **Done** (impl-D46): one `PIXEL_TITLES: Record<PixelImage,string>` exported from `pixels.ts`; `registry.ts` imports it (its own map removed). Butterflies titled "Millot’s Butterflies" everywhere. |
| D-31 | M | `index.html:66`, `src/main.ts:59-64` | Toast has no `role="status"`/`aria-live`; load progress and bench progress are invisible to screen readers. Detail pane (`index.html:65`) has no `role="dialog"`/`aria-labelledby` and focus is not moved into or restored from it. | Add `role="status" aria-live="polite"`; give the detail pane dialog semantics and focus the close button. | **Done** (impl-E3 / impl-C: toast has `role="status" aria-live="polite"`; `DetailPane` sets `role="dialog"`, `aria-labelledby`, focuses the close button; impl-D7 verified). |
| D-32 | L | `index.html:19-24`, `src/main.ts:207-212` | `role="tablist"`/`tab` without `aria-controls`, roving `tabindex` or arrow-key handling; buttons also lack `type="button"`. | Either implement the tab keyboard pattern or drop the tab roles and use `aria-pressed`. | **Done** (impl-D7): kept the tab roles and implemented the pattern — roving `tabindex` (`setLayoutKind` sets 0/-1), Arrow/Home/End keys move and activate; every chrome button now has `type="button"`. No `aria-controls` because the canvas is not a tab panel. |
| D-33 | L | `index.html:61`, `src/main.ts:245-253` | The canvas is not focusable; pan is mouse-only, zoom keys are global. No pinch-zoom (`camera.ts` handles one pointer). | `tabindex="0"` + arrow-key pan; two-pointer pinch in `CameraController`. | **Done** in part (impl-D2): two-pointer pinch in `CameraController`. Canvas needs `touch-action: none` (style.css/index.html, not touched here) for touch pinch to reach it; tabindex/arrow-key pan not done. |
| D-34 | L | `src/ui/style.css:212-214`, `src/app.ts:122-123` | `prefers-reduced-motion` only disables CSS transitions; 850–1100 ms card flights and camera tweens ignore it. | Read the media query and set `transitionMs`/tween ms to 0. | **Done** (impl-D3, app half): `REDUCED_MOTION` read once from `matchMedia`; `renderer.transitionMs` = 0 so card flights and `fit` land immediately. Group 7 — done, impl-D7: `camera.focus` in `onSelect` uses `tweenMs()` (0 when `renderer.transitionMs` is 0); `zoomTo` is only called from `app.zoomStep` (app half). CSS half (`.toast, .detail, .tour-*` transitions) was already in `style.css`. |
| D-35 | L | `src/ui/facets.ts:95-97` | Only the top 24 categories are shown with no "+N more"; `Segment` (59 categories) hides 35 specimens with no hint. | Add a "show all" toggle or a count of hidden categories. | **Done** (impl-D46): `MAX_ROWS`=24 exported; a `.facet-more` line "+N more" follows the list when categories are hidden. |
| D-36 | L | `src/layout/layouts.ts:84`, `src/main.ts:70` | Integer columns (Year: 16 values) are cut into 12 equal-width bins, so some bars hold one year and some two. | Bin integer columns on integer edges when distinct ≤ bins. | **Done** (impl-D15: `bucketize` bins an all-integer column on integer edges with plain-integer labels when `max - min + 1 <= bins`; tests). |

### Code quality

| id | sev | file:line | description | proposed fix | overlap |
|---|---|---|---|---|---|
| D-37 | L | `src/data/products.ts:6-21`, `src/data/titanic.ts:9-24`, `tests/helpers/prng.ts` | `mulberry32` + `gaussian` duplicated three times. | Move to `src/core/prng.ts`. | B **Done** (B + impl-D46): `src/data/random.ts` is the single PRNG; `tests/helpers/prng.ts` now re-exports `mulberry32` from it (test-only helpers `randU32/randInt/randRange/randFiniteFloat32` remain). No `core/prng.ts` needed. |
| D-38 | L | `src/data/columnar.ts:133-147` vs `src/layout/layouts.ts:69-95`; `columnar.ts:112-118` vs `layouts.ts:97-104` | `binNumeric` duplicates `bucketize` and is **unused in src** (only tested); `shortNumber` and `fmtTick` are near-duplicates with different thresholds. | Delete `binNumeric` (or make `bucketize` use it); unify the formatter. | **Done** (impl-D46 deleted `binNumeric`; impl-D15 made `fmtTick` = `shortNumber` from `data/columnar.ts`, so ticks and bin labels use the dataset formatter — integer bins label as plain integers). |
| D-39 | L | `renderer.ts:253-264 jumpTo`, `hud.ts:162 setGpu`, `axes.ts:79 clear`, `columnar.ts:94 getCategory`, `palette.ts:22 SURFACE` + light theme, `shaders.ts:12 a_meta.z/.w` + `renderer.ts:178 dim` | Dead code (never referenced). `RenderStats` returned by `render()` is discarded. | Remove or wire up. `noUnusedLocals` does not catch exports. | **Done for renderer/shaders** (impl-D15: `jumpTo`, the `dim` parameter and `a_meta.z` tint removed — `a_meta.z` is now a spare byte, `.w` stays as A's hi-res flag; `RenderStats` removed, `render()` returns void. impl-D46 did `hud.setGpu`/`axes.clear`). |
| D-40 | L | `src/main.ts:121` | Legend "Other" swatch hard-codes `#6f6e66` instead of `OTHER.dark` from `palette.ts:13`. | Import the constant. | **Done** (impl-D7): `OTHER.dark` from `core/palette`. |
| D-41 | L | `src/main.ts:172-175`, `:194` | `onDataset` fills `xSel`/`ySel` then immediately refills them in `fillAxisSelects()`; `positionOf` called twice for one point. | Remove the first fill; call once. | **Done** (impl-D7): `onDataset` no longer pre-fills `xSel`/`ySel` (only `fillAxisSelects()`); `positionOf` called once. |
| D-42 | L | `src/main.ts:60-64` | Toast timer stashed as a property on the function object via double cast. | A module-level `let toastTimer`. | **Done** (impl-D7): module-level `toastTimer`. |
| D-43 | L | `src/main.ts:194-195`, `app.ts:122-123,315`, `layouts.ts:70,88-89`, `axes.ts:53,44,63`, `shaders.ts:86,95` | Magic numbers: zoom `< 60 → 90`, stagger `20_000/0.35/0.18`, `200_000/1100/850`, fit pad 72, bins 12/10/8, label width `6.2`/px, axis gutters 38/54, LOD 3–9 px. | Name them as constants next to their rationale. | — |
| D-44 | L | `index.html:7` + `src/main.ts:1` | `style.css` is both `<link>`ed and `import`ed — loaded twice in dev. | Keep the import, drop the link. | **Done** (impl-D7): `<link>` dropped, the `import './ui/style.css'` stays. |

### Build / deploy / docs

| id | sev | file:line | description | proposed fix | overlap |
|---|---|---|---|---|---|
| D-45 | L | `README.md:17` | "58 unit tests" — there are 98. | Drop the number. | Deferred to lead: README line 17 now says "131 unit tests" (217 at time of writing) — drop the number. |
| D-46 | L | `README.md:70-71`, `src/app.ts:346-349` | README and the first comment say an idle collection "redraws at 10 Hz"; the code (and the second comment) draws nothing when idle. | Fix both to the current behaviour. | **Done** (impl-D3, app half): stale 10 Hz comment in `src/app.ts` loop replaced. README:71 still the lead's. |
| D-47 | L | `README.md:53`, `src/app.ts:161` | "~950" atlas capacity; `CardAtlas(4096,128,4)` gives `floor(4096/136)²` = 900. | Say 900 or compute it in the doc. | A · Already fixed by impl-A ("~950" no longer in README). |
| D-48 | L | `.github/workflows/deploy.yml:3-6`, `scripts/_verify-subpath.mjs` | CI runs only on push to `main`; the sub-path smoke test exists but is unwired, hard-codes `/var/web/pivot/screenshots` and port 4173. | Add a `pull_request` trigger; parameterise the script and run it in CI against `vite preview --base /tessera/`. | **Done** (impl-D2): `pull_request` trigger; build job runs `scripts/_verify-subpath.mjs` against `vite preview --base /tessera/` (script now takes a URL, `--screenshot`, `--swiftshader`; asserts `datasetN>0` not 891); deploy only on push. Verified locally. |
| D-49 | L | `tsconfig.json:15` | `include` lists `scripts` but `allowJs` is off, so the `.mjs` files are not checked. | Either `allowJs: true, checkJs: true` or drop `scripts`. | **Done** (impl-D2): dropped `scripts` from `tsconfig.json` include. |
| D-50 | L | `pipeline/segment.py:218-225` | `masks[big_enough]` copies the full-resolution bool stack (N×H×W; 300 proposals on the Papillons plate ≈ 900 MB). | Index lazily (`masks[i]` inside loops) or downsample before filtering. | **Done** (impl-D2): downsample by `DEDUP_STRIDE` before selecting `big_enough`; `dedup(..., strided=True)`. |

## Remediation plan

Steps are grouped by file area so independent agents can run them in
parallel without touching the same files. Groups marked **after A/B/C** must
wait for the named workstream to land, because they edit the same files.

### Group 1 — `src/layout/*` (no overlap; start now)
1. D-01: make raster detection column-based (`layouts.ts`), add `pitch` to `LayoutResult` (feeds D-10).
2. D-04: try/catch in `worker.ts`, error message type, `client.ts` rejects + `onerror`.
3. D-36: integer-edge binning in `bucketize`.
4. D-38: delete `binNumeric` from `columnar.ts` **only if** Group 4 agrees (it owns `data/*`); otherwise leave for Group 4.

### Group 2 — `src/gl/camera.ts` + `src/gl/zoom.ts` (no overlap; start now)
5. D-03: remove the DPR cap; single DPR source.
6. D-02: drag threshold / `wasDrag` flag on the controller.
7. D-08: `fit` no-op on empty bounds.
8. D-33 (optional): pinch zoom.

### Group 3 — `src/app.ts` core (after B lands, because B edits `loadByKey`)
9. D-05: load sequence guard; id-keyed `LayoutEngine.load`.
10. D-09: initial layout spec in `loadDataset`.
11. D-10: `scale` from layout pitch.
12. D-12: validate keys in `loadByKey`.
13. D-14, D-20, D-22, D-27, D-34 (`transitionMs` from reduced-motion).
14. D-06: DPR-change observer.
15. D-02 consumer: skip `onClick` when the camera reports a drag.

### Group 4 — `src/data/*` (after B lands)
16. D-17, D-18: csv blank rows, BOM, small-integer categoricals.
17. D-30: single `PIXEL_TITLES` export.
18. D-37: `core/prng.ts`.
19. D-38: `binNumeric`/formatter unification.

### Group 5 — `src/gl/renderer.ts`, `atlas.ts`, `shaders.ts` (after A lands)
20. D-07: context loss/restore.
21. D-16: drain queries on disjoint.
22. D-26: `MAX_TEXTURE_SIZE` clamp.
23. D-39: remove `jumpTo`, `dim`/`a_meta.zw`, unused `RenderStats`.
24. D-21: note for A — partial atlas upload.

### Group 6 — `src/ui/*` (no overlap; start now)
25. D-19: axes render only when camera/axes changed (needs a `cameraVersion` or `moved` flag in `FrameModel` — coordinate a one-line addition in `app.ts` with Group 3, or read `camera.current` deltas locally in `AxisOverlay`).
26. D-29: in-place facet updates.
27. D-35: hidden-category count.
28. D-23, D-39 (`hud.setGpu`, `axes.clear`).

### Group 7 — `src/main.ts` + `index.html` + `style.css` (after C lands)
29. D-24: try/catch around `load`, revert select.
30. D-25: shared `esc()` for detail/report.
31. D-11, D-13, D-31, D-32, D-40, D-41, D-42, D-44.

### Group 8 — docs, CI, scripts, pipeline (no overlap; start now)
32. D-45, D-46, D-47 README/comment fixes.
33. D-48: PR trigger + wired sub-path check.
34. D-49: tsconfig `scripts` include.
35. D-50: pipeline memory.

## Tests to add

Existing coverage is good for `sort`, `layouts` (grid/bars/scatter),
`columnar`, `pixels` colour maths and `zoom`. Missing, in priority order:

1. **`xyLayout`** (`tests/layouts.test.ts`): raster detection with and without
   a mask (D-01 regression), non-raster axis scaling, NaN rows hidden, tick
   positions, empty mask bounds.
2. **`parseCsv` / `inferDataset`** (new `tests/csv.test.ts`): quoted fields,
   `""` escapes, CRLF, trailing newline, blank lines, BOM, unterminated quote,
   numeric/category/text inference thresholds, `labelColumn` fallback.
3. **`CameraController`** (new `tests/camera.test.ts` cases with a stub canvas):
   `zoomAt` keeps the anchor fixed, `fit` respects `quantise` and empty bounds
   (D-08), `update` converges and returns false when settled, drag threshold
   (D-02), DPR consistency (D-03).
4. **`FrameStats`**: mean/percentile/worst/history ring-buffer wraparound.
5. **`FacetPanel.mask` / `maskExcept`** (extract the pure part to
   `core/filter.ts`): cross-filter semantics, multi-field AND, empty filters →
   null.
6. **`CardRenderer.setTargets` CPU half** (extract `snapshotFromTo(from,to,t,targets)`
   as a pure function): mid-flight snapshot, alpha-0 targets stay in place.
7. **`LayoutEngine`** with a fake `Worker`: newest-request-wins, error
   rejection (D-04), `load` id keying (D-05).
8. **`loadByKey` / `PivotApp.loadDataset` sequencing** with fake loaders (D-05).
9. **`generateProducts` / `generateTitanic`**: determinism for a seed, value
   ranges, `n` sizes, label column presence at the 50 k threshold.
10. **`palette`**: `categoricalColor` folds to `OTHER` past 8, `sequential`
    clamps.
11. **`fmtScale`**, **`fmtTick`/`shortNumber`** after unification.
12. **CI smoke**: run the sub-path Playwright check against `dist/` (D-48).

## Out of scope / deliberate non-issues

- `preserveDrawingBuffer: true` and skipping frames when the GPU is behind are
  deliberate and documented (`renderer.ts:74-78`, `app.ts:342-349`).
- `bufferData` orphaning on every layout upload (`renderer.ts:209-213`) is
  the right call; the 2×32 MB per morph at 2 M is inherent to the design.
- `pick()` is an O(n) scan per click (`renderer.ts:372-386`); ~2–5 ms at 2 M
  rows, not worth a spatial index.
- `worker.load` clones rather than transfers the columns on purpose
  (`client.ts:40-41`); the main thread needs them.
- Pending solves for superseded requests are resolved and discarded rather
  than rejected (`app.ts:278`) — fine, they are not errors.
- `vite` `base: './'` with `new URL('./worker.ts', import.meta.url)` was
  verified by the author under a `/tessera/` mount (`vite.config.ts:5-12`);
  the only gap is that the verification is not automated (D-48).
- `index.html` uses absolute `/src/...` URLs; Vite rewrites these at build
  time, so they are sub-path safe.
- Uncommitted `package.json`/lockfile changes (an `@elevenlabs/elevenlabs-js`
  dependency) belong to workstream C and were ignored.
- `.claude/agents/*.md` are tracked despite being in `.gitignore`; not a code
  issue.
- The legend shows the first 8 categories by code rather than by count; a
  design choice that matches the fixed-slot palette rule (`palette.ts:1-5`).
- Facet counts recompute an O(n·facets) mask per change (`facets.ts:69-82`);
  ~3 M ops at 1 M pixels, well under a frame.
- `tests/helpers/prng.ts` duplicating the app PRNG is acceptable for tests
  once D-37 exports it from `core/`.

## Review of this plan (second pass)

Dropped from the first draft: a "dead `RenderStats` allocation per frame"
perf finding (one small object per drawn frame — noise), a "`hud.percentile`
sorts twice per update" finding (180 floats every 140 ms), an "SVG label width
estimate is a magic 6.2 px/char" entry (folded into D-43), a "`Math.max(1,
...counts)` spread" robustness note (category counts are always small), and a
separate "`histogram` twice per facet change" note (folded into the facets
non-issue above). Merged: the DPR-cap and click/drag DPR mismatch into D-03;
`onDataset` double fill and the double `positionOf` into D-41; all dead-code
entries into D-39; README drift into D-45–47. D-01, D-08 and D-17 were reproduced with a
vitest probe against HEAD (`xyLayout` half-masked 10×8 raster → sx 0.889 /
sy 0.714; `gridLayout` all-masked → `minY:0,maxY:0`; `parseCsv` blank line →
`[""]`, BOM kept).
