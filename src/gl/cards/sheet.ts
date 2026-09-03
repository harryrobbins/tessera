/**
 * The decoded photo sheets a `custom: 'photo'` collection paints from, and the
 * arithmetic that turns a dataset row into a rectangle inside one of them.
 *
 * ## Why a module-level registry rather than a field on `Dataset`
 *
 * Two reasons, and both are load-bearing.
 *
 * A `Dataset` is handed to the layout worker (`toLayoutData`, `src/app.ts`) and
 * has to survive structured clone; an `ImageBitmap` is transferable but not
 * clonable, and nothing about the layout wants it anyway. And a decoded sheet
 * is *renderer* state — 67 MB of RGBA per 4096² sheet, owned by whatever is
 * currently painting — not data about birds. So the loader registers the sheets
 * here by `Dataset.kind` before `buildCards` runs, and `photoPainter` looks
 * them up by the same key.
 *
 * Because `buildCards` (`src/app.ts`) is **synchronous**, every sheet must
 * already be decoded when it is called. `loadBirds` does that decoding and is
 * awaited by `resolveDataset`, so the ordering holds — but the painter still
 * treats a missing registration as normal and falls back to the quiet card
 * rather than throwing or drawing an empty box.
 */

/** Tile layout of one collection's sheets. Pure geometry — no bitmaps. */
export interface SheetGeometry {
  /** Side of one square tile, in source pixels. No padding between tiles. */
  tile: number;
  /** Tiles across a sheet. Always full, even on the last sheet. */
  cols: number;
  /** Tiles down a *full* sheet. */
  rows: number;
  /** Tiles per full sheet — `cols * rows`. */
  perSheet: number;
  /** Sheet file names, in order, relative to `public/data/`. */
  files: readonly string[];
  /** Rows the collection has. Nothing at or past this is addressable. */
  n: number;
}

/** Where row `i`'s photograph lives: which sheet, and the source rect in it. */
export interface TileRect {
  /** Index into `SheetGeometry.files` / `PhotoSheets.images`. */
  sheet: number;
  sx: number;
  sy: number;
  /** Both `sw` and `sh`: tiles are square. */
  size: number;
}

/** A registered collection: its geometry plus the decoded sheets themselves. */
export interface PhotoSheets extends SheetGeometry {
  images: readonly ImageBitmap[];
}

/**
 * Validate a sheet manifest off the wire into a `SheetGeometry`. Throws rather
 * than guessing: a manifest that disagrees with the images is a build bug, and
 * a silently wrong `cols` would paint every card the wrong bird.
 */
export function sheetGeometry(manifest: unknown, n: number): SheetGeometry {
  const m = (manifest && typeof manifest === 'object' ? manifest : {}) as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0);
  const tile = int(m.tile);
  const cols = int(m.cols);
  const rows = int(m.rows);
  const files = (Array.isArray(m.files) ? m.files : []).filter((f): f is string => typeof f === 'string');
  const perSheet = int(m.perSheet) || cols * rows;
  if (tile < 1 || cols < 1 || rows < 1) throw new Error('sheet manifest: tile, cols and rows must be positive');
  if (perSheet !== cols * rows) throw new Error(`sheet manifest: perSheet ${perSheet} is not cols*rows (${cols * rows})`);
  if (files.length === 0) throw new Error('sheet manifest: no sheet files');
  const need = Math.ceil(n / perSheet);
  if (files.length < need) throw new Error(`sheet manifest: ${files.length} sheets cannot hold ${n} rows (needs ${need})`);
  return { tile, cols, rows, perSheet, files, n };
}

/**
 * Row → sheet and source rect, per the data contract: sheet `floor(i/perSheet)`,
 * slot `k = i % perSheet`, `sx = (k % cols) * tile`, `sy = floor(k / cols) * tile`.
 *
 * The last sheet is cropped to the rows it actually fills, so its pixel height
 * can be less than `rows * tile` — which is safe because `n` bounds the rows
 * that are ever asked for. Anything out of range returns null, and the painter
 * reads that as "no photograph for this row" rather than as an error.
 */
export function tileRect(g: SheetGeometry, row: number): TileRect | null {
  if (!Number.isInteger(row) || row < 0 || row >= g.n) return null;
  const sheet = Math.floor(row / g.perSheet);
  if (sheet >= g.files.length) return null;
  const k = row - sheet * g.perSheet;
  return { sheet, sx: (k % g.cols) * g.tile, sy: Math.floor(k / g.cols) * g.tile, size: g.tile };
}

// ---------------------------------------------------------------- registry

const SHEETS = new Map<string, PhotoSheets>();

/**
 * Hand the painter a collection's decoded sheets. Any sheets previously
 * registered under the same key are closed — two 4096² sheets are 134 MB of
 * RGBA and holding the last collection's as well as this one's is how a weak
 * GPU runs out of memory. The painter guards its own draw, so a card that
 * somehow still points at a closed bitmap degrades rather than throwing.
 */
export function registerSheets(kind: string, sheets: PhotoSheets): void {
  const old = SHEETS.get(kind);
  SHEETS.set(kind, sheets);
  if (old && old !== sheets) close(old);
}

export function sheetsFor(kind: string | undefined): PhotoSheets | undefined {
  return kind ? SHEETS.get(kind) : undefined;
}

/** Drop and close one collection's sheets, or all of them. */
export function clearSheets(kind?: string): void {
  if (kind === undefined) {
    for (const s of SHEETS.values()) close(s);
    SHEETS.clear();
    return;
  }
  const s = SHEETS.get(kind);
  if (!s) return;
  SHEETS.delete(kind);
  close(s);
}

function close(s: PhotoSheets): void {
  for (const image of s.images) {
    try { image.close(); } catch { /* already closed, or a stub in a test */ }
  }
}
