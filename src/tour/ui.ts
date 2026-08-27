import type { TourStep, SpotRect } from './engine';
import { esc } from '../core/esc';

export interface TourUIHandlers {
  onNext(): void;
  onBack(): void;
  onSkip(): void;
  onMute(): void;
}

const SPOT_PAD = 6;
const GAP = 14;      // spotlight edge → card edge
const MARGIN = 12;   // card → viewport edge
type Side = 'below' | 'above' | 'right' | 'left';

/**
 * The overlay: a spotlight cut-out that follows the current step's target, a
 * caption card with controls, and a welcome card shown before anything plays.
 * Pointer events pass through everywhere except the card itself.
 */
export class TourUI {
  readonly root: HTMLElement;
  private readonly spot: HTMLElement;
  private readonly card: HTMLElement;
  private readonly counter: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly arrow: HTMLElement;
  private readonly title: HTMLElement;
  private resolve: (() => Element | SpotRect | null) | null = null;
  private handlers: TourUIHandlers;
  private lastFocus: Element | null = null;
  /** rAF handle while a rect target (a card on the canvas) is being tracked. */
  private track = 0;
  private lastRect = '';

  constructor(parent: HTMLElement, handlers: TourUIHandlers) {
    this.handlers = handlers;
    this.root = h('div', 'tour');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Guided tour');
    this.spot = h('div', 'tour-spot');
    this.spot.hidden = true;
    this.card = h('div', 'tour-card');
    this.card.hidden = true;
    this.counter = h('span', 'tour-step');
    this.title = h('h2', 'tour-title');
    this.arrow = h('i', 'tour-arrow');
    this.caption = h('p', 'tour-caption');
    this.caption.setAttribute('aria-live', 'polite');
    this.muteBtn = button('Mute', 'tour-mute', 'Mute narration (M)');
    this.muteBtn.setAttribute('aria-pressed', 'false');
    this.backBtn = button('Back', 'tour-back', 'Previous step (←)');
    this.nextBtn = button('Next', 'tour-next', 'Next step (→)');
    this.nextBtn.classList.add('primary');
    const skipBtn = button('Skip tour', 'tour-skip', 'Leave the tour (Esc)');
    const head = h('div', 'tour-head');
    head.append(this.counter, this.muteBtn);
    const foot = h('div', 'tour-foot');
    foot.append(skipBtn, h('span', 'spacer'), this.backBtn, this.nextBtn);
    this.card.append(this.arrow, head, this.title, this.caption, foot);
    this.root.append(this.spot, this.card);
    parent.appendChild(this.root);

    this.backBtn.addEventListener('click', () => handlers.onBack());
    this.nextBtn.addEventListener('click', () => handlers.onNext());
    skipBtn.addEventListener('click', () => handlers.onSkip());
    this.muteBtn.addEventListener('click', () => handlers.onMute());
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.reposition);
    window.addEventListener('scroll', this.reposition, true);
    this.lastFocus = document.activeElement;
  }

  /** Welcome card: nothing plays until the visitor clicks Start. */
  showWelcome(onStart: () => void, onDismiss: () => void): void {
    this.spot.hidden = true;
    this.card.hidden = true;
    const w = h('div', 'tour-card tour-welcome');
    w.innerHTML =
      '<h2>Welcome to Tessera</h2>' +
      '<p>A two-minute guided tour, with narration, shows what the collection view can do: ' +
      'sort, bucket, cross-tabulate, filter and zoom — all without redrawing a single card.</p>';
    const foot = h('div', 'tour-foot');
    const later = button('Not now', 'tour-dismiss');
    const start = button('Start tour', 'tour-start');
    start.classList.add('primary');
    foot.append(later, h('span', 'spacer'), start);
    w.append(foot);
    this.root.appendChild(w);
    later.addEventListener('click', () => { w.remove(); onDismiss(); });
    start.addEventListener('click', () => { w.remove(); onStart(); });
    start.focus();
  }

  showStep(step: TourStep, index: number, total: number): void {
    this.card.hidden = false;
    this.counter.textContent = `Step ${index + 1} of ${total}`;
    this.title.textContent = step.title ?? '';
    this.title.hidden = !step.title;
    this.caption.innerHTML = markup(step.text);
    this.backBtn.disabled = index === 0;
    this.nextBtn.textContent = index === total - 1 ? 'Finish' : 'Next';
    this.spotlight(step);
    if (!this.card.contains(document.activeElement)) this.nextBtn.focus();
  }

  spotlight(step: TourStep): void {
    const target = step.target;
    this.resolve = typeof target === 'function' ? target
      : target ? () => document.querySelector(target) : null;
    const t = this.resolve?.() ?? null;
    // Sidebar rows and the far end of the topbar can sit beyond a scroll edge.
    if (t instanceof Element) { try { t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* jsdom */ } }
    this.reposition();
  }

  setMuted(muted: boolean): void {
    this.muteBtn.setAttribute('aria-pressed', String(muted));
    this.muteBtn.textContent = muted ? 'Unmute' : 'Mute';
  }

  destroy(): void {
    this.stopTracking();
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.reposition);
    window.removeEventListener('scroll', this.reposition, true);
    this.root.remove();
    if (this.lastFocus instanceof HTMLElement) this.lastFocus.focus();
  }

  private reposition = (): void => {
    const t = this.resolve?.() ?? null;
    const r = t instanceof Element ? t.getBoundingClientRect() : t;
    // A rect target is a card on the canvas: it moves when the user pans or
    // zooms, which fires no resize/scroll, so follow it frame by frame.
    if (t && !(t instanceof Element)) this.startTracking(); else this.stopTracking();
    if (!t || !r || (r.width === 0 && r.height === 0)) {
      this.spot.hidden = true;
      this.placeCard(null);
      return;
    }
    this.spot.hidden = false;
    const spot = { left: r.left - SPOT_PAD, top: r.top - SPOT_PAD, width: r.width + SPOT_PAD * 2, height: r.height + SPOT_PAD * 2 };
    this.spot.style.left = `${spot.left}px`;
    this.spot.style.top = `${spot.top}px`;
    this.spot.style.width = `${spot.width}px`;
    this.spot.style.height = `${spot.height}px`;
    this.placeCard(spot);
  };

  private startTracking(): void {
    // The transition animates the spotlight *between steps*. While it is
    // following a card on the canvas it must sit exactly on it: a 0.35 s ease
    // restarted every frame leaves the ring trailing the card it is pointing
    // at, and the caption — which is placed from the true rect — beside a
    // spotlight that has not arrived yet.
    this.spot.classList.add('tracking');
    // The caption is placed from the same rect, and its own .3s glide would
    // leave it lagging a card the camera is still settling on to — and, for a
    // couple of hundred milliseconds, sitting over the very card it points at.
    this.card.classList.add('tracking');
    if (this.track || typeof requestAnimationFrame !== 'function') return;
    const tick = () => {
      this.track = requestAnimationFrame(tick);
      const t = this.resolve?.() ?? null;
      if (!t || t instanceof Element) { this.reposition(); return; }
      const key = `${t.left},${t.top},${t.width},${t.height}`;
      if (key !== this.lastRect) { this.lastRect = key; this.reposition(); }
    };
    this.track = requestAnimationFrame(tick);
  }

  private stopTracking(): void {
    this.spot.classList.remove('tracking');
    this.card.classList.remove('tracking');
    if (this.track) cancelAnimationFrame(this.track);
    this.track = 0;
    this.lastRect = '';
  }

  /**
   * Put the card next to the spotlight — below it by preference, else above,
   * right, or left, whichever fits — with the arrow pointing at the target.
   * No target: bottom-centre, no arrow.
   */
  private placeCard(spot: { left: number; top: number; width: number; height: number } | null): void {
    const card = this.card;
    if (card.hidden) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    card.classList.remove('side-below', 'side-above', 'side-right', 'side-left', 'floating');
    if (!spot) {
      card.classList.add('floating');
      card.style.left = `${Math.max(MARGIN, (vw - card.offsetWidth) / 2)}px`;
      card.style.top = `${vh - card.offsetHeight - 28}px`;
      return;
    }
    const cw = card.offsetWidth;
    const chh = card.offsetHeight;
    const fits: Record<Side, boolean> = {
      below: spot.top + spot.height + GAP + chh + MARGIN <= vh,
      above: spot.top - GAP - chh >= MARGIN,
      right: spot.left + spot.width + GAP + cw + MARGIN <= vw,
      left: spot.left - GAP - cw >= MARGIN,
    };
    const side: Side = (['below', 'above', 'right', 'left'] as Side[]).find((s) => fits[s]) ?? 'below';
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    const cx = spot.left + spot.width / 2;
    const cy = spot.top + spot.height / 2;
    let left: number;
    let top: number;
    if (side === 'below' || side === 'above') {
      left = clamp(cx - cw / 2, MARGIN, vw - cw - MARGIN);
      top = side === 'below' ? spot.top + spot.height + GAP : spot.top - GAP - chh;
      this.arrow.style.left = `${clamp(cx - left, 18, cw - 18)}px`;
      this.arrow.style.top = '';
    } else {
      top = clamp(cy - chh / 2, MARGIN, vh - chh - MARGIN);
      left = side === 'right' ? spot.left + spot.width + GAP : spot.left - GAP - cw;
      this.arrow.style.top = `${clamp(cy - top, 18, chh - 18)}px`;
      this.arrow.style.left = '';
    }
    card.classList.add(`side-${side}`);
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(clamp(top, MARGIN, vh - chh - MARGIN))}px`;
  }

  /**
   * Keyboard map. Escape works anywhere, M anywhere but a form field;
   * Enter/Space/arrows advance only
   * when nothing outside the tour has focus (body, or the tour card itself),
   * so a focused control on the page — the detail pane's links, a layout tab,
   * a facet checkbox, a select — keeps its native activation.
   */
  private onKey = (e: KeyboardEvent): void => {
    const target = e.target as Node | null;
    const inCard = target !== null && this.root.contains(target);
    const onPage = target !== null && target !== document.body && !inCard;
    const tag = (target as HTMLElement | null)?.tagName ?? '';
    const isButton = tag === 'BUTTON';
    const editable = tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA';
    if (e.key === 'Tab') { this.trapTab(e); return; }
    if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); this.handlers.onSkip(); return; }
    if ((e.key === 'm' || e.key === 'M') && !editable) { e.stopImmediatePropagation(); e.preventDefault(); this.handlers.onMute(); return; }
    if (onPage) return;
    if (e.key === 'ArrowRight' || ((e.key === ' ' || e.key === 'Enter') && !(inCard && isButton))) {
      if (!this.card.hidden) { e.stopImmediatePropagation(); e.preventDefault(); this.handlers.onNext(); }
      return;
    }
    if (e.key === 'ArrowLeft') {
      if (!this.card.hidden) { e.stopImmediatePropagation(); e.preventDefault(); this.handlers.onBack(); }
    }
  };

  private trapTab(e: KeyboardEvent): void {
    const focusable = Array.from(this.root.querySelectorAll<HTMLElement>('button:not([disabled])'))
      .filter((b) => b.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (!this.root.contains(active)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }
}

function h(tag: string, cls: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}

function button(label: string, cls: string, title?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  if (title) b.title = title;
  return b;
}

/** Escape, then turn **term** into <b>. */
export function markup(text: string): string {
  return esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}
