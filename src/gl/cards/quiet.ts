/**
 * The quiet card: topic, title, blurb, at most two tags, one metric. Four
 * lines of identity, quiet enough to read at a glance and specific enough that
 * no two cards look alike.
 *
 * It is the design every dataset gets unless it opts into a bespoke painter,
 * and the content comes from the dataset's own declaration (`Dataset.card`)
 * compiled once by `compileCard`.
 */
import { BG, drawCover, paintFace, slotsFor, type CardFace, type CardPainter, type CardSpec } from '../atlas';
import type { Dataset } from '../../data/columnar';
import { drawGlyph } from './glyphs';
import { compileCard, type CardContent, type CardModel, type ModelOptions } from './model';
import { quietLayout } from './quietLayout';

export interface QuietOptions extends ModelOptions {
  /** The colour-by column: what the accent means, and the default `topic`. */
  colorBy?: string;
}

export function quietPainter(ds: Dataset, opts: QuietOptions = {}): CardPainter {
  // `buildCards` rebuilds the painter on every colour change, so the colour-by
  // is closed over here rather than passed per draw.
  const model = compileCard(ds, ds.card, opts.colorBy ?? '', opts);
  return (ctx, w, h, spec) => paintQuietSpec(ctx, w, h, spec, model);
}

/** Paint one spec: a record through the model, or a group cover as a label. */
export function paintQuietSpec(ctx: CanvasRenderingContext2D, w: number, h: number, spec: CardSpec, model: CardModel) {
  if (spec.cover) return drawCover(ctx, w, h, spec.cover.label, spec.cover.accent);
  // No row means no record: the base atlas is holding one slot per category.
  if (spec.row === undefined) return drawCover(ctx, w, h, spec.title, spec.accent);
  paintQuiet(ctx, w, h, model(spec));
}

// Painting is single-threaded and never re-entrant, so the face, the slot set
// and the glyph closure are scratch: one card rasterised allocates nothing.
const FACE: CardFace = { accent: '', topic: '', title: '', blurb: '', tags: [], tagCount: 0, metric: '', metricLabel: '', initials: '' };
let glyphName = '';
let glyphStroke = 1;
const MARK = (ctx: CanvasRenderingContext2D, tile: { x: number; y: number; w: number; h: number }, ink: string) =>
  drawGlyph(ctx, glyphName, tile, ink, glyphStroke);

/** The card face itself, from an already-filled `CardContent`. */
export function paintQuiet(ctx: CanvasRenderingContext2D, w: number, h: number, c: CardContent) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  FACE.accent = c.accent;
  FACE.topic = c.topic;
  FACE.title = c.title;
  FACE.blurb = c.blurb;
  FACE.tags = c.tags;
  FACE.tagCount = c.tagCount;
  FACE.metric = c.metric;
  FACE.metricLabel = c.metricLabel;
  FACE.initials = c.initials;
  glyphName = c.glyph;
  glyphStroke = Math.max(1, h * 0.012);
  // Missing values close up: a slot with nothing to say is not laid out at all.
  paintFace(ctx, quietLayout(w, h, slotsFor(ctx, w, h, FACE)), FACE, glyphName ? MARK : undefined);
}
