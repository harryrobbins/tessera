import { describe, it, expect } from 'vitest';
import { HIRES_MS_BUDGET, hiResWorthwhile, planTier, rasterBudgetLeft, tierBeatsBase, UNIQUE_MIN_PX } from '../src/gl/hires';
import { hiResCapacity } from '../src/gl/atlas';

/** Cards of `px` device pixels that fit a 3840x2160 drawing buffer. */
const onBuffer = (px: number, w = 3840, h = 2160) => Math.floor((w * h) / (px * px));

describe('planTier — the capacity-fitted hi-res tier (I-1.3)', () => {
  it('stays off below the size where a record could be read', () => {
    expect(planTier(UNIQUE_MIN_PX - 1, 10, 4096)).toBeNull();
    expect(planTier(0, 10, 4096)).toBeNull();
    expect(planTier(NaN, 10, 4096)).toBeNull();
    // Exactly at the floor it engages: the constant is the smallest size that
    // is worth a raster, not the first one above it.
    expect(planTier(UNIQUE_MIN_PX, 10, 4096)).toBe(64);
  });

  it('is null when there is nothing in view', () => {
    expect(planTier(200, 0, 4096)).toBeNull();
    expect(planTier(200, -1, 4096)).toBeNull();
  });

  it('never asks for a tier the atlas cannot cover the viewport at', () => {
    for (const visible of [1, 9, 50, 226, 901, 3136]) {
      for (const cardPx of [48, 64, 96, 129, 300, 700, 1040, 4000]) {
        const tier = planTier(cardPx, visible, 4096);
        if (tier === null) continue;
        expect(hiResCapacity(4096, tier, 4)).toBeGreaterThanOrEqual(visible);
      }
    }
  });

  it('returns null rather than a partial plan when even tier 64 cannot cover it', () => {
    // 3,136 slots is the whole 4096 texture at 64 px; one more card and no
    // tier fits, so the board keeps its base art uniformly.
    expect(planTier(64, 3136, 4096)).toBe(64);
    expect(planTier(64, 3137, 4096)).toBeNull();
  });

  it('reproduces the worked table on a 3840x2160 buffer and a 4096 texture', () => {
    const cases: Array<[number, number, number | null]> = [
      [48, onBuffer(48), null],   // 3,600 cards; 3,136 slots at tier 64
      [52, onBuffer(52), 64],     // 3,067
      [64, onBuffer(64), 64],     // 2,025
      [80, onBuffer(80), 64],     // 1,296 — tier 128 holds only 900
      [96, onBuffer(96), 128],    // 900, exactly tier 128's capacity
      [129, onBuffer(129), 128],  // 499
      [300, onBuffer(300), 256],  // 92
      [1040, onBuffer(1040), 1024], // 8
    ];
    for (const [cardPx, visible, tier] of cases) {
      expect([cardPx, planTier(cardPx, visible, 4096)]).toEqual([cardPx, tier]);
    }
  });

  it('steps down on a 2048 texture, where every tier holds a quarter as much', () => {
    expect(planTier(96, 225, 2048)).toBe(128);
    expect(planTier(96, 226, 2048)).toBe(64);   // 128 holds 225, 64 holds 784
    expect(planTier(600, 20, 2048)).toBe(256);  // 1024 holds 1, 512 holds 9, 256 holds 49
    expect(planTier(1040, 1, 2048)).toBe(1024);
    expect(planTier(1040, 2, 2048)).toBe(512);
  });

  it('fits the tier to the viewport rather than to the card (I-9.2)', () => {
    // The bug the user reported: zoomed right in on a large display, the
    // size-only rule asked for tier 1024, of which a 4096 texture holds nine —
    // nine crisp cards adrift in a field of stretched 64 px slots.
    expect(planTier(600, 20, 4096)).toBe(512);
    expect(hiResCapacity(4096, 512, 4)).toBe(49);
    expect(hiResCapacity(4096, 1024, 4)).toBe(9);
    // And it applies to per-item collections too: nothing here knows or cares
    // what the base atlas is holding.
    expect(planTier(900, 30, 4096)).toBe(512);
  });

  it('is monotone non-increasing in the number of cards to cover', () => {
    let last = Infinity;
    for (const visible of [1, 2, 8, 9, 10, 48, 49, 50, 224, 225, 226, 899, 900, 901, 3135, 3136]) {
      const tier = planTier(1040, visible, 4096) ?? 0;
      expect(tier).toBeLessThanOrEqual(last);
      last = tier;
    }
  });

  it('never rasterises larger than the card is drawn', () => {
    for (const cardPx of [48, 60, 64, 100, 128, 200, 512, 1024]) {
      const tier = planTier(cardPx, 1, 4096);
      expect(tier).not.toBeNull();
      expect(tier!).toBeLessThanOrEqual(Math.max(64, 2 ** Math.ceil(Math.log2(cardPx))));
    }
    // Past the 1024 ceiling the card is upscaled rather than the texture grown.
    expect(planTier(4000, 1, 4096)).toBe(1024);
  });
});

describe('hiResWorthwhile / tierBeatsBase — not re-painting what the base atlas has', () => {
  it('always earns its keep above the per-item cap, where the base atlas holds covers', () => {
    expect(hiResWorthwhile(48, false, 1024)).toBe(true);
    expect(tierBeatsBase(64, false, 512)).toBe(true);
  });

  it('is off while a per-item card is drawn no larger than its own base slot', () => {
    // The GPU baseline's 92 ms frame: 900 cards fitted to a 3608 px canvas are
    // 67 device px, and the base atlas already holds each of them at 128.
    expect(hiResWorthwhile(67, true, 128)).toBe(false);
    expect(hiResWorthwhile(128, true, 128)).toBe(false);
    expect(hiResWorthwhile(129, true, 128)).toBe(true);
  });

  it('is off again when the tier the scan settles on is no better than the slot', () => {
    // 1,000 cards at 65 px want tier 128, which a 4096 texture holds only 900
    // of, so planTier steps down to 64 — exactly the base slot, and a thousand
    // re-rasters for no texel.
    expect(planTier(65, 1000, 4096)).toBe(64);
    expect(tierBeatsBase(64, true, 64)).toBe(false);
    expect(tierBeatsBase(128, true, 64)).toBe(true);
  });
});

describe('rasterBudgetLeft — the settle tick budget', () => {
  it('always paints one card, however long that card takes', () => {
    expect(rasterBudgetLeft(0, 900)).toBe(true);
  });

  it('stops once the budget is spent, and keeps going while it is not', () => {
    expect(rasterBudgetLeft(1, HIRES_MS_BUDGET - 0.5)).toBe(true);
    expect(rasterBudgetLeft(1, HIRES_MS_BUDGET)).toBe(false);
    expect(rasterBudgetLeft(240, HIRES_MS_BUDGET + 40)).toBe(false);
  });

  it('bounds the tick whatever the tier costs per card, which a pixel budget could not', () => {
    // 4 Mpx was 256 cards at tier 128 and four at tier 1024; the cost of a card
    // is its text, not its area, so those two ticks were nothing alike.
    for (const perCard of [0.05, 0.4, 3.5, 17]) {
      let painted = 0;
      let elapsed = 0;
      while (rasterBudgetLeft(painted, elapsed)) { painted++; elapsed += perCard; }
      expect(elapsed).toBeLessThan(HIRES_MS_BUDGET + perCard);
    }
  });
});
