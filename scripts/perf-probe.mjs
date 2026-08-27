#!/usr/bin/env node
// Targeted performance probe: the numbers `pnpm bench` does not cover. Builds
// nothing — run `pnpm build` first — then serves dist/ with `vite preview`,
// drives the app in headless Chromium (see the playwright-wsl skill) and prints
// per-collection load time (with a breakdown), layout solve time, frame time
// in static / map / glow, the hi-res rasterisation hitch on settle, and the
// bytes uploaded to GPU textures and buffers. Writes bench-results/probe-<label>.json.
//
// Usage: node scripts/perf-probe.mjs [--port 5312] [--label before] [--swiftshader] [--keep-server]

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '5312' },
    label: { type: 'string', default: os.hostname() },
    swiftshader: { type: 'boolean', default: false },
    'keep-server': { type: 'boolean', default: false },
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

function startPreview() {
  const child = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(port), '--strictPort'], {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (c) => process.stderr.write(`[vite] ${c}`));
  return child;
}

/** Count bytes handed to the GPU, by wrapping the context methods on this page. */
const INSTRUMENT_FN = () => {
  const app = window.pivot;
  const gl = app.renderer.gl;
  const acc = { texBytes: 0, texCalls: 0, bufBytes: 0, bufCalls: 0, mipmaps: 0 };
  window.__gpuBytes = acc;
  const srcBytes = (s) => (s && s.width ? s.width * s.height * 4 : 0);
  const ti = gl.texImage2D.bind(gl);
  gl.texImage2D = function (...a) {
    acc.texCalls++;
    acc.texBytes += a.length === 6 ? srcBytes(a[5]) : a[3] * a[4] * 4;
    return ti(...a);
  };
  const ts = gl.texSubImage2D.bind(gl);
  gl.texSubImage2D = function (...a) {
    acc.texCalls++;
    acc.texBytes += a.length === 7 ? srcBytes(a[6]) : a[4] * a[5] * 4;
    return ts(...a);
  };
  const bd = gl.bufferData.bind(gl);
  gl.bufferData = function (...a) {
    acc.bufCalls++;
    const d = a[1];
    acc.bufBytes += typeof d === 'number' ? d : a.length >= 5 ? a[4] * (d.BYTES_PER_ELEMENT ?? 1) : d.byteLength;
    return bd(...a);
  };
  const gm = gl.generateMipmap.bind(gl);
  gl.generateMipmap = function (...a) { acc.mipmaps++; return gm(...a); };
};

/** Load `key` with a breakdown: worker load, card painting, atlas upload, first solve. */
const LOAD_FN = async (key) => {
  const app = window.pivot;
  const t = { key, total: 0, engineLoad: 0, buildCards: 0, setAtlas: 0, solve: 0, generate: 0 };
  const bytes0 = { ...window.__gpuBytes };
  const engine = app.engine;
  const r = app.renderer;
  const oLoad = engine.load.bind(engine);
  const oBuild = app.buildCards.bind(app);
  const oAtlas = r.setAtlas.bind(r);
  const oSolve = engine.solve.bind(engine);
  let tGen0 = 0;
  engine.load = async (d) => { t.generate = performance.now() - tGen0; const a = performance.now(); await oLoad(d); t.engineLoad = performance.now() - a; };
  app.buildCards = () => { const a = performance.now(); oBuild(); t.buildCards = performance.now() - a; };
  r.setAtlas = (s, m) => { const a = performance.now(); oAtlas(s, m); t.setAtlas = performance.now() - a; };
  engine.solve = async (...a) => { const s = await oSolve(...a); t.solve = s.solveMs; return s; };
  const t0 = tGen0 = performance.now();
  await app.loadDataset(key);
  t.total = performance.now() - t0;
  engine.load = oLoad; app.buildCards = oBuild; r.setAtlas = oAtlas; engine.solve = oSolve;
  t.buildCards -= t.setAtlas; // painting only; the upload is reported on its own
  const b = window.__gpuBytes;
  t.texMB = +((b.texBytes - bytes0.texBytes) / 1048576).toFixed(1);
  t.bufMB = +((b.bufBytes - bytes0.bufBytes) / 1048576).toFixed(1);
  t.mipmaps = b.mipmaps - bytes0.mipmaps;
  t.n = app.dataset.n;
  t.atlasSlot = app.lastFrame?.atlasSlot ?? null;
  return t;
};

/** Frame intervals for `ms` with alwaysRender on; p50/p95/worst and gpu p50. */
const FRAMES_FN = (ms) => new Promise((resolve) => {
  const app = window.pivot;
  const was = app.alwaysRender;
  app.alwaysRender = true;
  const dts = [];
  const gpus = [];
  let elapsed = 0;
  let seen = 0;
  const hook = (dt) => {
    seen++;
    elapsed += dt;
    if (seen > 5) { dts.push(dt); if (app.renderer.gpuMs >= 0) gpus.push(app.renderer.gpuMs); }
    if (elapsed >= ms) {
      app.frameHooks.delete(hook);
      app.alwaysRender = was;
      const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))] : -1; };
      resolve({ frames: dts.length, p50: q(dts, 0.5), p95: q(dts, 0.95), worst: Math.max(...dts, 0), gpuP50: q(gpus, 0.5) });
    }
  };
  app.frameHooks.add(hook);
});

/** Fly to `px`-wide card `i` instantly, then record every tick until the hi-res set stops growing. */
const HITCH_FN = async ([i, px]) => {
  const app = window.pivot;
  const o = i * 4;
  app.camera.focus(app.renderer.to[o], app.renderer.to[o + 1], px / app.cardSize, 0);
  return new Promise((resolve) => {
    const ticks = [];
    let quiet = 0;
    let last = -1;
    const hook = (dt) => {
      const hi = app.lastFrame?.hiRes;
      const cards = hi ? hi.cards : 0;
      ticks.push({ dt, cards });
      if (cards === last) quiet++; else quiet = 0;
      last = cards;
      if (quiet >= 30 || ticks.length > 600) {
        app.frameHooks.delete(hook);
        const busy = ticks.filter((t) => t.cards !== 0 || t === ticks[0]);
        const first = ticks.findIndex((t) => t.cards > 0);
        const done = ticks.length - quiet;
        resolve({
          tier: hi?.tier ?? null,
          cards: last,
          ticksToFill: first < 0 ? -1 : done - first,
          worstDt: Math.max(...ticks.slice(1, done + 1).map((t) => t.dt)),
          sumDt: +ticks.slice(1, done + 1).reduce((s, t) => s + t.dt, 0).toFixed(0),
          busy: busy.length,
        });
      }
    };
    app.frameHooks.add(hook);
  });
};

async function open(browser, query) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[page:error] ${e}`));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.pivotBenchReady === true, null, { timeout: 120_000 });
  const readyMs = Date.now() - t0;
  const nav = await page.evaluate(() => performance.now());
  await page.evaluate(INSTRUMENT_FN);
  return { ctx, page, readyMs, navMs: Math.round(nav) };
}

async function settle(page, ms = 1500) { await page.waitForTimeout(ms); }

async function main() {
  let vite = null;
  let browser = null;
  const out = { label: args.label, timestamp: new Date().toISOString(), swiftshader: args.swiftshader, loads: [], solves: [], frames: [], hitches: [] };
  try {
    if (!args['keep-server']) vite = startPreview();
    await waitForServer(60_000);
    browser = await chromium.launch({
      headless: true,
      args: args.swiftshader
        ? ['--use-gl=swiftshader', '--disable-dev-shm-usage']
        : ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--use-gl=angle', '--disable-dev-shm-usage'],
    });

    // 1. Cold first load of the default collection, then warm reloads with breakdowns.
    {
      const { ctx, page, navMs } = await open(browser, 'dataset=tax-cases:3000&tour=0');
      out.renderer = await page.evaluate(() => window.pivot.renderer.gpuHint);
      out.coldReadyMs = navMs;
      console.log(`renderer: ${out.renderer}`);
      console.log(`cold: tax-cases:3000 ready ${navMs} ms after navigation start`);
      for (const key of ['tax-cases:3000', 'tax-cases:900', 'tax-cases:20000', 'tax-cases:100000', 'products:100000', 'products:1000000']) {
        // Twice: the second run has the faker chunk cached and the JIT warm.
        let t = null;
        for (let k = 0; k < 2; k++) t = await page.evaluate(LOAD_FN, key);
        out.loads.push(t);
        console.log(`load ${key.padEnd(18)} ${t.total.toFixed(0).padStart(5)} ms  (generate ${t.generate.toFixed(0)}, worker ${t.engineLoad.toFixed(0)}, paint ${t.buildCards.toFixed(0)}, atlas upload ${t.setAtlas.toFixed(0)}, solve ${t.solve.toFixed(1)})  slot ${t.atlasSlot}  tex ${t.texMB} MB buf ${t.bufMB} MB mips ${t.mipmaps}`);
        if (key === 'products:1000000' || key === 'tax-cases:100000') {
          for (const spec of [{ type: 'grid', sortBy: 'Value' }, { type: 'bars' }, { type: 'scatter' }]) {
            const s = await page.evaluate(async (spec) => {
              const app = window.pivot;
              if (spec.type === 'bars') spec.by = app.defaultBucket();
              if (spec.type === 'scatter') { spec.x = app.defaultBucket(); spec.y = app.defaultAxisY(); }
              if (spec.type === 'grid' && !app.dataset.columns[spec.sortBy]) spec.sortBy = app.defaultSort();
              const t0 = performance.now();
              const sol = await app.setLayout(spec);
              return { type: spec.type, solveMs: sol.solveMs, roundTripMs: performance.now() - t0, uploadMs: app.renderer.lastUploadMs };
            }, spec);
            out.solves.push({ key, ...s });
            console.log(`  solve ${s.type.padEnd(8)} ${s.solveMs.toFixed(1).padStart(7)} ms  round trip ${s.roundTripMs.toFixed(1)} ms  upload ${s.uploadMs.toFixed(1)} ms`);
          }
        }
      }
      // 2. Frame time, static grid, per size.
      for (const key of ['tax-cases:3000', 'products:100000', 'products:1000000']) {
        await page.evaluate(LOAD_FN, key);
        await page.evaluate(async () => { const app = window.pivot; await app.setLayout({ type: 'grid', sortBy: app.defaultSort() }); app.fit(false); });
        await settle(page);
        const f = await page.evaluate(FRAMES_FN, 2000);
        out.frames.push({ key, phase: 'static', ...f });
        console.log(`frame static ${key.padEnd(18)} p50 ${f.p50.toFixed(1)} ms  p95 ${f.p95.toFixed(1)}  worst ${f.worst.toFixed(1)}  gpu p50 ${f.gpuP50.toFixed(2)}  (${f.frames} frames)`);
      }
      await ctx.close();
    }

    // 3. Map frame time with and without the glow, 20k and 100k.
    for (const key of ['tax-cases:20000', 'tax-cases:100000']) {
      for (const glow of [true, false]) {
        const { ctx, page } = await open(browser, `dataset=${key}&tour=0${glow ? '' : '&glow=0'}`);
        await settle(page, 2000);
        const f = await page.evaluate(FRAMES_FN, 2000);
        out.frames.push({ key, phase: glow ? 'map glow' : 'map plain', ...f });
        console.log(`frame ${(glow ? 'map glow' : 'map plain').padEnd(9)} ${key.padEnd(15)} p50 ${f.p50.toFixed(1)} ms  p95 ${f.p95.toFixed(1)}  worst ${f.worst.toFixed(1)}  gpu p50 ${f.gpuP50.toFixed(2)}`);
        await ctx.close();
      }
    }

    // 4. Hi-res hitch on settle: tier 1024 (one card fills the view) and tier 256 (a grid of ~70).
    {
      const { ctx, page } = await open(browser, 'dataset=tax-cases:900&tour=0');
      await settle(page, 1500);
      for (const px of [1040, 200]) {
        await page.evaluate(() => { const app = window.pivot; app.fit(false); });
        await settle(page, 800);
        const h = await page.evaluate(HITCH_FN, [450, px]);
        out.hitches.push({ key: 'tax-cases:900', px, ...h });
        console.log(`hi-res ${String(px).padStart(4)} px: tier ${h.tier}, ${h.cards} cards in ${h.ticksToFill} ticks, worst tick ${h.worstDt.toFixed(1)} ms, total ${h.sumDt} ms`);
      }
      await ctx.close();
    }
    const outPath = path.join(ROOT, 'bench-results', `probe-${args.label}.json`);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(out, null, 2));
    console.log(`wrote ${path.relative(ROOT, outPath)}`);
  } catch (err) {
    console.error('perf-probe failed:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
}

main();
