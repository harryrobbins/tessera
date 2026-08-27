#!/usr/bin/env node
// HiDPI card sharpness check: boots vite + headless Chromium (see the
// playwright-wsl skill), zooms onto one card at DPR 2 and DPR 1, and
// compares horizontal luminance gradients over the centre 400x400 device px
// with the hi-res atlas on (default) and off (?hires=0).
//
// Two numbers are printed. `tv` is the plan's mean |dL/dx| — but that is total
// variation, which an isolated edge keeps whether it is 1 or 4 px wide, so it
// moves little with blur. `energy` is the mean (dL/dx)^2, which scales with
// edge steepness and is what the >= 1.8x assertion is made on.
//
// Usage: node scripts/verify-hidpi.mjs [--port 5191] [--keep-server] [--swiftshader]

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '5191' },
    'keep-server': { type: 'boolean', default: false },
    swiftshader: { type: 'boolean', default: false },
    zoom: { type: 'string', default: '500' },
  },
});
const port = Number(args.port);
const ZOOM = Number(args.zoom);
const MIN_RATIO = 1.8;

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

/** Mean |dL/dx| and mean (dL/dx)^2 over the centre `side` device px of the drawing buffer. */
const SHARPNESS_FN = (side) => {
  const app = window.pivot;
  const gl = app.renderer.gl;
  const W = gl.drawingBufferWidth;
  const H = gl.drawingBufferHeight;
  const s = Math.min(side, W, H);
  const x0 = Math.floor((W - s) / 2);
  const y0 = Math.floor((H - s) / 2);
  const px = new Uint8Array(s * s * 4);
  gl.readPixels(x0, y0, s, s, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s - 1; x++) {
      const a = (y * s + x) * 4;
      const b = a + 4;
      const la = 0.299 * px[a] + 0.587 * px[a + 1] + 0.114 * px[a + 2];
      const lb = 0.299 * px[b] + 0.587 * px[b + 1] + 0.114 * px[b + 2];
      const g = lb - la;
      sum += Math.abs(g);
      sq += g * g;
      n++;
    }
  }
  return { tv: sum / n, energy: sq / n };
};

async function measure(browser, dpr, hires, shot) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[page:error] ${e}`));
  await page.goto(`http://127.0.0.1:${port}/?dataset=tax-cases:900${hires ? '' : '&hires=0'}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.pivotBenchReady === true, null, { timeout: 60_000 });
  // Let the initial fit land, then fly onto card 0.
  await page.waitForTimeout(1200);
  await page.evaluate((zoom) => {
    const app = window.pivot;
    app.camera.focus(app.renderer.to[0], app.renderer.to[1], zoom, 300);
  }, ZOOM);
  // Settle: the flight is 300 ms, the hi-res pass runs on the frames after it.
  // The pass is atomic — it commits only once every card in view has its own
  // art — so it can take a few ticks on a software rasteriser. Wait for it
  // rather than sampling mid-plan; the assertion below still requires it.
  await page.waitForTimeout(900);
  if (hires) {
    await page.waitForFunction(() => window.pivot.lastFrame?.hiRes != null, null, { timeout: 15_000 })
      .catch(() => { /* left off on purpose: the check below reports it */ });
  }
  const info = await page.evaluate(() => {
    const app = window.pivot;
    const gl = app.renderer.gl;
    return {
      buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      expected: [Math.round(app.canvas.clientWidth * devicePixelRatio), Math.round(app.canvas.clientHeight * devicePixelRatio)],
      cardPx: app.renderer.to[2] * app.camera.current.zoom,
      frame: app.lastFrame,
    };
  });
  const sharp = await page.evaluate(SHARPNESS_FN, 400);
  if (shot) await page.screenshot({ path: shot });
  await ctx.close();
  return { ...info, sharp };
}

async function main() {
  let vite = null;
  let browser = null;
  let failed = false;
  try {
    if (!args['keep-server']) vite = startVite();
    await waitForServer(60_000);
    browser = await chromium.launch({
      headless: true,
      args: args.swiftshader
        ? ['--use-gl=swiftshader', '--disable-dev-shm-usage']
        : ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--use-gl=angle', '--disable-dev-shm-usage'],
    });
    await fs.mkdir(path.join(ROOT, 'screenshots'), { recursive: true });

    for (const dpr of [2, 1]) {
      const shot = dpr === 2 ? path.join(ROOT, 'screenshots', 'hidpi-zoomed.png') : null;
      const on = await measure(browser, dpr, true, shot);
      const off = await measure(browser, dpr, false, null);
      const ratio = on.sharp.energy / off.sharp.energy;
      const tvRatio = on.sharp.tv / off.sharp.tv;
      const hi = on.frame?.hiRes ?? null;
      console.log(`DPR ${dpr}: buffer ${on.buffer.join('x')} (canvas box x DPR = ${on.expected.join('x')}), card ${on.cardPx.toFixed(0)} px, `
        + `base slot ${on.frame?.atlasSlot}, hi-res ${hi ? `tier ${hi.tier}, ${hi.cards} cards` : 'off'}`);
      console.log(`  gradient energy on ${on.sharp.energy.toFixed(1)}  off ${off.sharp.energy.toFixed(1)}  ratio ${ratio.toFixed(2)}x (need >= ${MIN_RATIO})`);
      console.log(`  |gradient| (tv)  on ${on.sharp.tv.toFixed(3)}  off ${off.sharp.tv.toFixed(3)}  ratio ${tvRatio.toFixed(2)}x (reported only)`);
      // The canvas shares the viewport with the sidebar, so check the buffer
      // honours the DPR rather than assuming it fills 1920x1080.
      const okBuf = on.buffer[0] === on.expected[0] && on.buffer[1] === on.expected[1];
      const ok = okBuf && hi && hi.tier >= 512 && hi.cards > 0 && ratio >= MIN_RATIO && (off.frame?.hiRes ?? null) === null;
      if (!ok) { failed = true; console.log('  FAIL'); } else console.log('  ok');
    }
    console.log(`screenshot: screenshots/hidpi-zoomed.png`);
  } catch (err) {
    failed = true;
    console.error('verify-hidpi failed:', err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  process.exitCode = failed ? 1 : 0;
}

main();
