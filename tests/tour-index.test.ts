import { describe, it, expect } from 'vitest';
import { shouldAutoStart } from '../src/tour/index';
import { TOUR_KEY, TOUR_DONE, markTourDone, safeStorage } from '../src/tour/store';

const params = (q: string) => new URLSearchParams(q);
const empty = { getItem: () => null };
const done = { getItem: (k: string) => (k === TOUR_KEY ? TOUR_DONE : null) };
const throwing = { getItem: (): string | null => { throw new Error('SecurityError'); } };

describe('shouldAutoStart', () => {
  it('?tour=1 forces it, even after completion or with a deep link', () => {
    expect(shouldAutoStart(params('tour=1'), done)).toBe(true);
    expect(shouldAutoStart(params('tour=1&dataset=x&bench=1'), done)).toBe(true);
  });

  it('?tour=0 suppresses it on a first visit', () => {
    expect(shouldAutoStart(params('tour=0'), empty)).toBe(false);
  });

  it('never interrupts a benchmark or a deep-linked dataset', () => {
    expect(shouldAutoStart(params('bench=1'), empty)).toBe(false);
    expect(shouldAutoStart(params('dataset=tax-cases:900'), empty)).toBe(false);
  });

  it('opens on a first visit only', () => {
    expect(shouldAutoStart(params(''), empty)).toBe(true);
    expect(shouldAutoStart(params(''), done)).toBe(false);
  });

  it('treats unavailable storage as a first visit', () => {
    expect(shouldAutoStart(params(''), null)).toBe(true);
    expect(shouldAutoStart(params(''), throwing)).toBe(true);
  });
});

describe('tour store', () => {
  it('markTourDone writes the done marker and swallows storage errors', () => {
    const m = new Map<string, string>();
    markTourDone({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } });
    expect(m.get(TOUR_KEY)).toBe(TOUR_DONE);
    expect(() => markTourDone({ getItem: () => null, setItem: () => { throw new Error('quota'); } })).not.toThrow();
    expect(() => markTourDone(null)).not.toThrow();
  });

  it('safeStorage is null outside a browser', () => {
    expect(safeStorage()).toBeNull();
  });
});
