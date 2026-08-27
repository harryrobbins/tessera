# H — Review round 1 (uncommitted tree vs HEAD bbd5e09)

Reviewed 2026-08-27 by reviewer-1 (Fable), read-only. Scope: the whole
uncommitted diff (`git status`: 32 modified/deleted, ~50 untracked under
src/, tests/, scripts/, docs/, .github). Every finding below was checked by
reading the cited lines; two read-only subagents covered `src/data/*` +
`src/core/palette.ts` and `src/tour/*` + `src/ui/detail*`, and their claims
were re-verified before inclusion.

## Summary

The tree is green: `pnpm typecheck` clean, `pnpm test` 235 pass / 3 skipped
(the skips are the audio-manifest checks; `public/audio/tour/` is empty by
design), `pnpm build` OK (main chunk 133 kB / 51 kB gzip; faker `en_GB`
split into its own 425 kB / 157 kB gzip chunk; relative `base: './'` so the
`/tessera/` Pages mount works), and all five browser scripts pass on
Linux node + bundled Chromium: `verify-map` (glow 3.08x, 2.02 % white),
`verify-hidpi` (tier 512, gradient energy 6.24x/6.25x at DPR 2/1),
`verify-card` (tier 1024), `detail-e2e` 22/22, `tour-e2e` all passes.
No secret appears in `src/`, `public/`, `index.html`, `scripts/` or
`.github/`; the ElevenLabs key is only read from `process.env` in
`scripts/generate-voiceover.mjs:34` and lives in `.env.local`, which is
ignored only by the **uncommitted** `.gitignore` line (`.env.*`).

The integration seams the parallel agents shared mostly hold: the
load-sequence guard, id-keyed worker loads, `pitch`-based scale, context
restore → `buildCards`, `wasDrag` → `onClick`, facets in-place update ↔ tour
`toggle`/`clearAll`, and named colours ↔ legend/facets/cards all agree.
Three problems are real and user-visible:

1. **Hi-res atlas never refreshes after a layout or filter change while the
   camera is still** (`app.ts:451-452`): the skip key is camera + viewport +
   tier only, so cards that moved keep (or never get) hi-res art.
2. **Tour swallows Enter/Space outside its card** (`tour/ui.ts:198`): during
   the detail step, Enter on "Review action" (or any select/tab) advances the
   tour instead of activating the control.
3. **Tour step actions are not abortable** (`tour/engine.ts:105`): after
   Skip/Esc or Back mid-step, the old action keeps driving the app (the
   `record` step selects a card and opens the pane after the tour is gone).

Then a cluster of "same value computed two ways" seams (card-0 size as "the"
card size, detail-pane accent vs card accent, three hex parsers, two
`mixHex`, two `esc`, two `safeStorage`), a few unhandled-rejection paths in
`main.ts`, and reduced-motion gaps in the tour and stepped zoom.

## Findings

Severity: Critical / High / Medium / Low. `[sub]` = raised by a subagent and
re-verified here.

| id | sev | file:line | description | proposed fix | status |
|---|---|---|---|---|---|
| H-01 | High | `src/app.ts:451-452`, `:518-540`, `:542-545` | `updateHiRes` returns early when `key === this.hiKey`, and the key is `cam.x,y,zoom,w,h,tier` only. `setLayout`/`setMask` never reset `hiKey`, so after a re-sort, a layout change, or a facet filter that leaves the camera where it was (common: the tour's filter steps, any facet click, Bars→Grid at the same zoom), the cards now in view are not re-rasterised and the slots still assigned to cards that moved away are never revoked. `verify-hidpi`/`verify-card` only zoom, so they cannot see it. | In `setLayout` (after `setTargets`) and in `clearHiRes` set `this.hiKey = ''`; or fold `this.solveSeq` into the key. Add a unit test on a pure `hiResKey(cam, view, tier, solveSeq)` helper, or a Playwright step in `verify-card.mjs` that filters and asserts `lastFrame.hiRes.cards` changes. | done (fix-1): `hiResKey(cam,w,h,tier,solveSeq)` in gl/hires.ts + `hiKey=''` after `setTargets`; tests/hires.test.ts |
| H-02 | High | `src/tour/ui.ts:198-201` `[sub]` | Window-capture keydown treats Enter/Space as "Next" unless the target is a `<button>` inside the tour card. Enter on `#detail a[data-action]` (the detail step's "Review action"), on a layout tab, or Space on a facet checkbox/select is intercepted (`stopImmediatePropagation` + `preventDefault`), so the control never activates. `detail.ts:96` stops propagation of *click*, not keydown, so it does not help. | Only treat Enter/Space as Next when `e.target === document.body` or `this.root.contains(e.target)`; leave native activation elsewhere. Add a jsdom test for the keyboard map. | done (fix-2): `ui.ts` `onKey` ignores Enter/Space/arrows unless the target is `<body>` or inside the tour card (M skips form fields); tests/tour-ui.test.ts |
| H-03 | High | `src/tour/engine.ts:94-121`, `src/tour/actions.ts:20,87-96,136-142` `[sub]` | `ctrl.signal` reaches only `player.play`; `step.run()` runs to completion regardless of `skip()`/`back()`/`next()`. `sleep`/`settle` keep resolving, then `host.select(i)` / `setLayout` / facet toggles fire against whatever the user (or the next step) is doing — e.g. Esc during `record` still opens the detail pane ~1 s later; Back during an `acting` step runs two `setLayout` chains concurrently. | Pass `ctrl.signal` to `run(signal)`; make `sleep`/`settle` resolve early on abort and check `signal.aborted` before every host mutation. Test: `back()` during `acting` leaves exactly one pending action. | done (fix-2): `TourStep.run(signal)`; `sleep`/`settle` resolve on abort; every action checks `signal.aborted` before each host mutation; tests/tour-engine.test.ts (back/skip during acting) |
| M-01 | Medium | `src/app.ts:443`, `src/tour/actions.ts:116` | `cardPx = r.to[2] * cam.zoom` and `cardZoom` read card **0**'s size. When card 0 is masked out (size 0) hi-res never engages and the tour's `flyTo` computes zoom `px / 1`. Same class as D-10, which was fixed for `scale` but not here. | Track the layout's card size (`CARD_SIZE`, `MAP_DOT`, or `CARD_PITCH` for rasters) alongside `pitch` on `LayoutResult`, or use the first entry of `visibleCards()`; expose `app.cardSize` for the tour. | done (fix-1): `LayoutResult.cardSize` (layouts/worker/client), `app.cardSize`, hi-res uses it; tour side is Group 2 |
| M-02 | Medium | `src/ui/detail.ts:68,73` vs `src/app.ts:331-335,385`, `src/main.ts:147` | The detail pane header is painted `categoricalColor(code)`, but the card, legend and facet swatches use `fieldColors(ds, colorBy)` (pins / colour-name auto-detect, no 8-slot cap) and the sequential ramp for a numeric colour-by. With `Tone` pins or `Hue family` names, or any numeric colour, the pane's accent disagrees with the selected card. | Add one `colorOfRow(ds, colorBy, i): string` (palette.ts) used by `cardSpec`, `applyColors` and `DetailPane.show`; pass its result as `accent`. | palette side done (fix-3): `colorOfRow(ds, colorBy, i, theme?)` exported from palette.ts + tests; detail/app consumers are Groups 2/1 | done (fix-2/fix-3): `DetailPane.show` uses `colorOfRow` from palette.ts; tests/detail.test.ts |
| M-03 | Medium | `src/main.ts:219`, `:256`, `:342-370` | `facets.onChange` calls `void app.setMask(...)`; a worker error (D-04 now rejects) is an unhandled rejection with no toast, unlike `apply()`. `datasetSel` change calls `void load(key)` and `load` **rethrows** after toasting, so every failed menu load is also an unhandled rejection. | Route `setMask` through the same try/catch + toast as `apply`; in the select handler use `load(key).catch(() => {})` (the toast is already shown), keep the rethrow for `boot()`/tour. | done (fix-3): `facets.onChange` catches `setMask` → "Filter failed" toast; menu change `load(key).catch(() => {})`, rethrow kept for boot/tour |
| M-04 | Medium | `src/ui/detail.ts:77,81-85` `[sub]` | `show()` moves focus to the pane's close button; `hide()` (button, Escape, dataset change) hides the pane while it holds focus, dropping focus to `<body>`. Keyboard users lose their place. | Remember `document.activeElement` in `show()`; in `hide()` refocus it (fallback `#gl` or `#tourBtn`). | done (fix-2): `DetailPane` remembers the opener, `hide()` refocuses it (else `#gl[tabindex]`, else `#tourBtn`) only if the pane held focus; tests/detail.test.ts |
| M-05 | Medium | `src/tour/actions.ts:136-142,226-229`, `src/app.ts:564-568`, `src/gl/camera.ts:194` | Reduced motion is honoured for card flights and `main.ts` fits (`tweenMs`), but the tour's `flyTo(…, 1000)` + `sleep(450)` and `app.zoomStep` → `camera.zoomTo(z)` (260 ms default) still animate. | Put `tweenMs` on `TourHost` (or read `app.renderer.transitionMs === 0`) and pass 0; give `zoomStep` a `ms` derived the same way. | done (fix-3 chrome side): `tourHost.tweenMs` in main.ts (0 under reduced motion); `zoomStep(dir, ms)` is fix-1, tour side fix-2 | done (fix-2 tour side): `TourHost.tweenMs?(ms)`; flyTo/sleep use `host.tweenMs?.(ms) ?? ms`; `cardZoom` reads `app.cardSize` (M-01). app/main halves by fix-1/fix-3 |
| M-06 | Medium | `src/core/palette.ts:55-67,131-145` `[sub]` | `NAMED` has near-identical hues for distinct names (purple 264°/violet 259°, aqua/teal/turquoise/cyan within 13°, royal/cobalt/blue) and many everyday words (Sky, Forest, Rose, Gold, Silver, Royal, Mint, Tan, Rust, Plum, Sage, Coral, Other, None) so a product-name or team-name field can auto-colour into indistinguishable swatches. | Require at least one core hue word (red/orange/yellow/green/cyan/blue/purple/pink/brown/grey) per field before auto-detecting; collapse exact synonyms to one hex; add a test asserting minimum pairwise hue/lightness separation for the common set. | done (fix-3): auto-detect requires a core hue word in at least one label (`hasCoreHue`), synonyms collapsed (violet=purple, aqua=cyan, royal/cobalt=blue, …), neutrals take `OTHER[theme]`; pairwise separation + light-theme tests |
| M-07 | Medium | `src/tour/player.ts:107-133` `[sub]` | `wait()` resolves on `ended`/`error`/abort only; a stalled stream that never fires either leaves the step up until the user clicks Next. | Arm a ceiling `setTimeout(finish, max(minMs, 3 × expected))` alongside the listeners. | done (fix-2): ceiling `setTimeout(finish, max(3*ms, 500))` in `AudioPlayer.play`; test |
| M-08 | Medium | `src/app.ts:190-211` | Between `renderer.setCount(ds.n)` (line 200) and `buildCards()` (211) there is an `await engine.load(...)`. During that window `renderer.count` is the new n while `to`/`style` hold the old collection, and `this.specOf`/`this.atlas` still close over the **old** dataset; a camera move (wheel during load) renders stale instance data with the new count, and `updateHiRes` can rasterise old-dataset cards into the hi-res atlas. Harmless today only because `applyColors` rewrites every style afterwards. | Set `this.specOf = null` and `this.renderer.setCount(0)` (or defer `setCount` to just before `buildCards`) at the top of the load; keep `clearHiRes()`/`releaseHi()` where they are. | done (fix-1): `specOf=null` at load start, `setCount` deferred to just before `buildCards` |
| M-09 | Medium | `scripts/generate-voiceover.mjs:97-122` `[sub]` | The manifest is written once after the loop; if `textToSpeech.convert` throws mid-run (missing/unshared voice returns an API error; there is no try/catch), the clips already generated (and billed) are orphaned and regenerated next run. `--only <bad-id>` silently yields 0 lines and still rewrites the manifest (line 75). | Write the manifest after each clip; wrap `convert` and, on a 4xx naming the voice, print the `--add-voice` hint; error out when `lines.length === 0`. | done (fix-3): manifest written after every clip, `convert` wrapped (4xx naming the voice → `--add-voice` hint), `--only <unknown>` exits 1 |
| M-10 | Medium | `.gitignore:7`, `.env.local` | The live `ELEVENLABS_API_KEY` in `.env.local` is protected only by the uncommitted `.env.*` line. Any `git add -A` before `.gitignore` is committed would stage it. | Commit the `.gitignore` change first (on its own), then the rest. | in place (fix-3): `.gitignore:7` `.env.*` covers `.env.local` (`git check-ignore` confirms); not committed per instructions — commit `.gitignore` on its own first |
| M-11 | Medium | `src/layout/client.ts:22-24,52-56` | `worker.onerror` rejects `pending` solves but never settles `loading`, so if the worker dies during `load` (bad clone, OOM at 1M rows) `this.loaded` never resolves and every later `solve()` awaits forever, with no toast. | Keep `reject` per `loading` entry and reject them in `onerror` (and on a `load` error reply); `loadDataset` then surfaces it via `main.ts` toast. | done (fix-1): `loading` keeps reject; `onerror` + `error` reply reject loads; 2 tests |
| L-01 | Low | `src/gl/atlas.ts:245-252`, `src/gl/cards/taxCase.ts:459-469`, `src/core/palette.ts:25,113` | Three hex parsers (`mixHex`, `inkOn`/`rgba`, `hexToRgb`) and two different functions both named `mixHex` (atlas: RGB lerp returning `rgb()`; palette: private HSL 50/50). | Export `hexToRgb`/`hexToHsl` from palette.ts and use them; rename palette's mixer `mixHueHsl`. | done (fix-1 + fix-3): atlas `mixHex`, taxCase `inkOn`/`rgba` use palette `hexToRgb`; palette mixer renamed by Group 3 |
| L-02 | Low | `src/gl/camera.ts:254` vs `src/gl/renderer.ts:519` | `easeInOutCubic` and `ease` are the same function. | One export (e.g. `src/core/ease.ts`), imported by both. | done (fix-1): `src/core/ease.ts`, imported by camera + renderer |
| L-03 | Low | `src/app.ts:508` vs `src/gl/atlas.ts:27`; `src/app.ts:455` vs `src/gl/renderer.ts:35` | `'#1c1c1b'` literal instead of `BG`; `gl.getParameter(MAX_TEXTURE_SIZE)` per settle instead of `renderer.maxTextureSize`. | Use the exported constant / field. | done (fix-1): `BG` + `renderer.maxTextureSize` |
| L-04 | Low | `src/gl/atlas.ts:86-87`, `src/app.ts:291` | `CardAtlas.size` was added (D-26) for app.ts, which compares `atlas.canvas.width` instead; `size` is unused. | Use `this.atlas.size !== atlasSize` and drop the duplicate, or drop the field. | done (fix-1): `atlas.size` compared |
| L-05 | Low | `src/tour/ui.ts:239`, `src/tour/player.ts:145` + `src/tour/index.ts:97`, `engine.ts:131` + `index.ts:6` `[sub]` | Second `esc`, two `safeStorage`, the `'tessera.tour.v1'` key literal twice, `markDone` duplicating the engine's store write. | Import `esc` from `core/esc`; one `safeStorage` + `TOUR_KEY` in `tour/store.ts`. | done (fix-2): `tour/store.ts` (`TOUR_KEY`, `TOUR_DONE`, `safeStorage`, `markTourDone`) used by engine/index/player; `markup` uses core/esc |
| L-06 | Low | `src/app.ts:613-620` | `this.wasIdle = this.idle` executes only inside the `needed` branch where `idle` is always false, so `wasIdle` is never true after the first draw and the `!this.wasIdle` guard is dead (pre-existing; D-14 removed the other half). | Either drop `wasIdle` or set it outside the branch so the first frame after an idle gap is excluded as intended. | done (fix-1): `wasIdle` set every tick, outside the draw branch |
| L-07 | Low | `src/main.ts:317-319` | `setLayoutKind` calls `describeZoom()` before `apply()`, so the zoom tooltip reflects the previous layout's `isRasterView`. | Call `describeZoom()` from `app.onLayout` (or after `apply` resolves). | done (fix-3): `describeZoom()` moves from `setLayoutKind` to `app.onLayout` |
| L-08 | Low | `src/main.ts:347` | `datasetSel.value = key` with a key not in the menu (`?dataset=tax-cases:5000`, `titanic`) leaves the select blank. | Fall back to `describeKey`-matched option or append a temporary option. | done (fix-3): `selectDatasetOption` — off-menu size of a known family gets a temporary option in its optgroup; unknown key shows the default |
| L-09 | Low | `scripts/verify-hidpi.mjs:85`, `scripts/tour-e2e.mjs:219` | `?dataset=titanic` — the key no longer exists; it works only via the unknown-key → default fallback, so the script's intent ("per-row cards") is now implicit. | Use `tax-cases:900` / `tax-cases:3000` explicitly. | done (fix-3): verify-hidpi → `tax-cases:900`, tour-e2e → `tax-cases:3000` |
| L-10 | Low | `src/tour/ui.ts:129-144` `[sub]` | A `SpotRect` target (the featured card) is re-resolved on resize/scroll only; panning during the `record` step leaves the spotlight on the old spot. | Re-run `reposition` from `app.camera.onChange` while a rect target is active. | done (fix-2): rAF tracking while a rect target is spotlit (`startTracking`/`stopTracking`), repositions only when the rect changes; test |
| L-11 | Low | `src/tour/engine.ts:95-102` `[sub]` | `goto(0)` with an empty `steps` array calls `onStep(undefined)` before the try/catch. | `if (!step) return this.finish('done')`. | done (fix-2): `goto` finishes 'done' on a missing step; test |
| L-12 | Low | `src/tour/player.ts:83-92` `[sub]` | `preloaded` `Audio` elements are never released; each `startTour` builds a fresh player. | `dispose()` clearing the map, called from `index.ts` `close`. | done (fix-2): `AudioPlayer.dispose()` called from `close()`; test |
| L-13 | Low | `src/data/registry.ts:63` vs `docs/plans/B-datasets.md:66` `[sub]` | `invoices` awaits the faker import at every size (100k too); the "faker only ≤ 50k" claim holds for tax-cases only. Deliberate (36 supplier names are a category) but undocumented. | One-line comment in registry.ts; or gate at 50k with placeholder suppliers. | done (fix-3): comment in registry.ts (supplier names are a category, so faker at every size); test asserts faker is not imported for tax-cases:100k |
| L-14 | Low | `src/data/registry.ts:77` `[sub]` | `pixels.load` throws and is never called (`resolveDataset` special-cases pixels at :124). | Make `load` optional on `DatasetFamily` or have it call `loadPixels`. | done (fix-3): `DatasetFamily.load` optional, pixels has none; `resolveDataset` throws a clear error if a family without `load` is reached |
| L-15 | Low | `src/bench/bench.ts:176` | D-15 still open: `solve[app.lastLayoutName] = app.lastSolveMs` after a `setLayout` that may have been superseded. | Have `setLayout` resolve to the solution (or null). | done (fix-1): `setLayout` resolves `LayoutSolution | null`; bench credits only a landed solve |
| L-16 | Low | `.github/workflows/deploy.yml:6,10-13` | `pull_request` builds run with `pages: write` / `id-token: write` at workflow level. | Move those permissions onto the `deploy` job only. | done (fix-3): workflow-level permissions `contents: read` only; `pages: write` / `id-token: write` on the deploy job |
| L-17 | Low | `tests/helpers/nodefs.ts:14-18` `[sub]` | `@ts-expect-error` on `import('node:fs')` becomes a compile error as soon as `@types/node` is added. | Add `@types/node` now and drop the directives. | done (fix-3): `@types/node` added (tsconfig `types: ["vite/client","node"]`), nodefs.ts uses plain imports |
| L-18 | Low | `src/data/taxCases.ts:237` `[sub]` | Local `const esc` (escalated flag) collides in grep with the HTML `esc()` helper. | Rename `isEscalated`. | done (fix-3): `isEscalated` |
| L-19 | Low | `src/ui/facets.ts:133`, `src/main.ts:152` | Swatch colours are interpolated into `style="background:…"` unescaped. They come from palette/`Dataset.colors` (trusted) today. | `esc()` them anyway, since `colors` is a public dataset field. | main.ts done (fix-3): legend swatches `esc()`d; facets.ts:133 is Group 2/ui — still open there |

### Test gaps (new code)

- `app.updateHiRes` policy: no test for the stale-key case (H-01) or for masked card 0 (M-01). Extract the key/tier decision into `gl/hires.ts` and test it.
- ~~`src/tour/ui.ts`: only `markup()` is tested; no jsdom test for the keyboard map (H-02), focus trap/return, `placeCard` sides/clamping, mute `aria-pressed`.~~ done (fix-2): tests/tour-ui.test.ts (jsdom devDep added).
- ~~`src/tour/index.ts`: `shouldAutoStart` (`tour=1/0`, `bench`, `dataset`, storage throwing) and the double-open guard are untested.~~ done (fix-2): tests/tour-index.test.ts covers `shouldAutoStart` + store (found and fixed: a `null` storage returned false, so a sandbox with no localStorage never auto-started). Double-open guard still only covered by tour-e2e.
- `src/tour/actions.ts`: `cardRect` (DPR, off-screen), `settle` timeout, `buildSteps` column guards untested. (open — needs a PivotApp stub; e2e covers the happy path)
- ~~`src/tour/engine.ts`: `back()`/`skip()` during `acting` (H-03) untested.~~ done (fix-2).
- ~~`src/ui/detail.ts`: no vitest; e2e covers links/toast/Escape but not focus return.~~ done (fix-2): tests/detail.test.ts.
- ~~`src/core/esc.ts`: no test (and `'` is deliberately not escaped — document that it is for double-quoted attributes only).~~ done (fix-2): tests/esc.test.ts documents the `'` rule.
- `resolveDataset('tax-cases:100000')` should assert the faker chunk is not imported; `describeKey`/unknown pixel image fallback untested.
- `palette`: no light-theme coverage, no hue-separation test, `fieldColors` never tested against the real `Tone` pins.
- `main.ts` load/menu guard (`loadSeq`, menu revert on failure) has no test.

## Fix groups (parallel-safe by file area)

**Group 1 — engine core (`src/app.ts`, `src/gl/*`, `src/layout/client.ts`, `tests/atlas|hires|layout-client`)**
H-01, M-01 (app side + `LayoutResult.cardSize`), M-08, M-11, L-01 (atlas/taxCase parsers → palette exports; palette.ts edit is a 2-line rename, coordinate with Group 3), L-02, L-03, L-04, L-06, L-15.

**Group 2 — tour + detail (`src/tour/*`, `src/ui/detail.ts`, `src/ui/detail/taxCase.ts`, `tests/tour-*`)**
H-02, H-03, M-02 (detail side: consume `colorOfRow`; Group 3 adds it), M-04, M-05 (tour side via `TourHost.tweenMs`), M-07, L-05, L-10, L-11, L-12.

**Group 3 — chrome, data, scripts, CI, docs (`src/main.ts`, `src/core/palette.ts`, `src/data/*`, `scripts/*`, `.github`, `.gitignore`, `tests/palette|registry|datasets`)**
M-03, M-05 (`zoomStep` ms + `tweenMs` on the host object in main.ts), M-06, M-09, **M-10 first**, `colorOfRow` for M-02, L-07, L-08, L-09, L-13, L-14, L-16, L-17, L-18, L-19.

Group 1 and Group 3 both touch `palette.ts` (L-01 exports vs M-06/`colorOfRow`); let Group 3 own the file and Group 1 import once it lands.

## Verified OK

- Build/deploy: typecheck, 235 tests, `vite build` (51 kB gzip main, faker as its own lazy chunk, relative base so `/tessera/` works; `dist/index.html` references `./assets/...`), the workflow's sub-path smoke test wiring, `.env.*` ignored, no key in shipped paths.
- Scripts: `verify-map`, `verify-hidpi`, `verify-card`, `detail-e2e`, `tour-e2e` all pass sequentially on their own ports and self-terminate.
- Seams: `loadSeq` guard bails at every await (`app.ts:193,210,214`) and `main.ts:354` mirrors it; `LayoutEngine.load` id-keyed and `solve` waits on the newest; worker error reply → reject → toast in `apply()`; `pitch` flows worker → client → `app.scale`; `onContextRestored` → `buildCards()` repaints both atlases after `init()`/`reupload()`; `renderer.atlasSize` clamps to `MAX_TEXTURE_SIZE`; `wasDrag` (4 css px, survives pinch → single-finger) is checked in `onClick`; canvas has `touch-action: none`; DPR observer uses `device-pixel-content-box` with a re-armed `resolution` media query fallback; `dispose()` releases observer, query, click listener and the three subsystems.
- Map: `mapScale` uses column extents (a mask cannot move the map), `equal` flag set only for the geo pair, `lod [14,32]` + additive glow only on the map, premultiplied blend correct for both cards and lights, `xy` `Y != X` guard in `currentSpec` and `fillAxisSelects`.
- Cards: `slotFor`/`hiResTier`/`slotRect`/`visibleCards`/`planHiRes` are pure and tested; `taxCasePainter` geometry scales proportionally across tiers (tested), fonts floor at 9 px, aggregates computed once per template field; `cardPainterFor` falls back to the generic card.
- Colours: one `hexToRgb`, `fieldColors` precedence (pins → names → palette) shared by app/facets/legend; `Tone` pins cover all five bands; legend shows 24 for named fields vs 8 otherwise, matching the facet list.
- Facets: DOM built once, `update()` keeps focus; `toggle`/`clearAll` fire `onChange` exactly like a click; mask ORs within / ANDs across fields (tested).
- Data: single `mulberry32` in `random.ts` (tests re-export it); faker seeded per family so names are size-independent; `ukPlaces` 262 unique entries inside the UK box; NaNs in hours/satisfaction handled by every layout; column names match `tour/columns.ts` exactly; Titanic and csv fully removed.
- Tour: double-open guarded (`index.ts:43`, `engine.start`); per-step `AbortController` + `seq` prevents double-advance; audio fallbacks (404, autoplay block, mute) all resolve; localStorage reads/writes wrapped; caption is `aria-live=polite`, dialog role, focus trap and return on destroy; ElevenLabs voice id is the only reference in `src/`.
- Detail: every dataset value passes through `esc`; links are `href="#"` + `preventDefault`; toast is a `role=status` live region; Escape and the close button both clear the selection ring.
- Docs: README test count, idle-redraw and atlas-capacity drift (D-45/46/47) fixed; the datasets table, tour section and voiceover instructions match the code and the empty `public/audio/tour/`.
