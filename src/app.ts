import { CardRenderer } from './gl/renderer';
import { CameraController } from './gl/camera';
import { CardAtlas, type CardSpec } from './gl/atlas';
import { LayoutEngine } from './layout/client';
import type { LayoutSpec, Bounds, Axis, LayoutData } from './layout/layouts';
import { FrameStats } from './ui/hud';
import { categoricalColor, hexToRgb, sequential } from './core/palette';
import type { Dataset } from './data/columnar';
import { getNumeric, valueAt } from './data/columnar';
import { loadTitanic } from './data/titanic';
import { generateProducts } from './data/products';
import { loadPixels, PIXEL_IMAGES, type PixelImage } from './data/pixels';

/** Sentinel colour field: paint every card its own true colour. */
export const TRUE_COLOUR = '__truecolour__';

export interface FrameModel {
  items: number;
  visible: number;
  solveMs: number;
  uploadMs: number;
  gpu: string;
  gpuMs: number;
  dpr: number;
  buffer: [number, number];
  animating: boolean;
  idle: boolean;
}

/**
 * The application core, deliberately free of DOM chrome so the benchmark can
 * drive it headlessly and the UI is just another consumer.
 */
export class PivotApp {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: CardRenderer;
  readonly camera: CameraController;
  readonly engine = new LayoutEngine();
  readonly stats = new FrameStats(180);
  readonly frameHooks = new Set<(dtMs: number) => void>();

  dataset: Dataset | null = null;
  datasetName = '';
  spec: LayoutSpec = { type: 'grid' };
  bounds: Bounds = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  mask: Uint8Array | null = null;
  colorBy = '';
  visible = 0;
  lastSolveMs = 0;
  lastLayoutName = 'grid';
  /** Render every rAF instead of only when something changed. */
  alwaysRender = false;

  onLayout?: (x: Axis | undefined, y: Axis | undefined) => void;
  onDataset?: (ds: Dataset) => void;
  onFrame?: (stats: FrameStats, model: FrameModel) => void;
  onSelect?: (index: number) => void;

  private atlas: CardAtlas | null = null;
  private slotOf: Int32Array = new Int32Array(0);
  private uvTable: Array<[number, number, number, number]> = [];
  private dpr = 1;
  private lastTs = 0;
  private lastDraw = 0;
  private dirty = true;
  private solveSeq = 0;
  private running = false;
  private idle = false;
  private wasIdle = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new CardRenderer(canvas);
    this.camera = new CameraController(canvas);
    this.camera.onChange = () => { this.dirty = true; };
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('click', this.onClick);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTs = performance.now();
    requestAnimationFrame(this.loop);
  }

  resize() {
    // Never cap this. A buffer smaller than the CSS box is upscaled by the
    // compositor, and resampling a one-quad-per-pixel image produces a beat
    // pattern of dark lines that the GL buffer itself never contains.
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.dpr = dpr;
      this.dirty = true;
    }
  }

  get aspect() {
    return this.canvas.width / Math.max(1, this.canvas.height);
  }

  // ---------------------------------------------------------------- datasets

  async loadDataset(key: string): Promise<void> {
    const ds = await loadByKey(key);
    this.dataset = ds;
    this.datasetName = ds.name;
    this.mask = null;
    // A photograph has one honest colouring: its own pixels.
    this.colorBy = ds.rgb ? TRUE_COLOUR : (firstCategorical(ds) ?? ds.facets[0] ?? '');

    this.renderer.setCount(ds.n);
    // Big collections get a wave; small ones move as one body, which reads better.
    this.renderer.stagger = ds.n > 20_000 ? 0.35 : 0.18;
    this.renderer.transitionMs = ds.n > 200_000 ? 1100 : 850;
    // Rounded cards read as objects; pixels must tile, so square them off.
    this.renderer.cornerRadius = ds.cards === false ? 0.02 : 0.14;

    await this.engine.load(toLayoutData(ds));
    this.buildCards();
    this.onDataset?.(ds);
    await this.setLayout({ type: 'grid', sortBy: this.defaultSort() });
    this.fit(false);
  }

  defaultSort(): string | undefined {
    const ds = this.dataset;
    if (!ds) return undefined;
    // True colour has no category to group by, so order by lightness instead —
    // every bucket then reads as a gradient rather than as noise.
    if (this.colorBy === TRUE_COLOUR) {
      return ds.columns['L*'] ? 'L*' : ds.columns['Luminance'] ? 'Luminance' : ds.facets[0];
    }
    return this.colorBy || ds.facets[0];
  }

  defaultBucket(): string {
    const ds = this.dataset!;
    return firstCategorical(ds) ?? ds.facets[0];
  }

  defaultAxisY(): string {
    const ds = this.dataset!;
    const nums = ds.facets.filter((f) => ds.columns[f]?.kind === 'number');
    if (nums.length) return nums[0];
    const cats = ds.facets.filter((f) => ds.columns[f]?.kind === 'category');
    return cats[1] ?? cats[0] ?? ds.facets[0];
  }

  // ------------------------------------------------------------------- cards

  /**
   * Build the atlas. Under ~950 rows every card is unique; above that we draw one
   * card per category and tint per item — the difference is invisible until you
   * zoom into a single card, and it keeps the texture at a fixed 64MB.
   */
  buildCards() {
    const ds = this.dataset;
    if (!ds) return;
    if (ds.cards === false) {
      this.uvTable = [[0, 0, 0, 0]];
      this.slotOf = new Int32Array(ds.n);
      this.renderer.clearAtlas();
      this.applyColors();
      return;
    }
    const atlas = this.atlas ?? new CardAtlas(4096, 128, 4);
    this.atlas = atlas;
    atlas.reset();
    this.uvTable = [];
    this.slotOf = new Int32Array(ds.n);

    const colorCol = ds.columns[this.colorBy];
    const perItem = ds.n <= atlas.capacity;
    const fieldNames = ds.facets.filter((f) => f !== ds.labelColumn).slice(0, 3);

    if (perItem) {
      for (let i = 0; i < ds.n; i++) {
        const slot = atlas.add(this.cardSpec(ds, i, fieldNames));
        this.uvTable.push(slot ? slot.uv : [0, 0, 0, 0]);
        this.slotOf[i] = i;
      }
    } else {
      const templateField = colorCol?.kind === 'category' ? this.colorBy : this.defaultBucket();
      const tcol = ds.columns[templateField];
      const cats = tcol?.kind === 'category' ? tcol.categories : ['All'];
      for (let c = 0; c < cats.length; c++) {
        const slot = atlas.add({
          title: cats[c],
          subtitle: ds.name,
          accent: categoricalColor(c),
          fields: [[templateField, cats[c]]],
        });
        this.uvTable.push(slot ? slot.uv : [0, 0, 0, 0]);
      }
      if (tcol?.kind === 'category') {
        this.slotOf.set(tcol.codes.subarray(0, ds.n));
      }
    }

    this.applyColors();
    this.renderer.setAtlas(atlas.canvas);
  }

  private cardSpec(ds: Dataset, i: number, fieldNames: string[]): CardSpec {
    const colorCol = ds.columns[this.colorBy];
    const code = colorCol?.kind === 'category' ? colorCol.codes[i] : 0;
    return {
      title: valueAt(ds, ds.labelColumn, i) || `#${i}`,
      subtitle: this.colorBy ? valueAt(ds, this.colorBy, i) : undefined,
      accent: categoricalColor(code),
      fields: fieldNames.slice(0, 2).map((f) => [f, valueAt(ds, f, i)] as [string, string]),
      badge: fieldNames[2] ? valueAt(ds, fieldNames[2], i) : undefined,
    };
  }

  /** Per-item colour + uv + stagger delay. One pass, then a single buffer upload. */
  applyColors() {
    const ds = this.dataset;
    if (!ds) return;
    const col = ds.columns[this.colorBy];
    const r = this.renderer;
    const fallback: [number, number, number, number] = [0, 0, 0, 0];

    if (this.colorBy === TRUE_COLOUR && ds.rgb) {
      const rgb = ds.rgb;
      for (let i = 0; i < ds.n; i++) {
        const o = i * 3;
        r.setStyle(i, this.uvTable[this.slotOf[i]] ?? fallback, rgb[o], rgb[o + 1], rgb[o + 2], 255, stagger(i));
      }
    } else if (col?.kind === 'number') {
      const n = getNumeric(ds, this.colorBy);
      const span = n.max - n.min || 1;
      for (let i = 0; i < ds.n; i++) {
        const t = (n.values[i] - n.min) / span;
        const [cr, cg, cb] = hexToRgb(sequential(Number.isFinite(t) ? t : 0));
        r.setStyle(i, this.uvTable[this.slotOf[i]] ?? fallback, cr, cg, cb, 255, stagger(i));
      }
    } else if (col?.kind === 'category') {
      const cache = col.categories.map((_, c) => hexToRgb(categoricalColor(c)));
      for (let i = 0; i < ds.n; i++) {
        const c = cache[col.codes[i]] ?? [110, 110, 102];
        r.setStyle(i, this.uvTable[this.slotOf[i]] ?? fallback, c[0], c[1], c[2], 255, stagger(i));
      }
    } else {
      const [cr, cg, cb] = hexToRgb(categoricalColor(0));
      for (let i = 0; i < ds.n; i++) {
        r.setStyle(i, this.uvTable[this.slotOf[i]] ?? fallback, cr, cg, cb, 255, stagger(i));
      }
    }
    r.uploadStyle();
    this.dirty = true;
  }

  setColorBy(field: string) {
    this.colorBy = field;
    if (this.dataset?.cards === false) { this.applyColors(); return; }
    // The accent is painted into the card art, so a per-item atlas has to be
    // redrawn — the instance tint alone is invisible once the texture fades in.
    this.buildCards();
  }

  // ------------------------------------------------------------------ layout

  async setLayout(spec: LayoutSpec): Promise<void> {
    if (!this.dataset) return;
    this.spec = spec;
    const seq = ++this.solveSeq;
    const sol = await this.engine.solve(spec, this.mask, this.aspect);
    if (seq !== this.solveSeq) return; // a newer request won
    this.lastSolveMs = sol.solveMs;
    this.lastLayoutName = spec.type;
    // Only the raw scatter places cards at full pitch, and only an atlas-free
    // collection fills every cell — that is the one case where quads truly tile.
    this.renderer.edgeAA = spec.type === 'xy' && this.dataset?.cards === false ? 0 : 1;
    this.bounds = sol.bounds;
    this.visible = sol.visible;
    this.renderer.setTargets(sol.positions);
    this.onLayout?.(sol.xAxis, sol.yAxis);
    this.dirty = true;
  }

  async setMask(mask: Uint8Array | null) {
    this.mask = mask;
    await this.setLayout(this.spec);
  }

  fit(animate = true) {
    // Land the camera at the same moment the cards do.
    const raster = this.dataset?.cards === false && this.spec.type === 'xy';
    this.camera.fit(this.bounds, 72, animate, this.renderer.transitionMs,
      raster ? wholePixelZoom : undefined);
    this.dirty = true;
  }

  // ------------------------------------------------------------------- frame

  private onClick = (e: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const [wx, wy] = this.camera.screenToWorld(
      (e.clientX - rect.left) * this.dpr,
      (e.clientY - rect.top) * this.dpr,
    );
    const hit = this.renderer.pick(wx, wy);
    this.onSelect?.(hit);
    this.dirty = true;
  };

  private loop = (now: number) => {
    const dt = Math.min(1000, now - this.lastTs);
    this.lastTs = now;
    for (const hook of this.frameHooks) hook(dt);

    this.renderer.poll();
    const camMoving = this.camera.update(dt);
    const animating = this.renderer.advance(dt);
    const needed = camMoving || animating || this.dirty || this.alwaysRender;
    // Pace to the GPU: skip this tick if it has not caught up, so the frame
    // interval we measure is the frame time we actually get.
    const busy = this.renderer.gpuBusy();

    // Idle throttle: a still collection redraws at ~10Hz. Nothing changes on
    // screen, and the laptop stays cool.
    // Nothing changed means nothing to draw: with a preserved drawing buffer the
    // last frame simply stays on screen, at zero GPU cost and zero flicker risk.
    this.idle = !needed;
    if (needed && !busy) {
      this.dirty = false;
      // Only rendered frames count: recording every rAF tick would report 60fps
      // for a collection the GPU is nowhere near keeping up with.
      const interval = now - this.lastDraw;
      if (!this.idle && !this.wasIdle && interval < 2000) this.stats.push(interval);
      this.wasIdle = this.idle;
      this.lastDraw = now;
      this.renderer.render(this.camera.current, [0.055, 0.055, 0.051]);
    }

    this.onFrame?.(this.stats, {
      items: this.dataset?.n ?? 0,
      visible: this.visible,
      solveMs: this.lastSolveMs,
      uploadMs: this.renderer.lastUploadMs,
      gpu: this.renderer.gpuHint,
      gpuMs: this.renderer.gpuMs,
      dpr: this.dpr,
      buffer: [this.canvas.width, this.canvas.height],
      animating,
      idle: this.idle,
    });

    requestAnimationFrame(this.loop);
  };
}

async function loadByKey(key: string): Promise<Dataset> {
  if (key.startsWith('products:')) return generateProducts(Number(key.split(':')[1]));
  if (key.startsWith('pixels:')) {
    const [, image, size] = key.split(':');
    return loadPixels(image as PixelImage, size ? Number(size) : undefined);
  }
  return loadTitanic();
}

export { PIXEL_IMAGES };

/**
 * Nearest whole number of device pixels per cell, chosen in log space so 1.42
 * rounds to 2 rather than 1 — slight overflow the viewer can pan beats a picture
 * occupying half the window. Below 1:1 it steps 1/2, 1/3, … for the same reason:
 * a fractional scale makes each cell cover one device pixel or two, and that
 * alternation is what reads as a grid over the image.
 */
export function wholePixelZoom(z: number): number {
  if (z >= 1) {
    const lo = Math.max(1, Math.floor(z));
    const hi = lo + 1;
    return Math.log(z / lo) <= Math.log(hi / z) ? lo : hi;
  }
  const inv = 1 / z;
  const lo = Math.max(1, Math.floor(inv));
  const hi = lo + 1;
  return 1 / (Math.log(inv / lo) <= Math.log(hi / inv) ? lo : hi);
}

/** Deterministic, well-spread stagger delay in 0..1 (golden-ratio sequence). */
function stagger(i: number): number {
  return (i * 0.6180339887498949) % 1;
}

/** Prefer a field the categorical palette can actually distinguish: eight hues
 *  is the ceiling, past which everything folds to a single "other" grey. */
function firstCategorical(ds: Dataset): string | undefined {
  const cats = ds.facets.filter((f) => ds.columns[f]?.kind === 'category');
  const fits = cats.find((f) => {
    const col = ds.columns[f];
    return col?.kind === 'category' && col.categories.length >= 2 && col.categories.length <= 8;
  });
  return fits ?? cats[0];
}

/** The worker only needs the columns, and typed arrays clone cheaply — but a
 *  column's `format` closure is not structured-cloneable, so strip it. */
function toLayoutData(ds: Dataset): LayoutData {
  const columns: LayoutData['columns'] = {};
  for (const [name, col] of Object.entries(ds.columns)) {
    columns[name] = col.kind === 'number'
      ? { kind: 'number', name: col.name, values: col.values, min: col.min, max: col.max }
      : col;
  }
  return { n: ds.n, columns };
}
