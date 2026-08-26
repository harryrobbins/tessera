/**
 * Zoom ladders.
 *
 * A raster — one card per image pixel — is only free of moire when a cell covers
 * a whole number of device pixels. At 1.42 each cell covers either one device
 * pixel or two, and that alternation is what reads as a grid ruled over the
 * picture. The artefact-free levels are therefore exactly … 1/3, 1/2, 1, 2, 3 …
 * and stepping between them is the only zoom control that stays clean.
 */

/** Nearest rung, chosen in log space so 1.42 rounds to 2 rather than 1. */
export function wholePixelZoom(z: number): number {
  if (z >= 1) {
    const lo = Math.max(1, Math.floor(z));
    return Math.log(z / lo) <= Math.log((lo + 1) / z) ? lo : lo + 1;
  }
  const inv = 1 / z;
  const lo = Math.max(1, Math.floor(inv));
  return 1 / (Math.log(inv / lo) <= Math.log((lo + 1) / inv) ? lo : lo + 1);
}

/** The next rung strictly above (dir 1) or below (dir -1) the current scale. */
export function stepWholePixelZoom(z: number, dir: 1 | -1): number {
  const eps = 1e-6;
  if (dir > 0) {
    if (z < 1 - eps) {
      const k = Math.ceil(1 / z - eps);
      return k <= 1 ? 1 : 1 / (k - 1);
    }
    return Math.floor(z + eps) + 1;
  }
  if (z > 1 + eps) return Math.max(1, Math.ceil(z - eps) - 1);
  return 1 / (Math.floor(1 / z + eps) + 1);
}

/** Card collections have no such constraint, so they step geometrically. */
export const ZOOM_FACTOR = 1.6;

export function stepFreeZoom(z: number, dir: 1 | -1): number {
  return dir > 0 ? z * ZOOM_FACTOR : z / ZOOM_FACTOR;
}
