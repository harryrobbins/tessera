import { describe, it, expect } from 'vitest';
import { generateTaxCases } from '../src/data/taxCases';
import { getNumeric, getCategory } from '../src/data/columnar';
import { COL, VAL, TOUR_DATASET } from '../src/tour/columns';
import { NARRATION } from '../src/tour/script';
import { featuredRow, rowsWhere } from '../src/tour/actions';

/**
 * Every number the narration claims, checked against the dataset the tour
 * loads (same size, same seed). If the generator changes, this fails before
 * a visitor hears a story the picture no longer tells.
 */
const names = { seed() { /* deterministic anyway */ }, person: { firstName: () => 'Morag', lastName: () => 'Wallace' } };
const ds = generateTaxCases(Number(TOUR_DATASET.split(':')[1]), 11, names);
const all = Array.from({ length: ds.n }, (_, i) => i);
const line = (id: string) => NARRATION.find((l) => l.id === id)!.text;
const label = (field: string, i: number) => { const c = getCategory(ds, field); return c.categories[c.codes[i]]; };
const share = (rows: number[], field: string, value: string) => rows.filter((i) => label(field, i) === value).length / rows.length;
const median = (rows: number[], field: string) => {
  const v = getNumeric(ds, field).values;
  const s = rows.map((i) => v[i]).filter(Number.isFinite).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const mean = (rows: number[], field: string) => {
  const v = getNumeric(ds, field).values;
  const s = rows.map((i) => v[i]).filter(Number.isFinite);
  return s.reduce((a, b) => a + b, 0) / s.length;
};
const by = (field: string, value: string) => all.filter((i) => label(field, i) === value);

describe('the narration is true of the data', () => {
  it('map: three thousand cases', () => {
    expect(line('map')).toContain('three thousand');
    expect(ds.n).toBe(3000);
  });

  it('bars: nearly half by phone, one in ten by post', () => {
    expect(share(all, COL.channel, VAL.phone)).toBeGreaterThan(0.42);
    expect(share(all, COL.channel, VAL.phone)).toBeLessThan(0.5);
    expect(share(all, COL.channel, VAL.post)).toBeGreaterThan(0.085);
    expect(share(all, COL.channel, VAL.post)).toBeLessThan(0.115);
  });

  it('colour: post and phone lean rural, webchat leans urban', () => {
    const rural = by(COL.areaType, 'Rural');
    const urban = by(COL.areaType, 'Urban');
    expect(share(rural, COL.channel, VAL.phone) + share(rural, COL.channel, VAL.post))
      .toBeGreaterThan(share(urban, COL.channel, VAL.phone) + share(urban, COL.channel, VAL.post) + 0.2);
    expect(share(urban, COL.channel, 'Webchat')).toBeGreaterThan(share(rural, COL.channel, 'Webchat') * 2);
  });

  it('area: rural one in five by post, urban one in sixteen', () => {
    expect(share(by(COL.areaType, 'Rural'), COL.channel, VAL.post)).toBeCloseTo(1 / 5, 1);
    expect(share(by(COL.areaType, 'Urban'), COL.channel, VAL.post)).toBeCloseTo(1 / 16, 1);
  });

  it('crosstab: over-75s a quarter by post and almost none by webchat; under-30s the reverse', () => {
    const old = by(COL.ageBand, '75+');
    const young = by(COL.ageBand, '18–29');
    expect(share(old, COL.channel, VAL.post)).toBeGreaterThan(0.2);
    expect(share(old, COL.channel, VAL.post)).toBeLessThan(0.3);
    expect(share(old, COL.channel, 'Webchat')).toBeLessThan(0.06);
    expect(share(young, COL.channel, 'Webchat')).toBeGreaterThan(0.3);
    expect(share(young, COL.channel, VAL.post)).toBeLessThan(0.06);
  });

  it('scatter: webchat about half an hour, post about five and a half days, satisfaction lower', () => {
    const webchat = by(COL.channel, 'Webchat');
    const post = by(COL.channel, VAL.post);
    expect(median(webchat, COL.hours)).toBeGreaterThan(0.3);
    expect(median(webchat, COL.hours)).toBeLessThan(0.75);
    expect(median(post, COL.hours) / 24).toBeGreaterThan(5);
    expect(median(post, COL.hours) / 24).toBeLessThan(6);
    expect(mean(post, COL.satisfaction)).toBeLessThan(mean(webchat, COL.satisfaction) - 0.4);
  });

  it('facet: around three hundred cases by post', () => {
    expect(by(COL.channel, VAL.post).length).toBeGreaterThan(280);
    expect(by(COL.channel, VAL.post).length).toBeLessThan(330);
  });

  it('facet2: twelve open, high-priority cases by post', () => {
    expect(line('facet2')).toContain('twelve');
    expect(rowsWhere(ds, { [COL.channel]: VAL.post, [COL.status]: VAL.open, [COL.priority]: VAL.high }).length).toBe(12);
  });

  it('record: the featured customer is a PAYE, High, Post case with five contacts, still open', () => {
    const rows = rowsWhere(ds, { [COL.channel]: VAL.post, [COL.status]: VAL.open, [COL.priority]: VAL.high });
    const mask = new Uint8Array(ds.n);
    for (const i of rows) mask[i] = 1;
    const i = featuredRow(ds, mask);
    expect(rows).toContain(i);
    expect(label(COL.topic, i)).toBe(VAL.paye);
    expect(label(COL.priority, i)).toBe(VAL.high);
    expect(label(COL.channel, i)).toBe(VAL.post);
    expect(label(COL.status, i)).toBe(VAL.open);
    expect(getNumeric(ds, COL.contacts).values[i]).toBe(5);
    expect(line('record')).toContain('five contacts');
    // Deterministic: the same person every time.
    expect(featuredRow(ds, mask)).toBe(i);
    expect(featuredRow(ds, null)).toBeGreaterThanOrEqual(0);
    expect(featuredRow(ds, new Uint8Array(ds.n))).toBe(-1);
  });
});
