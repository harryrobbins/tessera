import { describe, it, expect } from 'vitest';
import { slotFor, hiResCapacity, nextPow2, slotRect } from '../src/gl/atlas';
import { visibleCards, onScreenCards, hiResTextureSize } from '../src/gl/hires';

// Only the pure sizing maths is under test: CardAtlas itself needs a Canvas2D
// context and this suite runs in node.

describe('slotFor', () => {
  it('sizes the slot to the collection', () => {
    expect(slotFor(891)).toBe(128);
    expect(slotFor(8)).toBe(1024);
    expect(slotFor(100)).toBe(256);
    expect(slotFor(1)).toBe(1024);
  });

  it('clamps to the 64 px floor for collections past the per-item ceiling', () => {
    expect(slotFor(3844)).toBe(64);
    expect(slotFor(100_000)).toBe(64);
  });

  it('is monotone non-increasing in n', () => {
    let prev = Infinity;
    for (let n = 1; n <= 4000; n++) {
      const s = slotFor(n);
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
  });

  it('fits a ceil(sqrt(n))-column grid of padded slots in 4096 up to the 64 px capacity', () => {
    const cap = hiResCapacity(4096, 64, 4);
    expect(cap).toBe(3136);
    for (let n = 1; n <= cap; n++) {
      expect((slotFor(n) + 8) * Math.ceil(Math.sqrt(n))).toBeLessThanOrEqual(4096);
    }
  });
});

describe('hiResCapacity / slotRect', () => {
  it('counts padded slots in a square grid', () => {
    expect(hiResCapacity(4096, 128, 4)).toBe(30 * 30);
    expect(hiResCapacity(4096, 1024, 4)).toBe(3 * 3);
    expect(hiResCapacity(4096, 512, 4)).toBe(7 * 7);
  });

  it('places slot i on a padded pitch with a uv rect that excludes the bleed', () => {
    const r = slotRect(31, 4096, 128, 4, 30);
    expect(r.x).toBe(136 + 4);
    expect(r.y).toBe(136 + 4);
    expect(r.uv).toEqual([140 / 4096, 140 / 4096, 268 / 4096, 268 / 4096]);
  });

  it('nextPow2', () => {
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(129)).toBe(256);
    expect(nextPow2(512)).toBe(512);
  });
});

describe('visibleCards', () => {
  // A 10x10 grid at unit pitch, cards 0.86 wide, alpha 1.
  const n = 100;
  const to = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    to[i * 4] = i % 10;
    to[i * 4 + 1] = Math.floor(i / 10);
    to[i * 4 + 2] = 0.86;
    to[i * 4 + 3] = 1;
  }

  it('returns the centre 3x3 nearest-first when the viewport shows exactly that', () => {
    // Centre on card (4,4); 3 world units across at zoom 100 = 300 px.
    const cam = { x: 4, y: 4, zoom: 100 };
    const got = visibleCards(to, n, cam, 300, 300, 0);
    expect(got.length).toBe(9);
    expect(got[0]).toBe(44);
    // Edge neighbours before diagonals.
    expect(new Set(got.slice(1, 5))).toEqual(new Set([34, 43, 45, 54]));
    expect(new Set(got.slice(5))).toEqual(new Set([33, 35, 53, 55]));
  });

  it('grows the set with the margin and never counts hidden cards', () => {
    const cam = { x: 4, y: 4, zoom: 100 };
    const withMargin = visibleCards(to, n, cam, 300, 300, 0.25);
    expect(withMargin.length).toBeGreaterThan(9);
    expect(withMargin[0]).toBe(44);
    const hidden = new Float32Array(to);
    hidden[44 * 4 + 3] = 0;
    expect(visibleCards(hidden, n, cam, 300, 300, 0)).not.toContain(44);
  });

  it('onScreenCards narrows a margined scan back to the viewport itself', () => {
    const cam = { x: 4, y: 4, zoom: 100 };
    const near = visibleCards(to, n, cam, 300, 300, 0.25);
    const on = onScreenCards(near, to, cam, 300, 300);
    // The same set the margin-free scan finds, in the scan's nearest-first order.
    expect(on).toEqual(visibleCards(to, n, cam, 300, 300, 0));
    expect(on.length).toBe(9);
    expect(near.length).toBeGreaterThan(on.length);
    // A card the caller never scanned is never invented.
    expect(onScreenCards([], to, cam, 300, 300)).toEqual([]);
  });
});

describe('hiResTextureSize', () => {
  it('covers the drawing buffer four times over within [2048, 4096]', () => {
    expect(hiResTextureSize(1920, 1080, 16384)).toBe(4096);
    expect(hiResTextureSize(3840, 2160, 16384)).toBe(4096);
    expect(hiResTextureSize(800, 600, 16384)).toBe(2048);
    expect(hiResTextureSize(3840, 2160, 2048)).toBe(2048);
  });
});
