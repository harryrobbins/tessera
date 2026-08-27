// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TourUI, type TourUIHandlers } from '../src/tour/ui';

function handlers() {
  const calls: string[] = [];
  const h: TourUIHandlers = {
    onNext: () => calls.push('next'),
    onBack: () => calls.push('back'),
    onSkip: () => calls.push('skip'),
    onMute: () => calls.push('mute'),
  };
  return { h, calls };
}

function key(target: EventTarget, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

const step = (i = 0) => ({ id: `s${i}`, title: 'T', text: 'some **bold** text' });

let ui: TourUI | null = null;
let page: HTMLElement;

beforeEach(() => {
  document.body.innerHTML =
    '<button id="tourBtn">Tour</button>' +
    '<div id="detail"><a href="#" data-action="review">Review action</a></div>' +
    '<select id="sortBy"><option>a</option></select>' +
    '<label><input type="checkbox" id="facet"></label>';
  page = document.body;
});

afterEach(() => { ui?.destroy(); ui = null; });

describe('TourUI keyboard map (H-02)', () => {
  it('Enter/Space/arrows advance when focus is on the body or the caption text', () => {
    const { h, calls } = handlers();
    ui = new TourUI(page, h);
    ui.showStep(step(), 0, 3);
    document.body.focus();
    expect(key(document.body, 'Enter').defaultPrevented).toBe(true);
    expect(key(document.body, ' ').defaultPrevented).toBe(true);
    expect(key(document.body, 'ArrowRight').defaultPrevented).toBe(true);
    expect(key(document.body, 'ArrowLeft').defaultPrevented).toBe(true);
    expect(calls).toEqual(['next', 'next', 'next', 'back']);
  });

  it('Enter on a tour button activates the button, not Next', () => {
    const { h, calls } = handlers();
    ui = new TourUI(page, h);
    ui.showStep(step(), 0, 3);
    const back = ui.root.querySelector<HTMLButtonElement>('.tour-back')!;
    back.disabled = false;
    back.focus();
    expect(key(back, 'Enter').defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    // Arrows still navigate from inside the card.
    key(back, 'ArrowRight');
    expect(calls).toEqual(['next']);
  });

  it('leaves Enter/Space/arrows alone on page controls (detail link, select, checkbox)', () => {
    const { h, calls } = handlers();
    ui = new TourUI(page, h);
    ui.showStep(step(), 0, 3);
    const link = document.querySelector<HTMLAnchorElement>('#detail a')!;
    const sel = document.querySelector<HTMLSelectElement>('#sortBy')!;
    const box = document.querySelector<HTMLInputElement>('#facet')!;
    for (const t of [link, sel, box]) {
      t.focus();
      for (const k of ['Enter', ' ', 'ArrowRight', 'ArrowLeft']) {
        expect(key(t, k).defaultPrevented, `${t.id || t.tagName} ${k}`).toBe(false);
      }
    }
    expect(calls).toEqual([]);
  });

  it('Escape skips and M mutes from anywhere', () => {
    const { h, calls } = handlers();
    ui = new TourUI(page, h);
    ui.showStep(step(), 0, 3);
    const link = document.querySelector<HTMLAnchorElement>('#detail a')!;
    link.focus();
    expect(key(link, 'Escape').defaultPrevented).toBe(true);
    key(document.body, 'm');
    key(link, 'M');
    expect(calls).toEqual(['skip', 'mute', 'mute']);
  });

  it('does nothing for Enter while the card is hidden (welcome screen)', () => {
    const { h, calls } = handlers();
    ui = new TourUI(page, h);
    ui.showWelcome(() => calls.push('start'), () => calls.push('dismiss'));
    expect(key(document.body, 'Enter').defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('TourUI focus', () => {
  it('focuses Next on a step, traps Tab inside the card, and returns focus on destroy', () => {
    const { h } = handlers();
    const tourBtn = document.querySelector<HTMLButtonElement>('#tourBtn')!;
    tourBtn.focus();
    ui = new TourUI(page, h);
    ui.showStep(step(), 1, 3);
    const next = ui.root.querySelector<HTMLButtonElement>('.tour-next')!;
    expect(document.activeElement).toBe(next);
    // jsdom has no layout: offsetParent is null, so make the buttons "visible".
    for (const b of ui.root.querySelectorAll<HTMLButtonElement>('button')) {
      Object.defineProperty(b, 'offsetParent', { value: document.body });
    }
    // Tab from the last button wraps to the first.
    expect(key(next, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(ui.root.querySelector('.tour-mute'));
    // Shift+Tab from the first wraps to the last.
    expect(key(document.activeElement!, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(next);
    // Focus that escaped the dialog is pulled back in.
    tourBtn.focus();
    key(tourBtn, 'Tab');
    expect(ui.root.contains(document.activeElement)).toBe(true);
    ui.destroy();
    ui = null;
    expect(document.activeElement).toBe(tourBtn);
  });

  it('reflects mute state with aria-pressed and the label', () => {
    const { h } = handlers();
    ui = new TourUI(page, h);
    const btn = ui.root.querySelector<HTMLButtonElement>('.tour-mute')!;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    ui.setMuted(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.textContent).toBe('Unmute');
    ui.setMuted(false);
    expect(btn.textContent).toBe('Mute');
  });
});

describe('TourUI placement', () => {
  function withSize(el: HTMLElement, w: number, hgt: number) {
    Object.defineProperty(el, 'offsetWidth', { value: w, configurable: true });
    Object.defineProperty(el, 'offsetHeight', { value: hgt, configurable: true });
  }
  function rectTarget(r: { left: number; top: number; width: number; height: number }) {
    return { ...step(), target: () => r };
  }

  it('prefers below, then above, then right, then left, clamped to the viewport', () => {
    const { h } = handlers();
    ui = new TourUI(page, h);
    const card = ui.root.querySelector<HTMLElement>('.tour-card')!;
    withSize(card, 300, 150);
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });

    ui.showStep(rectTarget({ left: 400, top: 100, width: 50, height: 20 }), 0, 3);
    expect(card.classList.contains('side-below')).toBe(true);
    expect(parseFloat(card.style.left)).toBeGreaterThanOrEqual(12);

    ui.showStep(rectTarget({ left: 400, top: 500, width: 50, height: 20 }), 0, 3);
    expect(card.classList.contains('side-above')).toBe(true);

    // Tall target down the middle: neither below nor above fits, right does.
    ui.showStep(rectTarget({ left: 100, top: 100, width: 50, height: 450 }), 0, 3);
    expect(card.classList.contains('side-right')).toBe(true);

    ui.showStep(rectTarget({ left: 800, top: 100, width: 50, height: 450 }), 0, 3);
    expect(card.classList.contains('side-left')).toBe(true);

    // A target at the very edge: card stays inside the margin.
    ui.showStep(rectTarget({ left: 0, top: 0, width: 10, height: 10 }), 0, 3);
    expect(parseFloat(card.style.left)).toBeGreaterThanOrEqual(12);
    expect(parseFloat(card.style.top)).toBeGreaterThanOrEqual(12);
  });

  it('floats bottom-centre with no spotlight when the target is missing', () => {
    const { h } = handlers();
    ui = new TourUI(page, h);
    ui.showStep({ ...step(), target: '#nope' }, 0, 3);
    const card = ui.root.querySelector<HTMLElement>('.tour-card')!;
    const spot = ui.root.querySelector<HTMLElement>('.tour-spot')!;
    expect(card.classList.contains('floating')).toBe(true);
    expect(spot.hidden).toBe(true);
  });

  it('follows a moving rect target between frames (L-10)', async () => {
    const { h } = handlers();
    ui = new TourUI(page, h);
    const spot = ui.root.querySelector<HTMLElement>('.tour-spot')!;
    const r = { left: 10, top: 10, width: 20, height: 20 };
    ui.showStep({ ...step(), target: () => r }, 0, 3);
    expect(spot.style.left).toBe('4px');
    r.left = 110;
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    expect(spot.style.left).toBe('104px');
  });
});
