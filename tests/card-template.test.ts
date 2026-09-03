import { describe, it, expect } from 'vitest';
import { faker } from '@faker-js/faker/locale/en_GB';
import { MAX_TAGS, SLOT_CHARS, type CardTemplate, type SlotRef } from '../src/data/card';
import type { Dataset } from '../src/data/columnar';
import { compileCard } from '../src/gl/cards/model';
import { valueAt } from '../src/data/columnar';
import type { CardSpec } from '../src/gl/atlas';
import { generateTaxCases } from '../src/data/taxCases';
import { generateInvoices } from '../src/data/invoices';
import { generateProducts } from '../src/data/products';
import { generatePayments } from '../src/data/payments';
import { generateTaxReturns } from '../src/data/taxReturns';
import { parseBirds, BIRD_SIZES } from '../src/data/birds';
import { birdsFixture } from './helpers/birds';

/**
 * The contract between a dataset and its card: whatever a template names has
 * to be there, and whatever it resolves to has to fit on the face. The caps in
 * §2.1 are guidance — `clip()` enforces them with real font metrics — but a
 * slot that routinely overruns is a slot that reads as an ellipsis everywhere.
 */

const BUILT_INS: Array<{ key: string; ds: Dataset; colorBy: string }> = [
  { key: 'tax-cases:900', ds: generateTaxCases(900, 11, faker), colorBy: 'Topic' },
  { key: 'tax-cases:100000', ds: generateTaxCases(100_000, 11, faker), colorBy: 'Topic' },
  { key: 'invoices:900', ds: generateInvoices(900, 41, faker), colorBy: 'Status' },
  { key: 'products:1000', ds: generateProducts(1000), colorBy: 'Type' },
  { key: 'payments:900', ds: generatePayments(900), colorBy: 'Merchant category' },
  { key: 'tax-returns:900', ds: generateTaxReturns(900), colorBy: 'Sector' },
  // The birds collection is fetched, not generated, so it comes through
  // `parseBirds` on the frozen fixture — every size, because the whole point of
  // this file is that a template names a column the collection actually has.
  ...BIRD_SIZES.map((n) => ({ key: `birds:${n}`, ds: parseBirds(birdsFixture(n)).dataset, colorBy: 'Habitat' })),
];

/** Rows worth checking: the first, the middle and the last. */
function probes(ds: Dataset): number[] {
  return [0, ds.n >> 1, ds.n - 1];
}

function spec(ds: Dataset, i: number): CardSpec {
  return { title: `#${i}`, accent: '#3987e5', row: i };
}

/** Column names a template names directly (accessors are opaque by design). */
function namedColumns(card: CardTemplate | undefined): string[] {
  if (!card) return [];
  const out: string[] = [];
  const push = (ref: SlotRef | undefined) => { if (typeof ref === 'string') out.push(ref); };
  push(card.topic);
  push(card.title);
  push(card.blurb);
  if (typeof card.mark === 'object') push(card.mark.glyph);
  for (const t of card.tags ?? []) push(t.value);
  push(card.metric?.value);
  return out;
}

describe('declared card templates', () => {
  it.each(BUILT_INS)('$key names only columns it has', ({ ds }) => {
    for (const name of namedColumns(ds.card)) {
      expect(ds.columns[name], `${ds.name} declares ${name}`).toBeDefined();
    }
  });

  it.each(BUILT_INS)('$key declares at most two tags', ({ ds }) => {
    expect(ds.card?.tags?.length ?? 0).toBeLessThanOrEqual(MAX_TAGS);
  });

  it.each(BUILT_INS)('$key resolves a title on every probe row', ({ ds, colorBy }) => {
    const model = compileCard(ds, ds.card, colorBy);
    for (const i of probes(ds)) {
      const c = model(spec(ds, i));
      expect(c.title, `row ${i}`).not.toBe('');
      expect(c.initials).not.toBe('');
    }
  });

  it.each(BUILT_INS)('$key keeps the header slots inside their caps', ({ ds, colorBy }) => {
    const model = compileCard(ds, ds.card, colorBy);
    for (const i of probes(ds)) {
      const c = model(spec(ds, i));
      expect(c.topic.length, `topic @${i}: ${c.topic}`).toBeLessThanOrEqual(SLOT_CHARS.topic);
      expect(c.metric.length, `metric @${i}: ${c.metric}`).toBeLessThanOrEqual(SLOT_CHARS.metric);
      expect(c.metricLabel.length).toBeLessThanOrEqual(SLOT_CHARS.metricLabel);
      expect(c.tagCount).toBeLessThanOrEqual(MAX_TAGS);
    }
  });

  /**
   * The caps bind where an author *chose* the slot. The derived default (§3.3)
   * takes what the collection happens to have — products' generated label runs
   * to "Consumer Electronics — United Kingdom 2019", and its first two
   * categorical facets include "South & SE Asia / Oceania" — so there the cap
   * is `clip()`'s job at draw time, not the author's.
   */
  it.each(BUILT_INS.filter((b) => b.ds.card))('$key keeps every declared slot inside its cap', ({ ds, colorBy }) => {
    const model = compileCard(ds, ds.card, colorBy);
    for (const i of probes(ds)) {
      const c = model(spec(ds, i));
      expect(c.title.length, `title @${i}: ${c.title}`).toBeLessThanOrEqual(SLOT_CHARS.title);
      expect(c.blurb.length, `blurb @${i}: ${c.blurb}`).toBeLessThanOrEqual(SLOT_CHARS.blurb);
      for (let k = 0; k < c.tagCount; k++) {
        expect(c.tags[k].text.length, `tag @${i}: ${c.tags[k].text}`).toBeLessThanOrEqual(SLOT_CHARS.tag);
      }
    }
  });
});

describe('tax-cases at 100,000 rows', () => {
  const ds = BUILT_INS[1].ds;

  it('has the same columns and the same label as it does at 900 rows', () => {
    // A collection's shape must not depend on how many rows it has.
    const small = BUILT_INS[0].ds;
    expect(Object.keys(ds.columns)).toEqual(Object.keys(small.columns));
    expect(ds.labelColumn).toBe(small.labelColumn);
    expect(ds.facets).toEqual(small.facets);
    expect(ds.card?.custom).toBe(small.card?.custom);
  });

  it('derives the case reference rather than storing a hundred thousand strings', () => {
    const c = ds.columns.Case;
    expect(c?.kind).toBe('text');
    expect(c?.kind === 'text' && c.values).toBeNull();
    expect(valueAt(ds, 'Case', 0)).toBe('CS-25-000001');
    expect(valueAt(ds, 'Case', 99_999)).toBe('CS-25-100000');
  });

  it('still resolves a non-empty title and blurb — the slots degrade, they do not blank', () => {
    const model = compileCard(ds, ds.card, 'Channel');
    for (const i of probes(ds)) {
      const c = model(spec(ds, i));
      expect(c.title).not.toBe('');
      expect(c.blurb, `blurb @${i}`).not.toBe('');
      expect(c.glyph).not.toBe('');
    }
  });

  it('takes the same dense card at every size', () => {
    // The design used to switch to the quiet card above 3,000 rows, because
    // above the atlas cap every card in a category was the *same* texture and
    // the dense one made that obvious. Cards are per-row art at any size now,
    // so the design is a preference (the Cards popover), not a size rule.
    for (const n of [900, 3_000, 20_000]) {
      expect(generateTaxCases(n, 11, faker).card?.custom).toBe('taxCase');
    }
    expect(ds.card?.custom).toBe('taxCase');
  });
});

describe('detail templates', () => {
  it('tax-cases keeps the bespoke renderer and names three context facets', () => {
    const ds = BUILT_INS[0].ds;
    expect(ds.detail?.custom).toBe('tax-cases');
    expect(ds.detail?.context).toEqual(['Channel', 'Topic', 'Priority']);
    expect(ds.detail?.actions?.map((a) => a.id)).toEqual(['review', 'reassign', 'note']);
  });

  it('invoices declares sections whose context facets exist', () => {
    const ds = BUILT_INS[2].ds;
    expect(ds.detail?.sections?.map((s) => s.title)).toEqual(['Invoice', 'Payment']);
    for (const f of ds.detail?.context ?? []) expect(ds.columns[f]).toBeDefined();
  });
});

describe('slots that would say the same thing twice (I-6.3)', () => {
  it('drops an eyebrow equal to the title', () => {
    // A dataset whose title column *is* its topic column — or one that falls
    // back to it because its own label column is absent — would otherwise
    // print the same word twice, once small and once large.
    const ds = BUILT_INS[0].ds;
    const model = compileCard(ds, { title: 'Topic', topic: 'Topic' }, 'Topic');
    for (const i of probes(ds)) {
      const c = model(spec(ds, i));
      expect(c.title).not.toBe('');
      expect(c.topic).toBe('');
    }
  });

  it('keeps the eyebrow when it says something else', () => {
    const ds = BUILT_INS[0].ds;
    const c = compileCard(ds, { title: 'Customer', topic: 'Topic' }, 'Topic')(spec(ds, 3));
    expect(c.topic).not.toBe('');
    expect(c.topic).not.toBe(c.title);
  });
});
