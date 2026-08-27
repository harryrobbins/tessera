/**
 * Hi-res card selection — pure functions, so the policy is unit-testable
 * without a GPU. The renderer owns the texture; PivotApp owns the state.
 */
import { hiResCapacity, nextPow2 } from './atlas';
import type { Camera } from './renderer';

/**
 * Indices of cards whose target rect intersects the viewport expanded by
 * `margin` (a fraction of the viewport on each side), nearest the centre first.
 * `to` is the renderer's x, y, size, alpha layout; `w`/`h` are device pixels.
 */
export function visibleCards(
  to: Float32Array,
  count: number,
  cam: Camera,
  w: number,
  h: number,
  margin = 0.25,
): number[] {
  const halfW = (w / cam.zoom) * (0.5 + margin);
  const halfH = (h / cam.zoom) * (0.5 + margin);
  const hits: Array<{ i: number; d: number }> = [];
  for (let i = 0; i < count; i++) {
    if (!intersects(to, i, cam, halfW, halfH)) continue;
    const o = i * 4;
    const dx = to[o] - cam.x;
    const dy = to[o + 1] - cam.y;
    hits.push({ i, d: dx * dx + dy * dy });
  }
  hits.sort((a, b) => a.d - b.d || a.i - b.i);
  return hits.map((hit) => hit.i);
}

/** Card `i`'s target rect against a viewport half-extent, in world units. */
function intersects(to: Float32Array, i: number, cam: Camera, halfW: number, halfH: number): boolean {
  const o = i * 4;
  const size = to[o + 2];
  if (!(size > 0) || to[o + 3] === 0) return false;
  const half = size * 0.5;
  return Math.abs(to[o] - cam.x) - half <= halfW && Math.abs(to[o + 1] - cam.y) - half <= halfH;
}

/**
 * Those of `cards` that are on screen right now, in the order given.
 *
 * The tier and the commit are fitted to *this* set rather than to the scan's
 * pre-load margin: a card about to scroll into view has no business pushing
 * every card already on screen down a tier, and the invariant §1.6 protects is
 * about what the user can see.
 */
export function onScreenCards(cards: readonly number[], to: Float32Array, cam: Camera, w: number, h: number): number[] {
  const halfW = (w / cam.zoom) * 0.5;
  const halfH = (h / cam.zoom) * 0.5;
  return cards.filter((i) => intersects(to, i, cam, halfW, halfH));
}

/**
 * Whether a plan can be committed: every card in view has art in the hi-res
 * atlas. Until it does, flipping the ones that are ready would put a record
 * beside a group cover, which reads worse than either on its own — so the
 * caller keeps rasterising and commits the whole plan in one frame.
 */
export function planReady(wanted: readonly number[], rastered: { has(card: number): boolean }): boolean {
  for (const card of wanted) if (!rastered.has(card)) return false;
  return true;
}

/** Below this the card is too small for its own art to say anything a group
 *  cover does not; the hi-res pass stays off and the base atlas is enough. */
export const UNIQUE_MIN_PX = 48;

/**
 * The raster tier for a plan that must cover `visible` cards, or null when no
 * tier can. Never larger than the card is drawn (no wasted texels) and never
 * larger than the atlas can hold the whole viewport at (no mixed art).
 *
 * The size-only rule this replaced took no account of how many cards needed a
 * slot: zoomed in on a large display every visible card asks for tier 1024, of
 * which a 4096 texture holds nine, so nine cards were sharp and the rest kept
 * the 64 px base slot stretched over hundreds of device pixels. Stepping the
 * tier down until the viewport fits costs at most a 1.5x upscale in a narrow
 * band above each power of two — soft, since the texture carries mips and
 * anisotropy, and uniform, which is the point.
 */
export function planTier(cardPx: number, visible: number, hiSize: number, pad = 4, max = 1024): number | null {
  if (!(cardPx >= UNIQUE_MIN_PX) || visible <= 0) return null;
  let t = Math.min(max, Math.max(64, nextPow2(Math.ceil(cardPx))));
  while (t > 64 && hiResCapacity(hiSize, t, pad) < visible) t >>= 1;
  return hiResCapacity(hiSize, t, pad) >= visible ? t : null;
}

/**
 * Side of the hi-res texture: the smallest power of two whose area covers the
 * drawing buffer four times over (enough slots for the visible set plus its
 * margin), within [2048, min(4096, maxTex)].
 */
export function hiResTextureSize(bufW: number, bufH: number, maxTex: number): number {
  const want = Math.sqrt(bufW * bufH * 4);
  let size = 2048;
  while (size < want && size < 4096) size <<= 1;
  return Math.min(size, maxTex);
}

/**
 * Identity of one hi-res plan: the camera, the drawing buffer and the layout
 * solve it was made against. `updateHiRes` skips the scan while this is
 * unchanged, so anything that moves cards under a still camera (a re-sort, a
 * filter, a layout change) must bump `solveSeq`.
 *
 * The tier is deliberately *not* in the key: `planTier` derives it from the
 * card size and the visible count, both of which are already determined by
 * these inputs, and it is only knowable after the scan the key exists to skip.
 */
export function hiResKey(cam: Camera, w: number, h: number, solveSeq: number): string {
  return `${cam.x},${cam.y},${cam.zoom},${w},${h},${solveSeq}`;
}

/**
 * Whether a hi-res plan can add anything the base atlas has not already got.
 *
 * Above the per-item cap the base atlas holds group covers, so a row's own
 * record only ever exists here — the pass always earns its keep. Below it the
 * base atlas already holds *this row's card*, painted at `baseSlot` px; at or
 * under that size on screen, re-rasterising the whole viewport spends a
 * hundred milliseconds of Canvas2D to arrive at the texels it started with.
 * That was the 92 ms frame in the GPU baseline: 900 cards fitted to a 3608 px
 * canvas are 67 device px against a 128 px base slot.
 */
export function hiResWorthwhile(cardPx: number, perItem: boolean, baseSlot: number): boolean {
  return !perItem || cardPx > baseSlot;
}

/**
 * Whether a plan at `tier` beats the art already in the base atlas.
 *
 * `hiResWorthwhile` asks the same question of the card's on-screen size, which
 * is the cheap test that skips the viewport scan; this one asks it of the tier
 * the scan actually settled on, and the two can disagree. `planTier` steps down
 * until the whole viewport fits, so a thousand 65 px cards on a large display
 * come back as tier 64 — a re-raster of every row at exactly the resolution its
 * base slot already holds.
 */
export function tierBeatsBase(tier: number, perItem: boolean, baseSlot: number): boolean {
  return !perItem || tier > baseSlot;
}

/**
 * Wall-clock milliseconds one settle tick may spend painting cards.
 *
 * A pixel budget cannot bound this. A card's cost is dominated by shaping and
 * drawing its text, which barely moves with the slot size, so the 4 Mpx budget
 * this replaced was 256 cards at tier 128 and four at tier 1024 — two orders
 * of magnitude apart in pixels, but 256 cards is a 92 ms frame either way.
 */
export const HIRES_MS_BUDGET = 5;

/**
 * Whether the raster loop may paint another card this tick. Always the first,
 * so a tier whose single card costs more than the whole budget still makes
 * progress; never one that would start after the budget is already spent.
 */
export function rasterBudgetLeft(painted: number, elapsedMs: number, budgetMs = HIRES_MS_BUDGET): boolean {
  return painted === 0 || elapsedMs < budgetMs;
}
