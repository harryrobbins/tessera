import { describe, it, expect } from 'vitest';
import { wholePixelZoom, stepWholePixelZoom, stepFreeZoom, ZOOM_FACTOR } from '../src/gl/zoom';

/** The rungs a raster may sit on, ascending. */
const LADDER = [1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4, 5];

describe('wholePixelZoom', () => {
  it('leaves a rung where it is', () => {
    for (const z of LADDER) expect(wholePixelZoom(z)).toBeCloseTo(z, 10);
  });

  it('rounds in log space, so 1.42 goes up to 2 rather than down to 1', () => {
    expect(wholePixelZoom(1.4203)).toBe(2);
    expect(wholePixelZoom(1.2)).toBe(1);
    // the tipping point between rungs is their geometric mean
    expect(wholePixelZoom(Math.sqrt(2) - 1e-6)).toBe(1);
    expect(wholePixelZoom(Math.sqrt(2) + 1e-6)).toBe(2);
  });

  it('steps 1/2, 1/3 below 1:1', () => {
    expect(wholePixelZoom(0.45)).toBeCloseTo(1 / 2, 10);
    expect(wholePixelZoom(0.36)).toBeCloseTo(1 / 3, 10);
  });

  it('always returns a rung', () => {
    for (let z = 0.05; z < 12; z += 0.017) {
      const r = wholePixelZoom(z);
      const isRung = Math.abs(r - Math.round(r)) < 1e-9 || Math.abs(1 / r - Math.round(1 / r)) < 1e-9;
      expect(isRung).toBe(true);
    }
  });
});

describe('stepWholePixelZoom', () => {
  it('moves exactly one rung from a rung', () => {
    for (let i = 0; i < LADDER.length - 1; i++) {
      expect(stepWholePixelZoom(LADDER[i], 1)).toBeCloseTo(LADDER[i + 1], 10);
      expect(stepWholePixelZoom(LADDER[i + 1], -1)).toBeCloseTo(LADDER[i], 10);
    }
  });

  it('from between rungs, moves to the adjacent one and never skips', () => {
    // 1.42 sits between 1 and 2: up is 2, not 3; down is 1.
    expect(stepWholePixelZoom(1.4203, 1)).toBe(2);
    expect(stepWholePixelZoom(1.4203, -1)).toBe(1);
    expect(stepWholePixelZoom(0.4, 1)).toBeCloseTo(1 / 2, 10);
    expect(stepWholePixelZoom(0.4, -1)).toBeCloseTo(1 / 3, 10);
  });

  it('crosses 1:1 in both directions without landing on it twice', () => {
    expect(stepWholePixelZoom(1, -1)).toBeCloseTo(1 / 2, 10);
    expect(stepWholePixelZoom(1 / 2, 1)).toBe(1);
    expect(stepWholePixelZoom(1, 1)).toBe(2);
    expect(stepWholePixelZoom(2, -1)).toBe(1);
  });

  it('is strictly monotonic and reversible across the ladder', () => {
    let z = 1 / 4;
    for (let i = 0; i < 8; i++) {
      const up = stepWholePixelZoom(z, 1);
      expect(up).toBeGreaterThan(z);
      expect(stepWholePixelZoom(up, -1)).toBeCloseTo(z, 10);
      z = up;
    }
  });

  it('never goes below 1:N for any N, or returns a non-positive scale', () => {
    let z = 1;
    for (let i = 0; i < 40; i++) {
      z = stepWholePixelZoom(z, -1);
      expect(z).toBeGreaterThan(0);
    }
  });
});

describe('stepFreeZoom', () => {
  it('is geometric and reversible', () => {
    expect(stepFreeZoom(10, 1)).toBeCloseTo(10 * ZOOM_FACTOR, 10);
    expect(stepFreeZoom(stepFreeZoom(10, 1), -1)).toBeCloseTo(10, 10);
  });
});
