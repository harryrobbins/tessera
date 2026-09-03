/**
 * The photograph card: a real picture of the record in the top band, the quiet
 * card's own text underneath.
 *
 * It adds exactly one element to the quiet design and changes nothing else —
 * the accent, the tags, the metric, the clipping and the mip bleed are all the
 * shared code path (`paintFace`, `src/gl/atlas.ts`), so a photo collection
 * cannot drift away from every other collection's typography.
 *
 * Two rules make it safe to reach for:
 *
 * - **It degrades.** No sheets registered, a row past the end of the sheets, a
 *   bitmap closed out from under it — every one of those paints the quiet card
 *   instead. `buildCards` is synchronous and must never be able to throw
 *   because an image was slow.
 * - **A spec with no `row` is not its business.** Above the atlas's 3,136-row
 *   per-item ceiling the base atlas holds one *cover* per category, and a cover
 *   is a label, not a record; it falls through to `drawCover` untouched.
 */
import {
  BG, INK_DIM, drawCover, drawRun, paintFace,
  type CardFace, type CardPainter,
} from '../atlas';
import type { Dataset } from '../../data/columnar';
import { compileCard, type CardContent } from './model';
import { paintQuiet, type QuietOptions } from './quiet';
import { measureQuietSlots, quietLayout } from './quietLayout';
import { sheetsFor, tileRect, type PhotoSheets, type TileRect } from './sheet';

/**
 * Share of the card the text occupies, measured up from the foot. The
 * photograph is **not** confined to what is left: it fills the whole card and
 * the text sits over it behind a scrim.
 *
 * That is what keeps the picture still. The painter is always handed a square
 * box (`CardAtlas.drawSlot` calls it with `slot, slot`), so a photograph
 * letterboxed into a 0.44 band is a 2.27:1 centre-crop of a square tile — the
 * bird loses its head and its feet — while the same photograph at the mosaic
 * size fills the square and keeps all of itself. Zooming in therefore *recropped*
 * every card, which read as the image jumping. Full bleed at every size means
 * the framing never changes and only the text fades in.
 */
export const TEXT_BAND = 0.56;

/** How far the scrim reaches above the text, as a share of card height. */
const SCRIM_FADE = 0.14;

/**
 * Below this the card *is* the photograph. At a 64 px base slot the quiet text
 * would be a 9 px smudge over a 28 px thumbnail and neither would read; the
 * mosaic is the whole point at that size, and the hi-res pass brings the text
 * back after the mildest zoom (`hiResWorthwhile`, `src/gl/hires.ts`).
 */
export const PHOTO_ONLY_PX = 96;

export function photoPainter(ds: Dataset, opts: QuietOptions = {}): CardPainter {
  const model = compileCard(ds, ds.card, opts.colorBy ?? '', opts);
  return (ctx, w, h, spec) => {
    if (spec.cover) return drawCover(ctx, w, h, spec.cover.label, spec.cover.accent);
    // No row means no record — the base atlas is holding one slot per category.
    if (spec.row === undefined) return drawCover(ctx, w, h, spec.title, spec.accent);
    paintPhotoSpec(ctx, w, h, spec.row, model(spec), ds);
  };
}

function paintPhotoSpec(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  row: number,
  content: CardContent,
  ds: Dataset,
): void {
  const sheets = sheetsFor(ds.kind);
  const rect = usable(sheets, ds.n) ? tileRect(sheets!, row) : null;
  const image = rect ? sheets!.images[rect.sheet] : undefined;
  if (!rect || !image) return paintQuiet(ctx, w, h, content);
  try {
    paintPhoto(ctx, w, h, content, image, rect);
  } catch {
    // A closed or broken bitmap: the card still has something to say.
    paintQuiet(ctx, w, h, content);
  }
}

/** Sheets registered for a *different* size of the same family are not this
 *  dataset's; the key is the family tag, so check the row count agrees. */
function usable(sheets: PhotoSheets | undefined, n: number): boolean {
  return !!sheets && sheets.n === n && sheets.images.length > 0;
}

// One scratch face, refilled per card. Painting is single-threaded and never
// re-entrant, so a card rasterised allocates nothing here.
const FACE: CardFace = { accent: '', topic: '', title: '', blurb: '', tags: [], tagCount: 0, metric: '', metricLabel: '', initials: '' };

function paintPhoto(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  c: CardContent,
  image: ImageBitmap,
  rect: TileRect,
): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  // Full bleed, at every size. See TEXT_BAND for why this is not a band.
  const ruleH = Math.max(2, Math.round(h * 0.02));
  drawTile(ctx, image, rect, w, h);

  if (h < PHOTO_ONLY_PX) {
    // The mosaic card: the picture, and the accent so the colour-by still reads.
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = c.accent;
    ctx.fillRect(0, h - ruleH, w, ruleH);
    ctx.globalAlpha = 1;
    return;
  }

  const bodyH = Math.round(h * TEXT_BAND);
  const top = h - bodyH;
  // A scrim, not a panel: it starts fully transparent above the text so the
  // photograph is never cut by a hard edge, and reaches near-opaque at the foot
  // where the metric and the tags need a ground to read against.
  const fadeTop = Math.max(0, top - Math.round(h * SCRIM_FADE));
  const scrim = ctx.createLinearGradient(0, fadeTop, 0, h);
  // The middle stop is pinned to where the text begins rather than to a fixed
  // fraction, so the first line always lands on a scrim dark enough to read
  // against — a white gull and a black grouse have to work equally well.
  const textAt = (top - fadeTop) / Math.max(1, h - fadeTop);
  scrim.addColorStop(0, 'rgba(28, 28, 27, 0)');
  scrim.addColorStop(textAt, 'rgba(28, 28, 27, 0.78)');
  scrim.addColorStop(1, 'rgba(28, 28, 27, 0.94)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, fadeTop, w, h - fadeTop);

  ctx.save();
  ctx.translate(0, top);
  FACE.accent = c.accent;
  FACE.topic = '';
  FACE.title = c.title;
  FACE.blurb = c.blurb;
  FACE.tags = c.tags;
  FACE.tagCount = c.tagCount;
  FACE.metric = c.metric;
  FACE.metricLabel = c.metricLabel;
  FACE.initials = c.initials;
  // No mark tile: the photograph is the mark, and a pair of initials beside it
  // would say the same thing twice.
  const L = quietLayout(w, bodyH, measureQuietSlots(ctx, w, bodyH, c.title, c.blurb, c.tagCount, !!c.metric, false));
  // The header band is suppressed — the photograph is the top of the card —
  // so `paintFace` paints a zero-height gradient and nothing else changes.
  L.header.h = 0;
  paintFace(ctx, L, FACE);
  // The eyebrow is drawn here rather than through the face, because `paintFace`
  // inks it for the accent band that is no longer there.
  if (c.topic) drawRun(ctx, L.topic, c.topic, INK_DIM);
  ctx.restore();
}

/**
 * Blit one square tile into a `w` x `photoH` band, centre-cropping the source
 * rather than squashing it — a stretched bird is worse than a cropped one.
 */
function drawTile(ctx: CanvasRenderingContext2D, image: ImageBitmap, rect: TileRect, w: number, photoH: number): void {
  const aspect = w / photoH;
  const sw = aspect >= 1 ? rect.size : rect.size * aspect;
  const sh = aspect >= 1 ? rect.size / aspect : rect.size;
  ctx.drawImage(image, rect.sx + (rect.size - sw) / 2, rect.sy + (rect.size - sh) / 2, sw, sh, 0, 0, w, photoH);
}
