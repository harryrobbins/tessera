import './ui/style.css';
import { PivotApp, TRUE_COLOUR, PIXEL_IMAGES } from './app';
import { Hud } from './ui/hud';
import { AxisOverlay } from './ui/axes';
import { FacetPanel } from './ui/facets';
import { runBench, type BenchResult } from './bench/bench';
import { categoricalColor } from './core/palette';
import { valueAt } from './data/columnar';
import type { LayoutSpec } from './layout/layouts';
import { PRODUCT_SIZES } from './data/products';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('gl');
const app = new PivotApp(canvas);
const hud = new Hud($('hud'));
const axes = new AxisOverlay($<HTMLElement>('axes') as unknown as SVGSVGElement);
const facets = new FacetPanel($('facets'));

const datasetSel = $<HTMLSelectElement>('dataset');
const sortSel = $<HTMLSelectElement>('sortBy');
const barSel = $<HTMLSelectElement>('barBy');
const xSel = $<HTMLSelectElement>('axisX');
const ySel = $<HTMLSelectElement>('axisY');
const colorSel = $<HTMLSelectElement>('colorBy');
const legendEl = $('legend');
const detailEl = $('detail');
const toastEl = $('toast');

const params = new URLSearchParams(location.search);
const benchMode = params.get('bench') === '1';

let layoutKind: LayoutSpec['type'] = 'grid';
let selected = -1;
/** Sort tracks colour until the user picks a sort of their own. */
let sortPinned = false;

// ------------------------------------------------------------------ chrome

const PIXEL_TITLES: Record<string, string> = {
  'starry-night': 'Starry Night Over the Rhône',
  'great-wave': 'The Great Wave',
};
datasetSel.innerHTML = [
  '<option value="titanic">Titanic — 891</option>',
  ...PRODUCT_SIZES.map((n) => `<option value="products:${n}">Products — ${n.toLocaleString()}</option>`),
  '<option value="products:2000000">Products — 2,000,000</option>',
  ...PIXEL_IMAGES.flatMap((img: string) => [250_000, 1_000_000].map((n) =>
    `<option value="pixels:${img}:${n}">${PIXEL_TITLES[img] ?? img} — ${(n / 1000).toFixed(0)}k pixels</option>`)),
].join('');

function fillSelect(sel: HTMLSelectElement, fields: string[], selectedValue: string, allowNone = false) {
  sel.innerHTML =
    (allowNone ? '<option value="">none</option>' : '') +
    fields.map((f) => `<option value="${f}"${f === selectedValue ? ' selected' : ''}>${f}</option>`).join('');
}

function toast(msg: string, ms = 2400) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  window.clearTimeout((toast as unknown as { t?: number }).t);
  (toast as unknown as { t?: number }).t = window.setTimeout(() => { toastEl.hidden = true; }, ms);
}

function currentSpec(): LayoutSpec {
  switch (layoutKind) {
    case 'bars':
      return { type: 'bars', by: barSel.value || app.defaultBucket(), bins: 12, sortBy: sortSel.value || undefined };
    case 'xy': {
      // The menus only offer numeric columns here; this is a belt-and-braces
      // guard, and it must never silently plot a different column than the one
      // named in the dropdown.
      const nums = app.dataset ? Object.keys(app.dataset.columns)
        .filter((f) => app.dataset!.columns[f]?.kind === 'number') : [];
      const x = nums.includes(xSel.value) ? xSel.value : nums[0] ?? xSel.value;
      const y = nums.includes(ySel.value) ? ySel.value : nums[1] ?? nums[0] ?? ySel.value;
      if (x !== xSel.value) xSel.value = x;
      if (y !== ySel.value) ySel.value = y;
      return { type: 'xy', x, y };
    }
    case 'scatter':
      return {
        type: 'scatter',
        x: xSel.value || app.defaultBucket(),
        y: ySel.value || app.defaultAxisY(),
        xBins: 10,
        yBins: 8,
        sortBy: sortSel.value || undefined,
      };
    default: return { type: 'grid', sortBy: sortSel.value || undefined };
  }
}

async function apply(refit = false) {
  await app.setLayout(currentSpec());
  if (refit) app.fit();
}

function updateControls() {
  // Sorting orders cards within a cell in cross-tab, but position in a raw
  // scatter comes only from the axes, so it has nothing to order.
  $('sortField').classList.toggle('hidden', layoutKind === 'xy');
  $('barField').classList.toggle('hidden', layoutKind !== 'bars');
  const axial = layoutKind === 'scatter' || layoutKind === 'xy';
  $('xField').classList.toggle('hidden', !axial);
  $('yField').classList.toggle('hidden', !axial);
}

function renderLegend() {
  const ds = app.dataset;
  const col = ds?.columns[app.colorBy];
  if (!ds || !col || col.kind !== 'category') { legendEl.innerHTML = ''; return; }
  const shown = col.categories.slice(0, 8);
  legendEl.innerHTML =
    shown
      .map((c, i) => `<div><i style="background:${categoricalColor(i)}"></i>${c}</div>`)
      .join('') +
    (col.categories.length > shown.length
      ? `<div><i style="background:#6f6e66"></i>+${col.categories.length - shown.length} more</div>`
      : '');
}

function showDetail(i: number) {
  const ds = app.dataset;
  if (!ds || i < 0) { detailEl.hidden = true; return; }
  const col = ds.columns[app.colorBy];
  const code = col?.kind === 'category' ? col.codes[i] : 0;
  const rows = Object.keys(ds.columns)
    .filter((f) => f !== ds.labelColumn)
    .map((f) => `<dt>${f}</dt><dd>${valueAt(ds, f, i)}</dd>`)
    .join('');
  detailEl.innerHTML = `
    <header style="background:${categoricalColor(code)}">
      <h2>${valueAt(ds, ds.labelColumn, i) || `Item ${i}`}</h2>
      <p>${app.colorBy ? valueAt(ds, app.colorBy, i) : app.datasetName}</p>
    </header>
    <dl>${rows}</dl>
    <button class="close" aria-label="Close">×</button>`;
  detailEl.hidden = false;
  detailEl.querySelector('.close')!.addEventListener('click', () => {
    detailEl.hidden = true;
    if (selected >= 0) { app.renderer.setSelected(selected, false); app.renderer.uploadStyleAt(selected); }
    selected = -1;
  });
}

// ------------------------------------------------------------------- wiring

/**
 * The cross-tab bins whatever it is given, but a raw scatter needs two numeric
 * axes. Offering a categorical there and quietly substituting a number for it —
 * which is what used to happen — produces a chart that is a lie.
 */
function fillAxisSelects() {
  const ds = app.dataset;
  if (!ds) return;
  const cats = ds.facets.filter((f) => ds.columns[f]?.kind === 'category');
  const nums = ds.facets.filter((f) => ds.columns[f]?.kind === 'number');
  const xOpts = layoutKind === 'xy' ? nums : [...cats, ...nums];
  const yOpts = layoutKind === 'xy' ? nums : [...nums, ...cats];
  const keep = (v: string, opts: string[], alt: string) => (opts.includes(v) ? v : alt);
  fillSelect(xSel, xOpts, keep(xSel.value, xOpts, xOpts[0] ?? ''));
  fillSelect(ySel, yOpts, keep(ySel.value, yOpts, yOpts[1] ?? yOpts[0] ?? ''));
}

app.onDataset = (ds) => {
  const cats = ds.facets.filter((f) => ds.columns[f]?.kind === 'category');
  const nums = ds.facets.filter((f) => ds.columns[f]?.kind === 'number');
  fillSelect(sortSel, ds.facets, app.defaultSort() ?? '', true);
  fillSelect(barSel, [...cats, ...nums], cats[0] ?? ds.facets[0]);
  fillSelect(xSel, [...cats, ...nums], cats[0] ?? ds.facets[0]);
  fillSelect(ySel, [...nums, ...cats], nums[0] ?? cats[1] ?? ds.facets[0]);
  fillAxisSelects();
  colorSel.innerHTML =
    (ds.rgb ? `<option value="${TRUE_COLOUR}"${app.colorBy === TRUE_COLOUR ? ' selected' : ''}>True colour</option>` : '') +
    ds.facets.map((f) => `<option value="${f}"${f === app.colorBy ? ' selected' : ''}>${f}</option>`).join('');
  facets.colorBy = app.colorBy;
  facets.setDataset(ds);
  renderLegend();
  detailEl.hidden = true;
  selected = -1;
};

app.onLayout = (x, y) => axes.set(x, y);

app.onSelect = (i) => {
  if (selected >= 0) { app.renderer.setSelected(selected, false); app.renderer.uploadStyleAt(selected); }
  selected = i;
  if (i >= 0) {
    app.renderer.setSelected(i, true);
    app.renderer.uploadStyleAt(i);
    const [wx, wy] = [app.renderer.positionOf(i)[0], app.renderer.positionOf(i)[1]];
    if (app.camera.current.zoom < 60) app.camera.focus(wx, wy, 90);
  }
  showDetail(i);
};

app.onFrame = (stats, model) => {
  hud.update(stats, model, performance.now());
  axes.render(app.camera.current, canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
};

facets.onChange = () => { void app.setMask(facets.mask()); };

$('layoutSeg').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  setLayoutKind(btn.dataset.layout as LayoutSpec['type']);
  void apply(true);
});

sortSel.addEventListener('change', () => { sortPinned = true; void apply(true); });
for (const sel of [barSel, xSel, ySel]) sel.addEventListener('change', () => void apply(true));
colorSel.addEventListener('change', () => {
  app.setColorBy(colorSel.value);
  facets.colorBy = colorSel.value;
  facets.render();
  renderLegend();
  // Cards grouped by their own colour read as a chart; ungrouped they read as
  // confetti. Only stop following once the user has chosen a sort deliberately.
  if (!sortPinned) {
    sortSel.value = app.defaultSort() ?? '';
    void apply(true);
  }
});
datasetSel.addEventListener('change', () => void load(datasetSel.value));
const METRICS_KEY = 'pivot.metrics';
function setMetrics(on: boolean) {
  $('hud').style.display = on ? '' : 'none';
  $('metricsBtn').setAttribute('aria-pressed', String(on));
  $('metricsBtn').classList.toggle('ghost', !on);
  try { localStorage.setItem(METRICS_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}
let metricsOn = (() => {
  try { return localStorage.getItem(METRICS_KEY) !== '0'; } catch { return true; }
})();
setMetrics(metricsOn);
$('metricsBtn').addEventListener('click', () => setMetrics((metricsOn = !metricsOn)));

$('fitBtn').addEventListener('click', () => app.fit());

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'SELECT') return;
  if (e.key === 'f') app.fit();
  if (e.key === 'm') setMetrics((metricsOn = !metricsOn));
  if (e.key === 'Escape') { detailEl.hidden = true; }
});

function setLayoutKind(kind: LayoutSpec['type']) {
  layoutKind = kind;
  for (const b of $('layoutSeg').querySelectorAll('button')) {
    const on = b.dataset.layout === kind;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  fillAxisSelects();
  updateControls();
}

async function load(key: string) {
  sortPinned = false;
  toast(`Building ${key.startsWith('products') ? Number(key.split(':')[1]).toLocaleString() + ' cards' : 'the Titanic collection'}…`, 1400);
  const t0 = performance.now();
  await app.loadDataset(key);
  // Open a pixel collection as the picture it came from.
  if (app.dataset?.rgb && app.dataset.columns['X'] && app.dataset.columns['Y']) {
    xSel.value = 'X';
    ySel.value = 'Y';
    setLayoutKind('xy');
    await apply(true);
  } else {
    setLayoutKind('grid');
  }
  toast(`${app.dataset!.n.toLocaleString()} cards ready in ${(performance.now() - t0).toFixed(0)} ms`, 2000);
}

// ---------------------------------------------------------------- benchmark

function reportTable(result: BenchResult): string {
  const rows: string[] = [];
  for (const run of result.runs) {
    rows.push(`<tr class="head"><td colspan="6">${run.dataset} — ${run.n.toLocaleString()} cards</td></tr>`);
    for (const p of run.phases) {
      rows.push(
        `<tr><td>${p.name}</td><td>${p.fps.toFixed(1)}</td><td>${p.p50.toFixed(2)}</td>` +
        `<td>${p.p95.toFixed(2)}</td><td>${p.worst.toFixed(1)}</td><td>${p.frames}</td></tr>`,
      );
    }
  }
  const soft = /swiftshader|llvmpipe|software/i.test(String(result.env.renderer));
  return `
    <header>
      <h2>Benchmark</h2>
      <span style="color:var(--ink-3)">${result.env.renderer}</span>
      <span class="spacer" style="flex:1"></span>
      <button data-copy>Copy JSON</button>
      <button data-download>Download</button>
      <button data-close>Close</button>
    </header>
    <div class="body">
      ${soft ? '<p class="warn">Software renderer — these numbers are CPU-rasterised and not representative of this machine’s GPU.</p>' : ''}
      <table>
        <thead><tr><th>phase</th><th>fps</th><th>p50 ms</th><th>p95 ms</th><th>worst ms</th><th>frames</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

async function benchmark() {
  const sizes = (params.get('sizes')?.split(',').map(Number).filter(Boolean)) ?? [1000, 10_000, 100_000, 500_000];
  toast('Benchmarking… the window must stay in the foreground', 6000);
  const result = await runBench(app, { sizes, onProgress: (m) => toast(m, 4000) });
  const panel = document.createElement('div');
  panel.className = 'report';
  panel.innerHTML = reportTable(result);
  $('gl').parentElement!.appendChild(panel);
  panel.querySelector('[data-close]')!.addEventListener('click', () => panel.remove());
  panel.querySelector('[data-copy]')!.addEventListener('click', () => {
    void navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    toast('Copied');
  });
  panel.querySelector('[data-download]')!.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `pivot-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  return result;
}

$('benchBtn').addEventListener('click', () => void benchmark());

// -------------------------------------------------------------------- boot

declare global {
  interface Window {
    pivotBenchReady?: boolean;
    runPivotBench?: (opts?: { sizes?: number[] }) => Promise<BenchResult>;
    pivot?: PivotApp;
  }
}

async function boot() {
  try {
    await load(benchMode ? 'titanic' : (params.get('dataset') ?? 'titanic'));
    app.start();
    window.pivot = app;
    window.runPivotBench = (opts) =>
      runBench(app, { sizes: opts?.sizes ?? [1000, 10_000, 100_000, 500_000, 1_000_000] });
    window.pivotBenchReady = true;
  } catch (err) {
    toast(String(err), 20_000);
    throw err;
  }
}

void boot();
