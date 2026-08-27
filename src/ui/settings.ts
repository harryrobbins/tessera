/**
 * Card settings: the four things about a card that are a *preference* rather
 * than a property of the data — which design, whether the board is cards or
 * pure colour, whether tags are shown, and which column is the title.
 *
 * Everything else about a card is the dataset author's decision (§5.2): a
 * picker per slot would be a schema editor, and card size is what the zoom is.
 *
 * The state is a plain object with a pure reader/writer pair so it can be
 * tested without a DOM, and the panel below is a thin popover over it.
 */
import type { CustomCard } from '../data/card';
import type { KeyValueStore } from '../tour/engine';
import { safeStorage } from '../tour/store';

export interface CardSettings {
  /** 'auto' = whatever the dataset itself declared. */
  design: 'auto' | 'quiet' | CustomCard;
  /** false = no atlas at all: flat tinted quads at every zoom. */
  labels: boolean;
  tags: boolean;
  /** Column name, or '' for the template's own choice. */
  title: string;
}

export const CARDS_KEY = 'tessera.cards.v1';

export const DEFAULT_SETTINGS: CardSettings = { design: 'auto', labels: true, tags: true, title: '' };

const DESIGNS = new Set(['auto', 'quiet', 'taxCase']);

/** Everything that is not a known value falls back to the default rather than
 *  throwing: this is persisted state and a stale key must never break boot. */
export function normalise(raw: unknown): CardSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<CardSettings>;
  return {
    design: typeof o.design === 'string' && DESIGNS.has(o.design) ? o.design as CardSettings['design'] : 'auto',
    labels: o.labels !== false,
    tags: o.tags !== false,
    title: typeof o.title === 'string' ? o.title : '',
  };
}

/**
 * Stored settings, with `?cards=` overriding the *design* only. The design is
 * the one setting a demo-giver needs to pin in a URL beside `?dataset=`; the
 * other three are personal preferences and belong in storage, not in a link
 * someone else opens.
 */
export function loadSettings(store: KeyValueStore | null = safeStorage(), search = typeof location === 'undefined' ? '' : location.search): CardSettings {
  let stored: unknown = null;
  try { stored = JSON.parse(store?.getItem(CARDS_KEY) ?? 'null'); } catch { /* corrupt or private mode */ }
  const s = normalise(stored);
  const param = new URLSearchParams(search).get('cards');
  if (param && DESIGNS.has(param)) s.design = param as CardSettings['design'];
  return s;
}

export function saveSettings(s: CardSettings, store: KeyValueStore | null = safeStorage()): void {
  try { store?.setItem(CARDS_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

// ------------------------------------------------------------------- panel

export interface CardSettingsPanelOptions {
  /** The button the popover hangs off; it owns `aria-expanded`. */
  button: HTMLButtonElement;
  /** Applied on every change, before persistence. */
  onChange(s: CardSettings): void;
  /** Columns offered as the title, and whether `Detailed` is available. */
  fields(): { titles: string[]; custom: CustomCard | undefined };
}

/**
 * The popover itself. Not modal and it has no scrim: it is a preference, not a
 * decision, so the board stays live behind it and a click anywhere else is a
 * dismissal rather than something to swallow.
 */
export class CardSettingsPanel {
  readonly el: HTMLElement;
  private o: CardSettingsPanelOptions;
  private state: CardSettings;

  constructor(el: HTMLElement, initial: CardSettings, o: CardSettingsPanelOptions) {
    this.el = el;
    this.o = o;
    this.state = { ...initial };
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Card settings');
    el.hidden = true;
    o.button.setAttribute('aria-expanded', 'false');
    o.button.addEventListener('click', () => this.toggle());
    // Escape is handled on the document, not on the popover: changing a
    // setting re-renders it, which destroys whatever had focus, and a listener
    // on the panel would then never hear the key.
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('pointerdown', this.onOutside, true);
  }

  get settings(): CardSettings { return { ...this.state }; }
  get open(): boolean { return !this.el.hidden; }

  toggle(): void { this.open ? this.close() : this.show(); }

  show(): void {
    this.render();
    this.el.hidden = false;
    this.place();
    this.o.button.setAttribute('aria-expanded', 'true');
    this.controls()[0]?.focus({ preventScroll: true });
  }

  /** Under the button, and never off the right edge. Measured after the panel
   *  is visible, because a hidden element has no width to align by. */
  private place(): void {
    const r = this.o.button.getBoundingClientRect();
    if (r.width === 0) return;   // jsdom, or a button that is not laid out
    const w = this.el.offsetWidth;
    const vw = window.innerWidth;
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, vw - w - 8)))}px`;
  }

  close(): void {
    if (this.el.hidden) return;
    const hadFocus = this.el.contains(document.activeElement);
    this.el.hidden = true;
    this.o.button.setAttribute('aria-expanded', 'false');
    if (hadFocus) this.o.button.focus({ preventScroll: true });
  }

  /** Put everything back to the dataset's own choices, without persisting —
   *  the tour asserts a specific look and must not inherit a saved preference. */
  reset(): void {
    this.state = { ...DEFAULT_SETTINGS };
    this.o.onChange(this.settings);
    if (this.open) this.render();
  }

  private set<K extends keyof CardSettings>(key: K, value: CardSettings[K]): void {
    if (this.state[key] === value) return;
    this.state[key] = value;
    this.o.onChange(this.settings);
    saveSettings(this.state);
    this.render();
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.el.hidden || e.key !== 'Escape') return;
    e.stopPropagation();
    this.close();
  };

  private onOutside = (e: Event) => {
    if (this.el.hidden) return;
    const t = e.target as Node;
    if (this.el.contains(t) || this.o.button.contains(t)) return;
    this.close();
  };

  /** Controls in tab order; the panel's shape is fixed, so an index survives
   *  a re-render and is what focus is restored by. */
  private controls(): HTMLElement[] {
    return [...this.el.querySelectorAll<HTMLElement>('button, select')];
  }

  private render(): void {
    const { titles, custom } = this.o.fields();
    const s = this.state;
    const focused = this.el.contains(document.activeElement)
      ? this.controls().indexOf(document.activeElement as HTMLElement)
      : -1;
    this.el.textContent = '';
    this.el.append(
      seg('Design', [
        { id: 'auto', label: 'Auto', title: "The collection's own choice" },
        { id: 'quiet', label: 'Simple', title: 'Topic, title, one line of context, two tags' },
        { id: custom ?? 'taxCase', label: 'Detailed', title: custom ? 'The hand-drawn record card' : 'This collection has no detailed card', disabled: !custom },
      ], s.design, (v) => this.set('design', v as CardSettings['design'])),
      toggleRow('Labels', s.labels, 'Off draws flat colour at every zoom — the fastest path, and the clearest at 100,000 cards', (v) => this.set('labels', v)),
      toggleRow('Tags', s.tags, 'The noisiest element at small sizes', (v) => this.set('tags', v)),
      titleRow(titles, s.title, (v) => this.set('title', v)),
    );
    // A control the user just used must not take focus to `<body>` with it.
    if (focused >= 0) this.controls()[focused]?.focus({ preventScroll: true });
  }
}

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const r = document.createElement('div');
  r.className = 'set-row';
  const l = document.createElement('span');
  l.className = 'set-label';
  l.textContent = label;
  if (hint) l.title = hint;
  r.append(l, control);
  return r;
}

function seg(label: string, options: Array<{ id: string; label: string; title: string; disabled?: boolean }>, value: string, onPick: (v: string) => void): HTMLElement {
  const group = document.createElement('div');
  group.className = 'seg';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  for (const o of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o.label;
    b.title = o.title;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(o.id === value));
    b.classList.toggle('active', o.id === value);
    b.disabled = !!o.disabled;
    b.addEventListener('click', () => onPick(o.id));
    group.append(b);
  }
  return row(label, group);
}

function toggleRow(label: string, on: boolean, hint: string, onPick: (v: boolean) => void): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost';
  b.textContent = on ? 'On' : 'Off';
  b.setAttribute('aria-pressed', String(on));
  b.addEventListener('click', () => onPick(!on));
  return row(label, b, hint);
}

function titleRow(titles: string[], value: string, onPick: (v: string) => void): HTMLElement {
  const sel = document.createElement('select');
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Default';
  sel.append(auto);
  for (const t of titles) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    sel.append(o);
  }
  sel.value = titles.includes(value) ? value : '';
  sel.addEventListener('change', () => onPick(sel.value));
  return row('Title', sel, 'Which column names the record on the card');
}
