// Sub-path smoke test: the built demo served under a mount (GitHub Pages uses
// /tessera/) must boot, load its worker and data, and switch to the two
// collections that fetch at runtime — a pixel collection and the birds photo
// collection — without a 404. Run against `vite preview --base /tessera/`:
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
// Anything the page asked for and did not get. A data file that 404s under the
// mount is the exact failure this script exists to catch, and the birds photo
// sheets fail *quietly* — the cards fall back to the quiet design rather than
// throwing — so the response is the only honest evidence.
const missing = [];
page.on('response', (res) => {
  if (!res.ok() && !res.status().toString().startsWith('3')) missing.push(`${res.status()} ${res.url()}`);
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

// The birds collection fetches `data/birds-<n>.json` *and* its photo sheets,
// all on relative paths; every one of them 404s under a mount if anything grows
// a leading slash. The key comes from the menu rather than being hard-coded,
// and the sheet extension is matched loosely, because both the sizes and the
// encoding are the pipeline's to choose.
let birdsOk = false;
let birdsKey = undefined;
let birdsN = undefined;
let birdsPhotos = undefined;
try {
  birdsKey = await page.$eval('#dataset', (el) => Array.from(el.options).map((o) => o.value).find((v) => v.startsWith('birds:')));
  if (!birdsKey) throw new Error('no birds option in the dataset menu');
  await page.selectOption('#dataset', birdsKey);
  await page.waitForFunction("window.pivot?.dataset?.kind === 'birds'", { timeout: 20000 });
  birdsN = await page.evaluate(() => window.pivot?.dataset?.n);
  birdsPhotos = !missing.some((m) => /birds-\d+-\d+\.(?:avif|webp)/.test(m));
  birdsOk = birdsN > 0;
} catch (e) {
  birdsOk = false;
  errors.push('birds-switch-failed: ' + String(e));
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
  birdsOk,
  birdsKey,
  birdsN,
  birdsPhotos,
  missing,
  pageErrors: errors,
  consoleErrors,
}, null, 2));

process.exit(errors.length > 0 || !ready || !(datasetN > 0) || !pixelsOk || !birdsOk || !birdsPhotos ? 1 : 0);
