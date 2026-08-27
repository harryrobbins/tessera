// Sub-path smoke test: the built demo served under a mount (GitHub Pages uses
// /tessera/) must boot, load its worker and data, and switch to a pixel
// collection without a 404. Run against `vite preview --base /tessera/`:
//
//   node scripts/_verify-subpath.mjs [url] [--screenshot path] [--swiftshader]
//
// Defaults: url http://127.0.0.1:4173/tessera/ (or $SUBPATH_URL); no screenshot
// unless --screenshot or $SUBPATH_SCREENSHOT is given. Exits 1 on failure.
import { chromium } from '@playwright/test';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const url = argv.find((a) => /^https?:/.test(a)) ?? process.env.SUBPATH_URL ?? 'http://127.0.0.1:4173/tessera/';
const screenshot = flag('--screenshot') ?? process.env.SUBPATH_SCREENSHOT;
const swiftshader = argv.includes('--swiftshader');
const errors = [];
const consoleErrors = [];

const browser = await chromium.launch({
  headless: true,
  args: swiftshader
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage']
    : ['--use-angle=vulkan', '--ignore-gpu-blocklist', '--use-gl=angle', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

await page.goto(url, { waitUntil: 'load' });

let ready = false;
try {
  await page.waitForFunction('window.pivotBenchReady === true', { timeout: 30000 });
  ready = true;
} catch (e) {
  ready = false;
}

const datasetN = await page.evaluate(() => window.pivot?.dataset?.n).catch(() => undefined);

let pixelsOk = false;
let pixelsRgbDefined = undefined;
try {
  await page.selectOption('#dataset', 'pixels:great-wave:250000');
  await page.waitForFunction('window.pivot?.dataset?.rgb !== undefined', { timeout: 15000 });
  pixelsRgbDefined = await page.evaluate(() => window.pivot?.dataset?.rgb !== undefined);
  pixelsOk = true;
} catch (e) {
  pixelsOk = false;
  errors.push('pixel-switch-failed: ' + String(e));
}

if (screenshot) {
  await page.waitForTimeout(2000);
  await page.screenshot({ path: screenshot });
}

await browser.close();

console.log(JSON.stringify({
  url,
  ready,
  datasetN,
  pixelsOk,
  pixelsRgbDefined,
  pageErrors: errors,
  consoleErrors,
}, null, 2));

process.exit(errors.length > 0 || !ready || !(datasetN > 0) || !pixelsOk ? 1 : 0);
