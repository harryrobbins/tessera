import './ui/style.css';
import { PivotApp, TRUE_COLOUR } from './app';
import { Hud } from './ui/hud';
import { AxisOverlay } from './ui/axes';
import { FacetPanel } from './ui/facets';
import { DetailPane, registerDetail } from './ui/detail';
import { CardSettingsPanel, loadSettings, type CardSettings } from './ui/settings';
import { decodeView, encodeView, serialiseQuery, type ViewState } from './ui/deepLink';
import { customCardFor } from './gl/cards';
import { cardTextOf, compileCard, type CardModel } from './gl/cards/model';
import { taxCaseDetail } from './ui/detail/taxCase';
import { runBench, BenchCancelled, type BenchResult } from './bench/bench';
import { fieldColors, hasNamedColors, OTHER } from './core/palette';
import { esc } from './core/esc';
import type { LayoutSpec } from './layout/layouts';
import { menuEntries, describeKey, familyOf, DEFAULT_DATASET_KEY } from './data/registry';
import { startTour, shouldAutoStart, exposeTour } from './tour';
import type { TourHost } from './tour/actions';

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

{
  // One <optgroup> per dataset family, from the registry (src/data/registry.ts).
  const groups = new Map<string, string[]>();
  for (const e of menuEntries()) {
    const g = e.group ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(`<option value="${esc(e.key)}">${esc(e.label)}</option>`);
  }
  datasetSel.innerHTML = [...groups].map(([g, opts]) => `<optgroup label="${esc(g)}">${opts.join('')}</optgroup>`).join('');
}

function fillSelect(sel: HTMLSelectElement, fields: string[], selectedValue: string, allowNone = false) {
  sel.innerHTML =
    (allowNone ? '<option value="">none</option>' : '') +
    fields.map((f) => `<option value="${esc(f)}"${f === selectedValue ? ' selected' : ''}>${esc(f)}</option>`).join('');
}

let toastTimer = 0;
/** Pending modal open, cancelled if the selection changes mid-flight. */
let openTimer = 0;
function toast(msg: string, ms = 2400) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toastEl.hidden = true; }, ms);
}

/** Camera tween length; 0 under prefers-reduced-motion (app.ts sets `transitionMs` to 0 there). */
const tweenMs = (ms: number) => (app.renderer.transitionMs === 0 ? 0 : ms);

registerDetail('tax-cases', taxCaseDetail);
/** The record pane; closing it (button or Escape) also drops the selection ring. */
const detail = new DetailPane(detailEl, {
  onClose() {
    if (selected >= 0) { app.renderer.setSelected(selected, false); app.renderer.uploadStyleAt(selected); }
    selected = -1;
  },
  onToast: (msg) => toast(msg),
  scrim: $('scrim'),
  background: $('app'),
  mask: () => app.mask,
  cardRect: (i) => app.cardScreenRect(i),
  transitionMs: () => app.renderer.transitionMs,
});

/** Card settings: the design, whether the board is cards or pure colour,
 *  tags, and which column titles a record. Applied by repainting the atlas —
 *  no layout re-solve, so the board does not move under the viewer. */
const cardPanel = new CardSettingsPanel($('cardSettings'), loadSettings(), {
  button: $('cardsBtn') as HTMLButtonElement,
  onChange: (s) => applyCardSettings(s),
  fields: () => {
    const ds = app.dataset;
    const titles = ds
      ? Object.keys(ds.columns).filter((c) => ds.columns[c]?.kind === 'text' || ds.columns[c]?.kind === 'category')
      : [];
    return { titles, custom: ds ? customCardFor(ds) : undefined };
  },
});

function applyCardSettings(s: CardSettings) {
  app.setCardOptions({
    design: s.design === 'auto' ? undefined : s.design,
    tags: s.tags,
    title: s.title || undefined,
  }, s.labels);
}
// Adopt what was stored (or `?cards=`) before the first collection lands:
// `buildCards` is a no-op until there is one, so this only sets the fields.
applyCardSettings(cardPanel.settings);

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
      let y = nums.includes(ySel.value) ? ySel.value : nums[1] ?? nums[0] ?? ySel.value;
      // Never plot a column against itself (Longitude x Longitude is a black diagonal).
      if (y === x) y = nums.find((f) => f !== x) ?? y;
      if (x !== xSel.value) xSel.value = x;
      if (y !== ySel.value) ySel.value = y;
      // Geographic axes keep their true aspect and render as night lights.
      const geo = app.dataset?.geo;
      const equal = !!geo && x === geo.lon && y === geo.lat;
      return { type: 'xy', x, y, equal };
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

/** The most recent solve, so the tour can wait for a layout to settle. */
let lastApply: Promise<void> = Promise.resolve();
async function apply(refit = false) {
  const p = (async () => {
    try {
      await app.setLayout(currentSpec());
    } catch (err) {
      // A layout the worker could not solve (D-04) — say so rather than hang.
      toast(`Layout failed: ${err instanceof Error ? err.message : String(err)}`, 8000);
      return;
    }
    if (refit) app.fit();
  })();
  lastApply = p;
  return p;
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
  const swatches = fieldColors(ds, app.colorBy);
  // Pinned / colour-name fields carry a real colour per category, so show them all.
  const shown = col.categories.slice(0, hasNamedColors(ds, app.colorBy) ? 24 : 8);
  legendEl.innerHTML =
    shown
      .map((c, i) => `<div><i style="background:${esc(swatches[i] ?? OTHER.dark)}"></i>${esc(c)}</div>`)
      .join('') +
    (col.categories.length > shown.length
      ? `<div><i style="background:${OTHER.dark}"></i>+${col.categories.length - shown.length} more</div>`
      : '');
}

// ---------------------------------------------------------------- deep link

/**
 * The view the collection opened on, captured once `load()` has filled the
 * menus. Everything in the URL is a difference from this, so the link for a
 * collection's default view stays `?dataset=birds:900` rather than sprouting
 * six params that say "as you were".
 */
let openView: ViewState = {};
/** Nothing is written to the URL until boot has restored whatever was in it. */
let urlLive = false;
let urlTimer = 0;

const hasOption = (sel: HTMLSelectElement, value: string) =>
  Array.from(sel.options).some((o) => o.value === value);

/** What differs from the opening view — and only what the current layout uses. */
function currentView(): ViewState {
  const view: ViewState = {};
  if (layoutKind !== openView.layout) view.layout = layoutKind;
  if (colorSel.value && colorSel.value !== openView.color) view.color = colorSel.value;
  // Sort follows colour on its own (see the colorBy handler), so it is only
  // worth a param when it differs from what this colour would pick anyway.
  // '' is the real "none" choice, and has to survive the round trip.
  if (layoutKind !== 'xy' && sortSel.value !== (app.defaultSort() ?? '')) view.sort = sortSel.value;
  if (layoutKind === 'bars' && barSel.value && barSel.value !== openView.bucket) view.bucket = barSel.value;
  if (layoutKind === 'scatter' || layoutKind === 'xy') {
    // The axis menus are refilled per layout kind, so the opening values only
    // describe a default for the kind the collection opened on.
    const sameKind = layoutKind === openView.layout;
    if (xSel.value && (!sameKind || xSel.value !== openView.x)) view.x = xSel.value;
    if (ySel.value && (!sameKind || ySel.value !== openView.y)) view.y = ySel.value;
  }
  const filters = facets.filterLabels();
  if (filters.length) view.filters = filters;
  return view;
}

function writeUrl() {
  urlTimer = 0;
  if (!app.dataset || !urlLive) return;
  if (loadedKey) params.set('dataset', loadedKey);
  // Mutated, never rebuilt: ?hires=, ?glow=, ?cards=, ?bench=, ?preserve= and
  // the tour's params are read by other modules and must survive a facet tick.
  encodeView(params, currentView());
  const q = serialiseQuery(params);
  // replaceState, not push: ticking six facets is one view, not six pages back.
  history.replaceState(history.state, '', `${location.pathname}${q ? `?${q}` : ''}${location.hash}`);
}

/** Coalesce a drag across a column of checkboxes into a single URL write. */
function syncUrl() {
  if (!urlLive) return;
  window.clearTimeout(urlTimer);
  urlTimer = window.setTimeout(writeUrl, 150);
}

/**
 * Put a linked view onto the collection now loaded. Order matters: the layout
 * kind first (it refills the axis menus), then colour (it moves the sort with
 * it), then the rest, then the filters — and one solve at the end.
 *
 * Anything that does not resolve against this collection is skipped, so a
 * hand-edited or stale link degrades to the default view rather than to an
 * error.
 */
async function applyView(v: ViewState) {
  if (v.layout && v.layout !== layoutKind) setLayoutKind(v.layout);
  if (v.color && hasOption(colorSel, v.color)) {
    colorSel.value = v.color;
    app.setColorBy(v.color);
    facets.colorBy = v.color;
    facets.render();
    renderLegend();
    sortSel.value = app.defaultSort() ?? '';
  }
  if (v.sort !== undefined && hasOption(sortSel, v.sort)) { sortSel.value = v.sort; sortPinned = true; }
  if (v.bucket && hasOption(barSel, v.bucket)) barSel.value = v.bucket;
  if (v.x && hasOption(xSel, v.x)) xSel.value = v.x;
  if (v.y && hasOption(ySel, v.y)) ySel.value = v.y;
  if (v.filters?.length) {
    facets.setFilterLabels(v.filters);
    // Onto the field rather than through setMask(), so the filter and the rest
    // of the view land in one solve instead of two.
    app.mask = facets.mask();
  }
  await apply(true);
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
  const x = keep(xSel.value, xOpts, xOpts[0] ?? '');
  let y = keep(ySel.value, yOpts, yOpts[1] ?? yOpts[0] ?? '');
  // Never open a raw scatter on the same column twice (Longitude × Longitude).
  if (layoutKind === 'xy' && y === x) y = yOpts.find((o) => o !== x) ?? y;
  fillSelect(xSel, xOpts, x);
  fillSelect(ySel, yOpts, y);
}

app.onDataset = (ds) => {
  const cats = ds.facets.filter((f) => ds.columns[f]?.kind === 'category');
  const nums = ds.facets.filter((f) => ds.columns[f]?.kind === 'number');
  fillSelect(sortSel, ds.facets, app.defaultSort() ?? '', true);
  fillSelect(barSel, [...cats, ...nums], cats[0] ?? ds.facets[0]);
  // The axis menus are filled once, by layout kind, in fillAxisSelects().
  xSel.value = ySel.value = '';
  fillAxisSelects();
  colorSel.innerHTML =
    (ds.rgb ? `<option value="${TRUE_COLOUR}"${app.colorBy === TRUE_COLOUR ? ' selected' : ''}>True colour</option>` : '') +
    ds.facets.map((f) => `<option value="${esc(f)}"${f === app.colorBy ? ' selected' : ''}>${esc(f)}</option>`).join('');
  facets.colorBy = app.colorBy;
  facets.setDataset(ds);
  renderLegend();
  selected = -1;
  detail.hide();
};

app.onLayout = (x, y) => {
  axes.set(x, y);
  // After the solve, so the tooltip reflects the layout now on screen (isRasterView).
  describeZoom();
};

app.onSelect = (i) => {
  if (selected >= 0) { app.renderer.setSelected(selected, false); app.renderer.uploadStyleAt(selected); }
  window.clearTimeout(openTimer);
  selected = i;
  const ds = app.dataset;
  if (i < 0 || !ds) { detail.hide(); return; }
  app.renderer.setSelected(i, true);
  app.renderer.uploadStyleAt(i);
  // Fly to the card first when it is a speck, and open the modal only once the
  // flight lands: the dialog expands out of the card, so the card has to be
  // where the user is looking when it does.
  const [wx, wy] = app.renderer.positionOf(i);
  const ms = app.camera.current.zoom < 60 ? tweenMs(650) : 0;
  if (ms > 0) {
    app.camera.focus(wx, wy, 90, ms);
    openTimer = window.setTimeout(() => { if (selected === i) detail.show(ds, i, app.colorBy); }, ms);
  } else {
    detail.show(ds, i, app.colorBy);
  }
};

// ---- hover and keyboard: what a card says, as text.
//
// The chip and the live region read the *compiled card model*, so they can
// never drift from what the card itself paints.
const chip = $('cursorChip');
const live = $('cardLive');
let textModel: CardModel | null = null;
let textModelKey = '';
function cardText(i: number) {
  const ds = app.dataset;
  if (!ds || i < 0) return null;
  const key = `${ds.name}\u0000${app.colorBy}`;
  if (!textModel || key !== textModelKey) {
    textModel = compileCard(ds, ds.card, app.colorBy);
    textModelKey = key;
  }
  return cardTextOf(textModel, i);
}

let pointerAt = { x: 0, y: 0 };
canvas.addEventListener('pointermove', (e) => {
  pointerAt = { x: e.clientX, y: e.clientY };
  if (!chip.hidden) placeChip();
}, { passive: true });

function placeChip() {
  const r = chip.getBoundingClientRect();
  chip.style.left = `${Math.round(Math.min(pointerAt.x + 14, window.innerWidth - r.width - 8))}px`;
  chip.style.top = `${Math.round(Math.min(pointerAt.y + 16, window.innerHeight - r.height - 8))}px`;
}

app.onHover = (i, readable) => {
  // Above the LOD band the card is already saying this; the chip would only
  // be repeating it over the top of the thing it describes.
  const t = readable ? null : cardText(i);
  if (!t) { chip.hidden = true; return; }
  chip.innerHTML = `<b>${esc(t.title)}</b>${t.topic ? ` <span>${esc(t.topic)}</span>` : ''}`;
  chip.hidden = false;
  placeChip();
};

app.onFocusCard = (i) => {
  const t = cardText(i);
  live.textContent = t ? [t.title, t.topic, ...t.tags].filter(Boolean).join(', ') : '';
};

app.onFrame = (stats, model) => {
  hud.update(stats, model, performance.now());
  axes.render(app.camera.current, canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
};

facets.onChange = () => {
  syncUrl();
  // Same failure path as apply(): a worker that rejects the re-solve (D-04)
  // becomes a toast, not an unhandled rejection.
  app.setMask(facets.mask()).catch((err: unknown) => {
    toast(`Filter failed: ${err instanceof Error ? err.message : String(err)}`, 8000);
  });
};

$('layoutSeg').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  setLayoutKind(btn.dataset.layout as LayoutSpec['type']);
  syncUrl();
  void apply(true);
});
// Tabs move with the arrow keys, Home and End; Tab leaves the group (roving tabindex).
$('layoutSeg').addEventListener('keydown', (e) => {
  const tabs = Array.from($('layoutSeg').querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const i = tabs.indexOf(e.target as HTMLButtonElement);
  if (i < 0) return;
  const next =
    e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % tabs.length :
    e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i + tabs.length - 1) % tabs.length :
    e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
  if (next < 0) return;
  e.preventDefault();
  tabs[next].focus();
  tabs[next].click();
});

sortSel.addEventListener('change', () => { sortPinned = true; syncUrl(); void apply(true); });
for (const sel of [barSel, xSel, ySel]) sel.addEventListener('change', () => { syncUrl(); void apply(true); });
colorSel.addEventListener('change', () => {
  app.setColorBy(colorSel.value);
  facets.colorBy = colorSel.value;
  facets.render();
  renderLegend();
  syncUrl();
  // Cards grouped by their own colour read as a chart; ungrouped they read as
  // confetti. Only stop following once the user has chosen a sort deliberately.
  if (!sortPinned) {
    sortSel.value = app.defaultSort() ?? '';
    void apply(true);
  }
});
// load() has already toasted and reverted the menu on failure; the rethrow is
// for boot() and the tour, so swallow it here rather than leak an unhandled rejection.
datasetSel.addEventListener('change', () => { load(datasetSel.value).catch(() => {}); });
const METRICS_KEY = 'pivot.metrics';
function setMetrics(on: boolean) {
  $('hud').style.display = on ? '' : 'none';
  $('metricsBtn').setAttribute('aria-pressed', String(on));
  $('metricsBtn').classList.toggle('ghost', !on);
  try { localStorage.setItem(METRICS_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}
let metricsOn = (() => {
  // Absent means off: the FPS panel is a developer's tool, and a first-time
  // visitor should get the collection, not a readout over the top of it.
  try { return localStorage.getItem(METRICS_KEY) === '1'; } catch { return false; }
})();
setMetrics(metricsOn);
$('metricsBtn').addEventListener('click', () => setMetrics((metricsOn = !metricsOn)));

$('zoomIn').addEventListener('click', () => app.zoomStep(1));
$('zoomOut').addEventListener('click', () => app.zoomStep(-1));
$('fitBtn').addEventListener('click', () => app.fit());

// ------------------------------------------------------------------- tour

/** Everything the guided tour may do, routed through the same handlers a user would trigger. */
const tourHost: TourHost & { tweenMs(ms: number): number } = {
  app,
  loadDataset: (key) => load(key),
  async setLayout(kind) {
    const btn = $('layoutSeg').querySelector<HTMLButtonElement>(`[data-layout="${kind}"]`);
    btn?.click();
    await lastApply;
  },
  async setSelect(id, value) {
    const sel = $<HTMLSelectElement>(id);
    if (!Array.from(sel.options).some((o) => o.value === value)) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change'));
    await lastApply;
  },
  toggleFacet: (field, label) => facets.toggle(field, label),
  clearFacets: () => facets.clearAll(),
  select: (i) => app.onSelect?.(i),
  el: (selector) => document.querySelector(selector),
  stopBenchmark,
  resetCardSettings: () => cardPanel.reset(),
  tweenMs,
};
$('tourBtn').addEventListener('click', () => startTour(tourHost, { force: true }));
exposeTour(tourHost);

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'SELECT') return;
  if (e.key === 'f') app.fit();
  if (e.key === 'm') setMetrics((metricsOn = !metricsOn));
  if (e.key === '+' || e.key === '=') app.zoomStep(1);
  if (e.key === '-' || e.key === '_') app.zoomStep(-1);
  // The dialog is modal: Escape belongs to it and nothing behind it.
  if (e.key === 'Escape' && detail.visible) { e.stopPropagation(); detail.hide(); }
});

function setLayoutKind(kind: LayoutSpec['type']) {
  layoutKind = kind;
  for (const b of $('layoutSeg').querySelectorAll('button')) {
    const on = b.dataset.layout === kind;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  fillAxisSelects();
  updateControls();
}

function describeZoom() {
    const raster = app.isRasterView;
    $('zoomSeg').title = raster
      ? 'Steps between whole-pixel scales (1:2, 1:1, 2:1 …) — the only scales a pixel collection renders without moire'
      : 'Zoom in and out';
}

/**
 * Point the menu at `key`. A deep link can name a size the menu does not offer
 * (`?dataset=tax-cases:5000`) or an unknown key that resolves to the default;
 * rather than leave the select blank, show the collection actually loaded.
 */
function selectDatasetOption(key: string, sel: HTMLSelectElement = datasetSel) {
  const has = (v: string) => Array.from(sel.options).some((o) => o.value === v);
  if (has(key)) { sel.value = key; return; }
  if (!familyOf(key)) { sel.value = DEFAULT_DATASET_KEY; return; }
  // A known family at an off-menu size: add a temporary entry for it.
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = describeKey(key);
  opt.dataset.temp = '1';
  const group = Array.from(sel.querySelectorAll('optgroup')).find((g) => g.label === familyOf(key)!.label);
  (group ?? sel).appendChild(opt);
  sel.value = key;
}

/** The key of the collection on screen, so a failed load can put the menu back. */
let loadedKey = '';
/** Newest load wins; an older one that finishes late must not touch the chrome. */
let loadSeq = 0;

/**
 * Load a collection and open it on its default layout (map, picture or sorted
 * grid — `app.defaultLayout()`), solved once by `loadDataset`. `onDataset`
 * fills the menus; the layout kind and axes are set to match afterwards.
 * A failure (fetch, decode, a layout the worker rejects) becomes a toast and
 * the menu goes back to the collection still on screen; the error is rethrown
 * so `boot()` and the tour can see it.
 */
async function load(key: string) {
  const seq = ++loadSeq;
  const prev = loadedKey;
  sortPinned = false;
  // Keep the menu honest when the collection came from ?dataset= rather than a click.
  if (datasetSel.value !== key) selectDatasetOption(key);
  toast(`Building ${describeKey(key)}…`, 1400);
  const t0 = performance.now();
  try {
    // No `initial`: the menus belong to the old collection until onDataset
    // runs, so the opening layout is app.defaultLayout(), solved once inside.
    await app.loadDataset(key);
    if (seq !== loadSeq) return;
    const spec = app.defaultLayout();
    if (spec.type === 'xy') {
      setLayoutKind('xy');
      xSel.value = spec.x;
      ySel.value = spec.y;
    } else {
      setLayoutKind('grid');
    }
    // The baseline the URL is a diff against, taken once the menus are the new
    // collection's (onDataset) and the opening layout is set.
    openView = {
      layout: layoutKind,
      color: colorSel.value,
      sort: sortSel.value,
      bucket: barSel.value,
      x: xSel.value,
      y: ySel.value,
    };
    loadedKey = key;
    syncUrl();
    toast(`${app.dataset!.n.toLocaleString()} cards ready in ${(performance.now() - t0).toFixed(0)} ms`, 2000);
  } catch (err) {
    if (seq === loadSeq && prev) datasetSel.value = prev;
    toast(`Could not load ${describeKey(key)}: ${err instanceof Error ? err.message : String(err)}`, 8000);
    throw err;
  }
}

// ---------------------------------------------------------------- benchmark

function reportTable(result: BenchResult): string {
  const rows: string[] = [];
  for (const run of result.runs) {
    rows.push(`<tr class="head"><td colspan="6">${esc(run.dataset)} — ${run.n.toLocaleString()} cards</td></tr>`);
    for (const p of run.phases) {
      rows.push(
        `<tr><td>${esc(p.name)}</td><td>${p.fps.toFixed(1)}</td><td>${p.p50.toFixed(2)}</td>` +
        `<td>${p.p95.toFixed(2)}</td><td>${p.worst.toFixed(1)}</td><td>${p.frames}</td></tr>`,
      );
    }
  }
  const soft = /swiftshader|llvmpipe|software/i.test(String(result.env.renderer));
  return `
    <header>
      <h2>Benchmark</h2>
      <span style="color:var(--ink-3)">${esc(String(result.env.renderer))}</span>
      <span class="spacer" style="flex:1"></span>
      <button type="button" data-copy>Copy JSON</button>
      <button type="button" data-download>Download</button>
      <button type="button" data-close>Close</button>
    </header>
    <div class="body">
      ${soft ? '<p class="warn">Software renderer — these numbers are CPU-rasterised and not representative of this machine’s GPU.</p>' : ''}
      <table>
        <thead><tr><th>phase</th><th>fps</th><th>p50 ms</th><th>p95 ms</th><th>worst ms</th><th>frames</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

/**
 * The benchmark owns the whole application while it runs: it swaps the
 * collection four times and drives the camera every frame. Only one may run,
 * and anything else that wants the app — the guided tour — stops it first.
 */
let benchRun: AbortController | null = null;

/** Cancel a running suite and take down its report. Safe to call when idle. */
function stopBenchmark(): void {
  benchRun?.abort();
  benchRun = null;
  document.querySelector('.report')?.remove();
}

async function benchmark() {
  if (benchRun) { toast('A benchmark is already running'); return undefined; }
  const sizes = (params.get('sizes')?.split(',').map(Number).filter(Boolean)) ?? [1000, 10_000, 100_000, 500_000];
  const run = new AbortController();
  benchRun = run;
  $('benchBtn').setAttribute('aria-busy', 'true');
  toast('Benchmarking… the window must stay in the foreground', 6000);
  let result: BenchResult;
  try {
    result = await runBench(app, { sizes, signal: run.signal, onProgress: (m) => toast(m, 4000) });
  } catch (err) {
    if (err instanceof BenchCancelled) { toast('Benchmark stopped'); return undefined; }
    throw err;
  } finally {
    $('benchBtn').removeAttribute('aria-busy');
    if (benchRun === run) benchRun = null;
  }
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
    // The link's view, read before the load so a failed decode cannot leave
    // half a view applied; the collection is loaded on its own defaults first
    // and the linked view goes on top, because onDataset() and load() would
    // otherwise overwrite it.
    const view = benchMode ? {} : decodeView(params);
    const linked = Object.keys(view).length > 0;
    await load(benchMode ? 'tax-cases:900' : (params.get('dataset') ?? DEFAULT_DATASET_KEY));
    if (linked) await applyView(view);
    urlLive = true;
    app.start();
    window.pivot = app;
    window.runPivotBench = (opts) =>
      runBench(app, { sizes: opts?.sizes ?? [1000, 10_000, 100_000, 500_000, 1_000_000] });
    window.pivotBenchReady = true;
    // A link that names a view is a request to look at that view, not an
    // invitation to be shown around the app on top of it.
    if (!benchMode && !linked && shouldAutoStart(params)) startTour(tourHost);
  } catch (err) {
    toast(String(err), 20_000);
    throw err;
  }
}

void boot();
