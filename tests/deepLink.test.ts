import { describe, it, expect } from 'vitest';
import {
  decodeView, encodeView, encodeFilters, parseFilters, serialiseQuery, type ViewState,
} from '../src/ui/deepLink';
import { FacetPanel } from '../src/ui/facets';
import { category, numeric, type Dataset } from '../src/data/columnar';

/** Enough of an element for the constructor; nothing here reads the DOM. */
function host(): HTMLElement {
  return { addEventListener() {}, innerHTML: '', querySelectorAll: () => [] } as unknown as HTMLElement;
}

/**
 * Two builds of the same collection, in the shape the birds pipeline really
 * emits: categories ordered by frequency, so the *codes* differ while the
 * labels do not. `Trophic level` code 3 is Scavenger in the small one and
 * Unknown in the large one.
 */
function birdsLike(large: boolean): Dataset {
  const trophic = large
    ? ['Carnivore', 'Herbivore', 'Omnivore', 'Unknown', 'Scavenger']
    : ['Carnivore', 'Herbivore', 'Omnivore', 'Scavenger'];
  const habitat = large
    ? ['Forest', 'Shrubland', 'Grassland', 'Woodland', 'Marine']
    : ['Forest', 'Shrubland', 'Woodland', 'Grassland', 'Marine'];
  // One row per category of each field, paired off; the row's habitat and
  // trophic level are read back by label in the assertions.
  const n = 5;
  const rows = { trophic: [] as string[], habitat: [] as string[] };
  for (let i = 0; i < n; i++) {
    rows.trophic.push(trophic[i % trophic.length]);
    rows.habitat.push(habitat[i % habitat.length]);
  }
  return {
    name: large ? 'birds-2000' : 'birds-900', n, cards: false,
    columns: {
      Habitat: category('Habitat', rows.habitat),
      'Trophic level': category('Trophic level', rows.trophic),
      Mass: numeric('Mass', [1, 2, 3, 4, 5]),
    },
    facets: ['Habitat', 'Trophic level', 'Mass'],
  } as unknown as Dataset;
}

function panel(large: boolean): FacetPanel {
  const p = new FacetPanel(host());
  p.setDataset(birdsLike(large));
  return p;
}

/** The labels a panel's mask actually keeps, per field. */
function selectedLabels(p: FacetPanel, ds: Dataset, field: string): string[] {
  const col = ds.columns[field];
  if (col.kind !== 'category') throw new Error('not a category');
  const mask = p.mask();
  const out = new Set<string>();
  for (let i = 0; i < ds.n; i++) if (!mask || mask[i]) out.add(col.categories[col.codes[i]]);
  return [...out].sort();
}

describe('filter grammar', () => {
  it('round-trips fields and labels', () => {
    const filters = [
      { field: 'Habitat', labels: ['Forest', 'Marine'] },
      { field: 'Diet', labels: ['Fruit'] },
    ];
    const s = encodeFilters(filters);
    expect(s).toBe('Habitat:Forest,Marine;Diet:Fruit');
    expect(parseFilters(s)).toEqual(filters);
  });

  it('escapes a label containing a delimiter', () => {
    // Real labels are one bad taxonomy away from this: `Mass band` already
    // runs to `500 g - 2 kg`.
    const filters = [{ field: 'Mass band', labels: ['500 g, 2 kg', 'a;b', 'c:d', 'back\\slash'] }];
    const s = encodeFilters(filters);
    expect(s).toBe('Mass band:500 g\\, 2 kg,a\\;b,c\\:d,back\\\\slash');
    expect(parseFilters(s)).toEqual(filters);
  });

  it('takes only the first colon as the separator', () => {
    expect(parseFilters('Time:12:30,13:00')).toEqual([{ field: 'Time', labels: ['12:30', '13:00'] }]);
  });

  it('drops malformed groups rather than throwing', () => {
    expect(parseFilters('')).toEqual([]);
    expect(parseFilters('Habitat')).toEqual([]);
    expect(parseFilters('Habitat:')).toEqual([]);
    expect(parseFilters(':Forest')).toEqual([]);
    expect(parseFilters(';;;')).toEqual([]);
    expect(parseFilters('Habitat:Forest;;Diet:')).toEqual([{ field: 'Habitat', labels: ['Forest'] }]);
    expect(parseFilters('Habitat:Forest,Forest')).toEqual([{ field: 'Habitat', labels: ['Forest'] }]);
  });
});

describe('encodeView', () => {
  it('leaves params it does not own alone', () => {
    const p = new URLSearchParams('dataset=birds:900&hires=0&glow=0&cards=quiet&tour=0&preserve=0');
    encodeView(p, { layout: 'bars', color: 'Habitat' });
    expect(p.get('dataset')).toBe('birds:900');
    expect(p.get('hires')).toBe('0');
    expect(p.get('glow')).toBe('0');
    expect(p.get('cards')).toBe('quiet');
    expect(p.get('tour')).toBe('0');
    expect(p.get('preserve')).toBe('0');
  });

  it('clears the keys a default view does not set', () => {
    const p = new URLSearchParams('dataset=birds:900&layout=bars&color=Habitat&filter=Diet:Fruit&hires=0');
    encodeView(p, {});
    expect(serialiseQuery(p)).toBe('dataset=birds:900&hires=0');
  });

  it('writes a legible query string', () => {
    const p = new URLSearchParams('dataset=birds:900');
    encodeView(p, {
      layout: 'bars', color: 'Habitat',
      filters: [{ field: 'Habitat', labels: ['Forest', 'Marine'] }, { field: 'Diet', labels: ['Fruit'] }],
    });
    expect(serialiseQuery(p))
      .toBe('dataset=birds:900&layout=bars&color=Habitat&filter=Habitat:Forest,Marine;Diet:Fruit');
  });

  it('keeps an explicit "no sort" distinct from an absent one', () => {
    const p = new URLSearchParams();
    encodeView(p, { sort: '' });
    expect(serialiseQuery(p)).toBe('sort=');
    expect(decodeView(p).sort).toBe('');
    encodeView(p, {});
    expect(decodeView(p).sort).toBeUndefined();
  });
});

describe('decodeView', () => {
  it('reads a whole view', () => {
    const view = decodeView(new URLSearchParams(
      'dataset=birds:900&layout=scatter&color=Habitat&sort=Mass&bucket=Diet&x=Habitat&y=Mass&filter=Diet:Fruit',
    ));
    expect(view).toEqual({
      layout: 'scatter', color: 'Habitat', sort: 'Mass', bucket: 'Diet', x: 'Habitat', y: 'Mass',
      filters: [{ field: 'Diet', labels: ['Fruit'] }],
    } satisfies ViewState);
  });

  it('is empty for a URL with no view in it', () => {
    expect(decodeView(new URLSearchParams('dataset=birds:900&hires=0&bench=1'))).toEqual({});
  });

  it('ignores an unknown layout kind instead of guessing', () => {
    expect(decodeView(new URLSearchParams('layout=nonsense')).layout).toBeUndefined();
    expect(decodeView(new URLSearchParams('layout=&color=Habitat')))
      .toEqual({ color: 'Habitat' });
  });

  it('survives a mangled filter', () => {
    expect(decodeView(new URLSearchParams('layout=bars&filter=%3B%3B%3B')))
      .toEqual({ layout: 'bars' });
  });

  it('round-trips through a real query string', () => {
    const view: ViewState = {
      layout: 'bars', color: 'Trophic level', sort: 'Mass', bucket: 'Mass band',
      filters: [{ field: 'Mass band', labels: ['500 g - 2 kg', 'Over 2 kg'] }],
    };
    const p = new URLSearchParams();
    encodeView(p, view);
    expect(decodeView(new URLSearchParams(serialiseQuery(p)))).toEqual(view);
  });
});

describe('filters resolve by label, not by code', () => {
  /**
   * The whole reason the URL carries labels. These two collections order
   * `Trophic level` differently, so code 3 means different things in each; a
   * link that carried codes would keep working and quietly select the wrong
   * birds.
   */
  it('selects the same labels in two builds whose category order differs', () => {
    const small = birdsLike(false);
    const large = birdsLike(true);
    expect(small.columns['Trophic level'].kind === 'category'
      && small.columns['Trophic level'].categories.indexOf('Scavenger')).toBe(3);
    expect(large.columns['Trophic level'].kind === 'category'
      && large.columns['Trophic level'].categories.indexOf('Scavenger')).toBe(4);

    const url = 'filter=Trophic level:Scavenger;Habitat:Woodland,Marine';
    const view = decodeView(new URLSearchParams(url));

    const a = panel(false);
    const b = panel(true);
    a.setFilterLabels(view.filters!);
    b.setFilterLabels(view.filters!);

    // Same labels either side, from different codes.
    expect(a.filterLabels()).toEqual([
      { field: 'Habitat', labels: ['Woodland', 'Marine'] },
      { field: 'Trophic level', labels: ['Scavenger'] },
    ]);
    expect(b.filterLabels()).toEqual([
      { field: 'Habitat', labels: ['Woodland', 'Marine'] },
      { field: 'Trophic level', labels: ['Scavenger'] },
    ]);
    expect([...a.filters.get('Trophic level')!]).toEqual([3]);
    expect([...b.filters.get('Trophic level')!]).toEqual([4]);
    expect([...a.filters.get('Habitat')!].sort()).not.toEqual([...b.filters.get('Habitat')!].sort());

    // And the masks keep rows with those labels, not with those codes.
    const ha = panel(false);
    const hb = panel(true);
    ha.setFilterLabels(parseFilters('Habitat:Woodland,Marine'));
    hb.setFilterLabels(parseFilters('Habitat:Woodland,Marine'));
    expect(selectedLabels(ha, small, 'Habitat')).toEqual(['Marine', 'Woodland']);
    expect(selectedLabels(hb, large, 'Habitat')).toEqual(['Marine', 'Woodland']);
  });

  it('re-encodes to the same URL from either build', () => {
    const view = decodeView(new URLSearchParams('filter=Habitat:Woodland,Marine'));
    const a = panel(false);
    const b = panel(true);
    a.setFilterLabels(view.filters!);
    b.setFilterLabels(view.filters!);
    expect(encodeFilters(a.filterLabels())).toBe('Habitat:Woodland,Marine');
    expect(encodeFilters(b.filterLabels())).toBe('Habitat:Woodland,Marine');
  });

  it('drops a label that no longer exists and keeps the rest of the filter', () => {
    const p = panel(false); // no "Unknown" trophic level in the small build
    p.setFilterLabels(parseFilters('Trophic level:Scavenger,Unknown'));
    expect(p.filterLabels()).toEqual([{ field: 'Trophic level', labels: ['Scavenger'] }]);
  });

  it('drops a field that is not a categorical facet, and keeps the rest', () => {
    const p = panel(false);
    p.setFilterLabels(parseFilters('NoSuchField:X;Mass:3;Habitat:Forest'));
    expect(p.filterLabels()).toEqual([{ field: 'Habitat', labels: ['Forest'] }]);
  });

  it('applies nothing at all when nothing resolves', () => {
    const p = panel(false);
    p.setFilterLabels(parseFilters('NoSuchField:X'));
    expect(p.filterLabels()).toEqual([]);
    expect(p.mask()).toBeNull();
  });

  it('replaces the filters already set rather than adding to them', () => {
    const p = panel(false);
    p.toggle('Habitat', 'Forest');
    p.setFilterLabels(parseFilters('Trophic level:Carnivore'));
    expect(p.filterLabels()).toEqual([{ field: 'Trophic level', labels: ['Carnivore'] }]);
  });
});
