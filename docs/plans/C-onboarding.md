# Plan C — First-visit onboarding tour with pre-generated ElevenLabs voiceover

> **Lead amendment (reconciled with B-datasets.md D1):** the tour dataset is
> `tax-cases:900` (per-row cards, so the zoom/detail steps show real card art).
> Column names are B's: `Channel`, `Topic`, `Status` (Resolved/Open), `Escalated`
> (No/Yes), `Priority`, `Resolution hours`, `Contacts`, `Satisfaction`, `Month`.
> The narration below has been adjusted to those names. There is no `Outcome`
> or `Days to resolve` column.

## Findings (file:line)

**App core and how state is driven**
- `src/app.ts:37-132` — `PivotApp` is DOM-chrome-free. Public methods the tour drives: `loadDataset(key)`, `setColorBy(field)`, `setLayout(spec)`, `setMask(mask)`, `zoomStep(dir)`, `fit(animate)`. Callbacks: `onDataset`, `onLayout`, `onSelect(index)`.
- `src/app.ts:322-331` — click → `renderer.pick` → `onSelect`. No programmatic "select row i"; `main.ts` wires `app.onSelect` to highlight + `camera.focus` + detail pane, so the tour calls `app.onSelect?.(i)` directly.
- `src/gl/camera.ts:107-113` — `focus(x, y, zoom?, ms)`, `zoomTo(zoom, ms)`; `src/layout/layouts.ts:15-19` — `LayoutSpec` union (`grid | bars | scatter | xy`; UI label "Cross-tab" = `scatter`, "Scatter" = `xy`).

**UI wiring — closure-private in main.ts**
- `src/main.ts:33-36` locals; `66-98` `currentSpec()`/`apply(refit)`; `254-264` `setLayoutKind()`; `273-290` `load(key)`. None exported. The tour must not bypass them. Faithful path: set `select.value` + `dispatchEvent(new Event('change'))` (handlers 213-227), `click()` the layout tab (206-211).
- `src/main.ts:245-252` — global `keydown` (`f`, `m`, `+`, `-`, `Escape`). Tour key handling runs in capture phase with `stopPropagation()` while active.
- `src/main.ts:228-239` — localStorage pattern (`pivot.metrics`, try/catch) to copy.
- `src/main.ts:30-31, 360-374` — `URLSearchParams` (`bench`, `dataset`); `boot()` gates/auto-launches the tour after the first `load()`.
- `src/ui/facets.ts:31-50` — facet state changes only via checkbox `change` / `[data-clear]` click; rows addressable as `#facets input[data-field="X"][data-code="N"]` (line 107).
- `index.html:11-56` — spotlight targets: `#dataset`, `#layoutSeg [data-layout=…]`, `#sortField`, `#barField`, `#xField`, `#yField`, `#colorBy`, `#zoomSeg`, `#fitBtn`; stage: `#legend`, `#detail`, `#facets`.
- `src/ui/style.css:1-16` tokens; `.toast`/`.report` (188-210) overlay patterns; `.report` `z-index: 20` → tour uses 30+.

**Build, deploy, secrets**
- `vite.config.ts:12` `base: './'`; `public/` copied verbatim, so `audio/tour/x.mp3` (relative) resolves in dev and under `/tessera/` on Pages.
- `.github/workflows/deploy.yml` — typecheck/test/build on Node 24; no secrets. Voiceover must be committed, never generated in CI.
- `.gitignore` ignores `.env.*`. Vite exposes only `VITE_` vars; move `@elevenlabs/elevenlabs-js` to `devDependencies`.
- Node 24: `process.loadEnvFile('.env.local')`; unflagged type-stripping lets `scripts/generate-voiceover.mjs` import `src/tour/script.ts` directly if it uses erasable syntax only.

**ElevenLabs SDK (v2.65)**
- `client.textToSpeech.convert(voiceId, { text, modelId, outputFormat, voiceSettings, previousText, nextText, seed }) -> ReadableStream<Uint8Array>`.
- Output formats `mp3_44100_64` / `mp3_44100_128`. `import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'`.

**Tests**
- `vitest.config.ts` node env, no jsdom → engine must be DOM-free. No Playwright config; follow `scripts/bench-headless.mjs` and the `playwright-wsl` skill.

## Architecture

```
src/tour/
  script.ts      narration lines + voice config (data only, erasable TS; imported by node generator AND runtime)
  columns.ts     TOUR_DATASET + column/value name constants (single place bound to B's schema)
  engine.ts      pure TourEngine: steps, index, next/back/skip, awaits player, abortable (vitest)
  player.ts      AudioPlayer: HTMLAudioElement wrapper, preload next, mute, resolves on 'ended'
                 or after minDuration when play() rejects / file 404s
  actions.ts     bind steps → TourHost calls (the only file that knows the app)
  ui.ts          overlay DOM: spotlight, caption card, controls, keyboard, focus trap
  index.ts       startTour(host, {force}) + shouldAutoStart() (localStorage + ?tour=1)
  hash.ts        FNV-1a 64 string hash shared by generator, runtime, tests
scripts/generate-voiceover.mjs   ElevenLabs → public/audio/tour/<id>.mp3 + manifest.json (idempotent)
public/audio/tour/               committed mp3s + manifest.json
```

**TourHost facade** (built in `main.ts`, passed to `startTour`):
```ts
interface TourHost {
  app: PivotApp;
  loadDataset(key: string): Promise<void>;            // main.ts load()
  setLayout(kind: LayoutSpec['type']): Promise<void>; // clicks #layoutSeg button, awaits apply
  setSelect(id: 'sortBy'|'barBy'|'axisX'|'axisY'|'colorBy', value: string): Promise<void>;
  toggleFacet(field: string, label: string): void;    // new FacetPanel.toggle()
  clearFacets(): void;                                // new FacetPanel.clearAll()
  select(index: number): void;                        // app.onSelect?.(i)
  el(selector: string): Element | null;
}
```
`main.ts` wraps `apply` to record `lastApply: Promise` so `setLayout`/`setSelect` can await the solve.

```ts
interface TourStep { id: string; text: string; target?: string | (() => Element | null);
                     run?: (host: TourHost) => Promise<void> | void; minMs?: number }
```

**Engine contract**: `new TourEngine(steps, { player, spotlight, onDone, store })`; `start()`, `next()`, `back()`, `skip()`. Each step: `spotlight(target)` → `await run(host)` (errors caught → continue) → `await player.play(id, text, signal)` (resolves on ended; on error after `max(minMs, words/2.5*1000)`; immediately on `next()`/`skip()` via AbortController) → auto-advance. `back()` re-runs the previous step's action. Completion or skip writes `localStorage['tessera.tour.v1'] = 'done'`.

**First-visit gating** (`src/tour/index.ts`): auto-open when `?tour=1`, or when key absent and not `?bench=1` and no `?dataset=`. Auto-open shows a welcome card with **Start tour** / **Not now** — nothing plays until the click (autoplay policy). "Not now" also sets the key. `#tourBtn` in the topbar re-invokes with `force`.

**Audio**: `public/audio/tour/<id>.mp3` at `mp3_44100_64` (~0.75 MB total, lazily fetched; next clip preloaded). Model `eleven_multilingual_v2`. Voice: **George** (`JBFqnCBsd6RMkjVDRZzb`, British) default; **Lily** (`pFZP5JQG7iQjIQuC4Bku`) alternative; `--list-voices` to confirm. `voiceSettings: { stability: 0.5, similarityBoost: 0.75, style: 0.15, speed: 1.0, useSpeakerBoost: true }`, `previousText`/`nextText` from neighbours, fixed `seed`.

**Idempotency**: `manifest.json` maps `id → { hash, voice, model, chars }`, `hash = fnv1a64(text|voiceId|modelId|JSON(voiceSettings)|outputFormat)`. Generator skips matching ids; `--force`, `--dry-run`, `--only <id>`, `--list-voices`; removes orphan mp3s. `tests/tour-script.test.ts` recomputes the hash and fails when narration changed without regeneration.

## Narration script (British English, warm, ~15–25 words each)

Bold terms must match `columns.ts` (a test asserts this).

1. `welcome` — "Welcome to Tessera. Every tile you see is one record, and nothing is ever redrawn — the tiles simply fly to wherever you send them."
2. `dataset` — "Let's pick a collection. These are **tax customer-service cases**: each card is one enquiry, from first contact through to resolution."
3. `grid` — "This is the grid — the whole collection as a mosaic, ordered so that similar cases sit together. It's the honest starting point."
4. `sort` — "Sort by changes only the order. Sorting by **resolution hours** puts the quick cases first and the long-running ones last."
5. `bars` — "Bars stacks the cards into buckets. Bucketed by **channel**, you can see at a glance how enquiries actually arrive."
6. `colour` — "Now colour by **status**. Each bar shows how many of that channel's cases are resolved — and how many are still open."
7. `bucket` — "Change the bucket to **topic**, and the same cards regroup. Watch them travel; no card is lost, and none is redrawn."
8. `crosstab` — "Cross-tab bins on two fields at once. **Topic** across and **channel** up gives a table you can read from the other side of the room."
9. `scatter` — "Scatter uses raw numbers as axes. **Resolution hours** against **satisfaction** shows how waiting wears on people."
10. `facet` — "The sidebar filters. Tick **Phone** under channel, and every layout, and every other count, updates to match."
11. `facet2` — "Filters combine. Add **Yes** under escalated, and you're looking only at phone cases that had to go up a level."
12. `clear` — "Clear a filter with its clear link, and the cards return to their places. Filters never destroy anything."
13. `zoom` — "Zoom with the mouse wheel or the plus and minus buttons, and drag to pan. Up close, every card shows its own details."
14. `detail` — "Click any card to open its detail pane — the full record for that single enquiry, with the fields you filtered on."
15. `fit` — "Press F, or the Fit button, to frame the whole collection again whenever you get lost."
16. `finish` — "That's the tour. You can replay it any time from the Tour button. Now choose a collection, and see what it has to say."

≈1,450 characters.

## Steps (numbered, files touched)

1. **`src/tour/columns.ts`** — `TOUR_DATASET = 'tax-cases:900'`; `COL = { channel: 'Channel', topic: 'Topic', status: 'Status', escalated: 'Escalated', hours: 'Resolution hours', satisfaction: 'Satisfaction' }`; `VAL = { phone: 'Phone', escalatedYes: 'Yes' }`.
2. **`src/tour/script.ts`** — `VOICE` config and `NARRATION` (16 lines). Data only; erasable TS.
3. **`src/tour/hash.ts`** — `hashLine(text, voice)` FNV-1a 64-bit hex.
4. **`scripts/generate-voiceover.mjs`** — `process.loadEnvFile('.env.local')` in try/catch; fail fast if key missing; import `script.ts`; manifest read/write; `convert()` with `previousText`/`nextText`; collect stream into a Buffer; flags `--force`, `--dry-run`, `--only`, `--list-voices`; serialise requests. Add `"voiceover"` script to `package.json`; move SDK to `devDependencies`. Run once and commit `public/audio/tour/*.mp3` + `manifest.json`.
5. **`src/tour/engine.ts`** — pure `TourEngine`.
6. **`src/tour/player.ts`** — `AudioPlayer` with `play(id, text, signal)`, `preload(id)`, persisted `muted`; fallback timer on reject/404/muted; honours `localStorage['tessera.tour.fastMs']` for e2e. URL `` `audio/tour/${id}.mp3` `` relative.
7. **`src/ui/facets.ts`** — add `toggle(field, label)` and `clearAll()`; optionally `data-label` on rows.
8. **`src/main.ts`** — TourHost facade; wrap `apply` to expose its promise; `#tourBtn` → `startTour(host, { force: true })`; `boot()` → `if (shouldAutoStart(params)) startTour(host)`.
9. **`src/tour/actions.ts`** — `buildSteps(host)`: `dataset → loadDataset(TOUR_DATASET)`; `sort → setSelect('sortBy', COL.hours)`; `bars → setLayout('bars'); setSelect('barBy', COL.channel)`; `colour → setSelect('colorBy', COL.status)`; `bucket → setSelect('barBy', COL.topic)`; `crosstab → setSelect('axisX', COL.topic); setSelect('axisY', COL.channel); setLayout('scatter')`; `scatter → setLayout('xy'); setSelect('axisX', COL.hours); setSelect('axisY', COL.satisfaction)`; `facet → toggleFacet(COL.channel, VAL.phone)`; `facet2 → toggleFacet(COL.escalated, VAL.escalatedYes)`; `clear → clearFacets()`; `zoom → app.zoomStep(1)` ×2; `detail → host.select(firstVisibleIndex())`; `fit → app.fit()`. Each step guards on the column existing and otherwise skips its action.
10. **`src/tour/ui.ts`** — overlay in `#app`: `.tour-spot` (fixed, `box-shadow: 0 0 0 9999px rgba(0,0,0,.55)`, `pointer-events: none`, repositioned on step/resize), `.tour-card` (step counter, caption `aria-live="polite"`, Back/Next/Skip, mute `aria-pressed`), welcome card. Keys (capture, only while open): `ArrowRight`/`Space`/`Enter` next, `ArrowLeft` back, `Escape` skip, `m` mute. Focus management; `prefers-reduced-motion`.
11. **`src/tour/index.ts`** — `TOUR_KEY = 'tessera.tour.v1'`, `shouldAutoStart(params)`, `startTour(host, opts)`; `window.tessera = { tour }` for e2e.
12. **`index.html`** — `<button id="tourBtn" class="ghost" title="Take the guided tour">Tour</button>` after `#fitBtn`.
13. **`src/ui/style.css`** — `/* ---------- tour ---------- */` block; `z-index: 30`.
14. **`tests/tour-engine.test.ts`**, **`tests/tour-script.test.ts`**, **`tests/tour-columns.test.ts`**.
15. **`scripts/tour-e2e.mjs`** + `"test:e2e"` script.
16. **`README.md`** "Guided tour" section; **`docs/PROGRESS.md`** row C.

Sequencing: 1–3 first; 4 in parallel with 5–11; 12–13 with 10; 14 alongside 5; 15 last. Step 9/14c depend on B's `tax-cases` landing (watch the bus).

## Verification

**vitest**
- `tour-engine.test.ts` — fake player/spotlight/store: order; `next()` mid-audio aborts; `back()` at 0 no-op, else re-runs prior action; skip/complete write key; throwing action doesn't stop the tour; fallback duration on reject; muted resolves after `minMs`.
- `tour-script.test.ts` — ids unique kebab-case; 8–30 words; bold terms ∈ `COL`/`VAL`; each `public/audio/tour/<id>.mp3` exists and `manifest.json[id].hash === hashLine(...)`; total mp3 bytes < 1.5 MB.
- `tour-columns.test.ts` — load B's generator and assert every `COL` exists with the expected kind and `VAL` labels exist.

**Playwright (`scripts/tour-e2e.mjs`)**
- Spawn vite on 5182; route `**/audio/tour/*.mp3` → 404; `addInitScript` sets `tessera.tour.fastMs = 50`.
- `/?tour=1`: welcome visible; click Start; per step assert caption text, spotlight overlaps target, app state (`window.pivot.spec.type`, `colorBy`, `#barBy` value, facet checkbox, `#detail` visible, zoom increased); click Next.
- Finish: key `done`; reload `/` → no auto-open; `#tourBtn` → opens.
- Second pass unstubbed but muted: no unhandled rejections.

## Risks

- **Autoplay policy** — Start button; create/play `Audio` inside the click task; Safari: play a silent buffer on Start to unlock, reuse the element.
- **Audio size / Pages** — ~0.75 MB lazy; fall back to `mp3_22050_32` if it grows; `?v=<hash>` cache-bust available.
- **ElevenLabs cost/quota** — ≈1,500 credits per full regeneration; hash skip + `--dry-run`. Never in CI; never `VITE_`-prefix the key; SDK in `devDependencies`.
- **Schema drift vs B** — isolated in `columns.ts`, guarded at runtime, tested via `tour-columns.test.ts`. Renames cost clip regeneration (the hash test enforces it).
- **UI coupling** — element IDs; e2e catches breakage.
- **Overlay conflicts** — `z-index: 30`; no pointer blocking on the stage; closes under `?bench=1`.

## Self-review amendments (applied above)
- Synthetic `change`/`click` events + awaitable `apply` wrapper instead of exporting `main.ts` internals.
- Dependency-free `hash.ts` so the audio-sync test needs no Node `crypto` in browser code.
- Safari audio-unlock and the `fastMs` hook added.
- Dropped importing mp3s from `src/`.
- `back()` re-runs the previous action.
- Lead: dataset `tax-cases:900`; columns reconciled to B's D1.
