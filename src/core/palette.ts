/**
 * Categorical palette — validated instance from the data-viz guidelines.
 * Slot order is the CVD-safety mechanism, not cosmetic: assign in fixed order,
 * never cycle. A 9th category folds into "Other" (neutral grey).
 */
import type { Dataset } from '../data/columnar';

export type Theme = 'dark' | 'light';

export const CATEGORICAL: Record<Theme, string[]> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

export const OTHER: Record<Theme, string> = { light: '#8a8880', dark: '#6f6e66' };

/** Sequential blue ramp, light -> dark (100..700). */
export const SEQUENTIAL_BLUE = [
  '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec',
  '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab',
  '#184f95', '#104281', '#0d366b',
];

export const SURFACE: Record<Theme, string> = { light: '#fcfcfb', dark: '#141413' };

/** #rrggbb -> [r,g,b] 0..255 */
export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Colour for categorical slot i; slots past the palette fold to "Other". */
export function categoricalColor(i: number, theme: Theme = 'dark'): string {
  const p = CATEGORICAL[theme];
  return i >= 0 && i < p.length ? p[i] : OTHER[theme];
}

/** Sample the sequential ramp at t in [0,1]. */
export function sequential(t: number): string {
  const i = Math.max(0, Math.min(SEQUENTIAL_BLUE.length - 1,
    Math.round(t * (SEQUENTIAL_BLUE.length - 1))));
  return SEQUENTIAL_BLUE[i];
}

/**
 * The one colour a row is painted with: the card accent, the instance tint
 * (`applyColors`), the legend/facet swatch and the detail-pane header all
 * derive from this so they can never disagree. Numeric colour-by samples the
 * sequential ramp; categorical uses `fieldColors` (pins > names > palette);
 * anything else (true colour, no field) falls back to slot 0.
 */
export function colorOfRow(ds: Dataset, colorBy: string, i: number, theme: Theme = 'dark'): string {
  const col = ds.columns[colorBy];
  if (col?.kind === 'number') {
    const t = (col.values[i] - col.min) / (col.max - col.min || 1);
    return sequential(Number.isFinite(t) ? t : 0);
  }
  if (col?.kind === 'category') {
    const code = col.codes[i];
    return fieldColors(ds, colorBy, theme)[code] ?? categoricalColor(code, theme);
  }
  return categoricalColor(0, theme);
}

/* ------------------------------------------------------------------------ *
 * Named category colours.
 *
 * When categories *are* colours ("Red", "Dark blue", "Yellow-green") the
 * categorical palette is actively misleading — a bucket called Green painted
 * orange. A dataset can pin colours per category (`Dataset.colors`), and
 * failing that we auto-detect colour names. Auto-detection is all-or-nothing
 * per field (every label resolves, or all but one neutral such as "Other"),
 * so a field of mixed labels never ends up half-assigned.
 * ------------------------------------------------------------------------ */

/**
 * Curated, legible-on-dark colour per name (base hues are vivid but not neon).
 * Exact synonyms share one hex (aqua = cyan, violet = purple, royal/cobalt =
 * blue …) so two labels never auto-colour into near-identical swatches that
 * only look distinct in the table.
 */
const NAMED: Record<string, string> = {
  red: '#e04a3f', crimson: '#d6304a', scarlet: '#e04a3f', maroon: '#8c2a3a', burgundy: '#8c2a3a',
  orange: '#f28c28', amber: '#f0a71f', tangerine: '#f28c28', peach: '#f5b48c', coral: '#f07860',
  yellow: '#f2d340', gold: '#e5bf2c', lemon: '#f5e660', cream: '#f4ebc8', ivory: '#f4ebc8', beige: '#d9c59a', tan: '#c9a06a',
  green: '#3fb653', lime: '#a4d641', olive: '#8a9a2a', emerald: '#22a86b', mint: '#8ce0b8', forest: '#2b7a3d', teal: '#249a9b', sage: '#9fb08a',
  cyan: '#2fc2d8', aqua: '#2fc2d8', turquoise: '#33c1b5', sky: '#6fbdf0',
  blue: '#3b82e6', navy: '#22376e', azure: '#2f8ff0', cobalt: '#3b82e6', indigo: '#4b46b8', royal: '#3b82e6',
  purple: '#8e5bd8', violet: '#8e5bd8', lavender: '#b8a3f0', lilac: '#b8a3f0', plum: '#8a3f7a', mauve: '#b07ab0',
  magenta: '#d64ad0', fuchsia: '#e04ac8', pink: '#f07aa8', rose: '#e8607e', salmon: '#f08878',
  brown: '#9c6b3f', chocolate: '#6e4226', rust: '#b5502a', bronze: '#b0782a', copper: '#c07040', sienna: '#a0522d', ochre: '#c9932b', umber: '#6f4e2a', khaki: '#bfae6a',
  black: '#2a2a2a', white: '#f2f2f0', grey: '#8c8c88', gray: '#8c8c88', silver: '#b8b8b4', charcoal: '#4a4a48', slate: '#6b7a8a',
  neutral: '#8c8c88', other: '#6f6e66', none: '#6f6e66', unknown: '#6f6e66',
};

/** Modifiers that shift a base colour rather than naming one. Value = L* shift in HSL %. */
const LIGHTNESS: Record<string, number> = {
  dark: -14, deep: -14, darker: -20, darkest: -24, shadow: -20, dim: -10,
  light: 14, pale: 18, lighter: 20, lightest: 24, bright: 8, vivid: 0, pastel: 20,
  medium: 0, mid: 0, soft: 8, muted: 0, dull: 0, dusty: 6, warm: 0, cool: 0, hot: 0,
  ish: 0,
};

/**
 * Everyday words the table also knows (Sky, Forest, Rose, Gold, Silver, Royal,
 * Mint, Tan, Rust, Plum, Sage, Coral …) could turn a product- or team-name
 * field into colours. A field only auto-detects when at least one of its
 * labels contains one of these unambiguous hue words.
 */
const CORE_HUES = new Set(['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'brown', 'grey', 'gray', 'black', 'white']);

/** Labels treated as the one permitted non-colour in an otherwise-colour field. */
const NEUTRAL_LABELS = new Set(['other', 'neutral', 'grey', 'gray', 'none', 'unknown', 'n/a', 'na', 'mixed', 'various', 'multi', 'multicolour', 'multicolor']);

const NORMALISE: Record<string, string> = { greyish: 'grey', grayish: 'grey', reddish: 'red', bluish: 'blue', greenish: 'green', yellowish: 'yellow', brownish: 'brown', pinkish: 'pink', purplish: 'purple', orangey: 'orange', orangish: 'orange' };

/** #rrggbb -> [h 0..360, s 0..100, l 0..100] */
export function hexToHsl(hex: string): [number, number, number] {
  const [r0, g0, b0] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r0, g0, b0), min = Math.min(r0, g0, b0);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r0) h = ((g0 - b0) / d + (g0 < b0 ? 6 : 0)) / 6;
  else if (max === g0) h = ((b0 - r0) / d + 2) / 6;
  else h = ((r0 - g0) / d + 4) / 6;
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  const ss = s / 100, ll = l / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ll - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Mix two hexes 50/50 in HSL (hue on the short arc), for "yellow-green".
 *  (Not the RGB `mixHex` in gl/atlas.ts, which lerps by an arbitrary t.) */
function mixHueHsl(a: string, b: string): string {
  const [h1, s1, l1] = hexToHsl(a), [h2, s2, l2] = hexToHsl(b);
  let dh = h2 - h1;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  const h = (h1 + dh / 2 + 360) % 360;
  return hslToHex(h, (s1 + s2) / 2, (l1 + l2) / 2);
}

function shiftLightness(hex: string, dl: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s, Math.max(6, Math.min(94, l + dl)));
}

/**
 * Colour for a label that names a colour — "red", "Dark blue", "yellow-green",
 * "light greyish blue" — or null when the label is not a colour name.
 */
export function colorForCategoryName(label: string): string | null {
  const words = colourWords(label);
  if (words.length === 0 || words.length > 4) return null;
  const bases: string[] = [];
  let dl = 0;
  for (const w of words) {
    if (NAMED[w]) bases.push(NAMED[w]);
    else if (w in LIGHTNESS) dl += LIGHTNESS[w];
    else return null;
  }
  if (bases.length === 0 || bases.length > 2) return null;
  const base = bases.length === 2 ? mixHueHsl(bases[0], bases[1]) : bases[0];
  return dl ? shiftLightness(base, dl) : base;
}

function colourWords(label: string): string[] {
  return label.toLowerCase().replace(/[_/,+&]/g, ' ').replace(/-/g, ' ').split(/\s+/).filter(Boolean)
    .map((w) => NORMALISE[w] ?? w);
}

/** True when the label names one of the unambiguous hue words (Red, Dark blue, Greyish). */
export function hasCoreHue(label: string): boolean {
  return colourWords(label).some((w) => CORE_HUES.has(w));
}

function isNeutralLabel(label: string): boolean {
  return NEUTRAL_LABELS.has(label.trim().toLowerCase());
}

/**
 * Auto-detected colours for a whole category list, or null unless every label
 * resolves (one neutral/"Other" label is allowed and gets the OTHER grey) and
 * at least one label carries a core hue word — {Sky, Forest, Rose} alone is a
 * list of names, not of colours.
 */
export function autoCategoryColors(categories: string[], theme: Theme = 'dark'): string[] | null {
  if (categories.length === 0) return null;
  if (!categories.some(hasCoreHue)) return null;
  const out: string[] = [];
  let neutrals = 0;
  let named = 0;
  for (const c of categories) {
    const hex = colorForCategoryName(c);
    if (hex && !isNeutralLabel(c)) { out.push(hex); named++; continue; }
    if (isNeutralLabel(c) && neutrals++ === 0) { out.push(OTHER[theme]); continue; }
    return null;
  }
  return named > 0 ? out : null;
}

/**
 * Colour per category code for a field. Precedence: explicit `colors` (must
 * cover every category; the rest are matched case-insensitively) > auto-detected
 * colour names > the categorical palette (slots ≥ 8 fold to grey). Pinned and
 * auto colours bypass that cap.
 */
export function categoryColors(
  categories: string[],
  explicit?: Record<string, string> | null,
  theme: Theme = 'dark',
): string[] {
  if (explicit) {
    const lower = new Map(Object.entries(explicit).map(([k, v]) => [k.toLowerCase(), v]));
    const out = categories.map((c) => explicit[c] ?? lower.get(c.toLowerCase()) ?? null);
    if (out.every((v) => v !== null)) return out as string[];
    // Partial pins are still honoured for the labels they name.
    const auto = autoCategoryColors(categories, theme);
    return out.map((v, i) => v ?? auto?.[i] ?? categoricalColor(i, theme));
  }
  return autoCategoryColors(categories, theme) ?? categories.map((_, i) => categoricalColor(i, theme));
}

/** True when a field's colours are pinned or auto-detected from colour names
 *  (i.e. not the 8-slot categorical palette), so every category has its own. */
export function hasNamedColors(
  ds: { columns: Record<string, { kind: string; categories?: string[] }>; colors?: Record<string, Record<string, string>> },
  field: string,
): boolean {
  const col = ds.columns[field];
  if (!col || col.kind !== 'category' || !col.categories) return false;
  return !!ds.colors?.[field] || autoCategoryColors(col.categories) !== null;
}

/** Colour table for a dataset field: `ds.colors[field]` pins, then auto, then palette. */
export function fieldColors(
  ds: { columns: Record<string, { kind: string; categories?: string[] }>; colors?: Record<string, Record<string, string>> },
  field: string,
  theme: Theme = 'dark',
): string[] {
  const col = ds.columns[field];
  if (!col || col.kind !== 'category' || !col.categories) return [];
  return categoryColors(col.categories, ds.colors?.[field], theme);
}
