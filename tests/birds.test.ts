import { describe, it, expect, afterEach } from 'vitest';
import { parseBirds, BIRD_SIZES, BIRD_FACETS, BIRDS_KIND, formatMass, commonsImageUrl, PHOTO_WIDTH } from '../src/data/birds';
import { sheetGeometry, tileRect, registerSheets, sheetsFor, clearSheets, type SheetGeometry } from '../src/gl/cards/sheet';
import { photoPainter, PHOTO_ONLY_PX } from '../src/gl/cards/photo';
import { cardPainterFor } from '../src/gl/cards';
import type { CardSpec } from '../src/gl/atlas';
import { valueAt, type Dataset } from '../src/data/columnar';
import { birdsFixture, sheetFor, missingRangeRow, MIGRATION, MASS_BANDS, DENSITY } from './helpers/birds';

/**
 * The birds collection is fetched at runtime, so nothing here reads
 * `public/data`: the pipeline's output is a build artefact and a test that
 * needed it would be testing the build. `tests/helpers/birds.ts` is the frozen
 * contract instead — see `docs/plans/image-card-datasets.md` §5.
 */

const fixture = birdsFixture(12);
const { dataset: ds, sheet } = parseBirds(fixture);

describe('parseBirds', () => {
  it('reads the contract column names and kinds', () => {
    expect(ds.n).toBe(12);
    expect(ds.name).toBe('Birds of the world (12)');
    expect(ds.kind).toBe(BIRDS_KIND);
    expect(ds.labelColumn).toBe('Common name');
    for (const c of ['Common name', 'Scientific name']) expect(ds.columns[c]?.kind).toBe('text');
    for (const c of ['Order', 'Family', 'Habitat', 'Diet', 'Trophic level', 'Lifestyle',
      'Migration', 'Habitat density', 'Mass band']) expect(ds.columns[c]?.kind, c).toBe('category');
    for (const c of ['Mass', 'Wing length', 'Beak length', 'Tail length', 'Hand-wing index',
      'Range size', 'Longitude', 'Latitude']) expect(ds.columns[c]?.kind, c).toBe('number');
    expect(valueAt(ds, 'Common name', 0)).toBe('Barn owl');
    expect(valueAt(ds, 'Scientific name', 0)).toBe('Tyto alba');
  });

  it('leads the facets with Habitat, not Order, and names only columns it has', () => {
    // 36 orders against an eight-slot palette folds everything past the eighth
    // into one grey; Habitat is the field the default colour can actually show.
    expect(ds.facets[0]).toBe('Habitat');
    expect(ds.facets).toEqual(BIRD_FACETS);
    for (const f of ds.facets) expect(ds.columns[f], f).toBeDefined();
    // The numerics come after the categoricals so the default Y axis is Mass.
    const nums = ds.facets.filter((f) => ds.columns[f]?.kind === 'number');
    expect(nums[0]).toBe('Mass');
  });

  it('keeps ordered categories in the order the pipeline sent, never re-sorted', () => {
    const cats = (name: string) => {
      const c = ds.columns[name];
      return c?.kind === 'category' ? c.categories : [];
    };
    // Alphabetical would be Migratory, Partial, Sedentary — the opposite of the
    // meaning, and the reason the Bars layout can bucket these at all.
    expect(cats('Migration')).toEqual(MIGRATION);
    expect(cats('Habitat density')).toEqual(DENSITY);
    expect(cats('Mass band')).toEqual(MASS_BANDS);
    expect(cats('Mass band')).not.toEqual([...MASS_BANDS].sort());
  });

  it('turns a null in a numeric column into NaN, not zero', () => {
    const c = ds.columns['Range size'];
    expect(c?.kind).toBe('number');
    if (c?.kind !== 'number') return;
    const row = missingRangeRow(12);
    expect(Number.isNaN(c.values[row])).toBe(true);
    expect(c.min).toBeGreaterThan(0);           // NaN never widens the domain
    expect(valueAt(ds, 'Range size', row)).toBe('—');
  });

  it('wires up the geographic pair, so the map layout is the one it opens on', () => {
    expect(ds.geo).toEqual({ lon: 'Longitude', lat: 'Latitude' });
    expect(ds.columns[ds.geo!.lon]?.kind).toBe('number');
    expect(ds.columns[ds.geo!.lat]?.kind).toBe('number');
  });

  it('carries one true colour per row', () => {
    expect(ds.rgb).toBeInstanceOf(Uint8Array);
    expect(ds.rgb!.length).toBe(ds.n * 3);
  });

  it('ignores an rgb array that does not agree with the row count', () => {
    const bad = { ...birdsFixture(12), rgb: [1, 2, 3] };
    expect(parseBirds(bad).dataset.rgb).toBeUndefined();
  });

  it('formats Mass as grams or kilograms across four orders of magnitude', () => {
    expect(formatMass(1.9)).toBe('1.9 g');
    expect(formatMass(35.5)).toBe('36 g');
    expect(formatMass(999)).toBe('999 g');
    expect(formatMass(1100)).toBe('1.1 kg');
    expect(formatMass(111000)).toBe('111.0 kg');
    // The card metric slot is eight characters (SLOT_CHARS.metric).
    expect(formatMass(111000).length).toBeLessThanOrEqual(8);
  });

  it('declares the photo card and a detail template whose fields exist', () => {
    expect(ds.card?.custom).toBe('photo');
    expect(ds.card?.tags?.length).toBe(2);
    expect(ds.detail?.context).toEqual(['Habitat', 'Diet', 'Order']);
    for (const f of ds.detail!.context!) expect(ds.columns[f], f).toBeDefined();
    expect(valueAt(ds, 'Photographer', 0)).toBe('Photographer 0');
    expect(valueAt(ds, 'Photo licence', 0)).toBe('Public domain');
  });

  it('refuses a file with no columns or no rows', () => {
    expect(() => parseBirds({})).toThrow(/no columns/);
    expect(() => parseBirds({ columns: [{ name: 'Mass', kind: 'number', values: [] }] })).toThrow(/no rows/);
  });
});

// ------------------------------------------------------------------- sheets

describe('sheet geometry', () => {
  it('reads the manifest the fixture ships', () => {
    expect(sheet.tile).toBe(128);
    expect(sheet.cols).toBe(32);
    expect(sheet.perSheet).toBe(1024);
    expect(sheet.files).toEqual(['birds-12-0.avif']);
    expect(sheet.n).toBe(12);
  });

  it('rejects a manifest that cannot hold the rows, or disagrees with itself', () => {
    expect(() => sheetGeometry({ tile: 96, cols: 42, rows: 42, perSheet: 1764, files: ['a.avif'] }, 3000))
      .toThrow(/cannot hold/);
    expect(() => sheetGeometry({ tile: 96, cols: 42, rows: 42, perSheet: 999, files: ['a.avif'] }, 10))
      .toThrow(/perSheet/);
    expect(() => sheetGeometry({ tile: 0, cols: 42, rows: 42, files: ['a.avif'] }, 10)).toThrow(/positive/);
    expect(() => sheetGeometry({ tile: 96, cols: 42, rows: 42, files: [] }, 10)).toThrow(/no sheet files/);
  });
});

describe('tileRect — row to sheet, sx, sy', () => {
  // The 3,000-row collection: 96 px tiles, 42 x 42 = 1,764 per sheet, two
  // sheets, the second cropped to the 1,236 rows it actually holds.
  const g: SheetGeometry = sheetGeometry(sheetFor(3000), 3000);

  it('has the geometry the pipeline picks at 3,000 rows', () => {
    expect([g.tile, g.cols, g.perSheet, g.files.length]).toEqual([96, 42, 1764, 2]);
  });

  it('walks the first sheet across then down', () => {
    expect(tileRect(g, 0)).toEqual({ sheet: 0, sx: 0, sy: 0, size: 96 });
    expect(tileRect(g, 41)).toEqual({ sheet: 0, sx: 41 * 96, sy: 0, size: 96 });
    expect(tileRect(g, 42)).toEqual({ sheet: 0, sx: 0, sy: 96, size: 96 });
    expect(tileRect(g, 1763)).toEqual({ sheet: 0, sx: 41 * 96, sy: 41 * 96, size: 96 });
  });

  it('starts the second sheet over again at its own origin', () => {
    expect(tileRect(g, 1764)).toEqual({ sheet: 1, sx: 0, sy: 0, size: 96 });
    expect(tileRect(g, 1765)).toEqual({ sheet: 1, sx: 96, sy: 0, size: 96 });
  });

  it('keeps the last row inside the short sheet it was cropped to', () => {
    const last = tileRect(g, 2999)!;
    expect(last.sheet).toBe(1);
    expect(last).toEqual({ sheet: 1, sx: 17 * 96, sy: 29 * 96, size: 96 });
    // The pipeline crops the final sheet to the rows it fills; the read must
    // still land inside it.
    const croppedHeight = Math.ceil((3000 - g.perSheet) / g.cols) * g.tile;
    expect(last.sy + last.size).toBeLessThanOrEqual(croppedHeight);
  });

  it('has nothing to say about a row that is not there', () => {
    expect(tileRect(g, 3000)).toBeNull();
    expect(tileRect(g, -1)).toBeNull();
    expect(tileRect(g, 1.5)).toBeNull();
  });
});

// ------------------------------------------------------------------ painter

/** Enough of a 2D context for the painters, recording what they drew. */
function fakeCtx() {
  const calls: string[] = [];
  /** Every `drawImage` argument list after the bitmap: sx, sy, sw, sh, dx, dy, dw, dh. */
  const blits: number[][] = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, lineWidth: 1,
    fillRect: () => calls.push('fillRect'),
    strokeRect: () => calls.push('strokeRect'),
    fillText: (s: string) => calls.push(`text:${s}`),
    measureText: (s: string) => ({ width: s.length * 5 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    drawImage: (_img: unknown, ...a: number[]) => { blits.push(a); calls.push('drawImage'); },
    beginPath: () => {}, closePath: () => {}, moveTo: () => {}, lineTo: () => {},
    arc: () => {}, arcTo: () => {}, rect: () => {}, clip: () => {},
    fill: () => {}, stroke: () => {}, save: () => {}, restore: () => {},
    translate: () => {}, setLineDash: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, blits };
}

const bitmap = (): ImageBitmap => ({ width: 4096, height: 4096, close: () => {} } as unknown as ImageBitmap);
const spec = (row: number): CardSpec => ({ title: '', accent: '#3987e5', row });

function register(dataset: Dataset, geom: SheetGeometry) {
  registerSheets(dataset.kind!, { ...geom, images: geom.files.map(bitmap) });
}

afterEach(() => clearSheets());

describe('photoPainter', () => {
  it('degrades to the quiet card when no sheets are registered', () => {
    expect(sheetsFor(BIRDS_KIND)).toBeUndefined();
    const { ctx, calls } = fakeCtx();
    photoPainter(ds)(ctx, 256, 256, spec(0));
    expect(calls).not.toContain('drawImage');
    // Quiet, not blank: the record still says who it is.
    expect(calls).toContain('text:Barn owl');
  });

  it('draws the row it was given out of the sheet once they are registered', () => {
    register(ds, sheet);
    const { ctx, calls, blits } = fakeCtx();
    photoPainter(ds)(ctx, 256, 256, spec(5));
    expect(blits.length).toBe(1);
    const [sx, sy, sw, sh, dx, dy, dw, dh] = blits[0];
    // Row 5 is slot 5 of the only sheet: column 5 of a 32-wide grid of 128 px tiles.
    expect([sx, sw]).toEqual([5 * 128, 128]);
    // Full bleed: the whole square tile, over the whole square card, uncropped.
    expect([sy, sh]).toEqual([0, 128]);
    expect([dx, dy, dw, dh]).toEqual([0, 0, 256, 256]);
    // The photograph is the new element; the text over it is the quiet card's.
    expect(calls).toContain('text:Arctic tern');
    expect(calls).toContain('text:Sterna paradisaea');
  });

  it('frames the photograph identically at every size, so zooming never recrops it', () => {
    // The regression this pins: the text used to take a fixed share of the card
    // and the picture was letterboxed into what was left, so a card above the
    // mosaic threshold showed a 2.27:1 centre-crop — the bird lost its head and
    // its feet — while the same row at the base slot showed all of itself.
    // Zooming in re-rasterises at a bigger tier, so the image visibly jumped.
    register(ds, sheet);
    const source = (size: number) => {
      const { blits } = (() => {
        const f = fakeCtx();
        photoPainter(ds)(f.ctx, size, size, spec(5));
        return f;
      })();
      const [sx, sy, sw, sh, dx, dy, dw, dh] = blits[0];
      return { crop: [sx - 5 * 128, sy, sw, sh], dest: [dx / size, dy / size, dw / size, dh / size] };
    };
    // 64 px is the mosaic slot, 256 and 512 are hi-res tiers.
    const mosaic = source(64);
    expect(source(256)).toEqual(mosaic);
    expect(source(512)).toEqual(mosaic);
    expect(mosaic.crop).toEqual([0, 0, 128, 128]);
    expect(mosaic.dest).toEqual([0, 0, 1, 1]);
  });

  it('ignores sheets registered for a different size of the same family', () => {
    // Both sizes are `kind: 'birds'`, so the row count is the guard.
    register(ds, sheetGeometry(sheetFor(3000), 3000));
    const { ctx, calls } = fakeCtx();
    photoPainter(ds)(ctx, 256, 256, spec(0));
    expect(calls).not.toContain('drawImage');
  });

  it('degrades rather than throwing when a bitmap has been closed under it', () => {
    registerSheets(BIRDS_KIND, { ...sheet, images: [bitmap()] });
    const { ctx, calls } = fakeCtx();
    ctx.drawImage = (() => { throw new Error('InvalidStateError'); }) as typeof ctx.drawImage;
    expect(() => photoPainter(ds)(ctx, 256, 256, spec(0))).not.toThrow();
    expect(calls).toContain('text:Barn owl');
  });

  it('is the photograph and nothing else at the 64 px base slot', () => {
    register(ds, sheet);
    const { ctx, calls } = fakeCtx();
    photoPainter(ds)(ctx, 64, 64, spec(0));
    expect(calls).toContain('drawImage');
    // 9 px type over a 28 px thumbnail reads as neither; the mosaic is the point.
    expect(calls.some((c) => c.startsWith('text:'))).toBe(false);
    expect(64).toBeLessThan(PHOTO_ONLY_PX);
  });

  it('leaves a cover — a spec with no row — to drawCover, untouched', () => {
    register(ds, sheet);
    for (const s of [{ title: 'Forest', accent: '#3987e5' },
      { title: 'x', accent: '#3987e5', cover: { label: 'Forest', accent: '#3987e5' } }] as CardSpec[]) {
      const { ctx, calls } = fakeCtx();
      photoPainter(ds)(ctx, 512, 512, s);
      expect(calls).not.toContain('drawImage');
      expect(calls).toContain('strokeRect');   // only drawCover frames the card
      expect(calls).toContain('text:Forest');
    }
  });

  it('is what cardPainterFor picks for the collection', () => {
    register(ds, sheet);
    const { ctx, calls } = fakeCtx();
    cardPainterFor(ds, { colorBy: 'Habitat' })(ctx, 256, 256, spec(0));
    expect(calls).toContain('drawImage');
    // …and the Simple override still gets the quiet card.
    const quiet = fakeCtx();
    cardPainterFor(ds, { colorBy: 'Habitat', design: 'quiet' })(quiet.ctx, 256, 256, spec(0));
    expect(quiet.calls).not.toContain('drawImage');
  });
});

// ------------------------------------------------------------------- sizes

describe('the sizes the pipeline bakes', () => {
  it('are one editable list, and each parses to a collection of that many rows', () => {
    expect(BIRD_SIZES.length).toBeGreaterThan(0);
    for (const n of BIRD_SIZES) {
      const { dataset, sheet: g } = parseBirds(birdsFixture(n));
      expect(dataset.n, `${n} rows`).toBe(n);
      expect(dataset.facets).toEqual(BIRD_FACETS);
      expect(g.files.length * g.perSheet).toBeGreaterThanOrEqual(n);
      // Every row is addressable, and nothing past the last one is.
      expect(tileRect(g, n - 1)).not.toBeNull();
      expect(tileRect(g, n)).toBeNull();
    }
  });
});

/**
 * The modal's photograph — the only third-party fetch the app makes, and one
 * the collection has to survive without. `Special:FilePath` is Commons' own
 * name-to-file redirect, so no API call and no MD5 path bucketing.
 */
describe('commonsImageUrl', () => {
  it('builds the Special:FilePath redirect, underscoring spaces', () => {
    expect(commonsImageUrl('Masked booby with chick.JPG'))
      .toBe(`https://commons.wikimedia.org/wiki/Special:FilePath/Masked_booby_with_chick.JPG?width=${PHOTO_WIDTH}`);
  });

  it('escapes what a Commons file name can legally contain', () => {
    const url = commonsImageUrl('Turdus merula & co (male).jpg');
    expect(url).toContain('Turdus_merula_%26_co_(male).jpg');
    // The width stays a real query parameter rather than part of the name.
    expect(url.endsWith(`?width=${PHOTO_WIDTH}`)).toBe(true);
  });

  it('returns nothing for a row with no credited file, so no image is drawn', () => {
    expect(commonsImageUrl('')).toBe('');
    expect(commonsImageUrl('   ')).toBe('');
  });

  it('takes an explicit width', () => {
    expect(commonsImageUrl('A.jpg', 320)).toContain('?width=320');
  });
});

describe('the birds detail image', () => {
  it('names a Commons URL, the common name and the full credit for each row', () => {
    const image = ds.detail?.image;
    expect(image).toBeDefined();
    const at = (ref: unknown, i: number) => (typeof ref === 'function' ? (ref as (k: number) => string)(i) : '');
    const src = at(image!.src, 0);
    expect(src.startsWith('https://commons.wikimedia.org/wiki/Special:FilePath/')).toBe(true);
    expect(src).toContain(encodeURIComponent(valueAt(ds, 'Photograph', 0).replace(/ /g, '_')));
    expect(at(image!.alt, 0)).toBe(valueAt(ds, 'Common name', 0));
    const credit = at(image!.credit, 0);
    expect(credit).toContain(valueAt(ds, 'Photographer', 0));
    expect(credit).toContain(valueAt(ds, 'Photo licence', 0));
    expect(credit).toContain('Wikimedia Commons');
  });

  it('declares no image when the build shipped no credits', () => {
    const bare = { ...(birdsFixture(4) as Record<string, unknown>) };
    delete bare.credits;
    const { dataset } = parseBirds(bare);
    expect(dataset.columns.Photograph).toBeUndefined();
    expect(dataset.detail?.image).toBeUndefined();
  });
});
