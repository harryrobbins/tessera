import { chromium } from '@playwright/test';

const url = 'http://127.0.0.1:4173/tessera/';
const errors = [];
const consoleErrors = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=vulkan', '--ignore-gpu-blocklist', '--use-gl=angle', '--disable-dev-shm-usage'],
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

await page.waitForTimeout(2000);
await page.screenshot({ path: '/var/web/pivot/screenshots/pages-subpath.png' });

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

process.exit(errors.length > 0 || !ready || datasetN !== 891 || !pixelsOk ? 1 : 0);
