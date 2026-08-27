/**
 * Card atlas. Cards are drawn once with Canvas2D into a single texture; the GPU
 * then samples them for every instance. Small collections get a card per row;
 * large ones get a *cover* per category — a label, never a record.
 */
import { hexToRgb } from '../core/palette';
import type { TagTone } from '../data/card';
import { MONO, SANS, measureQuietSlots, quietLayout, type QuietLayout } from './cards/quietLayout';

/** One chip on a card face. */
export interface SpecTag {
  text: string;
  tone?: TagTone;
  shape?: 'pill' | 'dot';
}

export interface CardSpec {
  title: string;
  accent: string;
  /** Dataset row this card portrays (per-item atlases); painters that know the
   *  dataset read the typed columns directly by this index. */
  row?: number;
  /** Eyebrow in the accent header — the kind of record, and what the colour means. */
  topic?: string;
  /** One line of context under the title: where, when, from whom. */
  blurb?: string;
  /** At most two are drawn. */
  tags?: readonly SpecTag[];
  /** One number, right-aligned on the foot line. */
  metric?: string;
  /** Short unit or noun beside the metric. */
  metricLabel?: string;
  /** A group cover rather than a record: what the base atlas paints when it
   *  holds one slot per category. A cover is a label and cannot be mistaken
   *  for a record at any size, which is the whole point. */
  cover?: { label: string; accent: string };
  /** @deprecated Folded into `topic`. Read only as a fallback. */
  subtitle?: string;
  /** @deprecated Folded into `tags`. Read only as a fallback. */
  fields?: Array<[string, string]>;
  /** @deprecated Folded into `metric`. Read only as a fallback. */
  badge?: string;
  /** @deprecated Replaced by `cover`. */
  category?: string;
}

/** Paints one card into a `w` x `h` box whose origin is already translated. */
export type CardPainter = (ctx: CanvasRenderingContext2D, w: number, h: number, spec: CardSpec) => void;

export interface AtlasSlot {
  uv: [number, number, number, number];
}

export const BG = '#1c1c1b';
export const INK = '#f5f5f2';
export const INK_DIM = '#a3a29a';
/** Colour tokens shared by every painter, all drawn from src/core/palette.ts. */
export const INK_MUTE = '#6f6e66';       // OTHER.dark
export const CHIP_HIGH = '#e66767';      // CATEGORICAL.dark[7]
export const CHIP_STANDARD = '#3987e5';  // CATEGORICAL.dark[0]
export const CHIP_LOW = '#6f6e66';       // OTHER.dark
export const STATUS_OPEN = '#c98500';    // CATEGORICAL.dark[3]
export const STATUS_RESOLVED = '#199e70'; // CATEGORICAL.dark[2]
export const STAR = '#c98500';

/** Chip colour for a tag's tone. `accent` borrows the card's own accent. */
export function toneColor(tone: TagTone | undefined, accent: string): string {
  switch (tone) {
    case 'accent': return accent;
    case 'good': return STATUS_RESOLVED;
    case 'warn': return STATUS_OPEN;
    case 'bad': return CHIP_HIGH;
    default: return INK_MUTE;
  }
}

/** How many `slot`-px cards a square `size` texture holds at `pad` px of bleed each side. */
export function hiResCapacity(size: number, slot: number, pad: number): number {
  const cols = Math.floor(size / (slot + pad * 2));
  return cols * cols;
}

/**
 * The largest power-of-two card slot such that a ceil(sqrt(n))-column grid of
 * padded slots fits in `size`, clamped to [min, max]. A 900-row collection
 * (30 columns) gets 128 px; a category atlas of eight cards gets 1024.
 */
export function slotFor(n: number, size = 4096, pad = 4, min = 64, max = 1024): number {
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n))));
  const maxPitch = Math.floor(size / cols);
  let slot = max;
  while (slot > min && slot + pad * 2 > maxPitch) slot >>= 1;
  return Math.max(min, Math.min(max, slot));
}

/**
 * The grid a base atlas of `slots` cards lays out in, and the canvas it needs.
 *
 * Square-ish, so the mip chain stays sane, but no larger than the slots it
 * holds: what gets uploaded is the canvas, and that upload is repeated on every
 * colour change. `slots` of 0 means "fill the texture" — the old behaviour,
 * kept for a caller that does not know its count.
 */
export function atlasGrid(size: number, slot: number, pad: number, slots = 0): { cols: number; rows: number; width: number; height: number; capacity: number } {
  const pitch = slot + pad * 2;
  const fit = Math.max(1, Math.floor(size / pitch));
  const cols = slots > 0 ? Math.min(fit, Math.max(1, Math.ceil(Math.sqrt(slots)))) : fit;
  const rows = slots > 0 ? Math.min(fit, Math.ceil(slots / cols)) : fit;
  return { cols, rows, width: cols * pitch, height: rows * pitch, capacity: cols * rows };
}

export function nextPow2(v: number): number {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}

/** Pixel origin and uv rect of slot `i` in a `cols`-wide grid of padded slots.
 *  `height` differs from `width` only for the base atlas, which is cropped to
 *  the rows it fills; the hi-res atlas is square. */
export function slotRect(i: number, width: number, slot: number, pad: number, cols: number, height = width): { x: number; y: number; uv: [number, number, number, number] } {
  const pitch = slot + pad * 2;
  const x = (i % cols) * pitch + pad;
  const y = Math.floor(i / cols) * pitch + pad;
  return { x, y, uv: [x / width, y / height, (x + slot) / width, (y + slot) / height] };
}

export class CardAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly slot: number;
  readonly pad: number;
  readonly cols: number;
  readonly capacity: number;
  /** Largest texture side this atlas may use (D-26: the owner clamps this to
   *  MAX_TEXTURE_SIZE). The canvas itself is cropped to what `slots` needs. */
  readonly size: number;
  /** How many slots it was built to hold — part of the owner's rebuild test. */
  readonly slots: number;
  /** The card design; swapped per dataset by `cardPainterFor`. */
  painter: CardPainter = drawCard;
  private used = 0;

  /**
   * `slots` crops the canvas to the grid it actually needs, which is what gets
   * uploaded. A square 4096 texture is 64 MB and the upload is paid again on
   * every colour change; a collection past the per-item cap fills it with a
   * handful of group covers and used to send the other 60 MB of transparent
   * black with them. 0 keeps the full square.
   */
  constructor(size = 4096, slot = 128, pad = 4, slots = 0) {
    this.size = size;
    this.slot = slot;
    this.pad = pad;
    this.slots = slots;
    const grid = atlasGrid(size, slot, pad, slots);
    this.cols = grid.cols;
    this.capacity = grid.capacity;
    this.canvas = document.createElement('canvas');
    this.canvas.width = grid.width;
    this.canvas.height = grid.height;
    const ctx = this.canvas.getContext('2d', { alpha: true, willReadFrequently: false });
    if (!ctx) throw new Error('2D context unavailable for the card atlas');
    this.ctx = ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  reset() {
    this.used = 0;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Draw one card and return its uv rect. Returns null when the atlas is full. */
  add(spec: CardSpec): AtlasSlot | null {
    if (this.used >= this.capacity) return null;
    const i = this.used++;
    return this.drawSlot(spec, i);
  }

  /** Draw a card into slot `i` without touching the allocation counter. */
  drawSlot(spec: CardSpec, i: number): AtlasSlot {
    const { x, y, uv } = this.rectOf(i);
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    // Bleed the background into the padding so mip levels don't sample emptiness.
    ctx.fillStyle = BG;
    ctx.fillRect(-this.pad, -this.pad, this.slot + this.pad * 2, this.slot + this.pad * 2);
    this.painter(ctx, this.slot, this.slot, spec);
    ctx.restore();
    return { uv };
  }

  /** Pixel origin and uv rect of slot `i`. */
  rectOf(i: number) {
    return slotRect(i, this.canvas.width, this.slot, this.pad, this.cols, this.canvas.height);
  }

  get count() { return this.used; }
}

/** The card design itself — one place to restyle every collection.
 *  Datasets that know their own records go through `cardPainterFor`; this is
 *  what a bare `CardSpec` looks like, in the same four-line language. */
export function drawCard(ctx: CanvasRenderingContext2D, w: number, h: number, spec: CardSpec) {
  if (spec.cover) return drawCover(ctx, w, h, spec.cover.label, spec.cover.accent);
  const face = faceOfSpec(spec);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  paintFace(ctx, quietLayout(w, h, slotsFor(ctx, w, h, face)), face);
}

/** A quiet-card face, in display form. Painters fill one of these and hand it
 *  to `paintFace`; nothing here is allocated per row at draw time. */
export interface CardFace {
  accent: string;
  topic: string;
  title: string;
  blurb: string;
  tags: readonly SpecTag[];
  /** Only the first `tagCount` entries of `tags` are drawn. */
  tagCount: number;
  metric: string;
  metricLabel: string;
  /** Drawn on the mark tile when the caller supplies no glyph. */
  initials: string;
}

/** Which slots this face has something to say in, and how much room each needs. */
export function slotsFor(ctx: CanvasRenderingContext2D, w: number, h: number, f: CardFace) {
  return measureQuietSlots(ctx, w, h, f.title, f.blurb, f.tagCount, !!f.metric, !!(f.initials || f.topic));
}

/**
 * Paint one face into an already-cleared box. `mark` is the hook the dataset
 * painters use to put a glyph on the tile; returning false falls back to the
 * face's initials.
 */
export function paintFace(
  ctx: CanvasRenderingContext2D,
  L: QuietLayout,
  f: CardFace,
  mark?: (ctx: CanvasRenderingContext2D, tile: { x: number; y: number; w: number; h: number }, ink: string) => boolean,
) {
  const w = L.w;
  const accent = f.accent;

  const grad = ctx.createLinearGradient(0, 0, w, L.header.h);
  grad.addColorStop(0, accent);
  grad.addColorStop(1, mixHex(accent, BG, 0.35));
  ctx.fillStyle = grad;
  ctx.fillRect(L.header.x, L.header.y, L.header.w, L.header.h);
  const headInk = inkOn(accent);

  if (L.tile) {
    ctx.fillStyle = headInk === INK ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.45)';
    rrect(ctx, L.tile.x, L.tile.y, L.tile.w, L.tile.h, L.tile.radius);
    ctx.fill();
    if (!mark?.(ctx, L.tile, headInk)) {
      ctx.fillStyle = headInk;
      ctx.font = `600 ${Math.max(8, Math.round(L.tile.h * 0.5))}px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(f.initials, Math.round(L.tile.x + L.tile.w / 2), Math.round(L.tile.y + L.tile.h / 2));
    }
  }
  drawRun(ctx, L.topic, f.topic, headInk);

  // Body: title, then blurb, then chips. Each wraps into the runs it was given.
  drawLines(ctx, L.title, f.title, INK);
  drawLines(ctx, L.blurb, f.blurb, INK_DIM);
  if (L.tags) drawTagChips(ctx, L, f.tags, f.tagCount, accent);
  if (L.metric && f.metric) drawMetric(ctx, L, f.metric, f.metricLabel);

  ctx.globalAlpha = 0.9;
  ctx.fillStyle = accent;
  ctx.fillRect(L.foot.x, L.foot.y, L.foot.w, L.foot.h);
  ctx.globalAlpha = 1;
}

/**
 * A group cover: the category's accent, a frame one step darker, its initials,
 * and — where there is room for it to read — its name across the foot. No
 * counts, no percentages, no bar: a cover is a label, not a tile of statistics.
 */
export function drawCover(ctx: CanvasRenderingContext2D, w: number, h: number, label: string, accent: string) {
  ctx.fillStyle = mixHex(accent, BG, 0.42);
  ctx.fillRect(0, 0, w, h);
  const pad = Math.max(2, Math.round(h * 0.02));
  ctx.strokeStyle = mixHex(accent, BG, 0.72);
  ctx.lineWidth = pad;
  ctx.strokeRect(pad / 2, pad / 2, w - pad, h - pad);

  const ink = inkOn(mixHex(accent, BG, 0.42));
  const footH = h >= 256 ? Math.round(h * 0.16) : 0;
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.9;
  ctx.font = `600 ${Math.round(h * 0.4)}px ${SANS}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(clip(ctx, initials(label), w * 0.8), Math.round(w / 2), Math.round((h - footH) / 2));
  if (footH) {
    ctx.font = `500 ${Math.round(h * 0.08)}px ${SANS}`;
    ctx.globalAlpha = 0.75;
    ctx.fillText(clip(ctx, label, w * 0.88), Math.round(w / 2), Math.round(h - footH / 2));
  }
  ctx.globalAlpha = 1;
}

/** Ink that reads on `hex`: the light end of the sequential ramp needs dark text. */
export function inkOn(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? BG : INK;
}

// The painters' font stacks live with the layout that sizes them.
export { SANS, MONO };

/** Draw one text run, clipped to its own width. */
export function drawRun(ctx: CanvasRenderingContext2D, run: { x: number; y: number; size: number; weight: number; align: 'left' | 'right'; maxW: number; family: 'sans' | 'mono' }, s: string, color: string, alpha = 1) {
  if (!s) return;
  ctx.font = `${run.weight} ${run.size}px ${run.family === 'mono' ? MONO : SANS}`;
  ctx.textAlign = run.align;
  ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillText(clip(ctx, s, run.maxW), Math.round(run.x), Math.round(run.y));
  ctx.globalAlpha = 1;
}

/** Wrap `s` across the runs it was given, drawing from the first. */
function drawLines(ctx: CanvasRenderingContext2D, runs: QuietLayout['title'], s: string, color: string) {
  if (!s || runs.length === 0) return;
  ctx.font = `${runs[0].weight} ${runs[0].size}px ${SANS}`;
  const lines = runs.length > 1 ? wrap(ctx, s, runs[0].maxW, runs.length) : [s];
  for (let i = 0; i < lines.length && i < runs.length; i++) drawRun(ctx, runs[i], lines[i], color);
}

/** Up to `max` chips, left-aligned, dropping any that would overflow. */
export function drawTagChips(ctx: CanvasRenderingContext2D, L: QuietLayout, tags: readonly SpecTag[], max: number, accent: string) {
  const t = L.tags;
  if (!t) return;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let x = L.inset;
  const limit = Math.min(max, t.max, tags.length);
  for (let i = 0; i < limit; i++) {
    const chip = tags[i];
    if (!chip.text) continue;
    const color = toneColor(chip.tone, accent);
    ctx.font = `600 ${t.size}px ${SANS}`;
    const tw = ctx.measureText(chip.text).width;
    if (chip.shape === 'dot') {
      const dw = t.dot * 2 + t.gap * 0.6;
      if (x + dw + tw > L.right) break;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x + t.dot, t.y, t.dot, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = INK_DIM;
      ctx.font = `500 ${t.size}px ${SANS}`;
      ctx.fillText(chip.text, Math.round(x + dw), Math.round(t.y));
      x += dw + tw + t.gap;
    } else {
      const pw = Math.round(tw + t.padX * 2);
      if (x + pw > L.right) break;
      ctx.fillStyle = rgba(color, 0.2);
      rrect(ctx, x, t.y - t.h / 2, pw, t.h, t.h / 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(chip.text, Math.round(x + t.padX), Math.round(t.y));
      x += pw + t.gap;
    }
  }
}

/** Value then its label, right-aligned on the foot line. */
function drawMetric(ctx: CanvasRenderingContext2D, L: QuietLayout, value: string, label: string) {
  const m = L.metric!;
  if (label) {
    drawRun(ctx, m.label, label, INK_MUTE);
    ctx.font = `${m.label.weight} ${m.label.size}px ${SANS}`;
    const lw = ctx.measureText(label).width + m.value.size * 0.4;
    drawRun(ctx, { ...m.value, x: m.value.x - lw, maxW: m.value.maxW - lw }, value, INK_DIM);
  } else {
    drawRun(ctx, m.value, value, INK_DIM);
  }
}

/** Read a bare spec through the new slots, falling back to the legacy ones. */
function faceOfSpec(spec: CardSpec): CardFace {
  const tags = spec.tags ?? (spec.fields ?? []).map(([, value]) => ({ text: value, shape: 'dot' as const }));
  return {
    accent: spec.accent,
    topic: spec.topic ?? spec.subtitle ?? '',
    title: spec.title,
    blurb: spec.blurb ?? '',
    tags,
    tagCount: Math.min(2, tags.length),
    metric: spec.metric ?? spec.badge ?? '',
    metricLabel: spec.metricLabel ?? '',
    initials: initials(spec.title),
  };
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Rounded rectangle as a path; the caller fills or strokes it. */
export function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

export function initials(name: string): string {
  const parts = name.replace(/["'(),.]/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Wrap `s` into at most `maxLines`; the last line takes the whole remainder
 *  and is clipped, rather than showing only its first word. */
export function wrap(ctx: CanvasRenderingContext2D, s: string, maxW: number, maxLines: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (line && lines.length < maxLines - 1 && ctx.measureText(next).width > maxW) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(clip(ctx, line, maxW));
  return lines;
}

export function clip(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo) + '…';
}

/** Linear RGB blend of two hexes at `t` (0 = a, 1 = b), as a CSS `rgb()`. */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round(ar * (1 - t) + br * t);
  const g = Math.round(ag * (1 - t) + bg * t);
  const bl = Math.round(ab * (1 - t) + bb * t);
  return `rgb(${r},${g},${bl})`;
}
