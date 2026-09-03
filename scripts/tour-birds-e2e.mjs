#!/usr/bin/env node
// End-to-end check of the BIRDS tour: boots vite on its own port, picks the
// birds collection on the welcome card, then walks every step asserting the
// caption, the collection, the spotlight, and that the beam lands on it.
//
// scripts/tour-e2e.mjs does the same for the tax tour and additionally covers
// gating, auto-advance and the benchmark hand-off, which are tour-independent
// and so are not repeated here; this one exists because the birds tour drives
// a different schema and its own clip directory.
//
// Usage: pnpm test:e2e:birds
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { BIRDS_NARRATION } from '../src/tour/script.ts';
import { BIRD_TOUR_DATASET } from '../src/tour/columns.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots', 'tour-birds');
fs.mkdirSync(OUT, { recursive: true });
const port = 5183;
const base = `http://127.0.0.1:${port}`;

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures++; console.log(`  FAIL ${msg}`); }
};

const server = spawn('pnpm', ['exec', 'vite', '--config', 'scripts/vite.e2e.config.mjs', '--port', String(port), '--strictPort'],
  { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (c) => process.stderr.write(`[vite] ${c}`));
const kill = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } };

for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${base}/`)).status === 200) break; } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 300));
}

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  localStorage.setItem('tessera.tour.fastMs', '60000');
  localStorage.setItem('tessera.tour.muted', '1');
  localStorage.removeItem('tessera.tour.v1');
});
await ctx.route('**/audio/tour/**', (r) => r.fulfill({ status: 404, body: 'stub' }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });

await page.goto(`${base}/?tour=1`);
await page.waitForFunction(() => window.pivotBenchReady === true, null, { timeout: 60_000 });
await page.waitForSelector('.tour-welcome', { timeout: 10_000 });

// -- the picker ----------------------------------------------------------
const picks = await page.$$eval('.tour-pick', (els) => els.map((e) => ({
  label: e.querySelector('b')?.textContent, blurb: e.querySelector('span')?.textContent,
  pressed: e.getAttribute('aria-pressed'),
})));
check(picks.length === 2, `welcome offers ${picks.length} collections: ${picks.map((p) => p.label).join(' / ')}`);
check(picks[0].pressed === 'true' && picks[1].pressed === 'false', 'the first is selected by default');
check(picks.every((p) => p.blurb && p.blurb.length > 20), 'each pick has a blurb');

const birdsIdx = picks.findIndex((p) => /bird/i.test(p.label));
check(birdsIdx >= 0, 'a birds pick exists');
await page.$$eval('.tour-pick', (els, i) => els[i].click(), birdsIdx);
const after = await page.$$eval('.tour-pick', (els) => els.map((e) => e.getAttribute('aria-pressed')));
check(after[birdsIdx] === 'true' && after.filter((a) => a === 'true').length === 1,
  `clicking the birds pick selects exactly it (${after.join(',')})`);
await page.screenshot({ path: path.join(OUT, '00-picker.png') });

await page.click('.tour-start');

// -- the steps -----------------------------------------------------------
for (let i = 0; i < BIRDS_NARRATION.length; i++) {
  const line = BIRDS_NARRATION[i];
  await page.waitForFunction((id) => window.tessera?.tour?.stepId === id, line.id, { timeout: 30_000 });
  await page.waitForFunction(() => window.tessera?.tour?.phase === 'playing', null, { timeout: 30_000 });
  await page.waitForTimeout(500);

  const caption = (await page.textContent('.tour-caption')).trim();
  check(caption === line.text.replace(/\*\*/g, ''), `${line.id}: caption`);
  const counter = (await page.textContent('.tour-step')).trim();
  check(counter === `Step ${i + 1} of ${BIRDS_NARRATION.length}`, `${line.id}: ${counter}`);

  const st = await page.evaluate(() => ({
    key: window.pivot?.datasetKey, n: window.pivot?.dataset?.n,
    spec: window.pivot?.spec?.type, colorBy: window.pivot?.colorBy,
    masked: window.pivot?.mask ? Array.from(window.pivot.mask).filter(Boolean).length : null,
  }));
  check(st.key === BIRD_TOUR_DATASET, `${line.id}: collection ${st.key} (${st.n} birds)`);

  const geo = await page.evaluate(() => {
    const sp = document.querySelector('.tour-spot');
    const s = sp && !sp.hidden ? sp.getBoundingClientRect() : null;
    const beam = document.querySelector('.tour-beam');
    const pts = beam.querySelector('.cone')?.getAttribute('points') ?? '';
    const under = s ? (() => {
      const e = document.elementsFromPoint(s.left + s.width / 2, s.top + s.height / 2).find((x) => !x.closest('.tour'));
      return e ? `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}` : null;
    })() : null;
    const onTarget = s === null ? null : pts.split(' ').slice(1, 3).every((q) => {
      const [x, y] = q.split(',').map(Number);
      return Number.isFinite(x) && Number.isFinite(y)
        && x > s.left - 28 && x < s.right + 28 && y > s.top - 28 && y < s.bottom + 28;
    });
    const c = document.querySelector('.tour-card:not(.tour-welcome)').getBoundingClientRect();
    return { hasSpot: s !== null, under, onTarget, lit: beam.classList.contains('on'),
      dock: [Math.round(innerWidth - c.right), Math.round(innerHeight - c.bottom)] };
  });
  if (line.id === 'open') check(!geo.hasSpot, `${line.id}: no spotlight (opening line)`);
  else {
    check(geo.hasSpot && geo.under !== null, `${line.id}: spotlight over ${geo.under}`);
    check(geo.lit && geo.onTarget, `${line.id}: beam lands on it`);
  }
  check(geo.dock[0] === 20 && geo.dock[1] === 20, `${line.id}: card docked at ${geo.dock}`);

  if (['world', 'habitat', 'wall', 'voyagers', 'one-bird', 'credit'].includes(line.id)) {
    await page.screenshot({ path: path.join(OUT, `${String(i + 1).padStart(2, '0')}-${line.id}.png`) });
  }
  await page.click('.tour-next');
}

await page.waitForFunction(() => window.tessera?.tour?.open === false, null, { timeout: 15_000 });
check(true, 'tour closed after Finish');
check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);

await browser.close();
kill();
console.log(failures ? `\n${failures} failure(s)` : '\nall birds tour checks passed');
process.exit(failures ? 1 : 0);
