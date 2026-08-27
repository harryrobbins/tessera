#!/usr/bin/env node
// Card settings and canvas usability check: boots vite + headless Chromium
// (see the playwright-wsl skill), opens the Cards popover on tax-cases:900 and
// asserts that the four controls do what they say — Design repaints the board,
// Labels drops the atlas entirely, the deep link pins the design, and Detailed
// is offered only where the collection has one. Then the canvas itself: the
// keyboard walk between cards, its live region, and the cursor chip that
// stands in for card art below the LOD band.
//
// Usage: node scripts/verify-cards.mjs [--port 5197] [--keep-server] [--swiftshader]

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '5197' },
    'keep-server': { type: 'boolean', default: false },
    swiftshader: { type: 'boolean', default: false },
  },
});
const port = Number(args.port);
const shots = path.join(ROOT, 'screenshots');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).status === 200) return; } catch { /* not yet */ }
    await wait(300);
  }
  throw new Error(`no server at 127.0.0.1:${port} after ${ms}ms`);
}

function startVite() {
  const child = spawn('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (c) => process.stderr.write(`[vite] ${c}`));
  return child;
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Open the app in a fresh context with no stored settings. */
async function open(browser, query) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[page:error] ${e}`));
  await page.goto(`http://127.0.0.1:${port}/?tour=0&${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.pivotBenchReady === true, null, { timeout: 60_000 });
  await wait(1200);
  return { ctx, page };
}

/** A grid, sorted, with one card filling ~360 device px so the design reads. */
async function zoomToCard(page, i = 0) {
  await page.evaluate(async () => {
    await window.pivot.setLayout({ type: 'grid', sortBy: 'Topic' });
    window.pivot.fit(false);
  });
  await wait(700);
  await page.evaluate((i) => {
    const app = window.pivot;
    const o = i * 4;
    app.camera.focus(app.renderer.to[o], app.renderer.to[o + 1], 360 / app.renderer.to[o + 2], 0);
  }, i);
  await wait(1400);
}

const cardClip = async (page, i = 0) => {
  const r = await page.evaluate((i) => window.pivot.cardScreenRect(i), i);
  return r && { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
};

const design = (page) => page.evaluate(() => {
  const b = document.querySelector('#cardSettings [role="radio"][aria-checked="true"]');
  return b ? b.textContent : null;
});

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
    await fs.mkdir(shots, { recursive: true });

    // 1. The popover itself.
    {
      const { ctx, page } = await open(browser, 'dataset=tax-cases:900');
      await zoomToCard(page);
      await page.click('#cardsBtn');
      await wait(250);
      check('the Cards button opens a labelled dialog it owns',
        await page.locator('#cardSettings').isVisible()
        && (await page.getAttribute('#cardsBtn', 'aria-expanded')) === 'true'
        && (await page.getAttribute('#cardSettings', 'aria-label')) === 'Card settings');
      await page.screenshot({ path: path.join(shots, 'cards-settings.png') });

      // 2. Detailed vs Simple, on the same card.
      const clip = await cardClip(page);
      const detailed = clip && await page.screenshot({ clip });
      await page.locator('#cardSettings [role="radio"]', { hasText: 'Simple' }).click();
      await wait(1200);
      const simple = clip && await page.screenshot({ clip });
      check('Design repaints the board', !!detailed && !!simple && !detailed.equals(simple),
        `card ${clip?.width}x${clip?.height} css px`);
      check('and the choice sticks in the popover', (await design(page)) === 'Simple');
      await page.keyboard.press('Escape');
      await wait(250);
      check('Escape closes it and hands focus back to the button',
        await page.locator('#cardSettings').isHidden()
        && await page.evaluate(() => document.activeElement?.id === 'cardsBtn'));
      await page.screenshot({ path: path.join(shots, 'cards-simple.png'), clip: await cardClip(page) });

      // 3. Labels off: no atlas at all.
      await page.click('#cardsBtn');
      await wait(250);
      await page.locator('#cardSettings .set-row', { hasText: 'Labels' }).locator('button').click();
      await wait(1000);
      const frame = await page.evaluate(() => window.pivot.lastFrame);
      check('Labels off drops the atlas', frame?.atlasSlot === null, `atlasSlot ${frame?.atlasSlot}`);
      await page.keyboard.press('Escape');
      await wait(200);
      await page.screenshot({ path: path.join(shots, 'cards-labels-off.png'), clip: await cardClip(page) });

      // 4. The settings survive a reload; the board comes back the same way.
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.pivotBenchReady === true, null, { timeout: 60_000 });
      await wait(1200);
      const after = await page.evaluate(() => window.pivot.lastFrame);
      check('and survive a reload', after?.atlasSlot === null);
      await ctx.close();
    }

    // 5. The deep link pins the design, and only the design.
    {
      const { ctx, page } = await open(browser, 'dataset=tax-cases:900&cards=quiet');
      await page.click('#cardsBtn');
      await wait(250);
      check('?cards=quiet pins the design', (await design(page)) === 'Simple');
      await ctx.close();
    }

    // 6. Detailed is not offered where there is no bespoke card.
    {
      const { ctx, page } = await open(browser, 'dataset=products:1000');
      await page.click('#cardsBtn');
      await wait(250);
      const detailed = page.locator('#cardSettings [role="radio"]', { hasText: 'Detailed' });
      check('Detailed is disabled for a collection without one', await detailed.isDisabled(),
        await detailed.getAttribute('title') ?? '');
      await ctx.close();
    }

    // 7. The canvas as a control: focusable, walkable, and it says what it has.
    {
      const { ctx, page } = await open(browser, 'dataset=tax-cases:900');
      await page.evaluate(async () => {
        await window.pivot.setLayout({ type: 'grid', sortBy: 'Topic' });
        window.pivot.fit(false);
      });
      await wait(900);
      check('the canvas is focusable and described',
        (await page.getAttribute('#gl', 'tabindex')) === '0'
        && (await page.getAttribute('#gl', 'role')) === 'application'
        && (await page.locator('#glHelp').count()) === 1
        && (await page.getAttribute('#gl', 'aria-describedby')) === 'glHelp');

      await page.focus('#gl');
      await page.keyboard.press('Home');
      await wait(200);
      const first = await page.evaluate(() => window.pivot.focusedCard);
      const said = await page.textContent('#cardLive');
      await page.keyboard.press('ArrowRight');
      await wait(200);
      const second = await page.evaluate(() => window.pivot.focusedCard);
      check('arrow keys walk between cards', first >= 0 && second >= 0 && second !== first, `${first} -> ${second}`);
      check('and the live region says what is focused', !!said && said.split(',').length >= 2, said ?? '');
      check('the focused card is ringed',
        await page.evaluate((i) => window.pivot.renderer.styleU8[i * 16 + 13] === 128, second));

      await page.keyboard.press('Enter');
      await wait(900);
      check('Enter opens that record', await page.locator('#detail').isVisible());
      await page.keyboard.press('Escape');
      await wait(300);

      await ctx.close();
    }

    // 8. The cursor chip, on the collection the complaint came from: at fit,
    //    100,000 cards are ~7 device px and no art is legible on them at all.
    {
      const { ctx, page } = await open(browser, 'dataset=tax-cases:100000');
      await page.evaluate(async () => {
        await window.pivot.setLayout({ type: 'grid', sortBy: 'Topic' });
        window.pivot.fit(false);
      });
      await wait(1500);
      const px = await page.evaluate(() => window.pivot.cardSize * window.pivot.camera.current.zoom);
      const box = await page.evaluate(() => {
        const b = window.pivot.canvas.getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
      });
      // Nudge across a few cards: the exact centre may land in the gap between two.
      let shown = false;
      for (let dx = 0; dx < 40 && !shown; dx += 3) {
        await page.mouse.move(box.x + dx, box.y);
        await wait(120);
        shown = await page.locator('#cursorChip').isVisible();
      }
      check('the cursor chip names the card when it is a dot', shown,
        shown ? `${px.toFixed(1)} device px: ${(await page.textContent('#cursorChip')) ?? ''}` : `${px.toFixed(1)} device px, not shown`);
      if (shown) await page.screenshot({ path: path.join(shots, 'cursor-chip.png') });

      await zoomToCard(page);
      await page.mouse.move(box.x, box.y);
      await wait(400);
      check('and gets out of the way once the card can be read',
        await page.locator('#cursorChip').isHidden());
      await ctx.close();
    }

    console.log('screenshots: screenshots/cards-settings.png, cards-simple.png, cards-labels-off.png, cursor-chip.png');
  } catch (err) {
    checks.push(false);
    console.error('verify-cards failed:', err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  const failed = checks.filter((c) => !c).length;
  console.log(failed ? `${failed} of ${checks.length} checks failed` : `all ${checks.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

main();
