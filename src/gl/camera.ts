import { easeInOutCubic } from '../core/ease';
import type { Camera } from './renderer';
import type { Bounds } from '../layout/layouts';

/**
 * Smoothed pan/zoom. The camera chases a target with a frame-rate-independent
 * exponential, so wheel zoom feels continuous without an animation queue.
 */
export class CameraController {
  current: Camera = { x: 0, y: 0, zoom: 20 };
  target: Camera = { x: 0, y: 0, zoom: 20 };
  minZoom = 0.02;
  maxZoom = 600;
  /** Fraction of the remaining distance closed per 16.7ms, for live input. */
  smoothing = 0.22;
  /** A programmatic fit is a timed, eased flight — not an exponential chase, so it
   *  can be matched to the card transition and land at the same moment. */
  private tween: { t: number; ms: number; from: Camera; to: Camera } | null = null;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private downX = 0;
  private downY = 0;
  /** Set once a press has moved past `dragThresholdPx`; survives the release so
   *  the `click` that follows a pan can be told apart from a tap. */
  private moved = false;
  /** Active pointers, for two-finger pinch. */
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private canvas: HTMLCanvasElement;
  /** CSS pixels a press may travel and still count as a click. */
  dragThresholdPx = 4;
  onChange?: () => void;

  /** True if the most recent press moved far enough to be a pan or pinch. A
   *  click handler checks this to avoid selecting whatever a drag ended over. */
  get wasDrag(): boolean {
    return this.moved;
  }

  /** Device pixels per CSS pixel, read from the canvas itself so drag deltas,
   *  wheel anchors and `screenToWorld` (which divides by `canvas.width`) all
   *  agree — uncapped, because the drawing buffer is. */
  private dpr(): number {
    const cw = this.canvas.clientWidth;
    if (cw > 0 && this.canvas.width > 0) return this.canvas.width / cw;
    return (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  /** Any live input wins over an in-flight fit. */
  private cancelTween() {
    if (!this.tween) return;
    this.tween = null;
    this.target = { ...this.current };
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.cancelTween();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.canvas.setPointerCapture(e.pointerId);
    if (this.pointers.size === 2) {
      // Second finger: switch from pan to pinch about the midpoint.
      this.dragging = false;
      this.pinchDist = this.pointerSpan();
      this.moved = true;
      return;
    }
    this.dragging = true;
    this.moved = false;
    this.downX = this.lastX = e.clientX;
    this.downY = this.lastY = e.clientY;
  };

  private onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (p) {
      p.x = e.clientX;
      p.y = e.clientY;
    }
    if (this.pointers.size >= 2) {
      this.pinch();
      return;
    }
    if (!this.dragging) return;
    if (!this.moved) {
      const dx = e.clientX - this.downX;
      const dy = e.clientY - this.downY;
      if (dx * dx + dy * dy < this.dragThresholdPx * this.dragThresholdPx) return;
      this.moved = true;
    }
    const k = this.dpr() / this.target.zoom;
    this.target.x -= (e.clientX - this.lastX) * k;
    this.target.y += (e.clientY - this.lastY) * k;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.onChange?.();
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    this.dragging = false;
    if (this.pointers.size === 1) {
      // One finger lifted mid-pinch: the other carries on as a pan, but the
      // gesture stays a drag so the release does not read as a click.
      const [rest] = this.pointers.values();
      this.dragging = true;
      this.lastX = rest.x;
      this.lastY = rest.y;
    }
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };

  private pointerSpan(): number {
    const [a, b] = this.pointers.values();
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  /** Two-finger pinch: zoom about the midpoint by the change in finger spacing. */
  private pinch() {
    const dist = this.pointerSpan();
    if (dist < 1 || this.pinchDist < 1) {
      this.pinchDist = dist;
      return;
    }
    const [a, b] = this.pointers.values();
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.dpr();
    const px = ((a.x + b.x) / 2 - rect.left) * dpr;
    const py = ((a.y + b.y) / 2 - rect.top) * dpr;
    this.zoomAt(px, py, dist / this.pinchDist);
    this.pinchDist = dist;
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.cancelTween();
    const rect = this.canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * this.dpr();
    const py = (e.clientY - rect.top) * this.dpr();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
    this.zoomAt(px, py, factor);
  };

  /** Zoom about a point in device pixels, keeping that world point pinned. */
  zoomAt(px: number, py: number, factor: number) {
    const t = this.target;
    const before = this.screenToWorld(px, py, t);
    t.zoom = clamp(t.zoom * factor, this.minZoom, this.maxZoom);
    const after = this.screenToWorld(px, py, t);
    t.x += before[0] - after[0];
    t.y += before[1] - after[1];
    this.onChange?.();
  }

  screenToWorld(px: number, py: number, cam: Camera = this.current): [number, number] {
    const w = this.canvas.width;
    const h = this.canvas.height;
    return [cam.x + (px - w / 2) / cam.zoom, cam.y - (py - h / 2) / cam.zoom];
  }

  /** Frame a world-space box with padding, in device pixels. `quantise` lets a
   *  caller round the resulting scale — a raster needs a whole number of device
   *  pixels per cell or it point-samples into a moire. */
  fit(b: Bounds, padPx = 48, animate = true, ms = 900, quantise?: (zoom: number) => number) {
    // Nothing to frame (every row filtered out, or a degenerate box): keep the
    // camera where it is rather than clamping to maxZoom on a 1e-6 extent.
    if (!isFinite(b.minX) || !isFinite(b.maxX) || !isFinite(b.minY) || !isFinite(b.maxY)) return;
    if (b.maxX - b.minX <= 0 || b.maxY - b.minY <= 0) return;
    const w = Math.max(1, this.canvas.width - padPx * 2);
    const h = Math.max(1, this.canvas.height - padPx * 2);
    const bw = Math.max(1e-6, b.maxX - b.minX);
    const bh = Math.max(1e-6, b.maxY - b.minY);
    let zoom = clamp(Math.min(w / bw, h / bh), this.minZoom, this.maxZoom);
    if (quantise) zoom = clamp(quantise(zoom), this.minZoom, this.maxZoom);
    const to: Camera = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, zoom };
    this.flyTo(to, animate ? ms : 0);
  }

  /** Centre on a world point at a given zoom. */
  focus(x: number, y: number, zoom?: number, ms = 650) {
    this.flyTo({ x, y, zoom: zoom !== undefined ? clamp(zoom, this.minZoom, this.maxZoom) : this.target.zoom }, ms);
  }

  /** Change scale about the viewport centre, keeping the centred point fixed. */
  zoomTo(zoom: number, ms = 260) {
    this.flyTo({ x: this.target.x, y: this.target.y, zoom: clamp(zoom, this.minZoom, this.maxZoom) }, ms);
  }

  /** Eased flight to an exact camera. ms = 0 lands immediately. */
  flyTo(to: Camera, ms = 900) {
    this.target = { ...to };
    if (ms <= 0) {
      this.tween = null;
      this.current = { ...to };
    } else {
      this.tween = { t: 0, ms, from: { ...this.current }, to: { ...to } };
    }
    this.onChange?.();
  }

  /** Returns true while the camera is still settling. */
  update(dtMs: number): boolean {
    const tw = this.tween;
    if (tw) {
      tw.t = Math.min(1, tw.t + dtMs / tw.ms);
      const e = easeInOutCubic(tw.t);
      const c = this.current;
      c.x = tw.from.x + (tw.to.x - tw.from.x) * e;
      c.y = tw.from.y + (tw.to.y - tw.from.y) * e;
      // Zoom is geometric: interpolate the exponent, or the flight lurches.
      c.zoom = tw.from.zoom * Math.pow(tw.to.zoom / tw.from.zoom, e);
      if (tw.t >= 1) {
        this.tween = null;
        this.current = { ...tw.to };
      }
      return true;
    }
    const k = 1 - Math.pow(1 - this.smoothing, dtMs / 16.7);
    const c = this.current;
    const t = this.target;
    const dx = t.x - c.x;
    const dy = t.y - c.y;
    const dz = Math.log(t.zoom / c.zoom);
    const moving = Math.abs(dx) * c.zoom > 0.05 || Math.abs(dy) * c.zoom > 0.05 || Math.abs(dz) > 1e-4;
    if (!moving) {
      this.current = { ...t };
      return false;
    }
    c.x += dx * k;
    c.y += dy * k;
    c.zoom *= Math.exp(dz * k);
    return true;
  }

  dispose() {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onUp);
    c.removeEventListener('wheel', this.onWheel);
  }
}

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
