import { describe, it, expect } from 'vitest';
import { CameraController, clamp } from '../src/gl/camera';
import { mulberry32, randRange } from './helpers/prng';

describe('clamp', () => {
  it('passes values already inside the range through unchanged', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('clamps values below the range to lo, and above to hi', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('holds clamp(v, lo, hi) is always within [lo, hi] for random v/lo/hi', () => {
    const rand = mulberry32(0x1234);
    for (let i = 0; i < 300; i++) {
      const lo = randRange(rand, -1000, 1000);
      const hi = lo + Math.abs(randRange(rand, 0, 1000));
      const v = randRange(rand, -2000, 2000);
      const c = clamp(v, lo, hi);
      expect(c).toBeGreaterThanOrEqual(lo);
      expect(c).toBeLessThanOrEqual(hi);
      // Idempotent within range.
      if (v >= lo && v <= hi) expect(c).toBe(v);
    }
  });
});

// A fake canvas: enough of HTMLCanvasElement for the controller to wire up
// its listeners, and a `fire` helper to synthesise pointer events.
function fakeCanvas(width = 800, height = 600, dpr = 2) {
  const listeners = new Map<string, (e: any) => void>();
  const captured = new Set<number>();
  const canvas = {
    width: width * dpr,
    height: height * dpr,
    clientWidth: width,
    clientHeight: height,
    addEventListener: (type: string, fn: (e: any) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    hasPointerCapture: (id: number) => captured.has(id),
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    fire(type: string, e: Record<string, unknown>) {
      listeners.get(type)?.({ button: 0, pointerId: 1, preventDefault() {}, ...e });
    },
  };
  return canvas;
}

describe('CameraController drag threshold (D-02)', () => {
  it('a press that moves less than the threshold is not a drag and does not pan', () => {
    const c = fakeCanvas();
    const cam = new CameraController(c as unknown as HTMLCanvasElement);
    const before = { ...cam.target };
    c.fire('pointerdown', { clientX: 100, clientY: 100 });
    c.fire('pointermove', { clientX: 102, clientY: 101 });
    c.fire('pointerup', { clientX: 102, clientY: 101 });
    expect(cam.wasDrag).toBe(false);
    expect(cam.target).toEqual(before);
  });

  it('a press that moves past the threshold pans and reports wasDrag after release', () => {
    const c = fakeCanvas(800, 600, 2);
    const cam = new CameraController(c as unknown as HTMLCanvasElement);
    cam.target.zoom = 10;
    c.fire('pointerdown', { clientX: 100, clientY: 100 });
    c.fire('pointermove', { clientX: 120, clientY: 100 });
    c.fire('pointerup', { clientX: 120, clientY: 100 });
    expect(cam.wasDrag).toBe(true);
    // 20 css px * dpr 2 / zoom 10 = 4 world units, to the left.
    expect(cam.target.x).toBeCloseTo(-4, 6);
    expect(cam.target.y).toBeCloseTo(0, 6);
  });

  it('wasDrag resets on the next press', () => {
    const c = fakeCanvas();
    const cam = new CameraController(c as unknown as HTMLCanvasElement);
    c.fire('pointerdown', { clientX: 0, clientY: 0 });
    c.fire('pointermove', { clientX: 50, clientY: 50 });
    c.fire('pointerup', { clientX: 50, clientY: 50 });
    expect(cam.wasDrag).toBe(true);
    c.fire('pointerdown', { clientX: 50, clientY: 50 });
    expect(cam.wasDrag).toBe(false);
  });

  it('drag deltas use the canvas buffer/CSS ratio, not a capped DPR (D-03)', () => {
    const c = fakeCanvas(800, 600, 3);
    const cam = new CameraController(c as unknown as HTMLCanvasElement);
    cam.target.zoom = 1;
    c.fire('pointerdown', { clientX: 0, clientY: 0 });
    c.fire('pointermove', { clientX: 10, clientY: 0 });
    expect(cam.target.x).toBeCloseTo(-30, 6);
  });

  it('two pointers pinch: zoom follows the change in spacing (D-33)', () => {
    const c = fakeCanvas();
    const cam = new CameraController(c as unknown as HTMLCanvasElement);
    cam.target.zoom = 10;
    c.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
    c.fire('pointerdown', { pointerId: 2, clientX: 300, clientY: 300 });
    c.fire('pointermove', { pointerId: 2, clientX: 500, clientY: 300 });
    expect(cam.target.zoom).toBeCloseTo(20, 6);
    c.fire('pointerup', { pointerId: 2, clientX: 500, clientY: 300 });
    c.fire('pointerup', { pointerId: 1, clientX: 100, clientY: 300 });
    expect(cam.wasDrag).toBe(true);
  });
});

describe('CameraController.fit on empty bounds (D-08)', () => {
  it('keeps the camera where it is when the box has no extent', () => {
    const c = fakeCanvas();
    const cam = new CameraController(c as unknown as HTMLCanvasElement);
    cam.flyTo({ x: 3, y: 4, zoom: 12 }, 0);
    cam.fit({ minX: 0, maxX: 0, minY: 0, maxY: 0 }, 48, false);
    expect(cam.target).toEqual({ x: 3, y: 4, zoom: 12 });
    // The empty-grid case from the review: width but zero height.
    cam.fit({ minX: 0, maxX: 10, minY: 0, maxY: 0 }, 48, false);
    expect(cam.target).toEqual({ x: 3, y: 4, zoom: 12 });
    expect(cam.current.zoom).toBe(12);
  });

  it('still frames a real box', () => {
    const c = fakeCanvas(800, 600, 1);
    const cam = new CameraController(c as unknown as HTMLCanvasElement);
    cam.fit({ minX: 0, maxX: 100, minY: 0, maxY: 100 }, 0, false);
    expect(cam.target.x).toBe(50);
    expect(cam.target.y).toBe(50);
    expect(cam.target.zoom).toBeCloseTo(6, 6);
  });
});
