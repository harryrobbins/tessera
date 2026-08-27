// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  CARDS_KEY, CardSettingsPanel, DEFAULT_SETTINGS, loadSettings, normalise, saveSettings,
  type CardSettings,
} from '../src/ui/settings';

/** A Storage that records writes, and can be made to throw like private mode. */
function fakeStore(initial: Record<string, string> = {}, throws = false) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => { if (throws) throw new Error('denied'); return map.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (throws) throw new Error('denied'); map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    get size() { return map.size; },
    raw: map,
  };
}

describe('card settings state', () => {
  it('defaults to the collection\'s own choices', () => {
    expect(normalise(null)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(fakeStore(), '')).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips through storage', () => {
    const store = fakeStore();
    const s: CardSettings = { design: 'quiet', labels: false, tags: false, title: 'Case' };
    saveSettings(s, store);
    expect(loadSettings(store, '')).toEqual(s);
  });

  it('a storage that throws degrades silently to the defaults', () => {
    const store = fakeStore({}, true);
    expect(() => saveSettings({ ...DEFAULT_SETTINGS, labels: false }, store)).not.toThrow();
    expect(loadSettings(store, '')).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(null, '')).toEqual(DEFAULT_SETTINGS);
  });

  it('survives a corrupt or stale stored value', () => {
    expect(loadSettings(fakeStore({ [CARDS_KEY]: '{not json' }), '')).toEqual(DEFAULT_SETTINGS);
    expect(normalise({ design: 'holographic', title: 7 })).toEqual(DEFAULT_SETTINGS);
  });

  it('?cards= overrides the design and nothing else', () => {
    const store = fakeStore();
    saveSettings({ design: 'auto', labels: false, tags: false, title: 'Case' }, store);
    const s = loadSettings(store, '?dataset=tax-cases:900&cards=quiet');
    expect(s.design).toBe('quiet');
    // The personal preferences are not something a shared link gets to set.
    expect(s.labels).toBe(false);
    expect(s.tags).toBe(false);
    expect(s.title).toBe('Case');
  });

  it('an unknown ?cards= value falls back to the stored design', () => {
    expect(loadSettings(fakeStore(), '?cards=sparkly').design).toBe('auto');
  });
});

describe('CardSettingsPanel', () => {
  let panel: CardSettingsPanel;
  let button: HTMLButtonElement;
  let changes: CardSettings[];
  let custom: 'taxCase' | undefined;

  beforeEach(() => {
    document.body.innerHTML = '<button id="cardsBtn">Cards</button><div id="cardSettings" hidden></div>';
    button = document.getElementById('cardsBtn') as HTMLButtonElement;
    changes = [];
    custom = 'taxCase';
    panel = new CardSettingsPanel(document.getElementById('cardSettings')!, DEFAULT_SETTINGS, {
      button,
      onChange: (s) => changes.push(s),
      fields: () => ({ titles: ['Customer', 'Case'], custom }),
    });
  });

  const buttons = () => [...panel.el.querySelectorAll('button')];
  const byText = (text: string) => buttons().find((b) => b.textContent === text)!;

  it('is a labelled dialog the button owns', () => {
    expect(panel.el.getAttribute('role')).toBe('dialog');
    expect(panel.el.getAttribute('aria-label')).toBe('Card settings');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.click();
    expect(panel.open).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.click();
    expect(panel.open).toBe(false);
  });

  it('keeps focus on the control that was just used, so Escape still works', () => {
    panel.show();
    const labels = byText('On');
    labels.focus();
    labels.click();                       // re-renders the whole panel
    expect(panel.el.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).textContent).toBe('Off');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.open).toBe(false);
  });

  it('closes on Escape and on a click outside, returning focus to the button', () => {
    panel.show();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.open).toBe(false);
    expect(document.activeElement).toBe(button);

    panel.show();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(panel.open).toBe(false);
  });

  it('reports each change and persists it', () => {
    panel.show();
    byText('Simple').click();
    expect(changes.at(-1)!.design).toBe('quiet');
    byText('On').click();                    // Labels -> Off
    expect(changes.at(-1)!.labels).toBe(false);
    expect(panel.settings).toEqual({ design: 'quiet', labels: false, tags: true, title: '' });
  });

  it('disables Detailed for a collection that has no bespoke card', () => {
    custom = undefined;
    panel.show();
    expect(byText('Detailed').disabled).toBe(true);
    expect(byText('Detailed').title).toMatch(/no detailed card/);
    custom = 'taxCase';
    panel.close();
    panel.show();
    expect(byText('Detailed').disabled).toBe(false);
  });

  it('offers the text and category columns as the title', () => {
    panel.show();
    const sel = panel.el.querySelector('select')!;
    expect([...sel.options].map((o) => o.value)).toEqual(['', 'Customer', 'Case']);
    sel.value = 'Case';
    sel.dispatchEvent(new Event('change'));
    expect(changes.at(-1)!.title).toBe('Case');
  });

  it('reset puts everything back for the tour, and reports it', () => {
    panel.show();
    byText('Simple').click();
    panel.reset();
    expect(panel.settings).toEqual(DEFAULT_SETTINGS);
    expect(changes.at(-1)).toEqual(DEFAULT_SETTINGS);
  });
});
