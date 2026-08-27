import type { KeyValueStore } from './engine';

/** localStorage key recording that the visitor finished or dismissed the tour. */
export const TOUR_KEY = 'tessera.tour.v1';
export const TOUR_DONE = 'done';

/** localStorage, or null where it is absent or throws (private mode, sandboxed iframes). */
export function safeStorage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** Record completion; never throws. */
export function markTourDone(store: KeyValueStore | null = safeStorage(), key = TOUR_KEY): void {
  try { store?.setItem(key, TOUR_DONE); } catch { /* private mode */ }
}
