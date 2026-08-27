import type { PivotApp } from '../app';
import type { Dataset } from '../data/columnar';
import type { LayoutSpec } from '../layout/layouts';
import type { TourStep, SpotRect } from './engine';
import { NARRATION } from './script';
import { COL, TOUR_DATASET, VAL } from './columns';
import { FLIP_MS } from '../ui/detail/flip';

/** What the tour may do to the app — built in main.ts, the only DOM-aware side. */
export interface TourHost {
  app: PivotApp;
  loadDataset(key: string): Promise<void>;
  setLayout(kind: LayoutSpec['type']): Promise<void>;
  setSelect(id: 'sortBy' | 'barBy' | 'axisX' | 'axisY' | 'colorBy', value: string): Promise<void>;
  toggleFacet(field: string, label: string): void;
  clearFacets(): void;
  select(index: number): void;
  el(selector: string): Element | null;
  /** Camera tween length to use for `ms`; 0 under prefers-reduced-motion. Absent = `ms`. */
  tweenMs?(ms: number): number;
  /** Put Card settings back to the collection's own choices for the tour.
   *  Optional so the fakes in tests/tour-*.test.ts keep compiling. */
  resetCardSettings?(): void;
  /** Cancel a running benchmark suite and take down its report. The suite
   *  swaps the collection four times and drives the camera every frame, so
   *  the tour and it cannot share the app. Optional for the same reason. */
  stopBenchmark?(): void;
}

/** Resolves after `ms`, or at once when `signal` aborts (the user moved on). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done);
  });
}

/** First match that actually takes up space on screen. */
function visible(host: TourHost, selector: string): Element | null {
  const all = host.el('body')?.querySelectorAll(selector) ?? [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

// ------------------------------------------------------------ pure helpers

/** Rows passing `mask` (all rows when null). */
function visibleRows(ds: Dataset, mask: Uint8Array | null): number[] {
  const out: number[] = [];
  for (let i = 0; i < ds.n; i++) if (!mask || mask[i]) out.push(i);
  return out;
}

/** Rows where every `field: label` pair holds. */
export function rowsWhere(ds: Dataset, where: Record<string, string>, mask: Uint8Array | null = null): number[] {
  let rows = visibleRows(ds, mask);
  for (const [field, label] of Object.entries(where)) {
    const col = ds.columns[field];
    if (!col || col.kind !== 'category') return [];
    const code = col.categories.indexOf(label);
    if (code < 0) return [];
    rows = rows.filter((i) => col.codes[i] === code);
  }
  return rows;
}

/**
 * The customer the tour lands on: of the rows passing `mask`, the one with the
 * most contacts, oldest case first, lowest index as the final tie-break — so
 * the same person every time, and the last card of a grid sorted by Contacts.
 */
export function featuredRow(ds: Dataset, mask: Uint8Array | null = null): number {
  const rows = visibleRows(ds, mask);
  if (rows.length === 0) return -1;
  const contacts = ds.columns[COL.contacts];
  const opened = ds.columns[COL.opened];
  const c = contacts?.kind === 'number' ? contacts.values : null;
  const o = opened?.kind === 'number' ? opened.values : null;
  return rows.reduce((best, i) => {
    if (c) {
      if (c[i] > c[best]) return i;
      if (c[i] < c[best]) return best;
    }
    if (o) {
      if (o[i] < o[best]) return i;
      if (o[i] > o[best]) return best;
    }
    return best;
  }, rows[0]);
}

/** Where a card currently sits (its layout target), in world units. */
export function worldOf(app: PivotApp, i: number): [number, number] {
  const p = app.renderer.positionOf(i);
  return [p[0], p[1]];
}

/** Resolve once the camera has reached its target (or after `maxMs`, or on
 *  abort): frame rate varies, so a fixed sleep measures a spotlight mid-flight. */
export async function settle(app: PivotApp, maxMs = 3000, signal?: AbortSignal): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (signal?.aborted) return;
    const c = app.camera.current;
    const t = app.camera.target;
    if (Math.abs(c.zoom - t.zoom) < 1e-3 * t.zoom && Math.abs(c.x - t.x) * t.zoom < 0.5 && Math.abs(c.y - t.y) * t.zoom < 0.5) return;
    if (Date.now() - t0 > maxMs) return;
    await sleep(50, signal);
  }
}

/** Where card `i` is drawn on screen right now, in CSS pixels (null when off-canvas). */
export function cardRect(app: PivotApp, i: number): SpotRect | null {
  return app.cardScreenRect(i);
}

/** The camera zoom that draws one card `px` device pixels wide. */
export function cardZoom(app: PivotApp, px: number): number {
  // The layout's card size, not card 0's slot (which is 0 when card 0 is masked out).
  const size = app.cardSize || app.renderer.to[2] || 1;
  return px / size;
}

// ----------------------------------------------------------------- steps

/**
 * Bind the narration to actions. Every action guards on the column it needs
 * existing in the loaded dataset, so schema drift degrades to a silent step
 * rather than a broken tour. Each step sets absolute state, so `back()`
 * re-running an earlier action is always safe. Every action receives the
 * step's abort signal and checks it before each host mutation, so Skip, Esc,
 * Back or Next mid-step stops the old action driving the app.
 */
export function buildSteps(host: TourHost): TourStep[] {
  const has = (col: string) => Boolean(host.app.dataset?.columns[col]);
  const tween = (ms: number) => host.tweenMs?.(ms) ?? ms;
  const live = (signal: AbortSignal) => !signal.aborted;
  const layoutBtn = (kind: string) => `#layoutSeg [data-layout="${kind}"]`;
  const facetRow = (field: string, label: string) =>
    () => host.el(`#facets input[data-field="${css(field)}"][data-label="${css(label)}"]`)?.closest('label') ?? host.el('#facets');
  const facetOn = (field: string, label: string) =>
    Boolean((host.el(`#facets input[data-field="${css(field)}"][data-label="${css(label)}"]`) as HTMLInputElement | null)?.checked);
  const tick = (field: string, label: string) => { if (has(field) && !facetOn(field, label)) host.toggleFacet(field, label); };
  const flyTo = async (i: number, px: number, ms: number, signal: AbortSignal) => {
    if (i < 0 || !live(signal)) return;
    const [x, y] = worldOf(host.app, i);
    const t = tween(ms);
    host.app.camera.focus(x, y, cardZoom(host.app, px), t);
    await sleep(t, signal);
    await settle(host.app, 3000, signal);
  };
  /**
   * The tour narrates one collection, so it loads it. The menu is not the
   * authority on what is on screen — a benchmark run swaps the collection
   * without touching the menu — so this asks the app itself, and reloads
   * whenever the answer is anything but the tour's own collection.
   */
  const ensureDataset = async (signal: AbortSignal) => {
    if (host.app.datasetKey !== TOUR_DATASET && live(signal)) await host.loadDataset(TOUR_DATASET);
  };
  /** Close the record modal if it is open: it makes `#app` inert. */
  const closeRecord = () => {
    host.el('#detail .close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };
  const toMap = async (signal: AbortSignal) => {
    if (!live(signal)) return;
    await host.setLayout('xy');
    if (has(COL.longitude) && live(signal)) await host.setSelect('axisX', COL.longitude);
    if (has(COL.latitude) && live(signal)) await host.setSelect('axisY', COL.latitude);
    if (live(signal)) host.app.fit();
  };

  const actions: Record<string, Pick<TourStep, 'target' | 'run' | 'minMs'>> = {
    welcome: {},
    map: {
      target: '#dataset',
      minMs: 1200,
      run: async (signal) => {
        // Nothing else may be driving the app while the tour narrates it.
        host.stopBenchmark?.();
        closeRecord();
        await ensureDataset(signal);
        if (!live(signal)) return;
        // The tour asserts a specific look; a returning viewer's saved "labels
        // off" would desynchronise it from the narration.
        host.resetCardSettings?.();
        host.clearFacets();
        if (has(COL.topic)) await host.setSelect('colorBy', COL.topic);
        await toMap(signal);
      },
    },
    colour: {
      target: '#colorBy',
      run: async () => { if (has(COL.channel)) await host.setSelect('colorBy', COL.channel); },
    },
    bars: {
      target: layoutBtn('bars'),
      run: async (signal) => {
        await host.setLayout('bars');
        if (has(COL.channel) && live(signal)) await host.setSelect('barBy', COL.channel);
      },
    },
    area: {
      target: '#barField',
      run: async (signal) => {
        await host.setLayout('bars');
        if (has(COL.areaType) && live(signal)) await host.setSelect('barBy', COL.areaType);
      },
    },
    crosstab: {
      target: layoutBtn('scatter'),
      run: async (signal) => {
        await host.setLayout('scatter');
        if (has(COL.ageBand) && live(signal)) await host.setSelect('axisX', COL.ageBand);
        if (has(COL.channel) && live(signal)) await host.setSelect('axisY', COL.channel);
      },
    },
    scatter: {
      // Two thousand cards at their raw (hours, satisfaction) coordinates pile
      // into five smeared bands — satisfaction is an integer 1-5 and the hours
      // are heavily skewed — so this is the same pair of columns as a cross-tab,
      // where every card stays a card. The axis menus are what changes between
      // this step and the last, so they are what the spotlight follows.
      target: '#xField',
      run: async (signal) => {
        await host.setLayout('scatter');
        if (has(COL.hours) && live(signal)) await host.setSelect('axisX', COL.hours);
        if (has(COL.satisfaction) && live(signal)) await host.setSelect('axisY', COL.satisfaction);
        if (live(signal)) host.app.fit();
      },
    },
    facet: {
      target: facetRow(COL.channel, VAL.post),
      // Off the resolution-hours cross-tab first. The next step filters down
      // to twelve *open* cases, and an open case has neither a resolution time
      // nor a satisfaction score — on those axes the board would go honestly,
      // uselessly blank. Bars by Channel is where "one in ten arrives by post"
      // was claimed three steps ago, so it is where the paper trail shows.
      run: async (signal) => {
        await host.setLayout('bars');
        if (has(COL.channel) && live(signal)) await host.setSelect('barBy', COL.channel);
        if (live(signal)) tick(COL.channel, VAL.post);
      },
    },
    facet2: {
      target: facetRow(COL.status, VAL.open),
      run: async (signal) => {
        tick(COL.channel, VAL.post);
        tick(COL.status, VAL.open);
        await sleep(tween(350), signal);
        if (live(signal)) tick(COL.priority, VAL.high);
      },
    },
    grid: {
      target: layoutBtn('grid'),
      run: async (signal) => {
        await host.setLayout('grid');
        if (has(COL.contacts) && live(signal)) {
          await host.setSelect('sortBy', COL.contacts);
          if (live(signal)) await host.setSelect('colorBy', COL.contacts);
        }
      },
    },
    zoom: {
      target: '#zoomSeg',
      run: async (signal) => {
        host.app.zoomStep(1);
        await sleep(tween(450), signal);
        if (live(signal)) host.app.zoomStep(1);
      },
    },
    record: {
      target: () => {
        const ds = host.app.dataset;
        return (ds && cardRect(host.app, featuredRow(ds, host.app.mask))) ?? host.el('#gl');
      },
      minMs: 1400,
      run: async (signal) => {
        const ds = host.app.dataset;
        if (!ds) return;
        const i = featuredRow(ds, host.app.mask);
        if (i < 0) return;
        // Fly to the card and leave it on screen: the narration is about what
        // the card itself says. Opening the record here would cover it — the
        // modal expands over the middle of the board — so that is the next
        // step's job.
        await flyTo(i, 200, 1000, signal);
        await settle(host.app, 3000, signal);
      },
    },
    detail: {
      target: () => visible(host, '#detail [data-action="review"]') ?? host.el('#detail'),
      run: async (signal) => {
        const ds = host.app.dataset;
        if (!ds || !live(signal)) return;
        const i = featuredRow(ds, host.app.mask);
        if (i < 0) return;
        host.select(i);
        // The modal expands out of the card (a FLIP transform). Measuring the
        // action link mid-flight spotlights a shrunken rectangle of empty
        // dialog, so wait for the expansion to land before the caption asks
        // where it is.
        await sleep(tween(FLIP_MS + 120), signal);
      },
    },
    clear: {
      // Not the clear link: the action removes it, so by the time the caption
      // is up the spotlight would fall back to the whole 900-pixel sidebar.
      // The Channel facet is where the counts visibly go back to full.
      target: () => host.el(`#facets .facet[data-field="${css(COL.channel)}"]`) ?? host.el('#facets'),
      minMs: 1200,
      // The record modal is still open from the previous step, and it makes
      // the whole app inert: spotlighting a control the viewer could not click
      // would be a lie. It reads better with the modal gone anyway.
      run: () => {
        closeRecord();
        host.clearFacets();
      },
    },
    fit: { target: '#fitBtn', run: async (signal) => { host.app.fit(); await settle(host.app, 3000, signal); } },
    finish: { target: '#tourBtn' },
  };

  return NARRATION.map((line) => ({ id: line.id, title: line.title, text: line.text, ...(actions[line.id] ?? {}) }));
}

function css(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
