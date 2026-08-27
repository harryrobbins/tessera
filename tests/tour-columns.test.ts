import { describe, it, expect } from 'vitest';
import { generateTaxCases } from '../src/data/taxCases';
import { COL, VAL, TOUR_DATASET } from '../src/tour/columns';
import { rowsWhere } from '../src/tour/actions';

/** The tour's schema binding checked against the real generator, so drift in B's dataset fails here, not on stage. */
describe('tour columns vs tax-cases dataset', () => {
  // A faker-shaped stub: the real names come from @faker-js via the registry, lazily.
  const names = { seed() { /* deterministic anyway */ }, person: { firstName: () => 'Morag', lastName: () => 'Wallace' } };
  const ds = generateTaxCases(Number(TOUR_DATASET.split(':')[1]), 11, names);
  const expectedKind: Record<string, 'category' | 'number' | 'text'> = {
    [COL.customer]: 'text',
    [COL.town]: 'category',
    [COL.longitude]: 'number',
    [COL.latitude]: 'number',
    [COL.topic]: 'category',
    [COL.channel]: 'category',
    [COL.priority]: 'category',
    [COL.status]: 'category',
    [COL.escalated]: 'category',
    [COL.contacts]: 'number',
    [COL.opened]: 'number',
    [COL.ageBand]: 'category',
    [COL.areaType]: 'category',
    [COL.hours]: 'number',
    [COL.satisfaction]: 'number',
  };
  const cats = (name: string) => {
    const c = ds.columns[name];
    return c && c.kind === 'category' ? c.categories : [];
  };

  it('TOUR_DATASET names a tax-cases size', () => {
    expect(TOUR_DATASET).toMatch(/^tax-cases:\d+$/);
    expect(ds.n).toBe(Number(TOUR_DATASET.split(':')[1]));
  });

  it('every COL exists with the expected kind', () => {
    for (const [name, kind] of Object.entries(expectedKind)) {
      expect(ds.columns[name], name).toBeDefined();
      expect(ds.columns[name].kind, name).toBe(kind);
    }
  });

  it('the columns the tour drives from the menus are facets', () => {
    for (const name of [COL.longitude, COL.latitude, COL.topic, COL.channel, COL.priority, COL.status, COL.contacts, COL.ageBand, COL.areaType, COL.hours, COL.satisfaction]) {
      expect(ds.facets, `${name} in facets`).toContain(name);
    }
  });

  it('every VAL label exists in its column', () => {
    expect(cats(COL.topic)).toContain(VAL.paye);
    expect(cats(COL.channel)).toContain(VAL.phone);
    expect(cats(COL.channel)).toContain(VAL.post);
    expect(cats(COL.status)).toContain(VAL.open);
    expect(cats(COL.priority)).toContain(VAL.high);
  });

  it('rowsWhere filters by every pair, honours the mask, and is empty for unknown labels', () => {
    const post = rowsWhere(ds, { [COL.channel]: VAL.post });
    expect(post.length).toBeGreaterThan(0);
    const channel = ds.columns[COL.channel];
    for (const i of post) expect(channel.kind === 'category' && channel.categories[channel.codes[i]]).toBe(VAL.post);
    const mask = new Uint8Array(ds.n);
    mask[post[0]] = 1;
    expect(rowsWhere(ds, { [COL.channel]: VAL.post }, mask)).toEqual([post[0]]);
    expect(rowsWhere(ds, { [COL.channel]: 'Carrier pigeon' })).toEqual([]);
    expect(rowsWhere(ds, { 'No such column': 'x' })).toEqual([]);
  });

  it('per-row cards, so the zoom and detail steps show real card art', () => {
    expect(ds.cards).not.toBe(false);
    expect(ds.labelColumn).toBeTruthy();
  });
});
