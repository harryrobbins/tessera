#!/usr/bin/env node
// Night-lights map check: boots vite + headless Chromium (see the playwright-wsl
// skill), opens a geo collection and asserts that
//   - the default layout is the equal-aspect map ({type:'xy', equal:true}),
//   - the bounds carry the true lon*cos(lat) / lat aspect,
//   - the additive lights are brighter than plain dots (?glow=0) without
//     saturating (few near-white pixels),
//   - clicking Grid then Scatter never plots a column against itself.
// Writes screenshots/map-dpr2.png and screenshots/map-dpr1.png.
//
// Blend regression (premultiplied blend must be pixel-identical for cards):
//   --blend-capture <file>  save the DPR-1 grid frame of tax-cases:900 as raw RGBA
//   --blend-compare <file>  compare the same frame against that file (mean |diff| < 1/255)
//
// Usage: node scripts/verify-map.mjs [--port 5194] [--dataset tax-cases:20000]
//        [--keep-server] [--swiftshader] [--min-ratio 3] [--blend-capture f | --blend-compare f]

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '5194' },
    dataset: { type: 'string', default: 'tax-cases:20000' },
    'keep-server': { type: 'boolean', default: false },
    swiftshader: { type: 'boolean', default: false },
    'min-ratio': { type: 'string', default: '3' },
    'blend-capture': { type: 'string' },
    'blend-compare': { type: 'string' },
  },
});
const port = Number(args.port);
const DATASET = args.dataset;
const MIN_RATIO = Number(args['min-ratio']);
const MAX_WHITE = 0.05;

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

/** Mean luminance above the clear colour (0..1) and the fraction of pixels above
 *  0.8 luminance, over the centre `frac` of the buffer. The background is
 *  subtracted so the ratio measures light emitted by cards, not the dark ground
 *  they sit on (which is most of the crop). */
const LUMA_FN = (frac) => {
  const app = window.pivot;
  const gl = app.renderer.gl;
  const W = gl.drawingBufferWidth;
  const H = gl.drawingBufferHeight;
  const w = Math.floor(W * frac);
  const h = Math.floor(H * frac);
  const x0 = Math.floor((W - w) / 2);
  const y0 = Math.floor((H - h) / 2);
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const bg = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bg); // bottom-left corner: always clear colour
  const lbg = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) / 255;
  let sum = 0;
  let white = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const l = (0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]) / 255;
    sum += Math.max(0, l - lbg);
    if (l > 0.8) white++;
  }
  return { mean: sum / n, white: white / n, w, h };
};

/** The whole drawing buffer as raw RGBA bytes (base64 across the bridge). */
const FRAME_FN = () => {
  const gl = window.pivot.renderer.gl;
  const W = gl.drawingBufferWidth;
  const H = gl.drawingBufferHeight;
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let s = '';
  for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
  return { W, H, b64: btoa(s) };
};

async function open(browser, dpr, query) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[page:error] ${e}`));
  await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.pivotBenchReady === true, null, { timeout: 120_000 });
  // The load solves a grid first, then flies to the map (900 ms) and fits.
  await page.waitForTimeout(1800);
  // A concurrent edit can HMR-reload the page underneath us: wait again, then settle.
  await page.waitForFunction(() => window.pivotBenchReady === true && !!window.pivot, null, { timeout: 120_000 });
  await page.waitForTimeout(400);
  // The type-checker overlay reports other workstreams' errors over the canvas.
  await page.evaluate(() => document.querySelectorAll('vite-error-overlay').forEach((e) => e.remove()));
  return { ctx, page };
}

async function readState(page) {
  return page.evaluate(() => {
    const app = window.pivot;
    const ds = app.dataset;
    const geo = ds.geo;
    const xc = geo && ds.columns[geo.lon];
    const yc = geo && ds.columns[geo.lat];
    return {
      spec: app.spec,
      bounds: app.bounds,
      isMap: app.isMapView,
      lod: app.renderer.lod,
      glow: app.renderer.glow,
      cardPx: app.renderer.to[2] * app.camera.current.zoom,
      frame: app.lastFrame,
      ext: xc && yc ? { lon: [xc.min, xc.max], lat: [yc.min, yc.max] } : null,
      n: ds.n,
    };
  });
}

async function measure(browser, dpr, glow, shot, zoomK = 1) {
  const { ctx, page } = await open(browser, dpr, `dataset=${DATASET}&tour=0${glow ? '' : '&glow=0'}`);
  if (zoomK !== 1) {
    // Further out than the fit: where the old 6 px halo floor bloomed worst,
    // because every card's spread was pinned to 6 px however small it got.
    await page.evaluate((k) => { const c = window.pivot.camera; c.zoomTo(c.target.zoom * k, 0); }, zoomK);
    await page.waitForFunction(() => {
      const c = window.pivot.camera;
      return Math.abs(c.current.zoom - c.target.zoom) < 1e-9;
    }, null, { timeout: 10_000 });
    await page.waitForTimeout(400);
  }
  const state = await readState(page);
  const luma = await page.evaluate(LUMA_FN, 0.6);
  if (shot) await page.screenshot({ path: shot });
  await ctx.close();
  return { ...state, luma };
}

async function scatterTabCheck(browser) {
  const { ctx, page } = await open(browser, 1, `dataset=${DATASET}&tour=0`);
  await page.click('#layoutSeg [data-layout="grid"]');
  await page.waitForTimeout(300);
  await page.click('#layoutSeg [data-layout="xy"]');
  await page.waitForTimeout(300);
  const spec = await page.evaluate(() => window.pivot.spec);
  await ctx.close();
  return spec;
}

async function gridFrame(browser) {
  const { ctx, page } = await open(browser, 1, `dataset=tax-cases:900&tour=0&hires=0`);
  await page.click('#layoutSeg [data-layout="grid"]');
  // Grid flight 900 ms; fit; then wait until both the transition and the camera
  // chase have settled, so a cold server cannot shift the frame by a subpixel.
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => {
    const app = window.pivot;
    const c = app.camera;
    return app.renderer.t >= 1
      && Math.abs(c.current.x - c.target.x) < 1e-6 && Math.abs(c.current.y - c.target.y) < 1e-6
      && Math.abs(c.current.zoom - c.target.zoom) < 1e-9;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(300);
  const f = await page.evaluate(FRAME_FN);
  await ctx.close();
  return { W: f.W, H: f.H, px: Buffer.from(f.b64, 'base64') };
}

function check(ok, msg) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  return ok;
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

    if (args['blend-capture'] || args['blend-compare']) {
      const f = await gridFrame(browser);
      if (args['blend-capture']) {
        await fs.writeFile(args['blend-capture'], Buffer.concat([Buffer.from(`${f.W}x${f.H}\n`), f.px]));
        console.log(`blend: captured ${f.W}x${f.H} grid frame to ${args['blend-capture']}`);
      } else {
        const ref = await fs.readFile(args['blend-compare']);
        const nl = ref.indexOf(10);
        const dims = ref.subarray(0, nl).toString();
        const rpx = ref.subarray(nl + 1);
        if (dims !== `${f.W}x${f.H}`) throw new Error(`blend: size mismatch ${dims} vs ${f.W}x${f.H}`);
        let sum = 0;
        let maxd = 0;
        let diff = 0;
        for (let i = 0; i < rpx.length; i++) {
          if ((i & 3) === 3) continue; // alpha is always 1 (alpha:false context)
          const d = Math.abs(rpx[i] - f.px[i]);
          sum += d;
          if (d > maxd) maxd = d;
          if (d) diff++;
        }
        const mean = sum / (rpx.length * 0.75);
        console.log(`blend: mean |diff| ${mean.toFixed(4)}/255, max ${maxd}, ${diff} differing channels of ${rpx.length * 0.75}`);
        failed = !check(mean < 1, 'mean absolute pixel difference < 1/255') || failed;
      }
      return;
    }

    const on = await measure(browser, 2, true, path.join(ROOT, 'screenshots', 'map-dpr2.png'));
    const off = await measure(browser, 2, false, null);
    const one = await measure(browser, 1, true, path.join(ROOT, 'screenshots', 'map-dpr1.png'));

    console.log(`${DATASET}: n ${on.n}, spec ${JSON.stringify(on.spec)}, lod [${on.lod}], glow ${on.glow}`);
    console.log(`DPR 2: dot ${on.cardPx.toFixed(1)} px, base slot ${on.frame?.atlasSlot}, hi-res ${on.frame?.hiRes ? 'tier ' + on.frame.hiRes.tier : 'off'}`);
    console.log(`DPR 1: dot ${one.cardPx.toFixed(1)} px`);
    const ratio = on.luma.mean / off.luma.mean;
    console.log(`  centre-60% mean luminance above background: glow ${on.luma.mean.toFixed(4)}  plain ${off.luma.mean.toFixed(4)}  ratio ${ratio.toFixed(2)}x (need >= ${MIN_RATIO})`);
    console.log(`  fraction above 0.8 luminance: ${(on.luma.white * 100).toFixed(2)} % (need < ${MAX_WHITE * 100} %)`);

    const geo = on.ext;
    const s = on.spec;
    failed = !check(s.type === 'xy' && s.equal === true && on.isMap, 'default layout is the equal-aspect map') || failed;
    if (geo) {
      const latMid = (geo.lat[0] + geo.lat[1]) / 2;
      const want = ((geo.lon[1] - geo.lon[0]) * Math.cos((latMid * Math.PI) / 180)) / (geo.lat[1] - geo.lat[0]);
      const got = (on.bounds.maxX - on.bounds.minX) / (on.bounds.maxY - on.bounds.minY);
      failed = !check(Math.abs(got / want - 1) < 0.02, `bounds aspect ${got.toFixed(4)} ~ lon*cos(lat)/lat ${want.toFixed(4)} (2 %)`) || failed;
    } else {
      failed = !check(false, 'dataset has geo columns') || failed;
    }
    failed = !check(on.lod[0] === 14 && on.lod[1] === 32 && on.glow === 1 && off.glow === 0, 'map LOD band [14, 32], glow on (off under ?glow=0)') || failed;
    failed = !check(ratio >= MIN_RATIO, `lights brighter than plain dots by >= ${MIN_RATIO}x`) || failed;
    failed = !check(on.luma.white < MAX_WHITE, 'not a white blob') || failed;

    // Zoomed further out, the map must resolve into points rather than wash
    // together: each card's total emission is now independent of zoom, so
    // crowding is the only thing that can sum towards white.
    const far = await measure(browser, 2, true, path.join(ROOT, 'screenshots', 'map-far.png'), 0.35);
    const farOff = await measure(browser, 2, false, null, 0.35);
    const farRatio = far.luma.mean / farOff.luma.mean;
    console.log(`  zoomed out 0.35x: dot ${far.cardPx.toFixed(2)} px, above 0.8 luminance ${(far.luma.white * 100).toFixed(2)} % `
      + `(fit ${(on.luma.white * 100).toFixed(2)} %), glow ratio ${farRatio.toFixed(2)}x`);
    failed = !check(far.luma.white < on.luma.white, 'zooming out resolves into points rather than blooming') || failed;
    failed = !check(farRatio >= 1.5, `the far view is still lit (${farRatio.toFixed(2)}x >= 1.5)`) || failed;

    const tab = await scatterTabCheck(browser);
    failed = !check(tab.type === 'xy' && tab.x !== tab.y, `Scatter tab gives distinct axes (${tab.x} x ${tab.y})`) || failed;

    console.log('screenshots: screenshots/map-dpr2.png, screenshots/map-dpr1.png, screenshots/map-far.png');
  } catch (err) {
    failed = true;
    console.error('verify-map failed:', err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  process.exitCode = failed ? 1 : 0;
}

main();
