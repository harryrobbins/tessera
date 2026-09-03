import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BIRD_COL, BIRD_VAL, BIRD_TOUR_DATASET } from '../src/tour/columns';
import { BIRDS_NARRATION } from '../src/tour/script';

/**
 * Every number the birds narration claims, checked against the bake the tour
 * loads. If the pipeline is re-run and a figure moves, this fails before a
 * visitor hears a story the pictures no longer tell — the same contract
 * tests/tour-story.test.ts holds for the tax tour.
 *
 * The JSON is read straight off disk rather than through `loadBirds`, which
 * fetches and decodes the photo sheets too: none of the claims here are about
 * the pictures, and a WebGL atlas is not something vitest should be building.
 */
const file = path.join(__dirname, '..', 'public', 'data', `birds-${BIRD_TOUR_DATASET.split(':')[1]}.json`);
const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
  columns: { name: string; kind: string; categories?: string[]; codes?: number[]; values?: (number | string)[] }[];
};
const col = new Map(raw.columns.map((c) => [c.name, c]));

function categories(name: string): string[] {
  const c = col.get(name);
  if (!c?.categories) throw new Error(`${name} is not a category column`);
  return c.categories;
}
function label(name: string): (i: number) => string {
  const c = col.get(name)!;
  return (i) => c.categories![c.codes![i]] ?? '';
}
function values(name: string): number[] {
  const c = col.get(name);
  if (!c?.values) throw new Error(`${name} is not a number column`);
  return c.values as number[];
}
function names(): string[] {
  return col.get(BIRD_COL.commonName)!.values as string[];
}

const n = values(BIRD_COL.mass).length;
const all = Array.from({ length: n }, (_, i) => i);
const line = (id: string) => BIRDS_NARRATION.find((l) => l.id === id)!.text;
const by = (field: string, value: string) => all.filter((i) => label(field)(i) === value);
const share = (rows: number[], field: string, value: string) =>
  rows.filter((i) => label(field)(i) === value).length / rows.length;
const median = (rows: number[], field: string) => {
  const v = values(field);
  const s = rows.map((i) => v[i]).filter(Number.isFinite).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

describe('the birds narration is true of the data', () => {
  it('world: nine hundred birds, half of them south of the equator', () => {
    expect(line('world')).toContain('Nine hundred');
    expect(n).toBe(900);
    const lat = values(BIRD_COL.latitude);
    const south = all.filter((i) => lat[i] < 0).length / n;
    expect(south).toBeGreaterThan(0.45);
    expect(south).toBeLessThan(0.55);
  });

  it('habitat: six in ten are forest birds, and forty-one are marine', () => {
    const forest = share(all, BIRD_COL.habitat, BIRD_VAL.forest);
    expect(forest).toBeGreaterThan(0.55);
    expect(forest).toBeLessThan(0.65);
    expect(line('habitat')).toContain('forty-one');
    expect(by(BIRD_COL.habitat, BIRD_VAL.marine)).toHaveLength(41);
  });

  it('orders: thirty of them, one card in four a perching bird', () => {
    expect(line('orders')).toContain('thirty');
    expect(categories(BIRD_COL.order)).toHaveLength(30);
    const perching = share(all, BIRD_COL.order, BIRD_VAL.passeriformes);
    expect(perching).toBeGreaterThan(0.22);
    expect(perching).toBeLessThan(0.28);
  });

  it('bands: seven rungs, a two-gram woodstar to a thirty-five-kilo cassowary', () => {
    expect(categories(BIRD_COL.massBand)).toHaveLength(7);
    const mass = values(BIRD_COL.mass);
    const cn = names();
    const lightest = all.reduce((b, i) => (mass[i] < mass[b] ? i : b), 0);
    const heaviest = all.reduce((b, i) => (mass[i] > mass[b] ? i : b), 0);
    expect(mass[lightest]).toBeLessThan(3);
    expect(cn[lightest].toLowerCase()).toContain('woodstar');
    expect(mass[heaviest] / 1000).toBeGreaterThan(30);
    expect(mass[heaviest] / 1000).toBeLessThan(40);
    expect(cn[heaviest].toLowerCase()).toContain('cassowary');
  });

  it('diet: a nectar feeder is five grams, a vertebrate eater a hundred times more', () => {
    const nectar = median(by(BIRD_COL.diet, BIRD_VAL.nectar), BIRD_COL.mass);
    const verts = median(by(BIRD_COL.diet, BIRD_VAL.vertebrates), BIRD_COL.mass);
    expect(nectar).toBeGreaterThan(4);
    expect(nectar).toBeLessThan(7);
    expect(verts / nectar).toBeGreaterThan(70);
  });

  it('dispersal: sedentary twenty-five, migratory forty-nine, over eight times the range', () => {
    const sed = by(BIRD_COL.migration, BIRD_VAL.sedentary);
    const mig = by(BIRD_COL.migration, BIRD_VAL.migratory);
    expect(median(sed, BIRD_COL.handWing)).toBeGreaterThan(24);
    expect(median(sed, BIRD_COL.handWing)).toBeLessThan(26);
    expect(median(mig, BIRD_COL.handWing)).toBeGreaterThan(48);
    expect(median(mig, BIRD_COL.handWing)).toBeLessThan(50);
    const ratio = median(mig, BIRD_COL.range) / median(sed, BIRD_COL.range);
    expect(ratio).toBeGreaterThan(7);
    expect(ratio).toBeLessThan(9.5);
  });

  it('ocean: forty-one seabirds, and the highest hand-wing index of any habitat', () => {
    const marine = by(BIRD_COL.habitat, BIRD_VAL.marine);
    expect(marine).toHaveLength(41);
    const med = median(marine, BIRD_COL.handWing);
    expect(med).toBeGreaterThan(58);
    expect(med).toBeLessThan(63);
    // "the highest of any habitat here" — so no other habitat may beat it.
    for (const hb of categories(BIRD_COL.habitat)) {
      if (hb === BIRD_VAL.marine) continue;
      expect(median(by(BIRD_COL.habitat, hb), BIRD_COL.handWing)).toBeLessThan(med);
    }
  });

  it('voyagers: eleven marine migrants — two petrels, a shearwater, two eiders, five auks, a tropicbird', () => {
    const marine = by(BIRD_COL.habitat, BIRD_VAL.marine);
    const voyagers = marine.filter((i) => label(BIRD_COL.migration)(i) === BIRD_VAL.migratory);
    expect(voyagers).toHaveLength(11);
    const cn = names();
    const count = (word: string) => voyagers.filter((i) => cn[i].toLowerCase().includes(word)).length;
    expect(count('petrel')).toBe(2);
    expect(count('shearwater')).toBe(1);
    expect(count('eider')).toBe(2);
    expect(count('tropicbird')).toBe(1);
    // The five auks are an Alcidae count, not a name match: a murrelet, a
    // puffin, two auklets and a guillemot are all auks and none says so.
    const auks = voyagers.filter((i) => label(BIRD_COL.family)(i) === 'Alcidae');
    expect(auks).toHaveLength(5);
    expect(2 + 1 + 2 + 1 + auks.length).toBe(voyagers.length);
  });

  it('one bird: the red-tailed tropicbird tops the eleven at sixty-nine', () => {
    const marine = by(BIRD_COL.habitat, BIRD_VAL.marine);
    const voyagers = marine.filter((i) => label(BIRD_COL.migration)(i) === BIRD_VAL.migratory);
    const hwi = values(BIRD_COL.handWing);
    const top = voyagers.reduce((b, i) => (hwi[i] > hwi[b] ? i : b), voyagers[0]);
    expect(names()[top].toLowerCase()).toContain('red-tailed tropicbird');
    expect(Math.round(hwi[top])).toBe(69);
    expect(label(BIRD_COL.diet)(top)).toBe(BIRD_VAL.aquaticPrey);
    expect(label(BIRD_COL.habitat)(top)).toBe(BIRD_VAL.marine);
    expect(label(BIRD_COL.migration)(top)).toBe(BIRD_VAL.migratory);
  });

  it('promises pictures, not photographs — half of them are Victorian plates', () => {
    // The Commons images are filtered to public domain and CC0, which is in
    // effect a date filter: a large minority are lithographic plates by the
    // likes of Keulemans, Wolf and Naumann. An early draft of this narration
    // said "every picture is a real photograph", which was simply untrue.
    const credits = (raw as unknown as { credits?: { file?: string; artist?: string }[] }).credits ?? [];
    expect(credits.length).toBe(n);
    const plate = /plate|litho|Gould|Wolf|Keulemans|Naumann|Audubon|Fuertes|Richter|Smit|Gr[oö]nvold|Hu[eé]t/i;
    const plates = credits.filter((c) => plate.test(`${c.file ?? ''} ${c.artist ?? ''}`)).length;
    expect(plates / n).toBeGreaterThan(0.2);

    // A line may name a photograph only where it also owns up to the plates,
    // as the opening line does; anywhere else the word would promise that
    // every card carries one. The bolded **Photographer** column label is the
    // app's own wording, not a claim, so bold terms are stripped first.
    for (const l of BIRDS_NARRATION) {
      const prose = l.text.replace(/\*\*.+?\*\*/g, '');
      if (/photograph/i.test(prose)) {
        expect(prose, `${l.id} says photograph without mentioning the plates`).toMatch(/plate/i);
      }
      expect(l.title, `${l.id} title claims a photograph`).not.toMatch(/photograph/i);
    }
  });

  it('every bold term names a column or a value that exists', () => {
    const known = new Set<string>([
      ...Object.values(BIRD_COL),
      ...Object.values(BIRD_VAL),
    ]);
    for (const l of BIRDS_NARRATION) {
      for (const m of l.text.matchAll(/\*\*(.+?)\*\*/g)) {
        expect(known, `${l.id}: **${m[1]}**`).toContain(m[1]);
      }
    }
  });
});
