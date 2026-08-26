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
  private canvas: HTMLCanvasElement;
  private dpr = () => Math.min(window.devicePixelRatio || 1, 2);
  onChange?: () => void;

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
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const k = this.dpr() / this.target.zoom;
    this.target.x -= (e.clientX - this.lastX) * k;
    this.target.y += (e.clientY - this.lastY) * k;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.onChange?.();
  };

  private onUp = (e: PointerEvent) => {
    this.dragging = false;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };

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

  /** Frame a world-space box with padding, in device pixels. */
  fit(b: Bounds, padPx = 48, animate = true, ms = 900) {
    const w = Math.max(1, this.canvas.width - padPx * 2);
    const h = Math.max(1, this.canvas.height - padPx * 2);
    const bw = Math.max(1e-6, b.maxX - b.minX);
    const bh = Math.max(1e-6, b.maxY - b.minY);
    const to: Camera = {
      x: (b.minX + b.maxX) / 2,
      y: (b.minY + b.maxY) / 2,
      zoom: clamp(Math.min(w / bw, h / bh), this.minZoom, this.maxZoom),
    };
    this.flyTo(to, animate ? ms : 0);
  }

  /** Centre on a world point at a given zoom. */
  focus(x: number, y: number, zoom?: number, ms = 650) {
    this.flyTo({ x, y, zoom: zoom !== undefined ? clamp(zoom, this.minZoom, this.maxZoom) : this.target.zoom }, ms);
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

export function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
