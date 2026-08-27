import { describe, it, expect } from 'vitest';
import {
  autoCategoryColors,
  categoricalColor,
  categoryColors,
  colorForCategoryName,
  fieldColors,
  hasNamedColors,
  hexToRgb,
  hexToHsl,
  hasCoreHue,
  colorOfRow,
  sequential,
  CATEGORICAL,
  OTHER,
} from '../src/core/palette';
import { category, numeric, type Dataset } from '../src/data/columnar';

const hue = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return -1;
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60) % 360;
};
const sat = (hex: string) => {
  const c = hexToRgb(hex).map((v) => v / 255);
  return Math.max(...c) - Math.min(...c);
};
const lum = (hex: string) => hexToRgb(hex).reduce((a, v) => a + v, 0) / 3;

describe('colorForCategoryName', () => {
  it('maps plain colour names to the right hue', () => {
    expect(hue(colorForCategoryName('Red')!)).toBeLessThan(15);
    expect(hue(colorForCategoryName('orange')!)).toBeGreaterThan(20);
    expect(hue(colorForCategoryName('orange')!)).toBeLessThan(45);
    expect(hue(colorForCategoryName('Green')!)).toBeGreaterThan(100);
    expect(hue(colorForCategoryName('Green')!)).toBeLessThan(160);
    expect(hue(colorForCategoryName('BLUE')!)).toBeGreaterThan(200);
    expect(hue(colorForCategoryName('BLUE')!)).toBeLessThan(240);
    expect(hue(colorForCategoryName('magenta')!)).toBeGreaterThan(280);
    expect(hue(colorForCategoryName('pink')!)).toBeGreaterThan(300);
  });
  it('handles greys, black and white, and both spellings', () => {
    expect(colorForCategoryName('grey')).toBe(colorForCategoryName('gray'));
    expect(sat(colorForCategoryName('grey')!)).toBeLessThan(0.05);
    expect(lum(colorForCategoryName('white')!)).toBeGreaterThan(220);
    expect(lum(colorForCategoryName('black')!)).toBeLessThan(60);
  });
  it('applies lightness modifiers', () => {
    const red = colorForCategoryName('red')!;
    expect(lum(colorForCategoryName('Dark red')!)).toBeLessThan(lum(red));
    expect(lum(colorForCategoryName('light red')!)).toBeGreaterThan(lum(red));
    expect(lum(colorForCategoryName('Pale blue')!)).toBeGreaterThan(lum(colorForCategoryName('blue')!));
    expect(Math.abs(hue(colorForCategoryName('Dark red')!) - hue(red))).toBeLessThan(3);
  });
  it('blends compound hues', () => {
    const yg = hue(colorForCategoryName('Yellow-green')!);
    expect(yg).toBeGreaterThan(hue(colorForCategoryName('yellow')!));
    expect(yg).toBeLessThan(hue(colorForCategoryName('green')!));
    expect(colorForCategoryName('blue/green')).not.toBeNull();
    expect(colorForCategoryName('Greyish blue')).not.toBeNull();
  });
  it('returns null for non-colour labels', () => {
    for (const s of ['Email', 'London', 'Dark', 'Highlight', '', 'Red Cross Society', 'Blue Monday'])
      expect(colorForCategoryName(s), s).toBeNull();
  });
});

describe('autoCategoryColors (all-or-nothing)', () => {
  it('resolves when every label is a colour', () => {
    const out = autoCategoryColors(['Red', 'Green', 'Blue'])!;
    expect(out).toHaveLength(3);
    expect(hue(out[2])).toBeGreaterThan(200);
  });
  it('allows a single neutral/Other label', () => {
    expect(autoCategoryColors(['Red', 'Blue', 'Other'])).not.toBeNull();
    expect(autoCategoryColors(['Red', 'Blue', 'Neutral'])).not.toBeNull();
    expect(autoCategoryColors(['Red', 'Blue', 'Grey'])).not.toBeNull();
    expect(autoCategoryColors(['Red', 'Other', 'Unknown'])).toBeNull();
  });
  it('rejects mixed labels so nothing is half-assigned', () => {
    expect(autoCategoryColors(['Red', 'Email', 'Blue'])).toBeNull();
    expect(autoCategoryColors(['Other'])).toBeNull();
    expect(autoCategoryColors([])).toBeNull();
  });
  it('covers the pixel Hue family labels', () => {
    const names = ['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Violet', 'Magenta', 'Neutral'];
    const out = autoCategoryColors(names)!;
    expect(out).toHaveLength(9);
    for (let i = 0; i < 7; i++) expect(hue(out[i]) <= hue(out[i + 1]), names[i]).toBe(true);
    expect(sat(out[8])).toBeLessThan(0.05); // Neutral is a grey
    expect(autoCategoryColors(['Red', 'Blue', 'Other'])![2]).toBe(OTHER.dark);
  });
});

describe('categoryColors precedence', () => {
  it('explicit pins win over auto-detect', () => {
    expect(categoryColors(['Red', 'Blue'], { Red: '#123456', blue: '#abcdef' })).toEqual(['#123456', '#abcdef']);
  });
  it('auto-detect wins over the palette and bypasses the 8-slot cap', () => {
    const names = ['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Violet', 'Magenta', 'Pink', 'Brown'];
    const out = categoryColors(names);
    expect(out[9]).not.toBe(OTHER.dark);
    expect(out[0]).not.toBe(CATEGORICAL.dark[0]);
  });
  it('falls back to the categorical palette (grey past slot 8)', () => {
    const out = categoryColors(['Email', 'Phone', 'Post', 'a', 'b', 'c', 'd', 'e', 'f']);
    expect(out[0]).toBe(categoricalColor(0));
    expect(out[8]).toBe(OTHER.dark);
  });
  it('partial pins keep their labels and fall back for the rest', () => {
    const out = categoryColors(['Email', 'Phone'], { Phone: '#ff0000' });
    expect(out).toEqual([categoricalColor(0), '#ff0000']);
  });
  it('fieldColors / hasNamedColors read Dataset.colors', () => {
    const ds: Dataset = {
      name: 't', n: 2, labelColumn: 'Tone', facets: ['Tone', 'Channel'],
      columns: { Tone: category('Tone', ['Shadow', 'Light']), Channel: category('Channel', ['Email', 'Post']) },
      colors: { Tone: { Shadow: '#111111', Light: '#eeeeee' } },
    };
    expect(fieldColors(ds, 'Tone')).toEqual(['#111111', '#eeeeee']);
    expect(hasNamedColors(ds, 'Tone')).toBe(true);
    expect(hasNamedColors(ds, 'Channel')).toBe(false);
    expect(fieldColors(ds, 'Channel')).toEqual([categoricalColor(0), categoricalColor(1)]);
    expect(fieldColors(ds, 'Nope')).toEqual([]);
  });
});

describe('M-06: auto-detect needs a core hue word and keeps swatches apart', () => {
  it('does not colour a field of everyday words that happen to be in the table', () => {
    expect(autoCategoryColors(['Sky', 'Forest', 'Rose', 'Gold'])).toBeNull();
    expect(autoCategoryColors(['Royal', 'Mint', 'Coral', 'Other'])).toBeNull();
    expect(hasCoreHue('Sky')).toBe(false);
    expect(hasCoreHue('Sky blue')).toBe(true);
    expect(hasCoreHue('Greyish')).toBe(true);
  });
  it('still colours a field once one label names a core hue', () => {
    const out = autoCategoryColors(['Sky', 'Forest', 'Rose', 'Blue']);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(4);
    expect(autoCategoryColors(['Red', 'Other'])).not.toBeNull();
  });
  it('collapses exact synonyms to one hex', () => {
    expect(colorForCategoryName('violet')).toBe(colorForCategoryName('purple'));
    expect(colorForCategoryName('aqua')).toBe(colorForCategoryName('cyan'));
    expect(colorForCategoryName('royal')).toBe(colorForCategoryName('blue'));
    expect(colorForCategoryName('cobalt')).toBe(colorForCategoryName('blue'));
  });
  it('keeps the common set at least 18 degrees of hue or 12 % of lightness apart', () => {
    const names = ['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Purple', 'Pink', 'Brown', 'Grey', 'Black', 'White'];
    const hsl = names.map((n) => hexToHsl(colorForCategoryName(n)!));
    for (let a = 0; a < hsl.length; a++) {
      for (let b = a + 1; b < hsl.length; b++) {
        const [ha, sa, la] = hsl[a], [hb, sb, lb] = hsl[b];
        const dh = Math.min(Math.abs(ha - hb), 360 - Math.abs(ha - hb));
        const chromatic = sa > 20 && sb > 20;
        const apart = (chromatic && dh >= 18) || Math.abs(la - lb) >= 12 || Math.abs(sa - sb) >= 30;
        expect(apart, `${names[a]} vs ${names[b]}: dh=${dh.toFixed(0)} dl=${Math.abs(la - lb).toFixed(0)}`).toBe(true);
      }
    }
  });
  it('hexToHsl round-trips the primaries', () => {
    expect(hexToHsl('#ff0000')).toEqual([0, 100, 50]);
    expect(hexToHsl('#00ff00')[0]).toBe(120);
    expect(hexToHsl('#0000ff')[0]).toBe(240);
    expect(hexToHsl('#808080')[1]).toBe(0);
  });
});

describe('light theme', () => {
  it('has the same slot count as dark and a distinct Other grey', () => {
    expect(CATEGORICAL.light.length).toBe(CATEGORICAL.dark.length);
    expect(categoricalColor(0, 'light')).toBe(CATEGORICAL.light[0]);
    expect(categoricalColor(99, 'light')).toBe(OTHER.light);
    expect(OTHER.light).not.toBe(OTHER.dark);
  });
  it('categoryColors / fieldColors honour the theme for fallbacks', () => {
    const out = categoryColors(['Email', 'Phone', 'Post', 'a', 'b', 'c', 'd', 'e', 'f'], null, 'light');
    expect(out[0]).toBe(CATEGORICAL.light[0]);
    expect(out[8]).toBe(OTHER.light);
    expect(autoCategoryColors(['Red', 'Other'], 'light')![1]).toBe(OTHER.light);
  });
});

describe('colorOfRow (one colour per row for card, tint, legend and detail)', () => {
  const ds: Dataset = {
    name: 't', n: 3, labelColumn: 'Tone', facets: ['Tone', 'Channel', 'Hours', 'Hue'],
    columns: {
      Tone: category('Tone', ['Shadow', 'Light', 'Shadow']),
      Channel: category('Channel', ['Email', 'Post', 'Email']),
      Hue: category('Hue', ['Red', 'Blue', 'Red']),
      Hours: numeric('Hours', [0, 5, 10]),
    },
    colors: { Tone: { Shadow: '#3a3a38', Light: '#c8c8c2' } },
  };
  it('uses pins for a pinned field (the Tone case the detail pane got wrong)', () => {
    expect(colorOfRow(ds, 'Tone', 0)).toBe('#3a3a38');
    expect(colorOfRow(ds, 'Tone', 1)).toBe('#c8c8c2');
    expect(colorOfRow(ds, 'Tone', 1)).toBe(fieldColors(ds, 'Tone')[1]);
  });
  it('uses colour names for a named field and the palette otherwise', () => {
    expect(colorOfRow(ds, 'Hue', 1)).toBe(colorForCategoryName('Blue'));
    expect(colorOfRow(ds, 'Channel', 1)).toBe(categoricalColor(1));
    expect(colorOfRow(ds, 'Channel', 1, 'light')).toBe(categoricalColor(1, 'light'));
  });
  it('samples the sequential ramp for a numeric colour-by', () => {
    expect(colorOfRow(ds, 'Hours', 0)).toBe(sequential(0));
    expect(colorOfRow(ds, 'Hours', 1)).toBe(sequential(0.5));
    expect(colorOfRow(ds, 'Hours', 2)).toBe(sequential(1));
  });
  it('falls back to slot 0 with no usable field', () => {
    expect(colorOfRow(ds, '', 0)).toBe(categoricalColor(0));
    expect(colorOfRow(ds, '__truecolour__', 0)).toBe(categoricalColor(0));
  });
});
