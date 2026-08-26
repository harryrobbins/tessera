/**
 * Card atlas. Cards are drawn once with Canvas2D into a single texture; the GPU
 * then samples them for every instance. Small collections get a card per row;
 * large ones get a card per category and are tinted per item.
 */
export interface CardSpec {
  title: string;
  subtitle?: string;
  accent: string;
  fields?: Array<[string, string]>;
  badge?: string;
}

export interface AtlasSlot {
  uv: [number, number, number, number];
}

const BG = '#1c1c1b';
const INK = '#f5f5f2';
const INK_DIM = '#a3a29a';

export class CardAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly slot: number;
  readonly pad: number;
  readonly cols: number;
  readonly capacity: number;
  private used = 0;

  constructor(size = 4096, slot = 128, pad = 4) {
    this.slot = slot;
    this.pad = pad;
    const pitch = slot + pad * 2;
    this.cols = Math.floor(size / pitch);
    this.capacity = this.cols * this.cols;
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    const ctx = this.canvas.getContext('2d', { alpha: true, willReadFrequently: false });
    if (!ctx) throw new Error('2D context unavailable for the card atlas');
    this.ctx = ctx;
    ctx.clearRect(0, 0, size, size);
  }

  reset() {
    this.used = 0;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Draw one card and return its uv rect. Returns null when the atlas is full. */
  add(spec: CardSpec): AtlasSlot | null {
    if (this.used >= this.capacity) return null;
    const i = this.used++;
    const pitch = this.slot + this.pad * 2;
    const cx = (i % this.cols) * pitch + this.pad;
    const cy = Math.floor(i / this.cols) * pitch + this.pad;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(cx, cy);
    // Bleed the background into the padding so mip levels don't sample emptiness.
    ctx.fillStyle = BG;
    ctx.fillRect(-this.pad, -this.pad, this.slot + this.pad * 2, this.slot + this.pad * 2);
    drawCard(ctx, this.slot, this.slot, spec);
    ctx.restore();
    const s = this.canvas.width;
    return { uv: [cx / s, cy / s, (cx + this.slot) / s, (cy + this.slot) / s] };
  }

  get count() { return this.used; }
}

/** The card design itself — one place to restyle every collection. */
export function drawCard(ctx: CanvasRenderingContext2D, w: number, h: number, spec: CardSpec) {
  const accent = spec.accent;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  // Accent header with a monogram tile.
  const headerH = Math.round(h * 0.30);
  const grad = ctx.createLinearGradient(0, 0, w, headerH);
  grad.addColorStop(0, accent);
  grad.addColorStop(1, mixHex(accent, BG, 0.35));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, headerH);

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = `600 ${Math.round(h * 0.15)}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(initials(spec.title), Math.round(w * 0.06), headerH / 2);

  if (spec.badge) {
    ctx.font = `600 ${Math.round(h * 0.088)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(spec.badge, Math.round(w * 0.94), headerH / 2);
  }

  // Title, up to two lines.
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = `600 ${Math.round(h * 0.098)}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
  const lines = wrap(ctx, spec.title, w * 0.88, 2);
  let y = headerH + h * 0.13;
  for (const line of lines) {
    ctx.fillText(line, Math.round(w * 0.06), y);
    y += h * 0.115;
  }

  if (spec.subtitle) {
    ctx.fillStyle = INK_DIM;
    ctx.font = `400 ${Math.round(h * 0.082)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(clip(ctx, spec.subtitle, w * 0.88), Math.round(w * 0.06), y);
    y += h * 0.1;
  }

  // Field rows, label left / value right.
  ctx.font = `400 ${Math.round(h * 0.078)}px ui-sans-serif, system-ui, sans-serif`;
  let fy = h - h * 0.09 - (spec.fields?.length ?? 0) * h * 0.098 + h * 0.05;
  fy = Math.max(fy, y + h * 0.02);
  for (const [label, value] of spec.fields ?? []) {
    ctx.fillStyle = INK_DIM;
    ctx.textAlign = 'left';
    ctx.fillText(clip(ctx, label, w * 0.45), Math.round(w * 0.06), fy);
    ctx.fillStyle = INK;
    ctx.textAlign = 'right';
    ctx.fillText(clip(ctx, value, w * 0.45), Math.round(w * 0.94), fy);
    fy += h * 0.098;
  }

  // Accent foot rule.
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(0, h - Math.max(2, h * 0.02), w, Math.max(2, h * 0.02));
  ctx.globalAlpha = 1;
}

export function initials(name: string): string {
  const parts = name.replace(/["'(),.]/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function wrap(ctx: CanvasRenderingContext2D, s: string, maxW: number, maxLines: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (ctx.measureText(next).width > maxW && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    } else {
      line = next;
    }
  }
  if (line && lines.length < maxLines) lines.push(clip(ctx, line, maxW));
  return lines;
}

function clip(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo) + '…';
}

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round((((pa >> 16) & 255) * (1 - t)) + (((pb >> 16) & 255) * t));
  const g = Math.round((((pa >> 8) & 255) * (1 - t)) + (((pb >> 8) & 255) * t));
  const bl = Math.round(((pa & 255) * (1 - t)) + ((pb & 255) * t));
  return `rgb(${r},${g},${bl})`;
}
