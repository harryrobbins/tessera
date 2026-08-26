import { describe, it, expect } from 'vitest';
import { clamp } from '../src/gl/camera';
import { mulberry32, randRange } from './helpers/prng';

// Only the pure `clamp` helper is under test here — CameraController itself
// wires up DOM pointer/wheel listeners and needs a real HTMLCanvasElement,
// which is out of scope for this node-environment unit suite.
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
