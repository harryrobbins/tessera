#!/usr/bin/env node
// End-to-end check of the guided tour in a real (headless) Chromium: boots
// vite on its own port, stubs the narration mp3s so the fallback timer drives
// pacing, then walks every step asserting caption, spotlight and app state.
//
// Usage: pnpm test:e2e [--port 5182] [--headed] [--keep-server]

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NARRATION } from '../src/tour/script.ts';
import { TOUR_DATASET, COL, VAL } from '../src/tour/columns.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '5182' },
    headed: { type: 'boolean', default: false },
    'keep-server': { type: 'boolean', default: false },
  },
});
const port = Number(args.port);
const base = `http://127.0.0.1:${port}`;

// -- server ---------------------------------------------------------------

async function waitForServer(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await fetch(`${base}/`)).status === 200) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`vite did not answer on ${base} within ${timeoutMs} ms`);
}

function startServer() {
  const child = spawn('pnpm', ['exec', 'vite', '--config', 'scripts/vite.e2e.config.mjs', '--port', String(port), '--strictPort'], {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (c) => process.stderr.write(`[vite] ${c}`));
  return child;
}

function killServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
}

// -- assertions -----------------------------------------------------------

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures++; console.log(`  FAIL ${msg}`); }
}

async function waitFor(page, fn, arg, timeout = 8000) {
  await page.waitForFunction(fn, arg, { timeout });
}

const tourState = (page) => page.evaluate(() => {
  const t = window.tessera?.tour;
  return { open: t?.open ?? false, index: t?.index ?? -1, stepId: t?.stepId ?? null, running: t?.running ?? false };
});

const appState = (page) => page.evaluate(() => ({
  spec: window.pivot?.spec?.type,
  colorBy: window.pivot?.colorBy,
  dataset: document.querySelector('#dataset')?.value,
  sortBy: document.querySelector('#sortBy')?.value,
  barBy: document.querySelector('#barBy')?.value,
  axisX: document.querySelector('#axisX')?.value,
  axisY: document.querySelector('#axisY')?.value,
  zoom: window.pivot?.camera?.target?.zoom,
  masked: window.pivot?.mask ? Array.from(window.pivot.mask).filter(Boolean).length : null,
  detailVisible: !(document.querySelector('#detail')?.hidden ?? true),
  facetChecked: Array.from(document.querySelectorAll('#facets input:checked')).map((i) => `${i.dataset.field}=${i.dataset.label}`),
}));

const overlap = (page) => page.evaluate(() => {
  const spot = document.querySelector('.tour-spot');
  if (!spot || spot.hidden) return { hasSpot: false };
  const r = spot.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const under = document.elementsFromPoint(cx, cy).find((e) => !e.closest('.tour'));
  return { hasSpot: true, under: under ? `${under.tagName.toLowerCase()}#${under.id}.${under.className}` : null, rect: [r.left, r.top, r.width, r.height] };
});

/** Per-step expectations on the app after the action ran. */
const expectations = {
  map: (s) => s.dataset === TOUR_DATASET && s.spec === 'xy' && s.axisX === COL.longitude && s.axisY === COL.latitude,
  colour: (s) => s.colorBy === COL.channel,
  bars: (s) => s.spec === 'bars' && s.barBy === COL.channel,
  area: (s) => s.spec === 'bars' && s.barBy === COL.areaType,
  crosstab: (s) => s.spec === 'scatter' && s.axisX === COL.ageBand && s.axisY === COL.channel,
  scatter: (s) => s.spec === 'xy' && s.axisX === COL.hours && s.axisY === COL.satisfaction,
  facet: (s) => s.facetChecked.includes(`${COL.channel}=${VAL.post}`) && s.masked > 250 && s.masked < 350,
  facet2: (s) => s.facetChecked.length === 3 && s.masked === 12,
  grid: (s) => s.spec === 'grid' && s.sortBy === COL.contacts && s.colorBy === COL.contacts,
  zoom: (s, prev) => s.zoom > prev.zoom,
  // The record step flies to the card and leaves it visible; the modal — which
  // covers the middle of the board — belongs to the step that talks about it.
  record: (s) => !s.detailVisible,
  detail: (s) => s.detailVisible,
  // The clear step closes the modal first: with #app inert, spotlighting a
  // filter control the viewer could not click would be a lie.
  clear: (s) => !s.detailVisible && s.facetChecked.length === 0 && s.masked === null,
};
const spotless = new Set(['welcome']);

// -- runs -----------------------------------------------------------------

async function newContext(browser, { stubAudio, fastMs, seed }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(({ fastMs, seed }) => {
    localStorage.setItem('tessera.tour.fastMs', String(fastMs));
    // Seed once per context, not on every navigation, so return visits are real.
    if (sessionStorage.getItem('e2e-seeded')) return;
    sessionStorage.setItem('e2e-seeded', '1');
    for (const [k, v] of Object.entries(seed)) v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
  }, { fastMs, seed });
  if (stubAudio) await ctx.route('**/audio/tour/*.mp3', (route) => route.fulfill({ status: 404, body: 'stub' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    // Stubbed clips 404 on purpose; anything else is a real problem.
    if (m.type() === 'error' && !(stubAudio && /404/.test(m.text()))) errors.push(m.text());
  });
  return { ctx, page, errors };
}

async function steppedPass(browser) {
  console.log('\n[pass 1] ?tour=1, audio stubbed to 404, manual Next through every step');
  const { ctx, page, errors } = await newContext(browser, { stubAudio: true, fastMs: 60_000, seed: { 'tessera.tour.v1': null, 'tessera.tour.muted': '0' } });
  await page.goto(`${base}/?tour=1`);
  await waitFor(page, () => window.pivotBenchReady === true, null, 30_000);
  await page.waitForSelector('.tour-welcome', { timeout: 5000 });
  check(true, 'welcome card shown');
  check((await tourState(page)).running === false, 'nothing runs before Start');
  await page.click('.tour-start');

  let prev = await appState(page);
  for (let i = 0; i < NARRATION.length; i++) {
    const line = NARRATION[i];
    await waitFor(page, (id) => window.tessera?.tour?.stepId === id, line.id);
    // The action has finished and the caption is up; let the card's slide settle.
    await waitFor(page, () => window.tessera?.tour?.phase === 'playing', null, 15_000);
    await page.waitForTimeout(400);
    const caption = await page.textContent('.tour-caption');
    const plain = line.text.replace(/\*\*/g, '');
    check(caption.trim() === plain, `${line.id}: caption`);
    const counter = await page.textContent('.tour-step');
    check(counter.trim() === `Step ${i + 1} of ${NARRATION.length}`, `${line.id}: counter ${counter.trim()}`);
    const title = await page.textContent('.tour-title');
    check(title.trim() === line.title, `${line.id}: title`);
    const exp = expectations[line.id];
    if (exp) {
      let s = await appState(page);
      const t0 = Date.now();
      while (!exp(s, prev) && Date.now() - t0 < 6000) { await page.waitForTimeout(150); s = await appState(page); }
      check(exp(s, prev), `${line.id}: app state ${JSON.stringify(s)}`);
      prev = s;
    }
    const o = await overlap(page);
    if (spotless.has(line.id)) check(!o.hasSpot, `${line.id}: no spotlight`);
    else check(o.hasSpot && o.under !== null, `${line.id}: spotlight over ${o.under}`);
    const geo = await page.evaluate(() => {
      const c = document.querySelector('.tour-card:not(.tour-welcome)').getBoundingClientRect();
      const sp = document.querySelector('.tour-spot');
      const s = sp && !sp.hidden ? sp.getBoundingClientRect() : null;
      const inside = c.left >= 0 && c.top >= 0 && c.right <= innerWidth && c.bottom <= innerHeight;
      const overlaps = s ? !(c.right <= s.left || c.left >= s.right || c.bottom <= s.top || c.top >= s.bottom) : false;
      const gap = s ? Math.min(Math.abs(c.top - s.bottom), Math.abs(s.top - c.bottom), Math.abs(c.left - s.right), Math.abs(s.left - c.right)) : null;
      const arrow = getComputedStyle(document.querySelector('.tour-arrow')).display !== 'none';
      const r = (b) => b && [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
      return { inside, overlaps, gap, arrow, card: r(c), spot: r(s), side: [...document.querySelector('.tour-card:not(.tour-welcome)').classList].find((k) => k.startsWith('side-')) };
    });
    check(geo.inside, `${line.id}: card inside viewport`);
    if (!spotless.has(line.id)) {
      check(!geo.overlaps && geo.gap !== null && geo.gap <= 40 && geo.arrow,
        `${line.id}: card adjacent to spotlight (${geo.side}, gap ${geo.gap}px, arrow ${geo.arrow}`
        + `${geo.overlaps ? `, OVERLAPS card ${geo.card} spot ${geo.spot}` : ''})`);
    }
    const state = await tourState(page);
    check(state.index === i, `${line.id}: engine index ${state.index}`);
    if (['area', 'facet2', 'record'].includes(line.id)) await page.screenshot({ path: path.join(ROOT, 'screenshots', `tour-${line.id}.png`) });
    if (i < NARRATION.length - 1) await page.click('.tour-next');
    else await page.click('.tour-next'); // Finish
  }
  await waitFor(page, () => window.tessera?.tour?.open === false, null);
  check(true, 'tour closed after Finish');
  const key = await page.evaluate(() => localStorage.getItem('tessera.tour.v1'));
  check(key === 'done', `completion key = ${key}`);

  await page.goto(`${base}/`);
  await waitFor(page, () => window.pivotBenchReady === true, null, 30_000);
  await page.waitForTimeout(400);
  check((await page.$('.tour')) === null, 'no auto-open on a return visit');
  await page.click('#tourBtn');
  await page.waitForSelector('.tour-welcome', { timeout: 3000 });
  check(true, '#tourBtn reopens the welcome card');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check((await page.$('.tour')) === null, 'Escape dismisses');
  check(errors.length === 0, `no page errors (${errors.length})${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await ctx.close();
}

async function autoPass(browser) {
  console.log('\n[pass 2] first visit, real audio requests, muted: auto-advances to the end with no rejections');
  const { ctx, page, errors } = await newContext(browser, { stubAudio: false, fastMs: 60, seed: { 'tessera.tour.v1': null, 'tessera.tour.muted': '1' } });
  await page.goto(`${base}/`);
  await waitFor(page, () => window.pivotBenchReady === true, null, 30_000);
  await page.waitForSelector('.tour-welcome', { timeout: 5000 });
  check(true, 'first visit auto-opens the welcome card');
  await page.click('.tour-start');
  await waitFor(page, () => window.tessera?.tour?.open === false, null, 60_000);
  check(true, 'ran to completion unattended');
  check(errors.length === 0, `no page errors or unhandled rejections (${errors.length})${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await ctx.close();

  console.log('\n[pass 3] gating');
  const b = await newContext(browser, { stubAudio: true, fastMs: 60, seed: { 'tessera.tour.v1': null } });
  await b.page.goto(`${base}/?dataset=tax-cases:3000`);
  await waitFor(b.page, () => window.pivotBenchReady === true, null, 30_000);
  await b.page.waitForTimeout(400);
  check((await b.page.$('.tour')) === null, '?dataset= deep link does not auto-open');
  await b.page.goto(`${base}/?tour=1`);
  await b.page.waitForSelector('.tour-welcome', { timeout: 10_000 });
  await b.page.click('.tour-dismiss');
  const key = await b.page.evaluate(() => localStorage.getItem('tessera.tour.v1'));
  check(key === 'done', `Not now sets the key (${key})`);
  await b.ctx.close();
}

// -- main -----------------------------------------------------------------

const server = startServer();
const stop = () => { if (!args['keep-server']) killServer(server); };
process.on('SIGINT', () => { stop(); process.exit(130); });
let browser;
try {
  await waitForServer(60_000);
  browser = await chromium.launch({ headless: !args.headed, args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  await steppedPass(browser);
  await autoPass(browser);
} catch (err) {
  failures++;
  console.error(err);
} finally {
  await browser?.close();
  stop();
}
console.log(failures ? `\n${failures} failure(s)` : '\nall tour e2e checks passed');
process.exit(failures ? 1 : 0);
