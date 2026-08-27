/**
 * Pixel-collection datasets: turn a photograph into one row per pixel (or,
 * at reduced resolution, one card per pixel) with columns for position,
 * raw RGB, luminance, HSL, and CIELAB colour appearance.
 *
 * The colour maths is exported as small pure functions (srgbToLinear,
 * linearRgbToXyz, xyzToLab, rgbToLab, rgbToHsl) and is unit tested against
 * known reference values in tests/pixels.test.ts. The per-pixel build loop
 * (`buildPixelColumns`) needs to run over up to ~1M pixels well under
 * 400ms, so it does NOT call those functions per pixel (that would mean a
 * tuple allocation per pixel per colour space); instead it inlines the same
 * formulas against a precomputed 256-entry sRGB->linear lookup table.
 * `buildPixelColumns` is itself a pure function (no DOM/fetch), so the
 * duplicated maths is pinned against the exported reference functions by a
 * test in tests/pixels.test.ts across a spread of colours.
 *
 * ## Segmentation mask (optional, for SAM exports)
 *
 * After building the base columns, loadPixels() tries to fetch an optional
 * pair of files: `data/<image>.segments.png` and `data/<image>.segments.json`.
 * If BOTH fetches return 200 AND the PNG actually decodes as an image (a
 * dev server may answer any path with 200 + index.html — createImageBitmap
 * on that content will reject, which is the guard), the PNG is decoded at
 * the same scaled width/height used for the pixel columns, and each pixel's
 * colour is read back as a segment id:
 *
 *   id = (r << 16) | (g << 8) | b
 *
 * The JSON file maps those colour-encoded ids to human labels — the shape
 * a SAM (Segment Anything) export would naturally produce:
 *
 *   {
 *     "segments": [
 *       { "id": 16711680, "label": "sky" },
 *       { "id": 65280, "label": "sea" }
 *     ]
 *   }
 *
 * Any pixel whose id has no entry in `segments` falls back to the
 * "Unsegmented" category. If either file is missing, not OK, not valid
 * JSON/PNG, or anything else goes wrong, the mask is silently skipped and
 * no `Segment` column is added — this path must never throw and must never
 * log noise for the (normal) no-mask case.
 */

import { Dataset, Column, numeric, categoryFromCodes } from './columnar';

export const PIXEL_IMAGES = ['starry-night', 'great-wave', 'millot-papillons'] as const;
export type PixelImage = (typeof PIXEL_IMAGES)[number];

/** The one display title per image: menu, dataset name and toast all read this. */
export const PIXEL_TITLES: Record<PixelImage, string> = {
  'starry-night': 'Starry Night Over the Rhône',
  'great-wave': 'The Great Wave off Kanagawa',
  'millot-papillons': 'Millot’s Butterflies',
};

/* ------------------------------------------------------------------------ *
 * Colour maths — pure, exported, unit tested.
 * ------------------------------------------------------------------------ */

/** Standard sRGB EOTF: 8-bit channel (0..255) -> linear light (0..1). */
export function srgbToLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// sRGB (D65) linear RGB -> CIE XYZ, IEC 61966-2-1 matrix. The middle row is
// also the Rec.709 relative-luminance weighting used for the Luminance
// column below.
const M00 = 0.4124564, M01 = 0.3575761, M02 = 0.1804375;
const M10 = 0.2126729, M11 = 0.7151522, M12 = 0.0721750;
const M20 = 0.0193339, M21 = 0.1191920, M22 = 0.9503041;

export function linearRgbToXyz(r: number, g: number, b: number): [number, number, number] {
  return [M00 * r + M01 * g + M02 * b, M10 * r + M11 * g + M12 * b, M20 * r + M21 * g + M22 * b];
}

// CIE D65 white point, 2 degree observer.
const D65_XN = 0.95047;
const D65_YN = 1.0;
const D65_ZN = 1.08883;
const LAB_EPS = 216 / 24389; // (6/29)^3
const LAB_KAPPA = 24389 / 27; // (29/3)^3

function labF(t: number): number {
  return t > LAB_EPS ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
}

export function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  const fx = labF(x / D65_XN);
  const fy = labF(y / D65_YN);
  const fz = labF(z / D65_ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function rgbToLab(r8: number, g8: number, b8: number): [number, number, number] {
  const [x, y, z] = linearRgbToXyz(srgbToLinear(r8), srgbToLinear(g8), srgbToLinear(b8));
  return xyzToLab(x, y, z);
}

/** h in 0..360, s/l in 0..100. */
export function rgbToHsl(r8: number, g8: number, b8: number): [number, number, number] {
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 1e-9) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

/* ------------------------------------------------------------------------ *
 * Fixed category schemes.
 * ------------------------------------------------------------------------ */

// 8 hue families of 45 degrees each, centred on the named hue, plus Neutral
// for low-chroma/low-saturation pixels (greys, near-blacks, near-whites).
const HUE_FAMILY_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Violet', 'Magenta', 'Neutral'];
const NEUTRAL_CHROMA = 4; // Lab chroma
const NEUTRAL_SATURATION = 8; // HSL saturation, %

// 5 tone bands with FIXED L* thresholds (not quantiles), so "Mid" means the
// same thing across every image.
const TONE_NAMES = ['Shadow', 'Dark', 'Mid', 'Light', 'Highlight'];
// Tone bands are lightness, not hue, so pin a grey ramp rather than let the
// categorical palette paint "Shadow" blue. Hue family needs no pin: its labels
// are colour names and palette.ts auto-detects them.
const TONE_COLORS: Record<string, string> = {
  Shadow: '#3a3a38', Dark: '#6a6a66', Mid: '#9a9a94', Light: '#c8c8c2', Highlight: '#f2f2ee',
};

/* ------------------------------------------------------------------------ *
 * Hot loop.
 * ------------------------------------------------------------------------ */

// sRGB(0..255) -> linear light lookup table, built once from the exported
// reference function so it cannot drift from it.
const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) SRGB_TO_LINEAR[i] = srgbToLinear(i);

export interface PixelColumns {
  X: Float32Array;
  Y: Float32Array;
  R: Float32Array;
  G: Float32Array;
  B: Float32Array;
  Luminance: Float32Array;
  Hue: Float32Array;
  Saturation: Float32Array;
  Lightness: Float32Array;
  Lstar: Float32Array;
  Astar: Float32Array;
  Bstar: Float32Array;
  Chroma: Float32Array;
  hueFamilyCodes: Int32Array;
  toneCodes: Int32Array;
  rgb: Uint8Array;
}

/**
 * Build every per-pixel column in a single pass over `data` (an
 * RGBA-interleaved Uint8ClampedArray of length w*h*4, e.g. ImageData.data).
 * Pure and DOM-free so it is directly unit-testable; the maths here
 * duplicates srgbToLinear/linearRgbToXyz/xyzToLab/rgbToHsl above (inlined
 * against the LUT for speed) and is pinned against them in tests.
 *
 * Y is emitted increasing upward (row 0 of the image = the highest Y) so a
 * plot of X vs Y is not vertically mirrored relative to the photo.
 */
export function buildPixelColumns(w: number, h: number, data: Uint8ClampedArray | Uint8Array): PixelColumns {
  const n = w * h;
  const X = new Float32Array(n);
  const Y = new Float32Array(n);
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const Luminance = new Float32Array(n);
  const Hue = new Float32Array(n);
  const Saturation = new Float32Array(n);
  const Lightness = new Float32Array(n);
  const Lstar = new Float32Array(n);
  const Astar = new Float32Array(n);
  const Bstar = new Float32Array(n);
  const Chroma = new Float32Array(n);
  const hueFamilyCodes = new Int32Array(n);
  const toneCodes = new Int32Array(n);
  const rgb = new Uint8Array(n * 3);

  let i = 0;
  for (let row = 0; row < h; row++) {
    const yCoord = h - 1 - row;
    for (let col = 0; col < w; col++, i++) {
      const p = i * 4;
      const r8 = data[p], g8 = data[p + 1], b8 = data[p + 2];

      X[i] = col;
      Y[i] = yCoord;
      R[i] = r8;
      G[i] = g8;
      B[i] = b8;

      const ri = i * 3;
      rgb[ri] = r8;
      rgb[ri + 1] = g8;
      rgb[ri + 2] = b8;

      // Linear light via LUT, then XYZ (D65), then CIELAB — inlined copy of
      // linearRgbToXyz/xyzToLab, pinned against them in tests.
      const rl = SRGB_TO_LINEAR[r8], gl = SRGB_TO_LINEAR[g8], bl = SRGB_TO_LINEAR[b8];
      const yLin = M10 * rl + M11 * gl + M12 * bl;
      Luminance[i] = yLin * 100;

      const x = M00 * rl + M01 * gl + M02 * bl;
      const z = M20 * rl + M21 * gl + M22 * bl;
      const xr = x / D65_XN, yr = yLin / D65_YN, zr = z / D65_ZN;
      const fx = xr > LAB_EPS ? Math.cbrt(xr) : (LAB_KAPPA * xr + 16) / 116;
      const fy = yr > LAB_EPS ? Math.cbrt(yr) : (LAB_KAPPA * yr + 16) / 116;
      const fz = zr > LAB_EPS ? Math.cbrt(zr) : (LAB_KAPPA * zr + 16) / 116;
      const L = 116 * fy - 16;
      const A = 500 * (fx - fy);
      const Bl = 200 * (fy - fz);
      Lstar[i] = L;
      Astar[i] = A;
      Bstar[i] = Bl;
      const chroma = Math.sqrt(A * A + Bl * Bl);
      Chroma[i] = chroma;

      // HSL — inlined copy of rgbToHsl, pinned against it in tests.
      const rf = r8 / 255, gf = g8 / 255, bf = b8 / 255;
      const max = rf > gf ? (rf > bf ? rf : bf) : (gf > bf ? gf : bf);
      const min = rf < gf ? (rf < bf ? rf : bf) : (gf < bf ? gf : bf);
      const lum = (max + min) / 2;
      const d = max - min;
      let hue = 0, sat = 0;
      if (d > 1e-9) {
        sat = lum > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === rf) hue = (gf - bf) / d + (gf < bf ? 6 : 0);
        else if (max === gf) hue = (bf - rf) / d + 2;
        else hue = (rf - gf) / d + 4;
        hue *= 60;
      }
      Hue[i] = hue;
      Saturation[i] = sat * 100;
      Lightness[i] = lum * 100;

      hueFamilyCodes[i] =
        chroma < NEUTRAL_CHROMA || sat * 100 < NEUTRAL_SATURATION ? 8 : Math.floor(((hue + 22.5) % 360) / 45);
      toneCodes[i] = L < 20 ? 0 : L < 40 ? 1 : L < 60 ? 2 : L < 80 ? 3 : 4;
    }
  }

  return { X, Y, R, G, B, Luminance, Hue, Saturation, Lightness, Lstar, Astar, Bstar, Chroma, hueFamilyCodes, toneCodes, rgb };
}

/* ------------------------------------------------------------------------ *
 * Dataset assembly.
 * ------------------------------------------------------------------------ */

function buildDataset(
  image: PixelImage,
  w: number,
  h: number,
  data: Uint8ClampedArray,
  segments: SegmentColumns | null
): Dataset {
  const n = w * h;
  const p = buildPixelColumns(w, h, data);

  const columns: Record<string, Column> = {
    'Hue family': categoryFromCodes('Hue family', p.hueFamilyCodes, HUE_FAMILY_NAMES.slice()),
    Tone: categoryFromCodes('Tone', p.toneCodes, TONE_NAMES.slice()),
    X: numeric('X', p.X),
    Y: numeric('Y', p.Y),
    R: numeric('R', p.R),
    G: numeric('G', p.G),
    B: numeric('B', p.B),
    Luminance: numeric('Luminance', p.Luminance, (v) => v.toFixed(1)),
    Hue: numeric('Hue', p.Hue, (v) => `${v.toFixed(0)}°`),
    Saturation: numeric('Saturation', p.Saturation, (v) => `${v.toFixed(0)}%`),
    Lightness: numeric('Lightness', p.Lightness, (v) => `${v.toFixed(0)}%`),
    'L*': numeric('L*', p.Lstar, (v) => v.toFixed(1)),
    'a*': numeric('a*', p.Astar, (v) => v.toFixed(1)),
    'b*': numeric('b*', p.Bstar, (v) => v.toFixed(1)),
    Chroma: numeric('Chroma', p.Chroma, (v) => v.toFixed(1)),
  };

  const facets = ['Hue family', 'Tone'];
  if (segments) {
    columns.Segment = categoryFromCodes('Segment', segments.codes, segments.categories);
    facets.push('Segment');

    const segmentArea = new Float32Array(n);
    for (let i = 0; i < n; i++) segmentArea[i] = segments.areaByCode[segments.codes[i]];
    columns['Segment area'] = numeric('Segment area', segmentArea, (v) => Math.round(v).toLocaleString());
    facets.push('Segment area');
  }
  facets.push('X', 'Y', 'R', 'G', 'B', 'Luminance', 'Hue', 'Saturation', 'Lightness', 'L*', 'a*', 'b*', 'Chroma');

  return {
    name: `${PIXEL_TITLES[image]} — ${n.toLocaleString()} pixels`,
    n,
    columns,
    rgb: p.rgb,
    cards: false,
    labelColumn: 'Hue family',
    facets,
    colors: { Tone: TONE_COLORS },
  };
}

/* ------------------------------------------------------------------------ *
 * Canvas plumbing + fetch.
 * ------------------------------------------------------------------------ */

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type AnyContext2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function get2dContext(canvas: AnyCanvas): AnyContext2D | null {
  return canvas.getContext('2d') as AnyContext2D | null;
}

/**
 * Segment ids are colour-encoded, so the mask PNG must be scaled with
 * nearest-neighbour semantics: bilinear interpolation (the canvas default)
 * invents ids that appear in no map, and almost every pixel falls back to
 * "Unsegmented". Vendor-prefixed variants only exist on old WebKit/Firefox/
 * Edge; guarded rather than typed, since standard lib.dom types don't know
 * about them.
 */
function disableSmoothing(ctx: AnyContext2D): void {
  ctx.imageSmoothingEnabled = false;
  const vendor = ctx as unknown as Record<string, boolean | undefined>;
  for (const key of ['webkitImageSmoothingEnabled', 'mozImageSmoothingEnabled', 'msImageSmoothingEnabled']) {
    if (key in vendor) vendor[key] = false;
  }
}

/** Decode a mask pixel's colour into a segment id: id = (r<<16)|(g<<8)|b. */
export function decodeSegmentId(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

export interface SegmentColumns {
  codes: Int32Array;
  categories: string[];
  /** Index-aligned with `categories`; NaN where the JSON carried no (or a
   *  non-numeric) `area` for that category's id. */
  areaByCode: Float32Array;
}

/**
 * Pure core of segment-column construction: given one already-decoded id
 * per pixel (from the mask PNG, via decodeSegmentId) and the parsed
 * segments.json body, build the dictionary-encoded Segment category column
 * ("Unsegmented" is always code 0) plus a parallel per-category area
 * lookup. Returns null for any malformed `segmentsJson` shape — never
 * throws. DOM/fetch-free, so this is unit tested directly; tryLoadSegments
 * below is the thin fetch+canvas-decode wrapper around it.
 */
export function buildSegmentColumns(rawIds: Int32Array, segmentsJson: unknown): SegmentColumns | null {
  if (
    !segmentsJson ||
    typeof segmentsJson !== 'object' ||
    !Array.isArray((segmentsJson as { segments?: unknown }).segments)
  ) {
    return null;
  }

  const idToLabel = new Map<number, string>();
  const idToArea = new Map<number, number>();
  for (const seg of (segmentsJson as { segments: unknown[] }).segments) {
    if (
      seg &&
      typeof seg === 'object' &&
      typeof (seg as { id?: unknown }).id === 'number' &&
      typeof (seg as { label?: unknown }).label === 'string'
    ) {
      const id = (seg as { id: number }).id;
      idToLabel.set(id, (seg as { label: string }).label);
      const area = (seg as { area?: unknown }).area;
      if (typeof area === 'number' && Number.isFinite(area)) idToArea.set(id, area);
    }
  }

  const categories: string[] = ['Unsegmented'];
  const labelToCode = new Map<string, number>([['Unsegmented', 0]]);
  const areaByCode: number[] = [NaN];
  const codes = new Int32Array(rawIds.length);
  for (let i = 0; i < rawIds.length; i++) {
    const label = idToLabel.get(rawIds[i]);
    if (label === undefined) {
      codes[i] = 0;
      continue;
    }
    let code = labelToCode.get(label);
    if (code === undefined) {
      code = categories.length;
      labelToCode.set(label, code);
      categories.push(label);
      areaByCode.push(idToArea.get(rawIds[i]) ?? NaN);
    }
    codes[i] = code;
  }
  return { codes, categories, areaByCode: Float32Array.from(areaByCode) };
}

/**
 * Try to load an optional SAM-style segmentation mask for `image`, scaled
 * to the same w x h as the pixel columns. Returns null (never throws) if
 * either file is missing, not OK, or fails to decode as PNG/JSON — see the
 * file-level doc comment for the expected shapes. All actual parsing is
 * buildSegmentColumns above; this is just fetch + canvas decode.
 */
async function tryLoadSegments(image: PixelImage, w: number, h: number): Promise<SegmentColumns | null> {
  try {
    const [pngRes, jsonRes] = await Promise.all([
      fetch(`data/${image}.segments.png`),
      fetch(`data/${image}.segments.json`),
    ]);
    if (!pngRes.ok || !jsonRes.ok) return null;

    const pngBlob = await pngRes.blob();
    // Guard against a dev server answering any path with 200 + index.html:
    // real PNG bytes decode; HTML bytes make createImageBitmap reject.
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(pngBlob);
    } catch {
      return null;
    }
    if (bitmap.width < 1 || bitmap.height < 1) return null;

    const json: unknown = await jsonRes.json().catch(() => null);

    const canvas = makeCanvas(w, h);
    const ctx = get2dContext(canvas);
    if (!ctx) {
      bitmap.close();
      return null;
    }
    disableSmoothing(ctx); // KNOWN DEFECT fix: bilinear id colours are garbage ids
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const { data } = ctx.getImageData(0, 0, w, h);

    const n = w * h;
    const rawIds = new Int32Array(n);
    for (let i = 0, off = 0; i < n; i++, off += 4) {
      rawIds[i] = decodeSegmentId(data[off], data[off + 1], data[off + 2]);
    }
    return buildSegmentColumns(rawIds, json);
  } catch {
    return null;
  }
}

/**
 * Fetch, decode, and downsample one of PIXEL_IMAGES into a per-pixel
 * Dataset. Scales to fit `targetPixels` (default 1,000,000) preserving
 * aspect ratio without upscaling past the source image, decodes once via
 * a single getImageData call, then builds every column in one pass.
 */
export async function loadPixels(image: PixelImage, targetPixels = 1_000_000): Promise<Dataset> {
  const res = await fetch(`data/${image}.jpg`);
  if (!res.ok) throw new Error(`failed to fetch data/${image}.jpg: ${res.status} ${res.statusText}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);

  const scale = Math.min(1, Math.sqrt(targetPixels / (bitmap.width * bitmap.height)));
  let w = Math.max(1, Math.round(bitmap.width * scale));
  let h = Math.max(1, Math.round(bitmap.height * scale));
  // Rounding up can push w*h slightly over budget — trim the longer side.
  while (w * h > targetPixels && (w > 1 || h > 1)) {
    if (w >= h && w > 1) w--;
    else if (h > 1) h--;
    else break;
  }

  const canvas = makeCanvas(w, h);
  const ctx = get2dContext(canvas);
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, w, h);

  const segments = await tryLoadSegments(image, w, h);

  return buildDataset(image, w, h, data, segments);
}
