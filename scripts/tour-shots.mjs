#!/usr/bin/env node
// Screenshot every stage of the guided tour, and print the app state behind
// each one. `scripts/tour-e2e.mjs` asserts the tour; this is for looking at it
// — one PNG per step, plus the dataset, layout, filter and spotlight the step
// left the app in.
//
// Unlike the other verification scripts this one does NOT start its own vite:
// point it at a server you already have (`pnpm dev`, port 5180).
//
//   node scripts/tour-shots.mjs [--base http://127.0.0.1:5180]
//                               [--out screenshots/tour] [--tag ''] [--bench-first]
//
// --bench-first starts the benchmark, then opens the tour over it: the tour
// has to stop the suite and load its own collection (see the map step in
// src/tour/actions.ts).
import { chromium } from '@playwright/test';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const { values: args } = parseArgs({ options: {
  base: { type: 'string', default: 'http://127.0.0.1:5180' },
  out: { type: 'string', default: '/var/web/pivot/screenshots/tour' },
  'bench-first': { type: 'boolean', default: false },
  tag: { type: 'string', default: '' },
}});
fs.mkdirSync(args.out, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  localStorage.setItem('tessera.tour.fastMs', '600000');   // manual pacing
  localStorage.setItem('tessera.tour.muted', '1');
  localStorage.removeItem('tessera.tour.v1');
});
await ctx.route('**/audio/tour/*.mp3', (r) => r.fulfill({ status: 404, body: 'stub' }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });

const state = () => page.evaluate(() => {
  const app = window.pivot;
  const ds = app?.dataset;
  const spot = document.querySelector('.tour-spot');
  const sr = spot && !spot.hidden ? spot.getBoundingClientRect() : null;
  let under = null;
  if (sr) {
    const els = document.elementsFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2);
    const e = els.find((x) => !x.closest('.tour'));
    under = e ? `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : ''}` : null;
  }
  return {
    stepId: window.tessera?.tour?.stepId ?? null,
    phase: window.tessera?.tour?.phase,
    datasetSel: document.querySelector('#dataset')?.value,
    datasetLoaded: ds?.name, n: ds?.n,
    spec: JSON.stringify(app?.spec),
    colorBy: app?.colorBy,
    masked: app?.mask ? Array.from(app.mask).filter(Boolean).length : null,
    facetChecked: Array.from(document.querySelectorAll('#facets input:checked')).map((i) => `${i.dataset.field}=${i.dataset.label}`),
    detailVisible: !(document.querySelector('#detail')?.hidden ?? true),
    spotRect: sr ? [Math.round(sr.left), Math.round(sr.top), Math.round(sr.width), Math.round(sr.height)] : null,
    spotUnder: under,
    zoom: app?.camera?.target?.zoom,
  };
});

await page.goto(`${args.base}/?tour=1`);
await page.waitForFunction(() => window.pivotBenchReady === true, null, { timeout: 60000 });

if (args['bench-first']) {
  // Reproduce: start the benchmark, then open the tour while it is still running.
  await page.evaluate(() => { document.querySelector('.tour-dismiss')?.click(); });
  await page.click('#benchBtn');
  await page.waitForTimeout(9000);
  console.log('mid-bench state:', JSON.stringify(await state()));
  await page.screenshot({ path: path.join(args.out, `${args.tag}00-bench-running.png`) });
  await page.click('#tourBtn');
}

await page.waitForSelector('.tour-welcome', { timeout: 10000 });
await page.screenshot({ path: path.join(args.out, `${args.tag}00-welcome.png`) });
await page.click('.tour-start');

for (let i = 0; i < 16; i++) {
  await page.waitForFunction(() => window.tessera?.tour?.phase === 'playing', null, { timeout: 30000 });
  await page.waitForTimeout(900);
  const s = await state();
  console.log(`${String(i).padStart(2, '0')} ${s.stepId}\n   ${JSON.stringify(s)}`);
  await page.screenshot({ path: path.join(args.out, `${args.tag}${String(i + 1).padStart(2, '0')}-${s.stepId}.png`) });
  if (!(await page.$('.tour-next'))) break;
  await page.click('.tour-next');
  await page.waitForTimeout(200);
  if (!(await page.$('.tour'))) { console.log('tour closed'); break; }
}
await page.waitForTimeout(500);
console.log('final:', JSON.stringify(await state()));
await page.screenshot({ path: path.join(args.out, `${args.tag}99-after.png`) });
console.log(errors.length ? `ERRORS: ${errors.join(' | ')}` : 'no page errors');
await ctx.close();
await browser.close();
