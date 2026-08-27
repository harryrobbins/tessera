#!/usr/bin/env node
// Detail-pane e2e: boots vite + the bundled Linux Chromium (playwright-wsl
// skill), opens tax-cases:900, selects a record, and checks the pane is a
// dialog whose three demo action links never navigate. Saves
// screenshots/detail-customer.png of the open pane.
//
// Usage: node scripts/detail-e2e.mjs [--port 5195] [--keep-server] [--swiftshader]

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '5195' },
    'keep-server': { type: 'boolean', default: false },
    swiftshader: { type: 'boolean', default: false },
  },
});
const port = Number(args.port);
const DATASET = 'tax-cases:900';

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

const ready = (page) => page.waitForFunction(() => window.pivotBenchReady === true && !!window.pivot, null, { timeout: 60_000 });

const checks = [];
function check(name, ok, detail = '') {
  checks.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  let vite = null;
  let browser = null;
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
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error(`[page:error] ${e}`));
    let navigations = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });

    await page.goto(`http://127.0.0.1:${port}/?dataset=${DATASET}&tour=0`, { waitUntil: 'load' });
    await ready(page);
    await page.waitForTimeout(1200);
    await ready(page); // a vite full-reload (another agent editing) restarts boot
    const navsAfterLoad = navigations;

    // Pick a Glasgow customer with a resolved case so the journey is complete.
    const row = await page.evaluate(() => {
      const ds = window.pivot.dataset;
      const town = ds.columns.Town; const status = ds.columns.Status;
      const g = town.categories.indexOf('Glasgow');
      const resolved = status.categories.indexOf('Resolved');
      for (let i = 0; i < ds.n; i++) if (town.codes[i] === g && status.codes[i] === resolved) return i;
      return 0;
    });
    await page.evaluate((i) => window.pivot.onSelect(i), row);
    await page.waitForTimeout(900);

    const pane = page.locator('#detail');
    check('#detail is a visible dialog', await pane.isVisible() && (await pane.getAttribute('role')) === 'dialog');
    check('the dialog is modal and the app behind it is inert',
      (await pane.getAttribute('aria-modal')) === 'true'
      && (await page.evaluate(() => document.getElementById('app').hasAttribute('inert')))
      && !(await page.locator('#scrim').isHidden()));
    check('aria-labelledby points at the title', (await pane.getAttribute('aria-labelledby')) === 'detailTitle'
      && (await page.locator('#detailTitle').count()) === 1);
    check('close button has focus on open', await page.evaluate(() => document.activeElement?.matches('#detail .close') === true));
    const actions = page.locator('#detail a[data-action]');
    check('three action links', (await actions.count()) === 3, String(await actions.count()));
    check('[data-action="review"] present', (await page.locator('#detail [data-action="review"]').count()) === 1);
    const title = await page.locator('#detailTitle').textContent();
    check('title is the customer name', !!title && !/^CS-/.test(title), title ?? '');
    check('journey rendered', (await page.locator('#detail .timeline .node').count()) === 3);

    await page.screenshot({ path: path.join(ROOT, 'screenshots', 'detail-customer.png') });

    for (const action of ['review', 'reassign', 'note']) {
      const href = await page.evaluate(() => location.href);
      const before = navigations;
      await page.locator(`#detail [data-action="${action}"]`).click();
      await page.waitForTimeout(250);
      const after = await page.evaluate(() => location.href);
      const toast = page.locator('#toast');
      const toastText = (await toast.textContent()) ?? '';
      check(`${action}: no navigation`, after === href && navigations === before, after === href ? '' : `${href} -> ${after}`);
      check(`${action}: toast says demo only`, await toast.isVisible() && /Demo only/.test(toastText), toastText);
      check(`${action}: pane still open`, await pane.isVisible());
    }
    check('no frame navigations at all after load', navigations === navsAfterLoad);
    check('#toast is a live region', (await page.getAttribute('#toast', 'role')) === 'status');

    // Escape: pane hidden, selection ring cleared (style byte 13 of the row).
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('Escape hides the pane', await pane.isHidden());
    check('closing lifts inert and the scrim',
      !(await page.evaluate(() => document.getElementById('app').hasAttribute('inert')))
      && await page.locator('#scrim').isHidden());
    const ring = await page.evaluate((i) => window.pivot.renderer.styleU8[i * 16 + 13], row);
    check('selection ring cleared', ring === 0, String(ring));
    const noThrow = await page.evaluate(() => { try { window.pivot.onSelect(-1); return true; } catch { return false; } });
    check('onSelect(-1) does not throw', noThrow);

    // The modal expands out of the card: one frame after opening it is still
    // roughly the card's rect, and it has reached its own by the end.
    // Measured from the transition's *starting* matrix, read synchronously
    // after the open: waiting a frame races the easing, which has already moved
    // by an unpredictable amount on a loaded machine.
    const flip = await page.evaluate(async (i) => {
      const app = window.pivot;
      const el = document.getElementById('detail');
      const box = () => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width }; };
      const [wx, wy] = app.renderer.positionOf(i);
      app.camera.focus(wx, wy, 90, 0);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const card = app.cardScreenRect(i);
      app.onSelect(i);
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      const start = { scale: m.a, dx: m.e, dy: m.f };
      await new Promise((r) => setTimeout(r, 600));
      return { card, start, last: box(), settled: getComputedStyle(el).transform };
    }, row);
    const wantScale = flip.card && flip.last.width ? flip.card.width / flip.last.width : 0;
    check('the modal starts at the card it came from',
      !!flip.card && Math.abs(flip.start.scale - wantScale) < 0.05 && flip.start.scale < 0.5,
      `card ${flip.card?.width.toFixed(0)}px -> modal ${flip.last.width.toFixed(0)}px: `
      + `starts at scale ${flip.start.scale.toFixed(3)} (want ${wantScale.toFixed(3)}), offset ${flip.start.dx.toFixed(0)},${flip.start.dy.toFixed(0)}`);
    check('and settles with no transform of its own', flip.settled === 'none', flip.settled);

    // Reduced motion: no intermediate frame at all, the modal is simply there.
    {
      const rm = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
      const rp = await rm.newPage();
      rp.on('pageerror', (e) => console.error(`[page:error] ${e}`));
      await rp.goto(`http://127.0.0.1:${port}/?dataset=${DATASET}&tour=0`, { waitUntil: 'load' });
      await ready(rp);
      await rp.waitForTimeout(1200);
      const still = await rp.evaluate(async (i) => {
        const app = window.pivot;
        const el = document.getElementById('detail');
        const box = () => { const b = el.getBoundingClientRect(); return { left: b.left, width: b.width }; };
        const [wx, wy] = app.renderer.positionOf(i);
        app.camera.focus(wx, wy, 90, 0);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        app.onSelect(i);
        const first = await new Promise((r) => requestAnimationFrame(() => r(box())));
        await new Promise((r) => setTimeout(r, 400));
        return { first, last: box(), transform: getComputedStyle(el).transform };
      }, row);
      check('under prefers-reduced-motion the modal never moves',
        Math.abs(still.first.left - still.last.left) < 1 && Math.abs(still.first.width - still.last.width) < 1,
        `${still.first.width.toFixed(0)} -> ${still.last.width.toFixed(0)}, transform ${still.transform}`);
      await rm.close();
    }

    // Generic renderer still serves a non-tax collection.
    await page.goto(`http://127.0.0.1:${port}/?dataset=products:1000&tour=0`, { waitUntil: 'load' });
    await ready(page);
    await page.waitForTimeout(800);
    await ready(page);
    await page.evaluate(() => window.pivot.onSelect(3));
    await page.waitForTimeout(300);
    check('generic pane has a <dl> and no actions', (await page.locator('#detail dl').count()) === 1
      && (await page.locator('#detail a[data-action]').count()) === 0
      && !(await page.evaluate(() => document.querySelector('#detail').classList.contains('rich'))));

    await ctx.close();
  } catch (err) {
    checks.push(false);
    console.error('detail-e2e failed:', err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  const failed = checks.filter((c) => !c).length;
  console.log(failed ? `${failed} check(s) FAILED` : `all ${checks.length} checks passed; screenshot: screenshots/detail-customer.png`);
  process.exitCode = failed ? 1 : 0;
}

main();
