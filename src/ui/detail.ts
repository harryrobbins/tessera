import type { Dataset } from '../data/columnar';
import { valueAt } from '../data/columnar';
import { colorOfRow } from '../core/palette';
import { esc } from '../core/esc';
import { expandFrom, FLIP_MS, type Rect } from './detail/flip';
import { shareCounter, templateDetail, wireDetailImage } from './detail/template';

export interface DetailContext {
  /** Colour of the selected card under the current colour-by. */
  accent: string;
  colorBy: string;
  esc(s: string): string;
  /** Category counts over the current filter, or null for a non-category
   *  column. Memoised per open, so a renderer may ask freely. */
  shares(field: string): Int32Array | null;
  /** Rows in the current filter — what a share is a share *of*. */
  total: number;
}

/** Returns the inner HTML of the pane (header + body); the close button is added by the pane. */
export type DetailRenderer = (ds: Dataset, i: number, ctx: DetailContext) => string;

const registry = new Map<string, DetailRenderer>();

/** Register a renderer for datasets whose `kind` (or `detail.custom`) matches. */
export function registerDetail(kind: string, r: DetailRenderer): void {
  registry.set(kind, r);
}

/** The generic record view: a key/value list of every non-label column. */
export const genericDetail: DetailRenderer = (ds, i, { accent, colorBy, esc }) => {
  const rows = Object.keys(ds.columns)
    .filter((f) => f !== ds.labelColumn)
    .map((f) => `<dt>${esc(f)}</dt><dd>${esc(valueAt(ds, f, i))}</dd>`)
    .join('');
  const subtitle = colorBy ? valueAt(ds, colorBy, i) : ds.name;
  return `
    <header style="background:${accent}">
      <h2 id="detailTitle">${esc(valueAt(ds, ds.labelColumn, i) || `Item ${i}`)}</h2>
      <p>${esc(subtitle)}</p>
    </header>
    <dl>${rows}</dl>`;
};

export interface DetailPaneOptions {
  /** Called when the pane is dismissed by the user (close button or Escape). */
  onClose(): void;
  onToast(msg: string): void;
  /** The scrim behind the dialog. Clicking it closes. */
  scrim?: HTMLElement | null;
  /** Made `inert` while the dialog is open, so the board and the chrome are
   *  neither tabbable nor clickable behind it. */
  background?: HTMLElement | null;
  /** The current filter, for the shares in the Context section. */
  mask?(): Uint8Array | null;
  /** Where card `i` is drawn on screen, for the expansion. */
  cardRect?(i: number): Rect | null;
  /** The app's transition budget; 0 under reduced motion, which skips the FLIP. */
  transitionMs?(): number;
}

export const DEMO_ACTION_TOAST = 'Demo only — this would open the case in the case-management system';

/**
 * The record modal that opens on a selected card. Owns `#detail`: markup,
 * dialog semantics, the close button, the focus trap and the demo action links.
 */
export class DetailPane {
  private el: HTMLElement;
  private opts: DetailPaneOptions;
  /** Where focus was before the pane took it, so `hide()` can give it back. */
  private returnTo: Element | null = null;
  /** Filter the memoised shares were counted against. */
  private sharesFor: Uint8Array | null | undefined = undefined;
  private sharesOf: ((field: string) => Int32Array | null) | null = null;
  private sharesTotal = 0;

  constructor(el: HTMLElement, opts: DetailPaneOptions) {
    this.el = el;
    this.opts = opts;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'detailTitle');
    el.addEventListener('click', this.onClick);
    el.addEventListener('keydown', this.onKeyDown);
    opts.scrim?.addEventListener('click', () => this.hide());
  }

  get visible(): boolean { return !this.el.hidden; }

  show(ds: Dataset, i: number, colorBy: string): void {
    if (i < 0 || i >= ds.n) { this.hide(); return; }
    const opening = this.el.hidden;
    if (opening || !this.el.contains(document.activeElement)) this.returnTo = document.activeElement;
    // `detail.custom` names a renderer explicitly; `kind` is the older route
    // and still wins over the template, so `registerDetail` keeps working.
    const key = ds.detail?.custom ?? ds.kind ?? '';
    const render = (key ? registry.get(key) : undefined) ?? (ds.detail ? templateDetail : genericDetail);
    this.el.classList.toggle('rich', render !== genericDetail);
    this.el.innerHTML =
      render(ds, i, { accent: colorOfRow(ds, colorBy, i), colorBy, esc, ...this.shares(ds) }) +
      '<button class="close" aria-label="Close">×</button>';
    // A declared picture is an enhancement, never a dependency: this hides it
    // again if it does not load, so the pane is the same with or without it.
    wireDetailImage(this.el);
    this.el.hidden = false;
    if (this.opts.scrim) this.opts.scrim.hidden = false;
    this.opts.background?.setAttribute('inert', '');
    this.el.scrollTop = 0;
    // The card the user clicked is where the dialog comes from.
    if (opening) {
      const ms = Math.min(this.opts.transitionMs?.() ?? FLIP_MS, FLIP_MS);
      expandFrom(this.el, this.opts.cardRect?.(i) ?? null, ms);
    }
    this.el.querySelector<HTMLButtonElement>('.close')?.focus({ preventScroll: true });
  }

  /** Hide the pane; `onClose` fires only if it was open. Focus goes back to
   *  where it came from (else the canvas, else the tour button) rather than
   *  dropping to `<body>` while the pane still held it. */
  hide(): void {
    if (this.el.hidden) return;
    const hadFocus = this.el.contains(document.activeElement);
    this.el.hidden = true;
    if (this.opts.scrim) this.opts.scrim.hidden = true;
    this.opts.background?.removeAttribute('inert');
    this.opts.onClose();
    if (hadFocus) {
      const back = this.returnTo instanceof HTMLElement && this.returnTo.isConnected && this.returnTo !== document.body
        ? this.returnTo
        : document.querySelector<HTMLElement>('#gl[tabindex]') ?? document.querySelector<HTMLElement>('#tourBtn');
      back?.focus({ preventScroll: true });
    }
    this.returnTo = null;
  }

  /** Shares for the Context section, recounted only when the filter changes. */
  private shares(ds: Dataset): { shares: (f: string) => Int32Array | null; total: number } {
    const mask = this.opts.mask?.() ?? null;
    if (!this.sharesOf || mask !== this.sharesFor) {
      this.sharesFor = mask;
      this.sharesOf = shareCounter(ds, mask);
      let total = ds.n;
      if (mask) { total = 0; for (let i = 0; i < ds.n; i++) if (mask[i]) total++; }
      this.sharesTotal = total;
    }
    return { shares: this.sharesOf, total: this.sharesTotal };
  }

  /** `#app` is inert, so the only thing to handle is the wrap at the ends. */
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const focusable = this.el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  };

  private onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    if (t.closest('.close')) { this.hide(); return; }
    const a = t.closest<HTMLAnchorElement>('a[data-action]');
    if (a) {
      // Real links (keyboard, focus ring) that never navigate: the demo has no
      // case-management system behind it. stopPropagation keeps Enter on a link
      // from reaching the tour's key handler as a "next".
      e.preventDefault();
      e.stopPropagation();
      this.opts.onToast(DEMO_ACTION_TOAST);
    }
  };
}
