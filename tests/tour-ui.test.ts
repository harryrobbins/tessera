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
  function withCard(el: HTMLElement, w: number, hgt: number, left: number, top: number) {
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left, top, width: w, height: hgt, right: left + w, bottom: top + hgt, x: left, y: top, toJSON() {} }),
    });
  }
  function rectTarget(r: { left: number; top: number; width: number; height: number }) {
    return { ...step(), target: () => r };
  }
  function viewport(w: number, hgt: number) {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: hgt, configurable: true });
  }

  it('docks in one place whatever is spotlit', () => {
    const { h } = handlers();
    ui = new TourUI(page, h);
    const card = ui.root.querySelector<HTMLElement>('.tour-card')!;
    viewport(1000, 600);

    // Three targets as unlike each other as the script gets: the topbar, the
    // facet sidebar, and a card in the middle of the canvas. The card is
    // placed by CSS alone, so it must never grow an inline left/top again.
    for (const r of [
      { left: 400, top: 20, width: 50, height: 20 },
      { left: 8, top: 300, width: 200, height: 26 },
      { left: 480, top: 280, width: 60, height: 60 },
    ]) {
      ui.showStep(rectTarget(r), 0, 3);
      expect(card.style.left).toBe('');
      expect(card.style.top).toBe('');
      expect(card.classList.contains('dock-bl')).toBe(false);
    }
  });

  it('slides to the other corner only when the dock would cover the target', () => {
    const { h } = handlers();
    ui = new TourUI(page, h);
    const card = ui.root.querySelector<HTMLElement>('.tour-card')!;
    viewport(1000, 600);
    withCard(card, 420, 180, 560, 400);

    ui.showStep(rectTarget({ left: 400, top: 20, width: 50, height: 20 }), 0, 3);
    expect(card.classList.contains('dock-bl')).toBe(false);

    // Bottom-right, where the docked card sits: it has to get out of the way.
    ui.showStep(rectTarget({ left: 700, top: 480, width: 120, height: 40 }), 1, 3);
    expect(card.classList.contains('dock-bl')).toBe(true);
    expect(parseFloat(card.style.getPropertyValue('--dock-dx'))).toBeLessThan(0);
  });

  it('keeps the step card out of the way while the welcome card is up', () => {
    const { h } = handlers();
    ui = new TourUI(page, h);
    ui.showWelcome(() => {}, () => {});
    const card = ui.root.querySelector<HTMLElement>('.tour-card:not(.tour-welcome)')!;
    // `hidden` alone is not enough: .tour-card declares `display: flex`, which
    // outranks the UA stylesheet, so style.css carries a .tour-card[hidden]
    // rule. Assert the attribute here and keep that rule beside it.
    expect(card.hidden).toBe(true);
    expect(ui.root.querySelectorAll('.tour-welcome')).toHaveLength(1);
  });

  it('hides the spotlight and the beam when the target is missing', () => {
    const { h } = handlers();
    ui = new TourUI(page, h);
    ui.showStep({ ...step(), target: '#nope' }, 0, 3);
    const spot = ui.root.querySelector<HTMLElement>('.tour-spot')!;
    const beam = ui.root.querySelector<SVGSVGElement>('.tour-beam')!;
    expect(spot.hidden).toBe(true);
    expect(beam.hasAttribute('hidden')).toBe(true);
    expect(spot.classList.contains('lit')).toBe(false);
  });

  it('follows a moving rect target between frames (L-10)', async () => {
    const { h } = handlers();
    ui = new TourUI(page, h);
    const spot = ui.root.querySelector<HTMLElement>('.tour-spot')!;
    const beam = ui.root.querySelector<SVGSVGElement>('.tour-beam')!;
    const r = { left: 10, top: 10, width: 20, height: 20 };
    ui.showStep({ ...step(), target: () => r }, 0, 3);
    expect(spot.style.left).toBe('4px');
    // jsdom measures the card as 0x0, which is the same shape as a card that
    // has not been laid out yet: there is no lamp to draw a beam from.
    expect(beam.hasAttribute('hidden')).toBe(true);
    r.left = 110;
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    expect(spot.style.left).toBe('104px');
  });

  it('draws a finite cone that lands on the target (H-complaint 2)', () => {
    const { h } = handlers();
    ui = new TourUI(page, h);
    const card = ui.root.querySelector<HTMLElement>('.tour-card')!;
    const beam = ui.root.querySelector<SVGSVGElement>('.tour-beam')!;
    viewport(1000, 600);
    withCard(card, 420, 180, 560, 400);

    const target = { left: 100, top: 60, width: 40, height: 20 };
    ui.showStep(rectTarget(target), 0, 3);
    expect(beam.hasAttribute('hidden')).toBe(false);

    const points = beam.querySelector('.cone')!.getAttribute('points')!;
    expect(points).not.toMatch(/NaN|Infinity/);
    const pts = points.split(' ').map((q) => q.split(',').map(Number));
    expect(pts).toHaveLength(4);
    for (const [x, y] of pts) { expect(Number.isFinite(x)).toBe(true); expect(Number.isFinite(y)).toBe(true); }

    // The far edge is the target's own silhouette, so both of its points must
    // sit on the target rather than somewhere in the middle of the screen.
    const pad = 24;
    for (const [x, y] of pts.slice(1, 3)) {
      expect(x).toBeGreaterThan(target.left - pad);
      expect(x).toBeLessThan(target.left + target.width + pad);
      expect(y).toBeGreaterThan(target.top - pad);
      expect(y).toBeLessThan(target.top + target.height + pad);
    }

    // And the arrowhead points from the lamp towards the target, not away.
    const t = beam.querySelector('.head')!.getAttribute('transform')!;
    expect(t).toMatch(/^translate\([-\d.]+,[-\d.]+\) rotate\([-\d.]+\)$/);
  });
});
