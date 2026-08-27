import { describe, it, expect } from 'vitest';
import { hiResKey, planReady, planTier } from '../src/gl/hires';
import { computeLayout, CARD_SIZE, MAP_DOT, CARD_PITCH, type LayoutData } from '../src/layout/layouts';

const cam = { x: 1.5, y: -2, zoom: 40 };

describe('hiResKey (H-01)', () => {
  it('is stable while nothing changed', () => {
    expect(hiResKey(cam, 800, 600, 7)).toBe(hiResKey({ ...cam }, 800, 600, 7));
  });

  it('changes with the camera and the buffer', () => {
    const base = hiResKey(cam, 800, 600, 7);
    expect(hiResKey({ ...cam, zoom: 41 }, 800, 600, 7)).not.toBe(base);
    expect(hiResKey({ ...cam, x: 1.6 }, 800, 600, 7)).not.toBe(base);
    expect(hiResKey(cam, 801, 600, 7)).not.toBe(base);
    expect(hiResKey(cam, 800, 601, 7)).not.toBe(base);
  });

  it('changes when the layout is re-solved under a still camera', () => {
    // A filter, re-sort or layout change moves cards without moving the
    // camera; the plan must be redone, not skipped.
    expect(hiResKey(cam, 800, 600, 8)).not.toBe(hiResKey(cam, 800, 600, 7));
  });
});

describe('planReady - the atomic commit (I-1.6)', () => {
  it('commits nothing while any card in view is still missing its art', () => {
    const rastered = new Map([[4, 0], [9, 1]]);
    expect(planReady([4, 9], rastered)).toBe(true);
    expect(planReady([4, 9, 12], rastered)).toBe(false);
  });

  it('is vacuously ready for an empty viewport, and ignores spare slots', () => {
    expect(planReady([], new Map())).toBe(true);
    // Art left over from the previous plan does not make this one complete.
    expect(planReady([1], new Map([[2, 0], [3, 1]]))).toBe(false);
  });
});

describe('hi-res tier from the layout card size (M-01)', () => {
  const data: LayoutData = {
    n: 4,
    columns: {
      lon: { kind: 'number', name: 'lon', values: new Float32Array([0, 1, 2, 3]), min: 0, max: 3 },
      lat: { kind: 'number', name: 'lat', values: new Float32Array([0, 1, 2, 3]), min: 0, max: 3 },
    },
  };

  it('reports the drawn card size independently of card 0 being masked out', () => {
    const mask = new Uint8Array([0, 1, 1, 1]);
    const grid = computeLayout(data, { type: 'grid' }, mask, 1);
    expect(grid.positions[2]).toBe(0); // card 0 masked: its own size is useless
    expect(grid.cardSize).toBe(CARD_SIZE);
    expect(computeLayout(data, { type: 'xy', x: 'lon', y: 'lat', equal: true }, mask, 1).cardSize).toBe(MAP_DOT);
    expect(computeLayout(data, { type: 'xy', x: 'lon', y: 'lat' }, mask, 1).cardSize).toBe(CARD_PITCH);
  });

  it('plans from cardSize * zoom, so a masked card 0 does not switch it off', () => {
    const zoom = 400;
    expect(planTier(0 * zoom, 20, 4096)).toBeNull(); // what card 0's slot would say
    expect(planTier(CARD_SIZE * zoom, 20, 4096)).toBe(512);
  });
});
