/**
 * FLIP: run the modal from the card's own rect into its final one.
 *
 * The card is what the user clicked, so the dialog should look like that card
 * getting bigger rather than a panel arriving from nowhere. First/Last are
 * measured, Invert is a transform applied for one frame, Play is the class
 * that transitions it away.
 */

export interface Rect { left: number; top: number; width: number; height: number }

/** How long the expansion runs, given the app's transition budget. */
export const FLIP_MS = 260;

/**
 * Animate `el` as though it grew out of `from`. Returns immediately; the
 * transition owns the element until it finishes. `ms <= 0` (reduced motion)
 * applies nothing at all, so there is no intermediate frame to catch.
 */
export function expandFrom(el: HTMLElement, from: Rect | null, ms: number): void {
  el.classList.remove('opening');
  el.style.transform = '';
  el.style.transformOrigin = '';
  if (ms <= 0) return;

  const to = el.getBoundingClientRect();
  if (to.width === 0 || to.height === 0) return;
  // No origin card (off-screen, or filtered out): grow slightly from centre.
  const scale = from ? from.width / to.width : 0.96;
  const dx = from ? from.left - to.left : (to.width * (1 - scale)) / 2;
  const dy = from ? from.top - to.top : (to.height * (1 - scale)) / 2;

  el.style.transformOrigin = '0 0';
  // A uniform scale: scaling x and y independently distorts the header text
  // for the whole flight, which is exactly the part the eye follows.
  el.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
  el.style.setProperty('--flip-ms', `${ms}ms`);
  // Force the browser to take the inverted position as the starting point
  // before the class that transitions away from it lands.
  void el.offsetWidth;
  el.classList.add('opening');
  el.style.transform = '';
  const done = () => { el.classList.remove('opening'); el.style.transformOrigin = ''; };
  el.addEventListener('transitionend', done, { once: true });
  // A transition that never fires (element hidden again mid-flight) must not
  // leave the class on: it would suppress the next open's own transition.
  setTimeout(done, ms + 120);
}
