/**
 * Frame timing. A ring buffer of frame durations is the only honest FPS source —
 * an instantaneous 1/dt reading is far too noisy to compare machines with.
 */
export class FrameStats {
  private buf: Float32Array;
  private i = 0;
  private filled = 0;
  private sorted: Float32Array;
  private chrono: Float32Array;
  frames = 0;

  constructor(window = 180) {
    this.buf = new Float32Array(window);
    this.sorted = new Float32Array(window);
    this.chrono = new Float32Array(window);
  }

  push(dtMs: number) {
    this.buf[this.i] = dtMs;
    this.i = (this.i + 1) % this.buf.length;
    if (this.filled < this.buf.length) this.filled++;
    this.frames++;
  }

  reset() { this.i = 0; this.filled = 0; this.frames = 0; }

  get count() { return this.filled; }

  mean(): number {
    if (!this.filled) return 0;
    let s = 0;
    for (let k = 0; k < this.filled; k++) s += this.buf[k];
    return s / this.filled;
  }

  fps(): number {
    const m = this.mean();
    return m > 0 ? 1000 / m : 0;
  }

  /** q in 0..1. */
  percentile(q: number): number {
    if (!this.filled) return 0;
    const s = this.sorted.subarray(0, this.filled);
    s.set(this.buf.subarray(0, this.filled));
    s.sort();
    const idx = Math.min(this.filled - 1, Math.max(0, Math.round(q * (this.filled - 1))));
    return s[idx];
  }

  worst(): number {
    let w = 0;
    for (let k = 0; k < this.filled; k++) if (this.buf[k] > w) w = this.buf[k];
    return w;
  }

  /** Frame durations in chronological order. Returns a reused view: read it before the next call. */
  history(): Float32Array {
    const out = this.chrono.subarray(0, this.filled);
    for (let k = 0; k < this.filled; k++) {
      out[k] = this.buf[(this.i - this.filled + k + this.buf.length * 2) % this.buf.length];
    }
    return out;
  }
}

export interface HudModel {
  items: number;
  visible: number;
  solveMs: number;
  uploadMs: number;
  gpu: string;
  gpuMs: number;
  dpr: number;
  buffer: [number, number];
  scale: number | null;
  animating: boolean;
  idle: boolean;
}

/** The bottom-left readout: big FPS number, frame-time sparkline, cost breakdown. */
export class Hud {
  private fpsEl: HTMLElement;
  private spark: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  private rows: HTMLElement;
  private cells = new Map<string, HTMLElement>();
  private last = 0;

  constructor(el: HTMLElement) {
    el.innerHTML = `
      <div class="fps"><span data-fps>—</span><small>fps</small></div>
      <canvas class="spark" width="368" height="52"></canvas>
      <div data-rows></div>`;
    this.fpsEl = el.querySelector('[data-fps]')!;
    this.spark = el.querySelector('canvas')!;
    this.sctx = this.spark.getContext('2d')!;
    this.rows = el.querySelector('[data-rows]')!;
  }

  /** Throttled to ~7Hz: a HUD that repaints every frame distorts what it measures. */
  update(stats: FrameStats, model: HudModel, nowMs: number) {
    if (nowMs - this.last < 140) return;
    this.last = nowMs;
    // The GPU can be seconds behind while rAF still ticks at 60Hz, so take the
    // pessimistic of the two — that is the frame rate a user actually sees.
    const wall = stats.fps();
    const fps = model.gpuMs > 0 ? Math.min(wall, 1000 / model.gpuMs) : wall;
    this.fpsEl.textContent = fps > 0 ? fps.toFixed(0) : '—';
    this.fpsEl.parentElement!.style.color =
      fps >= 55 ? '#199e70' : fps >= 30 ? '#c98500' : '#e66767';

    this.row('cards', model.items.toLocaleString());
    this.row('shown', model.visible.toLocaleString());
    this.row('frame p50 / p95', `${stats.percentile(0.5).toFixed(1)} / ${stats.percentile(0.95).toFixed(1)} ms`);
    this.row('gpu frame', model.gpuMs >= 0 ? `${model.gpuMs.toFixed(2)} ms` : 'n/a');
    this.row('layout solve', `${model.solveMs.toFixed(1)} ms`);
    this.row('gpu upload', `${model.uploadMs.toFixed(1)} ms`);
    this.row('draw calls', '1');
    this.row('device', `${model.dpr}x · ${model.buffer[0]}×${model.buffer[1]}`);
    this.row('scale', model.scale === null ? null : fmtScale(model.scale));

    this.drawSpark(stats);
  }

  /** Rows are created once and their text nodes updated in place; `null` hides a row. */
  private row(label: string, value: string | null) {
    let cell = this.cells.get(label);
    if (!cell) {
      const div = document.createElement('div');
      div.className = 'row';
      const span = document.createElement('span');
      span.textContent = label;
      cell = document.createElement('b');
      div.append(span, cell);
      this.rows.appendChild(div);
      this.cells.set(label, cell);
    }
    const div = cell.parentElement!;
    if (value === null) { div.hidden = true; return; }
    div.hidden = false;
    if (cell.textContent !== value) cell.textContent = value;
  }

  private drawSpark(stats: FrameStats) {
    const { sctx: c, spark } = this;
    const w = spark.width;
    const h = spark.height;
    c.clearRect(0, 0, w, h);
    const hist = stats.history();
    if (hist.length < 2) return;
    const budget = 16.67;
    const scale = h / (budget * 2.5); // 2.5x the 60fps budget fills the box

    // 60fps reference line.
    c.strokeStyle = '#2f2f2c';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, h - budget * scale);
    c.lineTo(w, h - budget * scale);
    c.stroke();

    c.beginPath();
    for (let k = 0; k < hist.length; k++) {
      const x = (k / (hist.length - 1)) * w;
      const y = Math.max(1, h - Math.min(h, hist[k] * scale));
      k === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    }
    c.strokeStyle = '#3987e5';
    c.lineWidth = 1.5;
    c.stroke();
    c.lineTo(w, h);
    c.lineTo(0, h);
    c.closePath();
    c.fillStyle = 'rgba(57,135,229,0.16)';
    c.fill();
  }
}

/** Device pixels per cell: 2 reads as 2:1, 0.5 as 1:2. */
function fmtScale(s: number): string {
  const exact = Math.abs(s - Math.round(s)) < 0.01 || Math.abs(1 / s - Math.round(1 / s)) < 0.01;
  const text = s >= 1 ? `${s.toFixed(s % 1 ? 2 : 0)}:1` : `1:${(1 / s).toFixed((1 / s) % 1 ? 2 : 0)}`;
  return exact ? text : `${text} (fractional)`;
}
