# Handoff — Tessera (2026-08-27)

Read this first if you are resuming, then `docs/PROGRESS.md` (rows + dated log)
and `~/.claude/skills/agent-bus/bus.sh read 60`. Workstreams A–F, D, H and I are
**committed on `main`** as of 2026-08-27 (one commit per subsystem; `git log`
reads as the build order). G is implemented in the working tree, uncommitted.

## State

| ID | Plan | State |
|---|---|---|
| A | plans/A-hidpi-cards.md | done — hi-res atlas, superseded in part by I/WP3 |
| B | plans/B-datasets.md | done — tax-cases (+geo), tax-returns, payments, invoices, registry; Titanic removed; faker en_GB |
| C | plans/C-onboarding.md + E §4 | done — 16-step insight-led tour, **audio generated** (2026-08-27 09:22) |
| D | plans/D-code-review.md | done — all 8 remediation groups |
| E | plans/E-customer-journey.md | done — map + night lights, flagship card, detail view |
| F | (user request) | done — `Dataset.colors`, `colorOfRow` |
| H | plans/H-review-round1.md | done — review round 1, fix groups 1–3 |
| I | plans/I-cards.md | **done — WP1–WP6**, including the §9 addendum |
| G | plans/G-performance.md | done — hitch, solve memo, atlas bytes, shader branches; §5 lists what only the user's GPU can answer |

## What is left

1. **Re-measure G on real hardware.** `docs/plans/G-performance.md` §5 lists it:
   press **Benchmark** in the browser that produced
   `bench-results/manual-json-2026-08-27T11-46-49.json` and compare `worst` on
   `tax-cases:900` and `products:1000` (91.7 and 50.1 ms before) and `gpuP50`
   everywhere. Then load once with `?preserve=0` and press it again — if that
   moves `gpuP50`, `preserveDrawingBuffer` should stop being the default; if it
   does not, delete the flag. Nothing about a real GPU can be measured on this
   box: headless Chromium here is llvmpipe, so every local figure in that plan
   is a ratio against itself and says so.
2. Noted but deliberately not built (plan I §, plan G §4): a uniform grid index
   over `renderer.to` would make `renderer.pick` O(1) and lift the 200,000-row
   hover gate; Deep Zoom tiles beyond 1024 px; `OffscreenCanvas` rasterisation;
   packing the style buffer below 16 bytes.

## How to verify the tree

```
pnpm typecheck && pnpm test          # 414 tests
pnpm test:e2e                        # tour, port 5182
node scripts/detail-e2e.mjs          # record modal, 27 checks (5195)
node scripts/verify-cards.mjs        # Cards popover + canvas keyboard, 15 checks (5197)
node scripts/verify-card.mjs         # uniqueness + the flagship card (5196)
node scripts/verify-hidpi.mjs        # hi-res tier + sharpness (5191)
node scripts/verify-map.mjs          # map, glow, far zoom, blend (5194)
pnpm bench                           # bench-results/latest.json (5181)
node scripts/perf-probe.mjs          # load/solve/frame/fill/bytes (5312, needs pnpm build)
```

Use Linux node and the bundled Chromium (`playwright-wsl` skill); each script
starts its own vite on its own port and kills it. Add `--swiftshader` for a
reproducible CPU-only run. Screenshots land in `screenshots/`.

Two of these are timing-sensitive by design: the hi-res pass commits
**atomically** (nothing flips until every visible card has its own art), so
`verify-hidpi` and `verify-card` wait for `lastFrame.hiRes` before sampling
rather than sleeping a fixed time. If either starts reporting "hi-res off",
suspect the wait, not the renderer.

## Things worth knowing before you edit

- **The watcher is an allow-list.** `vite.config.ts` watches `src/`, `public/`,
  `index.html` and the three config files, via a chokidar predicate that prunes
  at the top level. A new top-level directory is *not* watched — add it there if
  it needs to be. This is a WSL2 heat/inotify measure; several vite servers run
  at once during the verification scripts.
- **A collection's shape never depends on its size.** All five generators used
  to drop their identity column above 50,000 rows; they no longer do. Formulaic
  identity columns (`Case`, `Return`, `Transaction`, `Invoice`, `Product`) are
  `derivedText` — computed from the row index, `values` is null — so read text
  columns through `col.at(i)` or `valueAt`, never `col.values[i]`.
- **Uniqueness lives in the hi-res atlas** (`src/gl/hires.ts` `planTier`,
  `src/app.ts` `updateHiRes`), not in the base atlas. The base atlas holds one
  card per row up to ~3,136 rows and one *cover* per category above that.
- **The hi-res pass is now deliberately off below the per-item cap** until a
  card outgrows its own base slot (`hiResWorthwhile`, `tierBeatsBase`). A script
  that expects `lastFrame.hiRes` must zoom past the slot, not merely past
  `UNIQUE_MIN_PX` — `verify-card` phase 2 reports "hi-res off" at 128 px on a
  128 px slot and that is correct, not a regression.
- **The modal is modal.** `#app` is `inert` while it is open, so anything that
  drives the app while the dialog is up must either close it first or call the
  app directly (the tour does both — see `src/tour/actions.ts`).
- **`.tour` is z-index 50, above `#overlay` (40).** The tour frames the whole
  application including the modal.
- **The tour's narration is fixed.** Audio exists and the hash tests are live;
  changing a line in `src/tour/script.ts` invalidates its clip and requires
  `pnpm voiceover`. The user has deferred that (§9.1).

## Coordination

Agent bus: `~/.claude/skills/agent-bus/bus.sh board|read|announce`. Ports in use
by the scripts: 5181, 5182, 5191–5197. Pick something else for ad-hoc servers
and kill the process group when done.
