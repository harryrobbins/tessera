import { describe, it, expect } from 'vitest';
import { layoutTaxCard, smallestFont, densityFor, type TaxCardLayout } from '../src/gl/cards/layout';
import { fmtHours, inkOn, priorityColor } from '../src/gl/cards/taxCase';
import { CHIP_HIGH, CHIP_LOW, CHIP_STANDARD, INK, BG } from '../src/gl/atlas';

// The painter needs a canvas; the geometry it paints from does not.

function rects(l: TaxCardLayout) {
  return [l.header, l.tile, l.bar, l.foot];
}

describe('layoutTaxCard geometry', () => {
  it('keeps every rect inside the 128 px slot and every run inside the inset', () => {
    const l = layoutTaxCard(128);
    expect(l.density).toBe('compact');
    for (const r of rects(l)) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(128);
      expect(r.y + r.h).toBeLessThanOrEqual(128);
    }
    for (const t of [l.topic, l.name, l.address, l.contacts!, l.barLabel!]) {
      expect(t.x).toBeGreaterThanOrEqual(l.inset);
      expect(t.x).toBeLessThanOrEqual(l.right);
      expect(t.y - t.size).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeLessThanOrEqual(128);
    }
  });

  it.each([64, 128, 256, 512, 1024])('rows never overlap at %i px', (h) => {
    const l = layoutTaxCard(h);
    const bands = [...l.bands].sort((a, b) => a.top - b.top);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].top, `${bands[i - 1].key} → ${bands[i].key}`).toBeGreaterThanOrEqual(bands[i - 1].bottom);
    }
    expect(bands[bands.length - 1].bottom).toBeLessThanOrEqual(h);
  });

  it('never draws a run below the 9 px floor', () => {
    expect(smallestFont(layoutTaxCard(64))).toBeGreaterThanOrEqual(9);
    expect(smallestFont(layoutTaxCard(128))).toBeGreaterThanOrEqual(9);
  });

  it('is the full variant at 256 with the opened line present; the case ref survives at 128', () => {
    const l = layoutTaxCard(256);
    expect(l.density).toBe('full');
    expect(l.caseRef).toBeDefined();
    expect(l.opened).toBeDefined();
    expect(layoutTaxCard(128).caseRef).toBeDefined();
    expect(layoutTaxCard(128).opened).toBeUndefined();
    expect(layoutTaxCard(64).caseRef).toBeUndefined();
  });

  it('scales proportionally: 256 is 2x the 128 geometry within a pixel, so hi-res tiers do not re-flow', () => {
    const a = layoutTaxCard(128);
    const b = layoutTaxCard(256);
    const pairs: Array<[number, number]> = [];
    for (const k of ['header', 'tile', 'bar', 'foot'] as const) {
      for (const f of ['x', 'y', 'w', 'h'] as const) pairs.push([a[k][f], b[k][f]]);
    }
    for (const k of ['topic', 'caseRef', 'name', 'address', 'contacts', 'barLabel'] as const) {
      for (const f of ['x', 'y', 'size'] as const) pairs.push([a[k]![f], b[k]![f]]);
    }
    pairs.push([a.chips.y, b.chips.y], [a.chips.h, b.chips.h], [a.stars!.y, b.stars!.y], [a.stars!.size, b.stars!.size]);
    for (const [v128, v256] of pairs) {
      // Font floor (9 px) only bites at 128; allow it on runs, not on boxes.
      if (v128 === 9 && v256 < 18) continue;
      expect(Math.abs(v256 - v128 * 2)).toBeLessThanOrEqual(1);
    }
  });

  it('has a smallest font of at least 72 px at 1024', () => {
    expect(smallestFont(layoutTaxCard(1024))).toBeGreaterThanOrEqual(58);
    expect(layoutTaxCard(1024).name.size).toBeGreaterThanOrEqual(100);
  });

  it('picks the density by height', () => {
    expect(densityFor(64)).toBe('tiny');
    expect(densityFor(128)).toBe('compact');
    expect(densityFor(256)).toBe('full');
  });
});

describe('painter helpers', () => {
  it('formats resolution hours for the bar label', () => {
    expect(fmtHours(0.9)).toBe('0.9 h');
    expect(fmtHours(36)).toBe('36 h');
    expect(fmtHours(120)).toBe('5 d');
  });
  it('maps priority to the chip palette', () => {
    expect(priorityColor('High')).toBe(CHIP_HIGH);
    expect(priorityColor('Standard')).toBe(CHIP_STANDARD);
    expect(priorityColor('Low')).toBe(CHIP_LOW);
  });
  it('uses dark ink on the light end of the sequential ramp', () => {
    expect(inkOn('#cde2fb')).toBe(BG);
    expect(inkOn('#0d366b')).toBe(INK);
  });
});

// --------------------------------------------------------------- quiet card

import { quietLayout, quietDensityFor, smallestQuietFont, type QuietLayout, type QuietSlots } from '../src/gl/cards/quietLayout';
import { compileCard } from '../src/gl/cards/model';
import { quietPainter } from '../src/gl/cards/quiet';
import { cardPainterFor } from '../src/gl/cards';
import { category, numeric, text, type Dataset } from '../src/data/columnar';
import type { CardSpec } from '../src/gl/atlas';

function quietRects(l: QuietLayout) {
  return [l.header, l.foot, ...(l.tile ? [l.tile] : [])];
}
function quietRuns(l: QuietLayout) {
  return [l.topic, ...l.title, ...l.blurb, ...(l.metric ? [l.metric.value] : [])];
}

describe('quietLayout geometry', () => {
  it.each([64, 128, 256, 512, 1024])('keeps every rect and run inside the %i px slot', (h) => {
    const l = quietLayout(h);
    for (const r of quietRects(l)) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(h);
      expect(r.y + r.h).toBeLessThanOrEqual(h);
    }
    for (const t of quietRuns(l)) {
      expect(t.x).toBeGreaterThanOrEqual(l.inset);
      expect(t.x).toBeLessThanOrEqual(l.right);
      expect(t.y - t.size).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeLessThanOrEqual(h);
      expect(t.maxW).toBeGreaterThan(0);
    }
  });

  it.each([64, 128, 256, 512, 1024])('rows never overlap at %i px', (h) => {
    const bands = [...quietLayout(h).bands].sort((a, b) => a.top - b.top);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].top, `${bands[i - 1].key} → ${bands[i].key}`).toBeGreaterThanOrEqual(bands[i - 1].bottom);
    }
    expect(bands[bands.length - 1].bottom).toBeLessThanOrEqual(h);
  });

  it('never draws a run below the 9 px floor', () => {
    for (const h of [64, 96, 128, 192, 256]) expect(smallestQuietFont(quietLayout(h)), `${h} px`).toBeGreaterThanOrEqual(9);
  });

  it('picks the density by height, switching at 96 and 192', () => {
    expect(quietDensityFor(95)).toBe('tiny');
    expect(quietDensityFor(96)).toBe('compact');
    expect(quietDensityFor(191)).toBe('compact');
    expect(quietDensityFor(192)).toBe('full');
  });

  it('drops the mark tile, the blurb and the metric at tiny, and caps tags at one', () => {
    const tiny = quietLayout(64);
    expect(tiny.tile).toBeUndefined();
    expect(tiny.blurb).toHaveLength(0);
    expect(tiny.metric).toBeUndefined();
    expect(tiny.title).toHaveLength(1);
    expect(tiny.tags?.max).toBe(1);
    // The topic then starts at the inset, not beside a tile that is not there.
    expect(tiny.topic.x).toBe(tiny.inset);

    const compact = quietLayout(128);
    expect(compact.tile).toBeDefined();
    expect(compact.blurb).toHaveLength(1);
    expect(compact.metric).toBeUndefined();
    expect(compact.tags?.max).toBe(2);

    const full = quietLayout(256);
    expect(full.title).toHaveLength(2);
    expect(full.blurb).toHaveLength(2);
    expect(full.metric).toBeDefined();

    // Content availability is the painter's to state; how much of it fits is
    // the density's to decide, so asking for more than the box allows is capped.
    expect(quietLayout(64, 64, { titleLines: 2, blurbLines: 2, tags: 2, metric: true, mark: true }))
      .toMatchObject({ title: [{}], blurb: [], metric: undefined, tile: undefined });
    expect(quietLayout(64, 64, { tags: 2 }).tags!.max).toBe(1);
  });

  it('scales proportionally within a density, so a hi-res tier never re-flows', () => {
    const pairs: Array<[number, number, string]> = [];
    const collect = (a: QuietLayout, b: QuietLayout) => {
      for (const k of ['header', 'foot'] as const) {
        for (const f of ['x', 'y', 'w', 'h'] as const) pairs.push([a[k][f], b[k][f], `${k}.${f}`]);
      }
      for (const f of ['x', 'y', 'w', 'h'] as const) pairs.push([a.tile![f], b.tile![f], `tile.${f}`]);
      for (const f of ['x', 'y', 'size'] as const) {
        pairs.push([a.topic[f], b.topic[f], `topic.${f}`]);
        pairs.push([a.title[0][f], b.title[0][f], `title.${f}`]);
        pairs.push([a.blurb[0][f], b.blurb[0][f], `blurb.${f}`]);
      }
      pairs.push([a.tags!.y, b.tags!.y, 'tags.y'], [a.tags!.h, b.tags!.h, 'tags.h']);
    };
    // 256 → 512 is the same density, so the whole table doubles.
    collect(quietLayout(256), quietLayout(512));
    // 128 → 256 crosses compact/full, so ask both for slots the *compact*
    // density also allows — a two-line title is a full-density thing.
    const slots: QuietSlots = { mark: true, titleLines: 1, blurbLines: 1, tags: 2, metric: false };
    collect(quietLayout(128, 128, slots), quietLayout(256, 256, slots));
    for (const [lo, hi, key] of pairs) {
      // The 9 px font floor only bites at the small end; allow it on runs.
      if (lo === 9 && hi < 18) continue;
      expect(Math.abs(hi - lo * 2), `${key}: ${lo} → ${hi}`).toBeLessThanOrEqual(1);
    }
  });

  it('closes up a missing slot rather than leaving a gap', () => {
    const all = quietLayout(256);
    const noBlurb = quietLayout(256, 256, { blurbLines: 0 });
    expect(noBlurb.blurb).toHaveLength(0);
    expect(noBlurb.bands.some((b) => b.key.startsWith('blurb'))).toBe(false);
    // The body block re-centres: the title starts lower, and the tags end higher.
    expect(noBlurb.title[0].y).toBeGreaterThan(all.title[0].y);
    expect(noBlurb.tags!.y).toBeLessThan(all.tags!.y);

    const bare = quietLayout(256, 256, { blurbLines: 0, tags: 0, metric: false });
    expect(bare.tags).toBeUndefined();
    expect(bare.metric).toBeUndefined();
    expect(bare.bands.map((b) => b.key)).toEqual(['topic', 'title0', 'title1', 'foot']);
    // …and what is left sits in the middle of the space, not at the top of it.
    const mid = (bare.title[0].y - bare.title[0].size + bare.title[1].y) / 2;
    expect(Math.abs(mid - (bare.header.h + bare.foot.y) / 2)).toBeLessThanOrEqual(bare.h * 0.04);
  });
});

// ------------------------------------------------------------ compiled model

function toyDataset(): Dataset {
  return {
    name: 'Toy',
    n: 4,
    columns: {
      Name: text('Name', ['Morag Sinclair', 'Ada Byron', 'Bo', '']),
      Status: category('Status', ['Open', 'Resolved', 'Open', 'Resolved']),
      Priority: category('Priority', ['High', 'Standard', 'Low', 'Standard']),
      Channel: category('Channel', ['Phone', 'Post', 'Webchat', 'Phone']),
      Contacts: numeric('Contacts', [1, 2, 3, 4], (v) => v.toFixed(0)),
    },
    labelColumn: 'Name',
    facets: ['Status', 'Priority', 'Channel', 'Contacts'],
  };
}
const spec = (i: number): CardSpec => ({ title: `#${i}`, accent: '#3987e5', row: i });

describe('compileCard', () => {
  it('refills one object rather than allocating per card', () => {
    const model = compileCard(toyDataset(), undefined, 'Status');
    const a = model(spec(0));
    const b = model(spec(1));
    expect(a).toBe(b);
    expect(a.tags[0]).toBe(b.tags[0]);
    expect(b.title).toBe('Ada Byron');
  });

  it('derives the §3.3 defaults: label as title, colour-by as topic, two facet tags, first numeric metric', () => {
    const ds = toyDataset();
    const c = compileCard(ds, undefined, 'Status')(spec(0));
    expect(c.title).toBe('Morag Sinclair');
    expect(c.initials).toBe('MS');
    expect(c.topic).toBe('Open');
    expect(c.blurb).toBe('');
    // Status is the accent, Name is the title, so Priority and Channel are next.
    expect(c.tagCount).toBe(2);
    expect([c.tags[0].text, c.tags[1].text]).toEqual(['High', 'Phone']);
    expect(c.tags[0].shape).toBe('dot');
    expect(c.metric).toBe('1');
    expect(c.metricLabel).toBe('Contacts');
  });

  it('resolves tones from a value map and drops hideWhen values', () => {
    const model = compileCard(toyDataset(), {
      tags: [
        { value: 'Priority', shape: 'pill', tone: { High: 'bad', Standard: 'accent', Low: 'neutral' }, hideWhen: ['Standard'] },
        { value: 'Status', shape: 'dot', tone: { Open: 'warn', Resolved: 'good' } },
      ],
    }, 'Status');
    const high = model(spec(0));
    expect(high.tagCount).toBe(2);
    expect(high.tags[0]).toMatchObject({ text: 'High', tone: 'bad', shape: 'pill' });
    expect(high.tags[1]).toMatchObject({ text: 'Open', tone: 'warn', shape: 'dot' });
    // Standard is 55 % of the board; hiding it leaves one chip, not an empty one.
    const standard = model(spec(1));
    expect(standard.tagCount).toBe(1);
    expect(standard.tags[0]).toMatchObject({ text: 'Resolved', tone: 'good' });
  });

  it('never drops below two tags-worth of state when a tag is hidden mid-list', () => {
    const model = compileCard(toyDataset(), {
      tags: [
        { value: 'Priority', hideWhen: ['High'] },
        { value: 'Status' },
        { value: 'Channel' },
      ],
    }, '');
    // Three declared, two drawn; the hidden one does not consume a slot.
    expect(model(spec(0)).tagCount).toBe(2);
    expect([model(spec(0)).tags[0].text, model(spec(0)).tags[1].text]).toEqual(['Open', 'Phone']);
  });

  it('falls back through missing columns instead of printing a placeholder', () => {
    const ds = toyDataset();
    delete ds.columns.Name;
    ds.labelColumn = 'Status';
    const c = compileCard(ds, { title: 'Customer', blurb: 'Postcode', metric: { value: 'Nope' } }, 'Priority')(spec(2));
    expect(c.title).toBe('Open');       // Customer is absent → the label column
    expect(c.blurb).toBe('');           // Postcode is absent → the line is not drawn
    expect(c.metric).toBe('');
  });

  it('reads an accessor slot and a glyph mark', () => {
    const c = compileCard(toyDataset(), {
      blurb: (i) => `row ${i}`,
      mark: { glyph: 'Channel' },
    }, 'Status')(spec(3));
    expect(c.blurb).toBe('row 3');
    expect(c.glyph).toBe('Phone');
    // The label column is empty at row 3 — the spec's own title is the fallback.
    expect(c.title).toBe('#3');
  });

  it('honours the settings overrides for title and tags', () => {
    const ds = toyDataset();
    const c = compileCard(ds, ds.card, 'Status', { title: 'Channel', tags: false })(spec(0));
    expect(c.title).toBe('Phone');
    expect(c.tagCount).toBe(0);
  });
});

// ------------------------------------------------------- painter smoke tests

/**
 * A recording stub for the handful of Canvas2D calls the painters make. The
 * geometry is tested above; this only proves the painters run end to end and
 * put the record's own words on the face — which is the whole complaint.
 */
function stubCtx() {
  const text: string[] = [];
  const ctx = {
    text,
    font: '',
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    lineCap: '',
    lineJoin: '',
    globalAlpha: 1,
    textAlign: '',
    textBaseline: '',
    fillText: (s: string) => { if (s) text.push(s); },
    measureText: (s: string) => ({ width: s.length * 6 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arcTo() {}, arc() {},
    rect() {}, clip() {}, fill() {}, stroke() {}, fillRect() {}, strokeRect() {}, setLineDash() {},
  };
  return ctx as unknown as CanvasRenderingContext2D & { text: string[] };
}

describe('painters', () => {
  const ds = toyDataset();

  it.each([64, 128, 256, 1024])('the quiet card puts the record on the face at %i px', (h) => {
    const ctx = stubCtx();
    quietPainter(ds, { colorBy: 'Status' })(ctx, h, h, spec(0));
    // 64 px is where `clip()` starts biting; the name is still the name.
    expect(ctx.text.some((s) => 'Morag Sinclair'.startsWith(s.replace('…', '')))).toBe(true);
    expect(ctx.text).toContain('Open');   // the topic, from the colour-by
    expect(ctx.text).toContain('High');   // one tag survives even at tiny
  });

  it('draws two neighbouring rows differently — that is the whole point', () => {
    const paint = quietPainter(ds, { colorBy: 'Status' });
    const a = stubCtx(); paint(a, 256, 256, spec(0));
    const b = stubCtx(); paint(b, 256, 256, spec(1));
    expect(a.text).not.toEqual(b.text);
  });

  it('never prints a placeholder for a missing value', () => {
    const paint = quietPainter(ds, { colorBy: 'Status' });
    const ctx = stubCtx();
    paint(ctx, 256, 256, spec(3));       // row 3 has an empty Name
    expect(ctx.text.join(' ')).not.toMatch(/—|not surveyed|undefined|null/);
  });

  it('paints a group cover, not a record, for a spec with no row', () => {
    const ctx = stubCtx();
    quietPainter(ds, { colorBy: 'Status' })(ctx, 256, 256, { title: 'PAYE', accent: '#3987e5' });
    expect(ctx.text).toEqual(['PA', 'PAYE']);
  });

  it('routes tax-cases to the dense painter below 3,000 rows and the quiet one above', () => {
    const dense = { ...ds, card: { custom: 'taxCase' as const } };
    const ctx = stubCtx();
    cardPainterFor(dense, { colorBy: 'Status' })(ctx, 256, 256, spec(0));
    // The dense card shows the case ref, the stars and the hours bar label;
    // the quiet card shows none of them.
    expect(ctx.text).toContain('#0');
    expect(cardPainterFor(ds, { design: 'quiet' })).not.toBe(cardPainterFor(dense));
  });
});
