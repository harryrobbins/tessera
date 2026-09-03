import type { TourStep, SpotRect } from './engine';
import { esc } from '../core/esc';

/** One narratable collection, offered on the welcome card. */
export interface TourChoice {
  id: string;
  label: string;
  blurb: string;
}

export interface TourUIHandlers {
  onNext(): void;
  onBack(): void;
  onSkip(): void;
  onMute(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const SPOT_PAD = 6;   // spotlight ring → target edge
const HALO = 10;      // where the beam stops short of the ring
const BASE = 7;       // half-width of the beam where it leaves the lamp
const DOCK = 20;      // card → viewport edge; mirrors .tour-card in style.css
const CARD_W = 420;   // .tour-card's width in style.css
/**
 * The strip down the right-hand side the lamp occupies. Exported because a
 * step that flies a card to the middle of the board has to frame it clear of
 * the lamp — moving the board is right, moving the lamp is what the tour is
 * trying not to do.
 */
export const LAMP_RESERVE = CARD_W + DOCK * 2;
const TRAVEL_MS = 460;
/** When the travelling glow is close enough to the target for the ring to light under it. */
const LAND_MS = 350;

/** The lamp, the target, and the axis between them — everything the beam is drawn from. */
interface Ray {
  s: { x: number; y: number };
  p: { x: number; y: number };
}

const REDUCED = (() => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
})();

/**
 * The overlay. The caption card is a lamp docked in one corner for the whole
 * tour — the eye learns where the words are and stops hunting for them — and
 * what changes between steps is the light: a glow flies from the lamp to the
 * step's target, the target lights up, and a cone of light stays behind
 * connecting the two, so there is never a question about which control the
 * caption is talking about. The page itself is only faintly veiled; the target
 * is picked out by being lit, not by everything else being black.
 *
 * Pointer events pass through everywhere except the card.
 */
export class TourUI {
  readonly root: HTMLElement;
  private readonly veil: HTMLElement;
  private readonly beam: SVGSVGElement;
  private readonly cone: SVGPolygonElement;
  private readonly head: SVGPathElement;
  private readonly lamp: SVGCircleElement;
  private readonly bulb: SVGCircleElement;
  private readonly grad: SVGLinearGradientElement;
  private readonly glow: HTMLElement;
  private readonly spot: HTMLElement;
  private readonly card: HTMLElement;
  private readonly counter: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly title: HTMLElement;
  private resolve: (() => Element | SpotRect | null) | null = null;
  private handlers: TourUIHandlers;
  private lastFocus: Element | null = null;
  /** rAF handle while a rect target (a card on the canvas) is being tracked. */
  private track = 0;
  private lastRect = '';
  /** The card's own size, measured once per step rather than once per frame. */
  private cardW = 0;
  private cardH = 0;
  /** Step id + whether it has a beam; a change is what fires the light's journey. */
  private stepKey = '';
  private lastLit: string | null = null;
  private lastShape = '';
  private revealTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement, handlers: TourUIHandlers) {
    this.handlers = handlers;
    this.root = h('div', 'tour');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Guided tour');

    this.veil = h('div', 'tour-veil');
    this.veil.setAttribute('aria-hidden', 'true');

    this.beam = svg('svg', 'tour-beam');
    this.beam.setAttribute('aria-hidden', 'true');
    this.beam.setAttribute('focusable', 'false');
    hide(this.beam, true);
    const defs = svg('defs', '');
    this.grad = svg('linearGradient', '');
    this.grad.id = 'tourBeamGrad';
    this.grad.setAttribute('gradientUnits', 'userSpaceOnUse');
    // Brightest at the lamp, thinning towards the target: light spreading out,
    // not a solid wedge laid over the thing the viewer is meant to be reading.
    for (const [offset, color] of [
      ['0%', 'rgba(150,196,255,.34)'],
      ['42%', 'rgba(140,190,255,.17)'],
      ['100%', 'rgba(130,185,255,.07)'],
    ]) {
      const stop = svg('stop', '');
      stop.setAttribute('offset', offset);
      stop.setAttribute('stop-color', color);
      this.grad.appendChild(stop);
    }
    defs.appendChild(this.grad);
    this.cone = svg('polygon', 'cone');
    this.cone.setAttribute('fill', 'url(#tourBeamGrad)');
    this.bulb = svg('circle', 'bulb');
    this.bulb.setAttribute('r', '11');
    this.lamp = svg('circle', 'lamp');
    this.lamp.setAttribute('r', '4');
    this.head = svg('path', 'head');
    this.head.setAttribute('d', 'M0 0 L-15 7.5 L-11 0 L-15 -7.5 Z');
    this.beam.append(defs, this.cone, this.bulb, this.lamp, this.head);

    this.glow = h('div', 'tour-glow');
    this.glow.setAttribute('aria-hidden', 'true');

    this.spot = h('div', 'tour-spot');
    this.spot.hidden = true;
    this.card = h('div', 'tour-card');
    this.card.hidden = true;
    this.counter = h('span', 'tour-step');
    this.title = h('h2', 'tour-title');
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
    this.card.append(head, this.title, this.caption, foot);
    this.root.append(this.veil, this.beam, this.glow, this.spot, this.card);
    parent.appendChild(this.root);
    // One frame later, so the veil fades in rather than snapping on.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => this.root.classList.add('up'));
    else this.root.classList.add('up');

    this.backBtn.addEventListener('click', () => handlers.onBack());
    this.nextBtn.addEventListener('click', () => handlers.onNext());
    skipBtn.addEventListener('click', () => handlers.onSkip());
    this.muteBtn.addEventListener('click', () => handlers.onMute());
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('scroll', this.reposition, true);
    this.lastFocus = document.activeElement;
  }

  /**
   * Welcome card: nothing plays until the visitor clicks Start. With more than
   * one collection to be shown around, it also asks which — the tours narrate
   * genuinely different stories, so the choice belongs to the visitor and not
   * to whichever collection happens to be loaded.
   */
  showWelcome(onStart: (tourId?: string) => void, onDismiss: () => void, choices: TourChoice[] = []): void {
    this.spot.hidden = true;
    hide(this.beam, true);
    this.card.hidden = true;
    const w = h('div', 'tour-card tour-welcome');
    const pick = choices.length > 1;
    w.innerHTML =
      '<h2>Welcome to Tessera</h2>' +
      (pick
        ? '<p>A two-minute guided tour, with narration, shows what the collection view can do: ' +
          'sort, bucket, cross-tabulate, filter and zoom — all without redrawing a single card. ' +
          'Pick a collection to be shown around.</p>'
        : '<p>A two-minute guided tour, with narration, shows what the collection view can do: ' +
          'sort, bucket, cross-tabulate, filter and zoom — all without redrawing a single card.</p>');

    let chosen = choices[0]?.id;
    if (pick) {
      // Toggle buttons rather than radios: the focus trap already gathers every
      // button in the overlay, so the picker joins the Tab cycle for free.
      const list = h('div', 'tour-picks');
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', 'Which collection');
      const buttons = choices.map((c) => {
        const b = button('', 'tour-pick');
        b.innerHTML = `<b>${esc(c.label)}</b><span>${esc(c.blurb)}</span>`;
        b.setAttribute('aria-pressed', String(c.id === chosen));
        b.addEventListener('click', () => {
          chosen = c.id;
          for (const other of buttons) other.setAttribute('aria-pressed', String(other === b));
        });
        return b;
      });
      list.append(...buttons);
      w.append(list);
    }

    const foot = h('div', 'tour-foot');
    const later = button('Not now', 'tour-dismiss');
    const start = button('Start tour', 'tour-start');
    start.classList.add('primary');
    foot.append(later, h('span', 'spacer'), start);
    w.append(foot);
    this.root.appendChild(w);
    later.addEventListener('click', () => { w.remove(); onDismiss(); });
    start.addEventListener('click', () => { w.remove(); onStart(chosen); });
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
    // Dark again for a moment: the light has to arrive at the new target for
    // the journey to be worth watching.
    this.spot.classList.remove('lit');
    this.beam.classList.remove('on');
    this.lastLit = null;
    this.measureCard();
    this.spotlight(step);
    if (!this.card.contains(document.activeElement)) this.nextBtn.focus();
  }

  spotlight(step: TourStep): void {
    const target = step.target;
    this.stepKey = step.id;
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
    if (this.revealTimer !== null) clearTimeout(this.revealTimer);
    this.revealTimer = null;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('scroll', this.reposition, true);
    this.root.remove();
    if (this.lastFocus instanceof HTMLElement) this.lastFocus.focus();
  }

  /**
   * The caption's height depends on how long the line is, so it is measured
   * once a step's text is in — never inside `reposition`, which runs every
   * frame while a card on the canvas is being followed and would then force a
   * synchronous layout between the read of the target and the write of the ring.
   */
  private measureCard(): void {
    const r = this.card.getBoundingClientRect();
    this.cardW = r.width;
    this.cardH = r.height;
  }

  private onResize = (): void => {
    this.measureCard();
    this.reposition();
  };

  private reposition = (): void => {
    const t = this.resolve?.() ?? null;
    const r = t instanceof Element ? t.getBoundingClientRect() : t;
    // A rect target is a card on the canvas: it moves when the user pans or
    // zooms, which fires no resize/scroll, so follow it frame by frame.
    if (t && !(t instanceof Element)) this.startTracking(); else this.stopTracking();
    if (!t || !r || (r.width === 0 && r.height === 0)) {
      this.spot.hidden = true;
      this.spot.classList.remove('lit');
      hide(this.beam, true);
      this.beam.classList.remove('on');
      this.dock(null);
      this.lastLit = null;
      return;
    }
    this.spot.hidden = false;
    const spot = { left: r.left - SPOT_PAD, top: r.top - SPOT_PAD, width: r.width + SPOT_PAD * 2, height: r.height + SPOT_PAD * 2 };
    this.spot.style.left = `${spot.left}px`;
    this.spot.style.top = `${spot.top}px`;
    this.spot.style.width = `${spot.width}px`;
    this.spot.style.height = `${spot.height}px`;
    const card = this.dock(spot);
    const ray = this.drawBeam(card, spot);
    const key = `${this.stepKey}|${ray ? 'beam' : 'bare'}`;
    if (key !== this.lastLit) {
      this.lastLit = key;
      this.reveal(ray);
    }
  };

  private startTracking(): void {
    // The ring is never transitioned, so it is always exactly on the card it
    // is pointing at; `tracking` only stops the idle breathing animation,
    // which would otherwise rasterise a large shadow at a new size every frame.
    this.spot.classList.add('tracking');
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
    if (this.track) cancelAnimationFrame(this.track);
    this.track = 0;
    this.lastRect = '';
  }

  /**
   * Where the card sits. Bottom-right, always — it is the one corner of this
   * layout that holds nothing the tour ever points at: the topbar, the facet
   * sidebar, the legend and the metrics readout each own one of the others.
   * The rect is computed rather than measured so that reading it costs no
   * layout, and only the card's own size has to come from the DOM.
   *
   * The single exception is a target the docked card would sit on top of,
   * which the current script never produces but a narrower window could: then
   * it slides to the other corner, by transform, so nothing re-lays out.
   */
  private dock(spot: SpotRect | null): SpotRect | null {
    if (this.cardW === 0 || this.cardH === 0) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const top = vh - DOCK - this.cardH;
    const right = vw - DOCK - this.cardW;
    // A real collision, not a graze: a target clipping the lamp's corner by a
    // few pixels is still perfectly readable, and moving the lamp for it would
    // undo the one thing the dock is for.
    const flip = spot !== null && overlaps({ left: right, top, width: this.cardW, height: this.cardH }, spot, -24);
    this.card.style.setProperty('--dock-dx', `${Math.round(DOCK - right)}px`);
    this.card.classList.toggle('dock-bl', flip);
    return { left: flip ? DOCK : right, top, width: this.cardW, height: this.cardH };
  }

  /**
   * The cone of light from the card to the target. Its far edge is the
   * target's own silhouette — the two corners at the extreme angles from the
   * lamp — so a 40-pixel select gets a needle and a sidebar row gets a wedge,
   * and neither needs any per-target tuning. Returns the axis it drew along,
   * or null when there is nothing sane to draw (no card size, as in jsdom, or
   * a target sitting almost on top of the lamp).
   */
  private drawBeam(card: SpotRect | null, spot: SpotRect): Ray | null {
    const nothing = () => { hide(this.beam, true); return null; };
    if (!card || this.card.hidden) return nothing();
    const c = { x: card.left + card.width / 2, y: card.top + card.height / 2 };
    const p = { x: spot.left + spot.width / 2, y: spot.top + spot.height / 2 };
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 40)) return nothing();
    const ux = dx / len;
    const uy = dy / len;
    // Where the axis leaves the card: the ray, clipped to the card box, nudged
    // clear of the border so the bulb is not half-buried in it.
    const k = 1 / Math.max(Math.abs(dx) / (card.width / 2 + 2), Math.abs(dy) / (card.height / 2 + 2));
    if (!Number.isFinite(k)) return nothing();
    const s = { x: c.x + dx * k + ux * 5, y: c.y + dy * k + uy * 5 };
    // Normal to the axis; `a` is the corner furthest around it in this direction.
    const nx = -uy;
    const ny = ux;

    // Stop short of the ring, so the light meets the halo rather than crossing it.
    const hw = spot.width / 2 + HALO;
    const hh = spot.height / 2 + HALO;
    const t = Math.min(ux !== 0 ? Math.abs(hw / ux) : Infinity, uy !== 0 ? Math.abs(hh / uy) : Infinity);
    if (!Number.isFinite(t)) return nothing();
    const tip = { x: p.x - ux * t, y: p.y - uy * t };

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let far: { x: number; y: number }[];
    if (spot.width * spot.height > 0.18 * vw * vh || Math.min(spot.width, spot.height) > 0.5 * Math.min(vw, vh)) {
      // A target filling much of the screen — the record step's canvas
      // fallback, or the whole facet sidebar. Its silhouette would be a cone
      // swallowing everything; a plain shaft landing on it says the same thing.
      far = [{ x: tip.x + nx * 22, y: tip.y + ny * 22 }, { x: tip.x - nx * 22, y: tip.y - ny * 22 }];
    } else {
      const corners = [
        { x: spot.left - HALO, y: spot.top - HALO },
        { x: spot.left + spot.width + HALO, y: spot.top - HALO },
        { x: spot.left + spot.width + HALO, y: spot.top + spot.height + HALO },
        { x: spot.left - HALO, y: spot.top + spot.height + HALO },
      ];
      let a: { x: number; y: number } | null = null;
      let b: { x: number; y: number } | null = null;
      let maxA = -Infinity;
      let maxB = -Infinity;
      for (const k2 of corners) {
        const vx = k2.x - s.x;
        const vy = k2.y - s.y;
        const along = vx * ux + vy * uy;
        if (along <= 0) continue; // behind the lamp: not part of the silhouette
        const ang = (vx * nx + vy * ny) / along;
        if (ang > maxA) { maxA = ang; a = k2; }
        if (-ang > maxB) { maxB = -ang; b = k2; }
      }
      if (!a || !b) return nothing();
      // Taking the extremes by side keeps the winding right, so the quad can
      // never fold into a bowtie however the target sits relative to the lamp.
      far = [a, b];
    }

    const pts = [
      { x: s.x + nx * BASE, y: s.y + ny * BASE },
      far[0],
      far[1],
      { x: s.x - nx * BASE, y: s.y - ny * BASE },
    ];
    const points = pts.map((q) => `${round(q.x)},${round(q.y)}`).join(' ');
    const deg = Math.atan2(dy, dx) * 180 / Math.PI;
    const shape = `${points}|${round(tip.x)},${round(tip.y)},${Math.round(deg)}`;
    hide(this.beam, false);
    if (shape === this.lastShape) return { s, p };
    this.lastShape = shape;
    this.cone.setAttribute('points', points);
    this.head.setAttribute('transform', `translate(${round(tip.x)},${round(tip.y)}) rotate(${deg.toFixed(1)})`);
    this.lamp.setAttribute('cx', `${round(s.x)}`);
    this.lamp.setAttribute('cy', `${round(s.y)}`);
    this.bulb.setAttribute('cx', `${round(s.x)}`);
    this.bulb.setAttribute('cy', `${round(s.y)}`);
    this.grad.setAttribute('x1', `${round(s.x)}`);
    this.grad.setAttribute('y1', `${round(s.y)}`);
    this.grad.setAttribute('x2', `${round(p.x)}`);
    this.grad.setAttribute('y2', `${round(p.y)}`);
    return { s, p };
  }

  /**
   * Send the light to the new target: a glow leaves the lamp, and the ring and
   * the beam come up under it as it lands, so the eye is carried to the thing
   * the caption is about instead of having to go looking for it.
   */
  private reveal(ray: Ray | null): void {
    if (this.revealTimer !== null) clearTimeout(this.revealTimer);
    this.revealTimer = null;
    const land = () => {
      this.revealTimer = null;
      this.spot.classList.add('lit');
      if (ray) this.beam.classList.add('on');
    };
    if (!ray || REDUCED || typeof this.glow.animate !== 'function') { land(); return; }
    const { s, p } = ray;
    this.glow.animate([
      { transform: `translate3d(${s.x}px,${s.y}px,0) scale(.42)`, opacity: 0 },
      { transform: `translate3d(${s.x}px,${s.y}px,0) scale(.55)`, opacity: 0.95, offset: 0.12 },
      { transform: `translate3d(${p.x}px,${p.y}px,0) scale(1)`, opacity: 0.85, offset: 0.78 },
      { transform: `translate3d(${p.x}px,${p.y}px,0) scale(1.25)`, opacity: 0 },
    ], { duration: TRAVEL_MS, easing: 'cubic-bezier(.22,.61,.36,1)' });
    this.revealTimer = setTimeout(land, LAND_MS);
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

/**
 * Show or hide an SVG element. `hidden` is an HTML property: assigning it on
 * an SVG element sets a meaningless expando and leaves the thing on screen, so
 * this uses the attribute, which `.tour-beam[hidden]` in style.css acts on.
 */
function hide(el: SVGElement, on: boolean): void {
  if (on) el.setAttribute('hidden', ''); else el.removeAttribute('hidden');
}

/** Do two rectangles touch, once `pad` is added all round the first (negative to inset)? */
function overlaps(a: SpotRect, b: SpotRect, pad = 0): boolean {
  return a.left - pad < b.left + b.width && a.left + a.width + pad > b.left
    && a.top - pad < b.top + b.height && a.top + a.height + pad > b.top;
}

/** Attribute values: one decimal is plenty, and keeps the change-compare cheap. */
function round(v: number): number {
  return Math.round(v * 10) / 10;
}

function h(tag: string, cls: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, cls: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (cls) el.setAttribute('class', cls);
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
