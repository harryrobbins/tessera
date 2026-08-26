/**
 * Categorical palette — validated instance from the data-viz guidelines.
 * Slot order is the CVD-safety mechanism, not cosmetic: assign in fixed order,
 * never cycle. A 9th category folds into "Other" (neutral grey).
 */
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
