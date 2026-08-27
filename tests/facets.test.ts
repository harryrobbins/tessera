import { describe, it, expect } from 'vitest';
import { FacetPanel } from '../src/ui/facets';
import { category, numeric, type Dataset } from '../src/data/columnar';

/** Enough of an element for the constructor; mask() never touches the DOM. */
function host(): HTMLElement {
  return { addEventListener() {}, innerHTML: '', querySelectorAll: () => [] } as unknown as HTMLElement;
}

function dataset(): Dataset {
  const colour = category('Colour', ['red', 'red', 'blue', 'green', 'blue', 'red']);
  const size = category('Size', ['S', 'M', 'S', 'L', 'M', 'S']);
  const value = numeric('Value', [1, 2, 3, 4, 5, 6]);
  return {
    name: 't', n: 6, cards: false,
    columns: { Colour: colour, Size: size, Value: value },
    facets: ['Colour', 'Size', 'Value'],
  } as unknown as Dataset;
}

function panel(): FacetPanel {
  const p = new FacetPanel(host());
  p.setDataset(dataset());
  return p;
}

describe('FacetPanel.mask', () => {
  it('is null when nothing is filtered', () => {
    expect(panel().mask()).toBeNull();
  });

  it('keeps rows whose code is ticked in one facet', () => {
    const p = panel();
    p.toggle('Colour', 'red');
    expect(Array.from(p.mask()!)).toEqual([1, 1, 0, 0, 0, 1]);
  });

  it('ORs within a facet and ANDs across facets', () => {
    const p = panel();
    p.toggle('Colour', 'red');
    p.toggle('Colour', 'blue'); // red|blue
    expect(Array.from(p.mask()!)).toEqual([1, 1, 1, 0, 1, 1]);
    p.toggle('Size', 'S'); // AND size S
    expect(Array.from(p.mask()!)).toEqual([1, 0, 1, 0, 0, 1]);
  });

  it('unticking the last category of a facet drops that facet', () => {
    const p = panel();
    p.toggle('Colour', 'red');
    p.toggle('Colour', 'red');
    expect(p.filters.size).toBe(0);
    expect(p.mask()).toBeNull();
  });

  it('ignores unknown fields and labels, and numeric columns', () => {
    const p = panel();
    p.toggle('Nope', 'x');
    p.toggle('Colour', 'mauve');
    p.toggle('Value', '1');
    expect(p.mask()).toBeNull();
  });

  it('clearAll drops every filter and notifies once', () => {
    const p = panel();
    let n = 0;
    p.onChange = () => n++;
    p.toggle('Colour', 'red');
    p.toggle('Size', 'S');
    p.clearAll();
    expect(p.mask()).toBeNull();
    expect(n).toBe(3);
    p.clearAll();
    expect(n).toBe(3);
  });

  it('setDataset resets filters', () => {
    const p = panel();
    p.toggle('Colour', 'red');
    p.setDataset(dataset());
    expect(p.mask()).toBeNull();
  });
});
