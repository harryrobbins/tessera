// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { DetailPane, DEMO_ACTION_TOAST, registerDetail } from '../src/ui/detail';
import { category, numeric, text, type Dataset } from '../src/data/columnar';
import { CATEGORICAL, SEQUENTIAL_BLUE, colorOfRow } from '../src/core/palette';

function dataset(extra: Partial<Dataset> = {}): Dataset {
  return {
    name: 'toy', n: 3, cards: true, labelColumn: 'Name',
    columns: {
      Name: text('Name', ['Ann <b>', 'Bob', 'Cy']),
      Tone: category('Tone', ['Red', 'Blue', 'Red']),
      Team: category('Team', ['Alpha', 'Beta', 'Gamma']),
      Score: numeric('Score', [0, 5, 10]),
    },
    facets: ['Tone', 'Team'],
    ...extra,
  } as unknown as Dataset;
}

/** The same toy collection, but declaring a card and a detail template — the
 *  route `templateDetail` takes. `Nonexistent` names no column on purpose. */
function withDetail(extra: Partial<Dataset> = {}): Dataset {
  return dataset({
    card: { title: 'Name', topic: 'Team', tags: [{ value: 'Tone' }] },
    detail: {
      sections: [{ title: 'Who', fields: ['Team', 'Nonexistent', { label: 'Ref', value: 'Name', as: 'mono' }] }],
      context: ['Tone'],
      actions: [{ id: 'review', label: 'Review action', primary: true }],
    },
    ...extra,
  });
}

describe('colorOfRow (the pane accent must agree with the card)', () => {
  it('uses the palette slot for a plain category', () => {
    const ds = dataset();
    expect(colorOfRow(ds, 'Team', 1)).toBe(CATEGORICAL.dark[1]);
  });

  it('honours dataset pins and colour-name auto-detection, like the card', () => {
    const pinned = dataset({ colors: { Team: { Alpha: '#111111', Beta: '#222222', Gamma: '#333333' } } });
    expect(colorOfRow(pinned, 'Team', 2)).toBe('#333333');
    const named = colorOfRow(dataset(), 'Tone', 1);
    expect(named).not.toBe(CATEGORICAL.dark[1]);
    expect(named).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('samples the sequential ramp for a numeric colour-by', () => {
    const ds = dataset();
    expect(colorOfRow(ds, 'Score', 0)).toBe(SEQUENTIAL_BLUE[0]);
    expect(colorOfRow(ds, 'Score', 2)).toBe(SEQUENTIAL_BLUE[SEQUENTIAL_BLUE.length - 1]);
  });

  it('falls back to the first palette slot when the column is absent', () => {
    expect(colorOfRow(dataset(), '', 0)).toBe(CATEGORICAL.dark[0]);
  });
});

describe('DetailPane', () => {
  let el: HTMLElement;
  let closed: number;
  let toasts: string[];
  let pane: DetailPane;

  beforeEach(() => {
    document.body.innerHTML = '<button id="tourBtn">Tour</button><button id="other">x</button><div id="detail" hidden></div>';
    el = document.getElementById('detail')!;
    closed = 0;
    toasts = [];
    pane = new DetailPane(el, { onClose: () => { closed++; }, onToast: (m) => toasts.push(m) });
  });

  it('sets dialog semantics and renders the generic view with escaped values', () => {
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-labelledby')).toBe('detailTitle');
    pane.show(dataset(), 0, 'Team');
    expect(el.hidden).toBe(false);
    expect(pane.visible).toBe(true);
    expect(el.querySelector('#detailTitle')!.innerHTML).toBe('Ann &lt;b&gt;');
    expect(el.querySelector('header')!.getAttribute('style')).toContain(CATEGORICAL.dark[0]);
    expect(el.querySelectorAll('dt').length).toBe(3);
    expect(el.classList.contains('rich')).toBe(false);
  });

  it('uses a registered renderer for the dataset kind', () => {
    registerDetail('toy-kind', (_ds, i, { accent }) => `<header style="background:${accent}"><h2 id="detailTitle">R${i}</h2></header>`);
    pane.show(dataset({ kind: 'toy-kind' }), 1, 'Team');
    expect(el.classList.contains('rich')).toBe(true);
    expect(el.querySelector('#detailTitle')!.textContent).toBe('R1');
    expect(el.querySelector('.close')).not.toBeNull();
  });

  it('hides on an out-of-range index and fires onClose only when it was open', () => {
    pane.show(dataset(), 7, 'Team');
    expect(el.hidden).toBe(true);
    expect(closed).toBe(0);
    pane.show(dataset(), 0, 'Team');
    pane.hide();
    pane.hide();
    expect(closed).toBe(1);
  });

  it('moves focus to the close button on show and returns it on hide (M-04)', () => {
    const other = document.getElementById('other')!;
    other.focus();
    pane.show(dataset(), 0, 'Team');
    expect(document.activeElement).toBe(el.querySelector('.close'));
    // Re-showing while the pane holds focus keeps the original return target.
    pane.show(dataset(), 1, 'Team');
    pane.hide();
    expect(document.activeElement).toBe(other);
  });

  it('falls back to the tour button when the opener was the body or is gone', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    pane.show(dataset(), 0, 'Team');
    pane.hide();
    expect(document.activeElement).toBe(document.getElementById('tourBtn'));
    const other = document.getElementById('other')!;
    other.focus();
    pane.show(dataset(), 0, 'Team');
    other.remove();
    pane.hide();
    expect(document.activeElement).toBe(document.getElementById('tourBtn'));
  });

  it('does not steal focus back when the user had already moved on', () => {
    pane.show(dataset(), 0, 'Team');
    const other = document.getElementById('other')!;
    other.focus();
    pane.hide();
    expect(document.activeElement).toBe(other);
  });

  it('close button hides; demo action links toast without navigating', () => {
    pane.show(dataset({ kind: 'toy-kind' }), 0, 'Team');
    el.innerHTML += '<a href="#" data-action="review">Review</a>';
    const a = el.querySelector<HTMLAnchorElement>('a[data-action]')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(toasts).toEqual([DEMO_ACTION_TOAST]);
    expect(el.hidden).toBe(false);
    el.querySelector<HTMLButtonElement>('.close')!.click();
    expect(el.hidden).toBe(true);
    expect(closed).toBe(1);
  });
});

describe('DetailPane as a modal (I-4.1, I-4.3)', () => {
  let el: HTMLElement;
  let scrim: HTMLElement;
  let background: HTMLElement;
  let pane: DetailPane;
  let closed: number;
  let maskNow: Uint8Array | null;

  beforeEach(() => {
    maskNow = null;
    document.body.innerHTML = '<div id="app"><button id="behind">b</button></div>'
      + '<div id="overlay"><div id="scrim" hidden></div><div id="detail" hidden></div></div>';
    el = document.getElementById('detail')!;
    scrim = document.getElementById('scrim')!;
    background = document.getElementById('app')!;
    closed = 0;
    pane = new DetailPane(el, {
      onClose: () => { closed++; },
      onToast: () => {},
      scrim,
      background,
      mask: () => maskNow,
    });
  });

  it('is a modal dialog that makes the application inert behind it', () => {
    expect(el.getAttribute('aria-modal')).toBe('true');
    expect(background.hasAttribute('inert')).toBe(false);
    pane.show(dataset(), 0, 'Team');
    expect(background.hasAttribute('inert')).toBe(true);
    expect(scrim.hidden).toBe(false);
    pane.hide();
    expect(background.hasAttribute('inert')).toBe(false);
    expect(scrim.hidden).toBe(true);
  });

  it('closes on a scrim click', () => {
    pane.show(dataset(), 0, 'Team');
    scrim.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.hidden).toBe(true);
    expect(closed).toBe(1);
  });

  it('wraps Tab inside the dialog at both ends', () => {
    pane.show(withDetail(), 0, 'Team');
    const focusable = [...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
    expect(focusable.length).toBeGreaterThan(1);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    const fwd = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    el.dispatchEvent(fwd);
    expect(fwd.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('leaves other keys alone', () => {
    pane.show(withDetail(), 0, 'Team');
    const ev = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('renders the declared sections, skipping fields whose column is missing', () => {
    pane.show(withDetail(), 0, 'Team');
    const heads = [...el.querySelectorAll('h3')].map((h) => h.textContent);
    expect(heads).toContain('Who');
    const labels = [...el.querySelectorAll('dt')].map((d) => d.textContent);
    expect(labels).toContain('Team');
    // 'Nonexistent' names no column: the row is dropped, not printed empty.
    expect(labels).not.toContain('Nonexistent');
  });

  it('escapes every value it renders', () => {
    pane.show(withDetail(), 0, 'Team');
    expect(el.querySelector('#detailTitle')!.innerHTML).toBe('Ann &lt;b&gt;');
    expect(el.innerHTML).not.toContain('<b>');
  });

  it('renders the declared actions as non-navigating links', () => {
    pane.show(withDetail(), 0, 'Team');
    const a = el.querySelector<HTMLAnchorElement>('a[data-action="review"]')!;
    expect(a).not.toBeNull();
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(el.hidden).toBe(false);
  });

  it('shows each value share against the filtered set, not the whole collection', () => {
    pane.show(withDetail(), 0, 'Team');
    // Row 0 is Tone=Red, 2 of 3 rows.
    let pct = [...el.querySelectorAll('.context li')].map((li) => li.querySelector('.pct')!.textContent);
    expect(pct).toContain('67%');
    expect(el.querySelector('.context .note')!.textContent).toContain('3');

    // Filter row 2 (the other Red) out: Red is now 1 of 2.
    maskNow = new Uint8Array([1, 1, 0]);
    pane.hide();
    pane.show(withDetail(), 0, 'Team');
    pct = [...el.querySelectorAll('.context li')].map((li) => li.querySelector('.pct')!.textContent);
    expect(pct).toContain('50%');
    expect(el.querySelector('.context .note')!.textContent).toContain('2');
  });

  it('a registered renderer still wins over the template', () => {
    registerDetail('toy-kind', (_ds, i, { accent }) => `<header style="background:${accent}"><h2 id="detailTitle">R${i}</h2></header>`);
    pane.show(withDetail({ kind: 'toy-kind' }), 1, 'Team');
    expect(el.querySelector('#detailTitle')!.textContent).toBe('R1');
  });
});
