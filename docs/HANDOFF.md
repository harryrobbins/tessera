# Handoff — Tessera (2026-08-27)

Read this first if you are resuming, then `docs/PROGRESS.md` (rows + dated log)
and `~/.claude/skills/agent-bus/bus.sh read 60`. Workstreams A–F, D, H and I are
**committed on `main`** as of 2026-08-27 (one commit per subsystem; `git log`
reads as the build order). Only G is outstanding.

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
| G | — | **not done**: the performance pass never landed (its agent died mid-run) |

## What is left

1. **G, the performance pass.** `bench-results/after-wp3-*.json` is a full run
   but it is **software** (llvmpipe on headless WSL2), not a GPU: 60 fps to
   1,000 cards, 42–51 at 10,000, 11–18 at 100,000, 2–4 at 500,000, and
   1,000,000 does not complete a phase. There is **no GPU baseline** — the older
   `before-*.json` is SwiftShader and reports p95 = 0 above 10,000 rows. To do
   this properly: `pnpm dev`, press **Benchmark** in a real browser window, save
   that as the baseline, then optimise. `scripts/perf-probe.mjs` measures load, solve,
   frame time per mode, the hi-res hitch and bytes uploaded — it was written
   for that pass and has never been run against the current tree.
2. Noted but deliberately not built (plan I): a uniform grid index over
   `renderer.to` would make `renderer.pick` O(1) and lift the 200,000-row hover
   gate; Deep Zoom tiles beyond 1024 px; `OffscreenCanvas` rasterisation.

## How to verify the tree

```
pnpm typecheck && pnpm test          # 391 tests
pnpm test:e2e                        # tour, port 5182
node scripts/detail-e2e.mjs          # record modal, 27 checks (5195)
node scripts/verify-cards.mjs        # Cards popover + canvas keyboard, 15 checks (5197)
node scripts/verify-card.mjs         # uniqueness + the flagship card (5196)
node scripts/verify-hidpi.mjs        # hi-res tier + sharpness (5191)
node scripts/verify-map.mjs          # map, glow, far zoom, blend (5194)
pnpm bench                           # bench-results/latest.json (5181)
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
