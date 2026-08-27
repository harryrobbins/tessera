#!/usr/bin/env node
// Flagship customer card check: boots vite + headless Chromium (playwright-wsl
// skill), loads tax-cases:900 at DPR 2, flies onto one card at ~520 px so the
// hi-res tier engages, and screenshots it; then a grid at ~128 px per card;
// then two neighbouring cards of tax-cases:20000, a collection far past the
// per-item cap. Asserts hiRes.tier >= 512 on the zoomed card, and that the two
// neighbours — same topic, adjacent slots, once literally the same texture —
// are now their own records and differ pixel for pixel.
//
// Usage: node scripts/verify-card.mjs [--port 5196] [--keep-server] [--swiftshader]

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '5196' },
    'keep-server': { type: 'boolean', default: false },
    swiftshader: { type: 'boolean', default: false },
  },
});
const port = Number(args.port);

async function waitForServer(ms) {
  const url = `http://127.0.0.1:${port}/`;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(url)).status === 200) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no server at ${url} after ${ms}ms`);
}

function startVite() {
  const child = spawn('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (c) => process.stderr.write(`[vite] ${c}`));
  return child;
}

async function open(browser, dataset) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[page:error] ${e}`));
  await page.goto(`http://127.0.0.1:${port}/?dataset=${dataset}&tour=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.pivotBenchReady === true, null, { timeout: 60_000 });
  await page.waitForTimeout(1200);
  // A grid, sorted by topic, so neighbours share a header colour.
  await page.evaluate(async () => {
    const app = window.pivot;
    await app.setLayout({ type: 'grid', sortBy: 'Topic' });
    app.fit(false);
  });
  await page.waitForTimeout(1000);
  return { ctx, page };
}

/** Camera zoom that draws one card `px` device pixels wide, centred on row i.
 *  The hi-res pass commits atomically once every visible card has its art, so
 *  `hires` waits for that rather than sampling a plan mid-fill. */
async function focusCard(page, i, px, ms, hires = true) {
  await page.waitForFunction(() => window.pivotBenchReady === true && !!window.pivot, null, { timeout: 60_000 });
  await page.evaluate(([i, px, ms]) => {
    const app = window.pivot;
    const o = i * 4;
    app.camera.focus(app.renderer.to[o], app.renderer.to[o + 1], px / app.renderer.to[o + 2], ms);
  }, [i, px, ms]);
  await page.waitForTimeout(ms + 900);
  if (hires) {
    await page.waitForFunction(() => window.pivot.lastFrame?.hiRes != null, null, { timeout: 15_000 })
      .catch(() => { /* the caller's assertion reports it */ });
  }
}

/** Screenshot clip of card `i` itself, inset to keep the gap and its edge AA out. */
async function clipOfCard(page, i, inset = 0.12, size = null) {
  const r = await page.evaluate((i) => window.pivot.cardScreenRect(i), i);
  if (!r) return null;
  const w = size ? size.width : Math.round(r.width * (1 - inset * 2));
  const h = size ? size.height : Math.round(r.height * (1 - inset * 2));
  return { x: Math.round(r.left + (r.width - w) / 2), y: Math.round(r.top + (r.height - h) / 2), width: w, height: h };
}

/** Screenshot clip of `side` CSS px centred on the canvas (the focused card sits at its centre). */
async function clipAround(page, side, aspect = 1) {
  const r = await page.evaluate(() => { const b = window.pivot.canvas.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });
  const wdt = side * aspect;
  return { x: Math.round(r[0] - wdt / 2), y: Math.round(r[1] - side / 2), width: Math.round(wdt), height: side };
}

async function frame(page) {
  return page.evaluate(() => ({
    cardPx: window.pivot.renderer.to[2] * window.pivot.camera.current.zoom,
    frame: window.pivot.lastFrame,
    spec: window.pivot.spec,
  }));
}

/** First row whose Town is `town` (falls back to row 0). */
async function rowInTown(page, town) {
  return page.evaluate((town) => {
    const ds = window.pivot.dataset;
    const col = ds.columns.Town;
    const code = col.categories.indexOf(town);
    for (let i = 0; i < ds.n; i++) if (col.codes[i] === code) return i;
    return 0;
  }, town);
}

async function main() {
  let vite = null;
  let browser = null;
  let failed = false;
  const shots = path.join(ROOT, 'screenshots');
  try {
    if (!args['keep-server']) vite = startVite();
    await waitForServer(60_000);
    browser = await chromium.launch({
      headless: true,
      args: args.swiftshader
        ? ['--use-gl=swiftshader', '--disable-dev-shm-usage']
        : ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--use-gl=angle', '--disable-dev-shm-usage'],
    });
    await fs.mkdir(shots, { recursive: true });

    // 1. Per-item card, magnified: the hi-res tier must be on.
    {
      const { ctx, page } = await open(browser, 'tax-cases:900');
      const row = await rowInTown(page, 'Glasgow');
      await focusCard(page, row, 1040, 300); // 1040 device px = 520 CSS px at DPR 2
      const z = await frame(page);
      const hi = z.frame?.hiRes ?? null;
      console.log(`zoomed: row ${row}, card ${z.cardPx.toFixed(0)} device px, base slot ${z.frame?.atlasSlot}, hi-res ${hi ? `tier ${hi.tier}, ${hi.cards} cards` : 'off'}`);
      await page.screenshot({ path: path.join(shots, 'card-zoomed.png'), clip: await clipAround(page, 320) });
      if (!hi || hi.tier < 512) { failed = true; console.log('  FAIL: expected hi-res tier >= 512'); } else console.log('  ok');

      // 2. The grid at ~128 device px per card: the base slot at 1:1.
      const mid = await page.evaluate(() => window.pivot.dataset.n >> 1);
      await focusCard(page, mid, 128, 300);
      const g = await frame(page);
      console.log(`grid: card ${g.cardPx.toFixed(0)} device px, hi-res ${g.frame?.hiRes ? 'on' : 'off'}`);
      await page.screenshot({ path: path.join(shots, 'card-grid.png'), clip: await clipAround(page, 560, 1.6) });
      await ctx.close();
    }

    // 3. A collection far past the per-item cap: every card is still its own
    //    record. Two neighbours sharing a topic used to be the same texture.
    {
      const { ctx, page } = await open(browser, 'tax-cases:20000');
      const [a, b] = await page.evaluate(() => {
        const app = window.pivot, to = app.renderer.to, codes = app.dataset.columns.Topic.codes;
        // Side by side on the same row of the sorted grid, same topic.
        for (let i = 0; i < app.dataset.n - 1; i++) {
          const j = i + 1;
          if (codes[i] !== codes[j]) continue;
          if (Math.abs(to[j * 4 + 1] - to[i * 4 + 1]) < 1e-3 && to[j * 4] > to[i * 4]) return [i, j];
        }
        return [0, 1];
      });
      // Frame both at once: halfway between them, each ~800 device px wide.
      await page.evaluate(([a, b]) => {
        const app = window.pivot, to = app.renderer.to;
        app.camera.focus((to[a * 4] + to[b * 4]) / 2, to[a * 4 + 1], 800 / to[a * 4 + 2], 300);
      }, [a, b]);
      await page.waitForTimeout(1600);
      const t = await frame(page);
      console.log(`unique: rows ${a}/${b}, card ${t.cardPx.toFixed(0)} device px, per-item ${t.frame?.perItem}, `
        + `tier ${t.frame?.cardTier}, hi-res ${t.frame?.hiRes ? `${t.frame.hiRes.tier} px, ${t.frame.hiRes.cards} cards` : 'off'}`);
      const clipA = await clipOfCard(page, a);
      const clipB = clipA ? await clipOfCard(page, b, 0.12, clipA) : null;
      const shotA = clipA ? await page.screenshot({ clip: clipA }) : null;
      const shotB = clipB ? await page.screenshot({ clip: clipB }) : null;
      await page.screenshot({ path: path.join(shots, 'card-neighbours.png'), clip: await clipAround(page, 520, 2) });
      if (t.frame?.perItem !== false) { failed = true; console.log('  FAIL: expected a category-mode collection'); }
      else if (t.frame?.cardTier !== 'unique') { failed = true; console.log(`  FAIL: expected cardTier "unique", got "${t.frame?.cardTier}"`); }
      else if (!shotA || !shotB) { failed = true; console.log('  FAIL: one of the two cards was off-screen'); }
      else if (shotA.equals(shotB)) { failed = true; console.log('  FAIL: neighbouring cards are pixel-identical'); }
      else console.log('  ok');
      await ctx.close();
    }
    // 4. The default collection (3,000 rows) at its 64 px base slot: the tiny density.
    {
      const { ctx, page } = await open(browser, 'tax-cases:3000');
      await focusCard(page, 0, 64, 300, false);
      const t = await frame(page);
      console.log(`tiny: card ${t.cardPx.toFixed(0)} device px, base slot ${t.frame?.atlasSlot}`);
      await page.screenshot({ path: path.join(shots, 'card-tiny.png'), clip: await clipAround(page, 300, 1.6) });
      await ctx.close();
    }
    console.log('screenshots: screenshots/card-zoomed.png, screenshots/card-grid.png, screenshots/card-neighbours.png, screenshots/card-tiny.png');
  } catch (err) {
    failed = true;
    console.error('verify-card failed:', err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  process.exitCode = failed ? 1 : 0;
}

main();
