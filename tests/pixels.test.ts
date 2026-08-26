import { describe, it, expect } from 'vitest';
import {
  srgbToLinear,
  linearRgbToXyz,
  xyzToLab,
  rgbToLab,
  rgbToHsl,
  buildPixelColumns,
  decodeSegmentId,
  buildSegmentColumns,
} from '../src/data/pixels';

describe('srgbToLinear', () => {
  it('maps 0 -> 0 and 255 -> 1', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(255)).toBeCloseTo(1, 6);
  });

  it('maps 128 -> ~0.2159', () => {
    expect(srgbToLinear(128)).toBeCloseTo(0.2159, 3);
  });

  it('is monotonically non-decreasing across all 256 8-bit inputs', () => {
    let prev = -Infinity;
    for (let c = 0; c <= 255; c++) {
      const v = srgbToLinear(c);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('rgbToLab', () => {
  const TOL = 0.05;

  it('white (255,255,255) -> L*=100, a*~0, b*~0', () => {
    const [L, a, b] = rgbToLab(255, 255, 255);
    expect(L).toBeCloseTo(100, 1);
    expect(Math.abs(a)).toBeLessThan(TOL);
    expect(Math.abs(b)).toBeLessThan(TOL);
  });

  it('black (0,0,0) -> 0,0,0', () => {
    const [L, a, b] = rgbToLab(0, 0, 0);
    expect(Math.abs(L)).toBeLessThan(TOL);
    expect(Math.abs(a)).toBeLessThan(TOL);
    expect(Math.abs(b)).toBeLessThan(TOL);
  });

  it('sRGB red (255,0,0) -> ~(53.24, 80.09, 67.20)', () => {
    const [L, a, b] = rgbToLab(255, 0, 0);
    expect(L).toBeCloseTo(53.24, 1);
    expect(a).toBeCloseTo(80.09, 1);
    expect(b).toBeCloseTo(67.2, 1);
  });

  it('green (0,255,0) -> ~(87.74, -86.18, 83.18)', () => {
    const [L, a, b] = rgbToLab(0, 255, 0);
    expect(L).toBeCloseTo(87.74, 1);
    expect(a).toBeCloseTo(-86.18, 1);
    expect(b).toBeCloseTo(83.18, 1);
  });

  it('blue (0,0,255) -> ~(32.30, 79.19, -107.86)', () => {
    const [L, a, b] = rgbToLab(0, 0, 255);
    expect(L).toBeCloseTo(32.3, 1);
    expect(a).toBeCloseTo(79.19, 1);
    expect(b).toBeCloseTo(-107.86, 1);
  });

  it('mid grey (128,128,128) -> L*~53.59, a*~0, b*~0', () => {
    const [L, a, b] = rgbToLab(128, 128, 128);
    expect(L).toBeCloseTo(53.59, 1);
    expect(Math.abs(a)).toBeLessThan(TOL);
    expect(Math.abs(b)).toBeLessThan(TOL);
  });

  it('composes from linearRgbToXyz and xyzToLab the same way rgbToLab does', () => {
    const [x, y, z] = linearRgbToXyz(srgbToLinear(200), srgbToLinear(60), srgbToLinear(10));
    expect(xyzToLab(x, y, z)).toEqual(rgbToLab(200, 60, 10));
  });
});

describe('rgbToHsl', () => {
  it('red primary -> h=0, s=100, l=50', () => {
    const [h, s, l] = rgbToHsl(255, 0, 0);
    expect(h).toBeCloseTo(0, 3);
    expect(s).toBeCloseTo(100, 3);
    expect(l).toBeCloseTo(50, 3);
  });

  it('green primary -> h=120, s=100, l=50', () => {
    const [h, s, l] = rgbToHsl(0, 255, 0);
    expect(h).toBeCloseTo(120, 3);
    expect(s).toBeCloseTo(100, 3);
    expect(l).toBeCloseTo(50, 3);
  });

  it('blue primary -> h=240, s=100, l=50', () => {
    const [h, s, l] = rgbToHsl(0, 0, 255);
    expect(h).toBeCloseTo(240, 3);
    expect(s).toBeCloseTo(100, 3);
    expect(l).toBeCloseTo(50, 3);
  });

  it('a grey has s=0 (h undefined-but-0 by convention)', () => {
    const [h, s, l] = rgbToHsl(128, 128, 128);
    expect(s).toBe(0);
    expect(h).toBe(0);
    expect(l).toBeCloseTo(50.2, 0);
  });

  it('wraps hue correctly for magenta (h=300)', () => {
    const [h] = rgbToHsl(255, 0, 255);
    expect(h).toBeCloseTo(300, 3);
  });

  it('wraps hue correctly for a hue just past red going through magenta (h~350)', () => {
    // A slightly blue-ish red: max=r, and (g-b)/d is negative, so the
    // +6 wraparound branch is exercised.
    const [h] = rgbToHsl(255, 0, 20);
    expect(h).toBeGreaterThan(340);
    expect(h).toBeLessThan(360);
  });
});

describe('buildPixelColumns (hot-loop pinning)', () => {
  // A spread of colours: primaries, secondaries, greys, black/white, and a
  // few arbitrary mixes, laid out as a 1-row image.
  const swatches: Array<[number, number, number]> = [
    [0, 0, 0],
    [255, 255, 255],
    [128, 128, 128],
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [0, 255, 255],
    [255, 0, 255],
    [200, 60, 10],
    [10, 60, 200],
    [17, 233, 99],
    [90, 90, 91],
    [255, 0, 20],
  ];

  const w = swatches.length;
  const h = 1;
  const data = new Uint8ClampedArray(w * h * 4);
  swatches.forEach(([r, g, b], i) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  });

  const cols = buildPixelColumns(w, h, data);

  it('matches rgbToLab (L*, a*, b*, Chroma) for every swatch', () => {
    swatches.forEach(([r, g, b], i) => {
      const [L, a, bStar] = rgbToLab(r, g, b);
      expect(cols.Lstar[i]).toBeCloseTo(L, 1);
      expect(cols.Astar[i]).toBeCloseTo(a, 1);
      expect(cols.Bstar[i]).toBeCloseTo(bStar, 1);
      expect(cols.Chroma[i]).toBeCloseTo(Math.sqrt(a * a + bStar * bStar), 1);
    });
  });

  it('matches rgbToHsl (Hue, Saturation, Lightness) for every swatch', () => {
    swatches.forEach(([r, g, b], i) => {
      const [hue, sat, light] = rgbToHsl(r, g, b);
      expect(cols.Hue[i]).toBeCloseTo(hue, 1);
      expect(cols.Saturation[i]).toBeCloseTo(sat, 1);
      expect(cols.Lightness[i]).toBeCloseTo(light, 1);
    });
  });

  it('matches Luminance to the Y (Rec.709) component of the XYZ conversion', () => {
    swatches.forEach(([r, g, b], i) => {
      const [, y] = linearRgbToXyz(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
      expect(cols.Luminance[i]).toBeCloseTo(y * 100, 1);
    });
  });

  it('copies raw R/G/B and the interleaved rgb triplet unchanged', () => {
    swatches.forEach(([r, g, b], i) => {
      expect(cols.R[i]).toBe(r);
      expect(cols.G[i]).toBe(g);
      expect(cols.B[i]).toBe(b);
      expect(cols.rgb[i * 3]).toBe(r);
      expect(cols.rgb[i * 3 + 1]).toBe(g);
      expect(cols.rgb[i * 3 + 2]).toBe(b);
    });
  });

  it('emits X as the column index and Y increasing upward (single row, h=1)', () => {
    for (let i = 0; i < w; i++) {
      expect(cols.X[i]).toBe(i);
      expect(cols.Y[i]).toBe(0); // h-1-row = 1-1-0 = 0
    }
  });

  it('flips Y to increase upward across multiple rows', () => {
    const w2 = 2, h2 = 3;
    const data2 = new Uint8ClampedArray(w2 * h2 * 4);
    for (let i = 0; i < w2 * h2; i++) data2[i * 4 + 3] = 255;
    const cols2 = buildPixelColumns(w2, h2, data2);
    // row 0 (top of image) should get the highest Y value.
    expect(cols2.Y[0]).toBe(h2 - 1);
    expect(cols2.Y[1]).toBe(h2 - 1);
    expect(cols2.Y[w2 * (h2 - 1)]).toBe(0);
  });

  it('assigns a Neutral hue-family code (8) to greys, and a hue-band code to saturated colours', () => {
    const idxBlack = swatches.findIndex(([r, g, b]) => r === 0 && g === 0 && b === 0);
    const idxGrey = swatches.findIndex(([r, g, b]) => r === 128 && g === 128 && b === 128);
    const idxRed = swatches.findIndex(([r, g, b]) => r === 255 && g === 0 && b === 0);
    expect(cols.hueFamilyCodes[idxBlack]).toBe(8);
    expect(cols.hueFamilyCodes[idxGrey]).toBe(8);
    expect(cols.hueFamilyCodes[idxRed]).toBe(0); // Red family
  });

  it('assigns fixed L* tone bands (Shadow..Highlight)', () => {
    const idxBlack = swatches.findIndex(([r, g, b]) => r === 0 && g === 0 && b === 0);
    const idxWhite = swatches.findIndex(([r, g, b]) => r === 255 && g === 255 && b === 255);
    expect(cols.toneCodes[idxBlack]).toBe(0); // Shadow
    expect(cols.toneCodes[idxWhite]).toBe(4); // Highlight
  });
});

describe('decodeSegmentId', () => {
  it('packs (r<<16)|(g<<8)|b', () => {
    expect(decodeSegmentId(0, 0, 0)).toBe(0);
    expect(decodeSegmentId(0, 0, 1)).toBe(1);
    expect(decodeSegmentId(0, 1, 0)).toBe(256);
    expect(decodeSegmentId(1, 0, 0)).toBe(65536);
    expect(decodeSegmentId(255, 0, 0)).toBe(16711680); // matches the doc-comment example ("sky")
    expect(decodeSegmentId(0, 255, 0)).toBe(65280); // matches the doc-comment example ("sea")
    expect(decodeSegmentId(255, 255, 255)).toBe(16777215);
  });
});

describe('buildSegmentColumns (pure core of the mask/JSON pairing, no DOM/fetch)', () => {
  // Three pixels: id 16711680 -> "sky", id 65280 -> "sea", id 0 -> nothing
  // in the map (falls back to Unsegmented like a genuinely unmapped id).
  const rawIds = Int32Array.from([16711680, 65280, 16711680, 0]);
  const validJson = {
    segments: [
      { id: 16711680, label: 'sky', area: 120 },
      { id: 65280, label: 'sea' }, // no area -> NaN, and this must not throw
    ],
  };

  it('dictionary-encodes categories with Unsegmented always at code 0', () => {
    const result = buildSegmentColumns(rawIds, validJson);
    expect(result).not.toBeNull();
    expect(result!.categories[0]).toBe('Unsegmented');
    expect(result!.codes[3]).toBe(0); // id 0 has no map entry -> Unsegmented
    const skyCode = result!.categories.indexOf('sky');
    const seaCode = result!.categories.indexOf('sea');
    expect(result!.codes[0]).toBe(skyCode);
    expect(result!.codes[2]).toBe(skyCode);
    expect(result!.codes[1]).toBe(seaCode);
  });

  it('carries a numeric area per category and NaN where the JSON omitted it', () => {
    const result = buildSegmentColumns(rawIds, validJson)!;
    const skyCode = result.categories.indexOf('sky');
    const seaCode = result.categories.indexOf('sea');
    expect(result.areaByCode[skyCode]).toBe(120);
    expect(Number.isNaN(result.areaByCode[seaCode])).toBe(true);
    expect(Number.isNaN(result.areaByCode[0])).toBe(true); // Unsegmented
  });

  it('still works with the documented minimal {id,label} shape (no area at all)', () => {
    const minimal = { segments: [{ id: 16711680, label: 'sky' }] };
    const result = buildSegmentColumns(rawIds, minimal);
    expect(result).not.toBeNull();
    expect(result!.categories).toContain('sky');
    expect(Number.isNaN(result!.areaByCode[result!.categories.indexOf('sky')])).toBe(true);
  });

  it('returns null, never throws, for malformed input', () => {
    expect(buildSegmentColumns(rawIds, null)).toBeNull();
    expect(buildSegmentColumns(rawIds, undefined)).toBeNull();
    expect(buildSegmentColumns(rawIds, 'not an object')).toBeNull();
    expect(buildSegmentColumns(rawIds, 42)).toBeNull();
    expect(buildSegmentColumns(rawIds, {})).toBeNull(); // no `segments` key
    expect(buildSegmentColumns(rawIds, { segments: 'nope' })).toBeNull(); // not an array
    // Malformed entries inside an otherwise-valid array are just skipped.
    const messy = {
      segments: [null, 42, { id: 'not-a-number', label: 'x' }, { id: 1 }, { id: 16711680, label: 'sky' }],
    };
    const result = buildSegmentColumns(rawIds, messy);
    expect(result).not.toBeNull();
    expect(result!.categories).toEqual(['Unsegmented', 'sky']);
  });

  it('is idempotent/order-stable: first-seen id for a label wins its area', () => {
    // Two different ids sharing one label — rare in practice, but must not throw,
    // and the category area is whichever id's area is discovered first.
    const dupIds = Int32Array.from([1, 2]);
    const json = {
      segments: [
        { id: 1, label: 'blob', area: 10 },
        { id: 2, label: 'blob', area: 999 },
      ],
    };
    const result = buildSegmentColumns(dupIds, json)!;
    expect(result.categories).toEqual(['Unsegmented', 'blob']);
    expect(result.areaByCode[1]).toBe(10);
  });
});
