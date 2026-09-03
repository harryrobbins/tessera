import { CardRenderer } from './gl/renderer';
import { CameraController } from './gl/camera';
import { wholePixelZoom, stepWholePixelZoom, stepFreeZoom } from './gl/zoom';
import { BG, CardAtlas, slotFor, hiResCapacity, slotRect, type CardSpec } from './gl/atlas';
import { cardPainterFor, type CardPainterOptions } from './gl/cards';
import { visibleCards, onScreenCards, planTier, planReady, hiResTextureSize, hiResKey, hiResWorthwhile, tierBeatsBase, rasterBudgetLeft, UNIQUE_MIN_PX } from './gl/hires';
import { LayoutEngine, type LayoutSolution } from './layout/client';
import { CARD_PITCH, CARD_SIZE, type LayoutSpec, type Bounds, type Axis, type LayoutData } from './layout/layouts';
import { FrameStats } from './ui/hud';
import { categoricalColor, fieldColors, hexToRgb, sequential, SEQUENTIAL_BLUE } from './core/palette';
import type { Dataset } from './data/columnar';
import { getNumeric, valueAt } from './data/columnar';
import { resolveDataset } from './data/registry';

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
  /** Device pixels per cell, for raster views only. */
  scale: number | null;
  animating: boolean;
  idle: boolean;
  /** Base atlas slot in texels, or null for atlas-free collections. */
  atlasSlot: number | null;
  /** The hi-res atlas when it is holding magnified cards. */
  hiRes: { tier: number; cards: number } | null;
  /** Where the art on screen comes from: no texture at all, the base atlas
   *  (the row's own card for a per-item collection, its group's cover
   *  otherwise), or a slot rasterised for that one row. */
  cardTier: 'dot' | 'base' | 'unique';
  /** True while the base atlas holds one card per row rather than one cover
   *  per category. */
  perItem: boolean;
}

const ATLAS_PAD = 4;
/** `renderer.pick` is O(n): past this a pointer move costs more than the
 *  answer is worth, and the cards are dots anyway (§6.1). A grid index over
 *  `renderer.to` would lift this — noted, not built. */
const HOVER_LIMIT = 200_000;
/** Above this many style rows, one orphaned upload of the whole buffer beats
 *  a sub-range upload each (`uploadStyleAt` is 16 bytes and a GL call). */
const STYLE_BULK = 256;
/**
 * Largest slot a *group cover* is painted at. `slotFor` would give a handful
 * of covers 1024 px each, and eight of those is a 3096 px atlas; a cover is
 * only ever on screen while the cards are too small for their own art, since
 * anything bigger gets a hi-res raster of the row instead. The one path that
 * can magnify a cover past this is a viewport holding more cards than the
 * hi-res atlas has slots for, which needs 3,136 cards of 512 device px each —
 * a 205 megapixel display.
 */
const COVER_SLOT = 512;
/** The numeric ramp as RGB, parsed once rather than once per row. */
const SEQUENTIAL_RGB = SEQUENTIAL_BLUE.map(hexToRgb);
/** `prefers-reduced-motion`: card flights and camera fits land immediately. */
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  /** The registry key the loaded collection came from — what the menu, a deep
   *  link and the tour all name it by. `datasetName` is the human label and is
   *  not unique across sizes; anything asking "is *this* collection loaded?"
   *  must ask this. */
  datasetKey = '';
  spec: LayoutSpec = { type: 'grid' };
  bounds: Bounds = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  mask: Uint8Array | null = null;
  colorBy = '';
  visible = 0;
  lastSolveMs = 0;
  lastLayoutName = 'grid';
  /** World units per cell in the current layout (from the last solve). */
  pitch = CARD_PITCH;
  /** World units a card is drawn at in the current layout (from the last
   *  solve). Card 0's own slot is not a proxy: a mask can zero it. */
  cardSize = CARD_SIZE;
  /** Render every rAF instead of only when something changed. */
  alwaysRender = false;

  onLayout?: (x: Axis | undefined, y: Axis | undefined) => void;
  onDataset?: (ds: Dataset) => void;
  onFrame?: (stats: FrameStats, model: FrameModel) => void;
  onSelect?: (index: number) => void;
  /** The card under the pointer (or -1), and whether its art is big enough to
   *  read. The UI uses it for the cursor chip; the ring is drawn here. */
  onHover?: (index: number, readable: boolean) => void;
  /** The keyboard-focused card, for the live region that stands in for the
   *  canvas's own inaccessibility. */
  onFocusCard?: (index: number) => void;

  private atlas: CardAtlas | null = null;
  /** Card art for index i — always that row's own record, whatever the base
   *  atlas is holding; null without an atlas. */
  private specOf: ((i: number) => CardSpec) | null = null;
  /** True while the base atlas holds one card per row (n small enough that
   *  every row fits at the smallest slot), false when it holds group covers. */
  perItem = false;
  /** The Card settings' overrides on top of the dataset's own declaration.
   *  Assign through `setCardOptions` so the atlas is repainted. */
  cardOptions: CardPainterOptions = {};
  /** false = no atlas at all: flat tinted quads at every zoom. At 100,000
   *  cards the mosaic reads better as pure colour, and it is the cheapest path
   *  on a weak GPU. */
  cardLabels = true;
  /**
   * Hi-res atlas bookkeeping at one tier per settle. `slots` is what has been
   * *rasterised*; `shown` is what has been flipped over to it. They differ
   * while a plan is filling: art is committed only once the whole viewport has
   * it, so the board never shows a record beside a cover (§1.6).
   */
  private hi = { tier: 0, slots: new Map<number, number>(), shown: new Set<number>(), free: [] as number[], cols: 0 };
  private hiScratch: HTMLCanvasElement | null = null;
  private hiKey = '';
  /**
   * The viewport scan behind the plan now filling, kept across ticks. The scan
   * is O(n) and a budgeted fill takes tens of ticks; re-running it every one of
   * them would put the cost it saves straight back. `key` is what it was
   * scanned for, so it is dropped the moment the camera or the solve moves.
   */
  private hiPlan: { key: string; near: number[]; inView: number[]; capacity: number; wanted: number[]; wantedSet: Set<number>; fresh: boolean } | null = null;
  /** Camera as of the previous tick: a scripted camera that writes `current`
   *  directly never reports as moving, so settle is judged by stillness too. */
  private hiLastCam = { x: NaN, y: NaN, zoom: NaN };
  /** `?hires=0` disables the hi-res pass (the sharpness check's baseline). */
  hiResEnabled = typeof location === 'undefined' || new URLSearchParams(location.search).get('hires') !== '0';
  /** `?glow=0` keeps map cards as plain dots (the night-lights brightness baseline). */
  glowEnabled = typeof location === 'undefined' || new URLSearchParams(location.search).get('glow') !== '0';
  /** The last frame's readout, for scripted verification. */
  lastFrame: FrameModel | null = null;
  /** Card under the pointer, and the keyboard-focused card. Both draw the
   *  quieter of the two rings; the selection keeps the loud one. */
  private hovered = -1;
  private focused = -1;
  private pointer: { x: number; y: number } | null = null;
  private hoverDirty = false;
  private slotOf: Int32Array = new Int32Array(0);
  private uvTable: Array<[number, number, number, number]> = [];
  private dpr = 1;
  private lastTs = 0;
  private lastDraw = 0;
  private dirty = true;
  private solveSeq = 0;
  private loadSeq = 0;
  private resizeObserver: ResizeObserver | null = null;
  private dprQuery: MediaQueryList | null = null;
  private running = false;
  private idle = false;
  private wasIdle = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new CardRenderer(canvas);
    this.camera = new CameraController(canvas);
    this.camera.onChange = () => { this.dirty = true; };
    // After a context loss both atlases come back empty: repaint the cards.
    this.renderer.onContextRestored = () => { this.buildCards(); this.dirty = true; };
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    // A content-box observer is silent when only devicePixelRatio changes
    // (window dragged to another monitor, browser zoom); the device-pixel box
    // fires for that too where supported, and a resolution media query covers
    // the rest.
    try {
      this.resizeObserver.observe(canvas, { box: 'device-pixel-content-box' });
    } catch {
      this.resizeObserver.observe(canvas);
    }
    this.watchDpr();
    canvas.addEventListener('click', this.onClick);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('keydown', this.onKeyDown);
  }

  /** Re-armed after every DPR change: the query only matches the current ratio. */
  private watchDpr() {
    if (typeof matchMedia !== 'function') return;
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  private onDprChange = () => {
    this.resize();
    this.watchDpr();
  };

  /** Stop the frame loop and release every listener and subsystem. */
  dispose() {
    this.running = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = null;
    this.canvas.removeEventListener('click', this.onClick);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('keydown', this.onKeyDown);
    this.camera.dispose();
    this.renderer.dispose();
    this.engine.dispose();
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

  /**
   * Load a collection and solve its opening layout. Only the newest call wins:
   * a slow load (pixels: fetch + decode) that finishes after a quicker later
   * one is dropped, so the renderer never shows a collection the menu does not.
   * `initial` is the first layout; by default the one the collection opens on
   * (map for geo data, picture for pixels, sorted grid otherwise), so the
   * opening layout is solved once rather than grid-then-something-else.
   */
  async loadDataset(key: string, initial?: LayoutSpec): Promise<void> {
    const seq = ++this.loadSeq;
    const ds = await resolveDataset(key);
    if (seq !== this.loadSeq) return; // superseded while loading
    this.dataset = ds;
    this.datasetName = ds.name;
    this.datasetKey = key;
    this.mask = null;
    // A pixel has one honest colouring: itself. A *record* that happens to
    // carry a colour does not — a bird's mean plumage colour is a mode worth
    // offering, but opening on it would throw away the facets that make it a
    // collection, and leave every card's painted accent stuck on one hue.
    // So true colour leads only where the rows are not records: `cards: false`.
    this.colorBy = ds.rgb && ds.cards === false ? TRUE_COLOUR : (firstCategorical(ds) ?? ds.facets[0] ?? '');

    // The old atlas and card art stay on screen until the new layout lands,
    // but nothing may rasterise them against the new dataset: the hi-res pass
    // bails while `specOf` is null, and the instance count is only grown once
    // the new cards are about to be painted (below).
    this.specOf = null;
    this.clearHiRes();
    this.renderer.releaseHi();
    // Big collections get a wave; small ones move as one body, which reads better.
    this.renderer.stagger = ds.n > 20_000 ? 0.35 : 0.18;
    this.renderer.transitionMs = REDUCED_MOTION ? 0 : ds.n > 200_000 ? 1100 : 850;
    // Rounded cards read as objects; pixels must tile, so square them off.
    this.renderer.cornerRadius = ds.cards === false ? 0.02 : 0.14;

    await this.engine.load(toLayoutData(ds));
    if (seq !== this.loadSeq) return;
    this.renderer.setCount(ds.n);
    this.buildCards();
    this.onDataset?.(ds);
    await this.setLayout(initial ?? this.defaultLayout());
    if (seq !== this.loadSeq) return;
    this.fit(false);
  }

  /** The layout a collection opens on. */
  defaultLayout(): LayoutSpec {
    const ds = this.dataset;
    if (!ds) return { type: 'grid' };
    const geo = ds.geo;
    if (geo && ds.columns[geo.lon]?.kind === 'number' && ds.columns[geo.lat]?.kind === 'number') {
      return { type: 'xy', x: geo.lon, y: geo.lat, equal: true };
    }
    if (ds.rgb && ds.columns['X']?.kind === 'number' && ds.columns['Y']?.kind === 'number') {
      return { type: 'xy', x: 'X', y: 'Y' };
    }
    return { type: 'grid', sortBy: this.defaultSort() };
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
   * Build the base atlas. Up to ~3,100 rows it holds every row's own card;
   * above that it holds one *cover* per category — a label, not a record, so
   * nothing on it can be mistaken for a row's data. Either way the slot is
   * sized to the count, so a handful of covers are drawn at 1024 px, not 128.
   *
   * Uniqueness above the cap comes from the hi-res atlas instead: `specOf` is
   * always the row, so `updateHiRes` rasterises real records as soon as a card
   * is big enough for one to read (`UNIQUE_MIN_PX`).
   */
  buildCards() {
    const ds = this.dataset;
    if (!ds) return;
    this.clearHiRes();
    if (ds.cards === false || !this.cardLabels) {
      this.uvTable = [[0, 0, 0, 0]];
      this.slotOf = new Int32Array(ds.n);
      this.specOf = null;
      this.renderer.clearAtlas();
      this.applyColors();
      return;
    }
    this.uvTable = [];
    this.slotOf = new Int32Array(ds.n);

    const colorCol = ds.columns[this.colorBy];
    // Per-item is decided at the smallest slot; the slot is then sized to
    // whatever the atlas actually has to hold, so small collections and the
    // handful of covers get the sharpest art the texture allows.
    const atlasSize = this.renderer.atlasSize;
    const perItem = ds.n <= hiResCapacity(atlasSize, 64, ATLAS_PAD);
    this.perItem = perItem;
    const coverField = colorCol?.kind === 'category' ? this.colorBy : this.defaultBucket();
    const ccol = ds.columns[coverField];
    const cats = ccol?.kind === 'category' ? ccol.categories : ['All'];
    const wantSlots = perItem ? ds.n : cats.length;
    const slot = slotFor(wantSlots, atlasSize, ATLAS_PAD, 64, perItem ? 1024 : COVER_SLOT);
    if (!this.atlas || this.atlas.slot !== slot || this.atlas.size !== atlasSize || this.atlas.slots !== wantSlots) {
      this.atlas = new CardAtlas(atlasSize, slot, ATLAS_PAD, wantSlots);
    }
    const atlas = this.atlas;
    atlas.reset();
    // The accent is painted into the card, so the painter has to know what the
    // colour means; a colour change rebuilds it along with the atlas.
    atlas.painter = cardPainterFor(ds, { colorBy: this.colorBy, ...this.cardOptions });

    if (perItem) {
      for (let i = 0; i < ds.n; i++) {
        const s = atlas.add(this.cardSpec(ds, i));
        this.uvTable.push(s ? s.uv : [0, 0, 0, 0]);
        this.slotOf[i] = i;
      }
    } else {
      const swatches = fieldColors(ds, coverField);
      for (let c = 0; c < cats.length; c++) {
        const accent = swatches[c] ?? categoricalColor(c);
        const s = atlas.add({ title: cats[c], accent, cover: { label: cats[c], accent } });
        this.uvTable.push(s ? s.uv : [0, 0, 0, 0]);
      }
      if (ccol?.kind === 'category') {
        this.slotOf.set(ccol.codes.subarray(0, ds.n));
      }
    }
    // Never a template: the hi-res pass draws this row, whatever the base
    // atlas is holding for it.
    this.specOf = (i) => this.cardSpec(ds, i);

    this.applyColors();
    this.renderer.setAtlas(atlas.canvas);
  }

  private cardSpec(ds: Dataset, i: number): CardSpec {
    const colorCol = ds.columns[this.colorBy];
    const code = colorCol?.kind === 'category' ? colorCol.codes[i] : 0;
    // The painted accent must agree with the instance tint (applyColors):
    // the blue ramp for a numeric colour-by, the category swatch otherwise.
    let accent = this.colorTable(ds)[code] ?? categoricalColor(code);
    if (colorCol?.kind === 'number') {
      const t = (colorCol.values[i] - colorCol.min) / (colorCol.max - colorCol.min || 1);
      accent = sequential(Number.isFinite(t) ? t : 0);
    }
    // Everything else on the face comes from the dataset's own card template,
    // compiled once by the painter (`compileCard`); the row index is all it
    // needs. `title` is only the fallback for a dataset that declares nothing.
    return { title: valueAt(ds, ds.labelColumn, i) || `#${i}`, accent, row: i };
  }

  /** Colour per category code of the colour field, memoised per dataset+field
   *  (cardSpec is called per row). Pins > colour-name auto-detect > palette. */
  private colorTableKey = '';
  private colorTableCache: string[] = [];
  private colorTable(ds: Dataset): string[] {
    const key = `${ds.name}\u0000${this.colorBy}`;
    if (key !== this.colorTableKey) {
      this.colorTableKey = key;
      this.colorTableCache = fieldColors(ds, this.colorBy);
    }
    return this.colorTableCache;
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
      const last = SEQUENTIAL_RGB.length - 1;
      for (let i = 0; i < ds.n; i++) {
        const t = (n.values[i] - n.min) / span;
        // Same rounding as sequential(), without the hex round-trip per row.
        const k = Number.isFinite(t) ? Math.max(0, Math.min(last, Math.round(t * last))) : 0;
        const [cr, cg, cb] = SEQUENTIAL_RGB[k];
        r.setStyle(i, this.uvTable[this.slotOf[i]] ?? fallback, cr, cg, cb, 255, stagger(i));
      }
    } else if (col?.kind === 'category') {
      const cache = fieldColors(ds, this.colorBy).map(hexToRgb);
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

  /** Apply new card settings: the painter, and therefore the whole atlas, is
   *  rebuilt. Sub-40 ms at 3,000 rows, and it never re-solves the layout. */
  setCardOptions(opts: CardPainterOptions, labels = true) {
    this.cardOptions = opts;
    this.cardLabels = labels;
    this.buildCards();
  }

  setColorBy(field: string) {
    this.colorBy = field;
    if (this.dataset?.cards === false) { this.applyColors(); return; }
    // The accent is painted into the card art, so a per-item atlas has to be
    // redrawn — the instance tint alone is invisible once the texture fades in.
    this.buildCards();
  }

  // ------------------------------------------------------------------ hi-res

  /** Forget every hi-res slot. Style bytes are rewritten by the caller
   *  (applyColors) or reverted here when the instance buffer is kept. */
  private clearHiRes(revert = false) {
    if (revert && this.hi.shown.size) {
      const bulk = this.hi.shown.size > STYLE_BULK;
      for (const card of this.hi.shown) this.revertCard(card, !bulk);
      if (bulk) this.renderer.uploadStyle();
    }
    this.hi = { tier: 0, slots: new Map(), shown: new Set(), free: [], cols: 0 };
    this.hiKey = '';
    this.hiPlan = null;
    this.renderer.hasHiRes = false;
  }

  /** Point a card back at its base-atlas art. The caller batches the upload
   *  when it is reverting more cards than a whole-buffer write costs. */
  private revertCard(card: number, upload = true) {
    const r = this.renderer;
    r.setUv(card, this.uvTable[this.slotOf[card]] ?? [0, 0, 0, 0]);
    r.setHi(card, false);
    if (upload) r.uploadStyleAt(card);
  }

  /**
   * Once the camera and the cards have settled, re-rasterise everything in
   * view at one tier into the hi-res atlas and point those instances at it.
   * Still one draw call: the fragment shader mixes the two samplers per
   * instance.
   *
   * Three rules. The tier is fitted to the *viewport's* capacity (`planTier`),
   * not just to the card size, so the atlas can hold every visible card at it;
   * the flip is committed only once every visible card has its art, so a
   * half-filled plan is never on screen; and nothing runs at all while the base
   * atlas already holds this row's card at this size or better
   * (`hiResWorthwhile`, `tierBeatsBase`). The first two make the board uniform
   * rather than merely sharp, and matter most zoomed right in on a large
   * display, where nine cards used to be crisp and the rest smears. The third
   * is where the GPU baseline's 92 ms frame went: at the fitted view a 900-row
   * collection draws 67 device px cards from a 128 px slot, and every one of
   * them was being painted again for the same texels.
   */
  private updateHiRes(camMoving: boolean, animating: boolean) {
    const ds = this.dataset;
    const atlas = this.atlas;
    const r = this.renderer;
    if (!this.hiResEnabled || !ds || ds.cards === false || !this.cardLabels || !atlas || !this.specOf || r.count === 0) return;
    const cam = this.camera.current;
    const still = cam.x === this.hiLastCam.x && cam.y === this.hiLastCam.y && cam.zoom === this.hiLastCam.zoom;
    this.hiLastCam.x = cam.x; this.hiLastCam.y = cam.y; this.hiLastCam.zoom = cam.zoom;
    if (camMoving || animating || !still) return;

    // Nothing moved since the last completed plan: skip the scan, which is
    // O(n) and would otherwise run every idle tick. The solve sequence is part
    // of the key, so a re-sort, layout change or filter under a still camera
    // re-plans (H-01) — cards now in view get their art and the slots of cards
    // that moved away are revoked.
    const key = hiResKey(cam, this.canvas.width, this.canvas.height, this.solveSeq);
    if (key === this.hiKey) return;

    const cardPx = this.cardSize * cam.zoom;
    // Cheap tests first: below UNIQUE_MIN_PX no card is big enough to be worth
    // its own raster, and on a per-item atlas nothing is worth re-rasterising
    // until the card outgrows the slot its art is already painted at. The scan
    // below is the expensive part of this function.
    if (!(cardPx >= UNIQUE_MIN_PX) || !hiResWorthwhile(cardPx, this.perItem, atlas.slot)) {
      if (this.hi.slots.size) { this.clearHiRes(true); this.dirty = true; }
      this.hiKey = key;
      return;
    }

    const size = hiResTextureSize(this.canvas.width, this.canvas.height, r.maxTextureSize);
    // One scan, two sets: the cards on screen, which the tier has to cover,
    // and the ring just outside them, which is rasterised afterwards so a
    // small pan does not start from nothing. Both are settled by `key`, so the
    // scan happens once per plan however many ticks the fill takes.
    let plan = this.hiPlan;
    if (!plan || plan.key !== key) {
      const near = visibleCards(r.to, r.count, cam, this.canvas.width, this.canvas.height, 0.25);
      plan = {
        key,
        near,
        inView: onScreenCards(near, r.to, cam, this.canvas.width, this.canvas.height),
        capacity: -1,
        wanted: [],
        wantedSet: new Set(),
        fresh: true,
      };
    } else {
      plan.fresh = false;
    }
    const { near, inView } = plan;
    const tier = planTier(cardPx, inView.length, size, ATLAS_PAD);
    if (tier === null || !tierBeatsBase(tier, this.perItem, atlas.slot)) {
      if (this.hi.slots.size) { this.clearHiRes(true); this.dirty = true; }
      this.hiKey = key;
      return;
    }

    const realloc = r.ensureHi(size);
    if (realloc || tier !== this.hi.tier) {
      this.clearHiRes(true);
      const cols = Math.floor(size / (tier + ATLAS_PAD * 2));
      this.hi.tier = tier;
      this.hi.cols = cols;
      for (let i = cols * cols - 1; i >= 0; i--) this.hi.free.push(i);
    }
    this.hiPlan = plan;
    const hi = this.hi;
    const capacity = hi.cols * hi.cols;
    // On screen first, then the pre-load ring, up to what the atlas holds.
    if (plan.capacity !== capacity) {
      plan.capacity = capacity;
      plan.wanted = inView.slice(0, capacity);
      plan.wantedSet = new Set(plan.wanted);
      for (const card of near) {
        if (plan.wanted.length >= capacity) break;
        if (plan.wantedSet.has(card)) continue;
        plan.wanted.push(card);
        plan.wantedSet.add(card);
      }
      plan.fresh = true;
    }
    const { wanted, wantedSet } = plan;
    // Cards whose style bytes this tick changed, uploaded together at the end.
    const touched: number[] = [];

    // Only a new plan can have orphaned a slot; on the ticks that merely
    // continue filling one there is nothing here to find.
    if (plan.fresh) {
      for (const [card, slot] of hi.slots) {
        if (wantedSet.has(card)) continue;
        if (hi.shown.delete(card)) { this.revertCard(card, false); touched.push(card); }
        hi.slots.delete(card);
        hi.free.push(slot);
      }
    }

    // Rasterise to a wall-clock budget, carrying the remainder to the next
    // tick rather than hitching now.
    const t0 = performance.now();
    let rastered = 0;
    for (const card of wanted) {
      if (hi.slots.has(card)) continue;
      if (hi.free.length === 0 || !rasterBudgetLeft(rastered, performance.now() - t0)) break;
      const slot = hi.free.pop()!;
      const rect = slotRect(slot, size, tier, ATLAS_PAD, hi.cols);
      r.setHiSlot(rect.x - ATLAS_PAD, rect.y - ATLAS_PAD, this.rasterise(this.specOf(card), tier));
      hi.slots.set(card, slot);
      rastered++;
    }

    // Commit: every card *on screen* has art, so flip together — including
    // any of the pre-load ring that is ready, which costs nothing to show.
    if (planReady(inView, hi.slots)) {
      for (const card of wanted) {
        if (hi.shown.has(card)) continue;
        const slot = hi.slots.get(card);
        if (slot === undefined) continue;
        r.setUv(card, slotRect(slot, size, tier, ATLAS_PAD, hi.cols).uv);
        r.setHi(card, true);
        hi.shown.add(card);
        touched.push(card);
      }
    }
    // Stop scanning only once the ring is done too, so it fills across ticks.
    if (planReady(wanted, hi.slots)) this.hiKey = key;

    // The mip chain covers the whole texture, so rebuilding it per raster tick
    // would hand back what the budget just saved. Slots that have not been
    // flipped yet are sampled by nothing, so the only moment mips have to be
    // current is the one where art becomes visible.
    if (touched.length) {
      r.hasHiRes = hi.shown.size > 0;
      r.finishHi();
      if (touched.length > STYLE_BULK) r.uploadStyle();
      else for (const card of touched) r.uploadStyleAt(card);
      this.dirty = true;
    }
  }

  /** Draw one card, with its bleed, at `tier` px into the scratch canvas. */
  private rasterise(spec: CardSpec, tier: number): HTMLCanvasElement {
    const side = tier + ATLAS_PAD * 2;
    const c = this.hiScratch ?? (this.hiScratch = document.createElement('canvas'));
    if (c.width !== side || c.height !== side) { c.width = side; c.height = side; }
    const ctx = c.getContext('2d')!;
    ctx.save();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, side, side);
    ctx.translate(ATLAS_PAD, ATLAS_PAD);
    (this.atlas?.painter ?? cardPainterFor(this.dataset!, { colorBy: this.colorBy, ...this.cardOptions }))(ctx, tier, tier, spec);
    ctx.restore();
    return c;
  }

  // ------------------------------------------------------------------ layout

  /** Solve and apply a layout. Resolves to the solution, or null when a newer
   *  request superseded this one (so a caller never credits a stale solve). */
  async setLayout(spec: LayoutSpec): Promise<LayoutSolution | null> {
    if (!this.dataset) return null;
    this.spec = spec;
    const seq = ++this.solveSeq;
    const sol = await this.engine.solve(spec, this.mask, this.aspect);
    if (seq !== this.solveSeq) return null; // a newer request won
    this.lastSolveMs = sol.solveMs;
    this.lastLayoutName = spec.type;
    // Only the raw scatter places cards at full pitch, and only an atlas-free
    // collection fills every cell — that is the one case where quads truly tile.
    this.renderer.edgeAA = spec.type === 'xy' && this.dataset?.cards === false ? 0 : 1;
    // On the map a card stays a point of light until it is a town's-worth
    // zoomed in (14 px), then turns into its card; elsewhere art fades in at 3-9 px.
    const map = this.isMapView;
    this.renderer.lod = map ? [14, 32] : [3, 9];
    this.renderer.glow = map && this.glowEnabled ? 1 : 0;
    this.bounds = sol.bounds;
    this.visible = sol.visible;
    this.pitch = sol.pitch;
    this.cardSize = sol.cardSize;
    this.renderer.setTargets(sol.positions);
    // Cards moved: the hi-res plan is stale even if the camera is not.
    this.hiKey = '';
    this.onLayout?.(sol.xAxis, sol.yAxis);
    this.dirty = true;
    return sol;
  }

  async setMask(mask: Uint8Array | null) {
    const prev = this.bounds;
    this.mask = mask;
    if (!(await this.setLayout(this.spec))) return; // a newer solve owns the refit
    // A filter re-solves the layout, and every layout is sized by what it has
    // to place: 3,000 cards make a board sixteen times wider than 12 do. The
    // camera stays where it was, so a mask change can strand it in either
    // direction: narrowing can leave the viewport on empty space ("my filter
    // deleted the data"), and broadening can bury it inside a board that grew
    // far past the frame ("removing my filter did nothing"). Reframe in those
    // two cases only — panning and zooming a filtered board the viewer can
    // still see is theirs to do.
    if (this.layoutOffView() || this.layoutOutgrewView(prev)) this.fit();
  }

  /** How small the whole layout may get on screen before a filter has, in
   *  effect, emptied the viewport: 15 % of it in *both* axes. */
  private static readonly SPECK = 0.15;

  /** True when the layout, as solved, is off screen or too small to read. */
  private layoutOffView(): boolean {
    const b = this.bounds;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (!(w > 0) || !(h > 0)) return false; // nothing to frame; fit() would bail anyway
    const cam = this.camera.target;
    const halfW = this.canvas.width / 2 / cam.zoom;
    const halfH = this.canvas.height / 2 / cam.zoom;
    if (b.maxX < cam.x - halfW || b.minX > cam.x + halfW) return true;
    if (b.maxY < cam.y - halfH || b.minY > cam.y + halfH) return true;
    return w / (halfW * 2) < PivotApp.SPECK && h / (halfH * 2) < PivotApp.SPECK;
  }

  /** The mirror of layoutOffView, for a mask change that *grew* the board:
   *  true when the viewport is left framing under SPECK of it in both axes.
   *  Gated on actual growth so the map and the raw scatter — whose bounds are
   *  a function of the columns, never the mask — keep their promise that a
   *  filter tick does not move the camera. */
  private layoutOutgrewView(prev: Bounds): boolean {
    const b = this.bounds;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (!(w > 0) || !(h > 0)) return false;
    const grew = w > prev.maxX - prev.minX + 1e-6 || h > prev.maxY - prev.minY + 1e-6;
    if (!grew) return false;
    const cam = this.camera.target;
    const viewW = this.canvas.width / cam.zoom;
    const viewH = this.canvas.height / cam.zoom;
    return viewW / w < PivotApp.SPECK && viewH / h < PivotApp.SPECK;
  }

  /** True for an equal-aspect longitude x latitude scatter — the night-lights map. */
  get isMapView(): boolean {
    return this.spec.type === 'xy' && !!this.spec.equal;
  }

  /** True when cards tile one-per-cell and the scale must stay a whole number. */
  get isRasterView(): boolean {
    return this.dataset?.cards === false && this.spec.type === 'xy';
  }

  /** Where the art on screen comes from. Below the LOD floor the fragment
   *  shader samples no texture at all, so the card is its tint and nothing
   *  more; above it the board shows base-atlas art until a hi-res plan is
   *  committed, at which point every card in view is its own record. */
  get cardTier(): 'dot' | 'base' | 'unique' {
    const px = this.cardSize * this.camera.current.zoom;
    if (px < this.renderer.lod[0]) return 'dot';
    return this.hi.shown.size > 0 ? 'unique' : 'base';
  }

  /** Device pixels per cell, for the readout: the layout's pitch, not a
   *  card's size (item 0 may be masked out, size 0). */
  get scale(): number {
    return this.camera.current.zoom * this.pitch;
  }

  /** One step along the ladder the current collection needs. Lands at once
   *  under reduced motion, like every other camera move (M-05). */
  zoomStep(dir: 1 | -1, ms = 260) {
    const z = this.camera.target.zoom;
    this.camera.zoomTo(this.isRasterView ? stepWholePixelZoom(z, dir) : stepFreeZoom(z, dir),
      this.renderer.transitionMs === 0 ? 0 : ms);
    this.dirty = true;
  }

  /**
   * Where card `i` is drawn on screen right now, in CSS pixels relative to the
   * viewport, or null when it is off-canvas. The modal's FLIP origin and the
   * tour's spotlight are the same question, so they ask it in one place.
   * Clamped to 24 px: a one-pixel card (a pixel collection, a board zoomed
   * right out) still has to give an animation somewhere to start from.
   */
  cardScreenRect(i: number): { left: number; top: number; width: number; height: number } | null {
    if (i < 0 || i >= this.renderer.count) return null;
    const canvas = this.canvas;
    const cam = this.camera.current;
    const box = canvas.getBoundingClientRect();
    const dpr = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
    const [wx, wy, size] = this.renderer.positionOf(i);
    const px = (canvas.width / 2 + (wx - cam.x) * cam.zoom) / dpr;
    const py = (canvas.height / 2 - (wy - cam.y) * cam.zoom) / dpr;
    const s = Math.max(24, (size * cam.zoom) / dpr);
    const rect = { left: box.left + px - s / 2, top: box.top + py - s / 2, width: s, height: s };
    const onScreen = rect.left + rect.width > box.left && rect.left < box.right
      && rect.top + rect.height > box.top && rect.top < box.bottom;
    return onScreen ? rect : null;
  }

  fit(animate = true) {
    // Every row filtered out: nothing to frame, keep the camera where it is.
    if (this.visible === 0) return;
    // Land the camera at the same moment the cards do.
    this.camera.fit(this.bounds, 72, animate, this.renderer.transitionMs,
      this.isRasterView ? wholePixelZoom : undefined);
    this.dirty = true;
  }

  // ------------------------------------------------------------------- frame

  private onClick = (e: MouseEvent) => {
    // A click also fires at the end of a pointer-captured pan; selecting
    // whatever the drag ended over (and flying to it) is never what was meant.
    if (this.camera.wasDrag) return;
    const rect = this.canvas.getBoundingClientRect();
    const [wx, wy] = this.camera.screenToWorld(
      (e.clientX - rect.left) * this.dpr,
      (e.clientY - rect.top) * this.dpr,
    );
    const hit = this.renderer.pick(wx, wy);
    this.onSelect?.(hit);
    this.dirty = true;
  };

  /** Card art is only legible above the LOD band; below it the UI owes the
   *  viewer a cursor chip, because the card itself cannot say who it is. */
  private get cardsReadable(): boolean {
    return this.cardSize * this.camera.current.zoom >= this.renderer.lod[1];
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.renderer.count > HOVER_LIMIT) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer = { x: (e.clientX - rect.left) * this.dpr, y: (e.clientY - rect.top) * this.dpr };
    // One pick per frame at most: `pick` is O(n) and a pointer emits far more
    // moves than the screen has frames to show them in.
    this.hoverDirty = true;
  };

  private onPointerLeave = () => {
    this.pointer = null;
    this.hoverDirty = true;
  };

  /** Resolve the pending pointer position, at most once per frame. */
  private updateHover() {
    if (!this.hoverDirty) return;
    this.hoverDirty = false;
    let hit = -1;
    if (this.pointer && this.dataset) {
      const [wx, wy] = this.camera.screenToWorld(this.pointer.x, this.pointer.y);
      hit = this.renderer.pick(wx, wy);
    }
    this.canvas.style.cursor = hit >= 0 ? 'pointer' : '';
    if (hit === this.hovered) return;
    this.mark(this.hovered, false);
    this.hovered = hit;
    this.mark(hit, true);
    this.dirty = true;
    this.onHover?.(hit, this.cardsReadable);
  }

  /** Draw (or clear) the quiet ring on a card, unless it is the focused one. */
  private mark(i: number, on: boolean) {
    if (i < 0 || i >= this.renderer.count) return;
    if (!on && i === this.focused) return;   // still keyboard-focused
    this.renderer.setMarked(i, on);
    this.renderer.uploadStyleAt(i);
  }

  /**
   * Move the keyboard focus to the nearest card in `dir`, or to the first or
   * last visible one. One O(n) scan per keypress is affordable in a way that
   * one per pointer move is not.
   */
  focusCard(dir: 'left' | 'right' | 'up' | 'down' | 'first' | 'last'): number {
    const r = this.renderer;
    const from = this.focused;
    const o = from * 4;
    const fx = from >= 0 ? r.to[o] : this.camera.current.x;
    const fy = from >= 0 ? r.to[o + 1] : this.camera.current.y;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < r.count; i++) {
      if (i === from) continue;
      const p = i * 4;
      if (!(r.to[p + 2] > 0) || r.to[p + 3] === 0) continue;
      const dx = r.to[p] - fx;
      const dy = r.to[p + 1] - fy;
      if (dir === 'left' && !(dx < -1e-6 && Math.abs(dy) <= Math.abs(dx))) continue;
      if (dir === 'right' && !(dx > 1e-6 && Math.abs(dy) <= Math.abs(dx))) continue;
      if (dir === 'up' && !(dy > 1e-6 && Math.abs(dx) <= Math.abs(dy))) continue;
      if (dir === 'down' && !(dy < -1e-6 && Math.abs(dx) <= Math.abs(dy))) continue;
      const d = dir === 'first' ? i : dir === 'last' ? -i : dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return this.focused;
    this.setFocusedCard(best);
    return best;
  }

  /** The keyboard-focused card: ringed, kept on screen, announced by the UI. */
  setFocusedCard(i: number) {
    if (i === this.focused) return;
    const was = this.focused;
    this.focused = i;
    if (was >= 0 && was !== this.hovered) { this.renderer.setMarked(was, false); this.renderer.uploadStyleAt(was); }
    if (i >= 0) {
      this.renderer.setMarked(i, true);
      this.renderer.uploadStyleAt(i);
      const [wx, wy, size] = this.renderer.positionOf(i);
      // Only chase the card when it has left the viewport; a scroll on every
      // arrow press would make the board unusable.
      const cam = this.camera.current;
      const halfW = this.canvas.width / cam.zoom / 2;
      const halfH = this.canvas.height / cam.zoom / 2;
      if (Math.abs(wx - cam.x) + size / 2 > halfW || Math.abs(wy - cam.y) + size / 2 > halfH) {
        this.camera.focus(wx, wy, cam.zoom, this.renderer.transitionMs === 0 ? 0 : 200);
      }
    }
    this.dirty = true;
    this.onFocusCard?.(i);
  }

  get focusedCard(): number { return this.focused; }

  private onKeyDown = (e: KeyboardEvent) => {
    const dir = e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowRight' ? 'right'
      : e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down'
        : e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : null;
    if (dir) {
      e.preventDefault();
      this.focusCard(dir);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && this.focused >= 0) {
      e.preventDefault();
      this.onSelect?.(this.focused);
      return;
    }
    if (e.key === 'Escape' && this.focused >= 0) {
      e.preventDefault();
      this.setFocusedCard(-1);
    }
  };

  private loop = (now: number) => {
    if (!this.running) return;
    const dt = Math.min(1000, now - this.lastTs);
    this.lastTs = now;
    for (const hook of this.frameHooks) hook(dt);

    this.renderer.poll();
    this.updateHover();
    const camMoving = this.camera.update(dt);
    const animating = this.renderer.advance(dt);
    this.updateHiRes(camMoving, animating);
    const needed = camMoving || animating || this.dirty || this.alwaysRender;
    // Pace to the GPU: skip this tick if it has not caught up, so the frame
    // interval we measure is the frame time we actually get.
    const busy = this.renderer.gpuBusy();

    // Idle: nothing changed means nothing to draw. With a preserved drawing
    // buffer the last frame simply stays on screen, at zero GPU cost and zero
    // flicker risk — and the laptop stays cool.
    this.idle = !needed;
    if (needed && !busy) {
      this.dirty = false;
      // Only rendered frames count: recording every rAF tick would report 60fps
      // for a collection the GPU is nowhere near keeping up with.
      // The first frame after an idle gap is a wake-up, not a frame time.
      const interval = now - this.lastDraw;
      if (!this.wasIdle && interval < 2000) this.stats.push(interval);
      this.lastDraw = now;
      this.renderer.render(this.camera.current, [0.055, 0.055, 0.051]);
    }
    this.wasIdle = this.idle;

    const model: FrameModel = {
      items: this.dataset?.n ?? 0,
      visible: this.visible,
      solveMs: this.lastSolveMs,
      uploadMs: this.renderer.lastUploadMs,
      gpu: this.renderer.gpuHint,
      gpuMs: this.renderer.gpuMs,
      dpr: this.dpr,
      buffer: [this.canvas.width, this.canvas.height],
      scale: this.isRasterView ? this.scale : null,
      animating,
      idle: this.idle,
      atlasSlot: this.dataset?.cards === false || !this.cardLabels ? null : (this.atlas?.slot ?? null),
      hiRes: this.hi.shown.size ? { tier: this.hi.tier, cards: this.hi.shown.size } : null,
      cardTier: this.cardTier,
      perItem: this.perItem,
    };
    this.lastFrame = model;
    this.onFrame?.(this.stats, model);

    requestAnimationFrame(this.loop);
  };
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

/** The worker only needs the columns a layout can name — the facets and the
 *  geographic pair — and typed arrays clone cheaply; but a column's `format`
 *  closure is not structured-cloneable, so strip it. Every other column (pixel
 *  channels, free text) stays on the main thread alone. */
export function toLayoutData(ds: Dataset): LayoutData {
  const columns: LayoutData['columns'] = {};
  const wanted = new Set<string>(ds.facets);
  if (ds.geo) { wanted.add(ds.geo.lon); wanted.add(ds.geo.lat); }
  for (const name of wanted) {
    const col = ds.columns[name];
    if (!col) continue;
    // Text columns cannot be bucketed and a derived one carries a closure that
    // structured clone would reject, so they never travel.
    if (col.kind === 'text') continue;
    columns[name] = col.kind === 'number'
      ? { kind: 'number', name: col.name, values: col.values, min: col.min, max: col.max }
      : col;
  }
  return { n: ds.n, columns };
}
