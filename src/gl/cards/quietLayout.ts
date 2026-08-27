/**
 * Geometry of the quiet card — four lines of identity rather than seven rows of
 * statistics. A pure function of the box and of which slots have something to
 * say, so the 64 px base slot and the 1024 px hi-res tier are the same design
 * at different scales, and so vitest can check it without a canvas.
 *
 * Slots that are empty are not laid out at all: the body block shrinks and
 * re-centres. Absence is silence — a card never prints a placeholder.
 */
import { FONT_FLOOR, band, type Band, type Density, type Rect, type TextRun } from './layout';

export type { Band, Density, Rect, TextRun };
export { FONT_FLOOR };

/** Which slots the painter has content for. Omitted keys take the density's default. */
export interface QuietSlots {
  /** Header mark tile. Default: every density but `tiny`. */
  mark?: boolean;
  /** 1 line everywhere but `full`. */
  titleLines?: 1 | 2;
  /** 0 at `tiny`, 1 at `compact`, up to 2 at `full`. */
  blurbLines?: 0 | 1 | 2;
  /** At most 1 at `tiny`, else at most 2. */
  tags?: 0 | 1 | 2;
  /** `full` only. */
  metric?: boolean;
}

export interface QuietTags {
  y: number;
  h: number;
  size: number;
  padX: number;
  gap: number;
  dot: number;
  /** How many chips this layout has room for. */
  max: number;
}

export interface QuietLayout {
  w: number;
  h: number;
  density: Density;
  inset: number;
  right: number;
  /** Stroke width for the mark glyph. */
  stroke: number;
  header: Rect;
  /** Absent at `tiny`: 15 % of 64 px is 10 px and reads as a smudge. */
  tile?: Rect & { radius: number };
  topic: TextRun;
  /** One or two runs; always at least one. */
  title: TextRun[];
  /** Zero to two runs. */
  blurb: TextRun[];
  tags?: QuietTags;
  metric?: { value: TextRun; label: TextRun };
  foot: Rect;
  bands: Band[];
}

export function quietDensityFor(h: number): Density {
  return h < 96 ? 'tiny' : h < 192 ? 'compact' : 'full';
}

export const SANS = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';
export const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';

// One scratch slot set: measuring runs once per card *rasterised*, never
// per frame, and painting is never re-entrant.
const MEASURED: QuietSlots = {};

/**
 * How many lines the title and blurb actually need in this box, so the layout
 * can close up after them. A one-line title in a two-line block is a gap, and
 * a gap reads as something missing rather than as something absent.
 */
export function measureQuietSlots(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  title: string,
  blurb: string,
  tags: number,
  metric: boolean,
  mark: boolean,
): QuietSlots {
  const density = quietDensityFor(h);
  const font = (f: number) => Math.max(FONT_FLOOR, Math.round(h * f));
  const maxW = w - Math.round(h * 0.06) * 2;
  const fits = (s: string, weight: number, size: number) => {
    ctx.font = `${weight} ${size}px ${SANS}`;
    return ctx.measureText(s).width <= maxW;
  };
  MEASURED.mark = mark;
  MEASURED.titleLines = density === 'full' && !fits(title, 650, font(TITLE_SIZE)) ? 2 : 1;
  MEASURED.blurbLines = !blurb ? 0 : density === 'full' && !fits(blurb, 400, font(BLURB_SIZE)) ? 2 : 1;
  MEASURED.tags = Math.max(0, Math.min(2, tags)) as 0 | 1 | 2;
  MEASURED.metric = metric;
  return MEASURED;
}

// Fractions of `h`. The accent appears exactly twice — header and foot rule —
// and the tags carry the only other colour on the card.
// The body has 1 - HEADER - foot = 0.72h to spend; at `full` every slot is
// present and the four rows below add up to 0.70h, which is what keeps the
// metric off the foot rule at every size.
const HEADER = 0.26;
const TITLE_SIZE = 0.11;
const TITLE_LEAD = 0.14;
const BLURB_SIZE = 0.07;
const BLURB_LEAD = 0.092;
const BLURB_GAP = 0.012;
const TAGS_H = 0.09;
/** A 9 px chip needs more than 9 px of capsule; only `tiny` ever floors. */
const TAGS_H_TINY = 0.17;
const TAGS_GAP = 0.035;
const METRIC_SIZE = 0.062;
const METRIC_LEAD = 0.085;
const METRIC_GAP = 0.015;

export function quietLayout(w: number, h: number = w, slots: QuietSlots = {}): QuietLayout {
  const density = quietDensityFor(h);
  const tiny = density === 'tiny';
  const full = density === 'full';
  const r = (f: number) => Math.round(h * f);
  const font = (f: number) => Math.max(FONT_FLOOR, Math.round(h * f));

  const inset = r(0.06);
  const right = w - inset;
  const stroke = Math.max(1, h * 0.012);
  const run = (x: number, y: number, size: number, weight: number, align: 'left' | 'right', maxW: number): TextRun =>
    ({ x, y, size, weight, align, maxW, family: 'sans' });

  const hasMark = (slots.mark ?? !tiny) && !tiny;
  const titleLines = clampInt(slots.titleLines ?? (full ? 2 : 1), 1, full ? 2 : 1);
  const blurbLines = clampInt(slots.blurbLines ?? (tiny ? 0 : full ? 2 : 1), 0, tiny ? 0 : full ? 2 : 1);
  const tagCount = clampInt(slots.tags ?? (tiny ? 1 : 2), 0, tiny ? 1 : 2);
  const hasMetric = (slots.metric ?? full) && full;

  const header: Rect = { x: 0, y: 0, w, h: r(HEADER) };
  const tile = hasMark ? { x: inset, y: r(0.055), w: r(0.15), h: r(0.15), radius: r(0.03) } : undefined;
  const topicX = tile ? r(0.245) : inset;
  const topic = run(topicX, r(0.165), font(0.075), 600, 'left', right - topicX);

  const footH = Math.max(2, r(0.02));
  const foot: Rect = { x: 0, y: h - footH, w, h: footH };

  // Row heights never fall below the run's own band, so the 9 px font floor
  // cannot make two rows collide on a 64 px slot. The cursor below stays in
  // unrounded px and only the baselines are rounded, so doubling the box
  // doubles the layout and a hi-res tier never re-flows.
  const titleSize = font(TITLE_SIZE);
  const titleLead = lead(h, TITLE_LEAD, titleSize);
  const blurbSize = font(BLURB_SIZE);
  const blurbLead = lead(h, BLURB_LEAD, blurbSize);
  const metricSize = font(METRIC_SIZE);
  const metricLead = lead(h, METRIC_LEAD, metricSize);
  const tagsH = h * (tiny ? TAGS_H_TINY : TAGS_H);
  const tagsGap = h * TAGS_GAP;
  const blurbGap = h * BLURB_GAP;
  const metricGap = h * METRIC_GAP;

  const blockH = titleLines * titleLead
    + (blurbLines ? blurbGap + blurbLines * blurbLead : 0)
    + (tagCount ? tagsGap + tagsH : 0)
    + (hasMetric ? metricGap + metricLead : 0);

  // Body bounds in unrounded px: the header and foot rects snap to whole
  // pixels, but a whole-pixel bound drifts by up to 1 px per tier and compounds
  // down the block, which is exactly the re-flow the hi-res pass must not see.
  const top = h * HEADER;
  const bottom = h - Math.max(2, h * 0.02);
  let y = top + Math.max(0, (bottom - top - blockH) / 2);

  const bands: Band[] = [band('topic', topic)];

  const title: TextRun[] = [];
  for (let k = 0; k < titleLines; k++) {
    const t = run(inset, Math.round(y + titleSize), titleSize, 650, 'left', right - inset);
    title.push(t);
    bands.push(band(`title${k}`, t));
    y += titleLead;
  }

  const blurb: TextRun[] = [];
  if (blurbLines) {
    y += blurbGap;
    for (let k = 0; k < blurbLines; k++) {
      const t = run(inset, Math.round(y + blurbSize), blurbSize, 400, 'left', right - inset);
      blurb.push(t);
      bands.push(band(`blurb${k}`, t));
      y += blurbLead;
    }
  }

  let tags: QuietTags | undefined;
  if (tagCount) {
    y += tagsGap;
    tags = {
      y: Math.round(y + tagsH / 2),
      h: Math.round(tagsH),
      size: font(0.058),
      padX: r(0.045),
      gap: r(0.04),
      dot: Math.max(1.5, h * 0.02),
      max: tagCount,
    };
    bands.push({ key: 'tags', top: tags.y - tags.h / 2, bottom: tags.y + tags.h / 2 });
    y += tagsH;
  }

  let metric: { value: TextRun; label: TextRun } | undefined;
  if (hasMetric) {
    y += metricGap;
    // Value and label share one right-aligned line; the painter measures the
    // label and places the value to its left.
    const my = Math.round(y + metricSize);
    const value = run(right, my, metricSize, 500, 'right', w * 0.5);
    metric = { value, label: run(right, my, metricSize, 400, 'right', w * 0.5) };
    bands.push(band('metric', value));
    y += metricLead;
  }

  bands.push({ key: 'foot', top: foot.y, bottom: h });

  return { w, h, density, inset, right, stroke, header, tile, topic, title, blurb, tags, metric, foot, bands };
}

/** A row's advance, unrounded: the nominal fraction, but never less than the
 *  run's own band — that is what stops the 9 px font floor colliding two rows
 *  on a 64 px slot. */
function lead(h: number, frac: number, size: number): number {
  return Math.max(h * frac, size * 1.25);
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Smallest font on the card — the 9 px legibility floor is the contract. */
export function smallestQuietFont(l: QuietLayout): number {
  const runs = [l.topic, ...l.title, ...l.blurb, l.metric?.value].filter(Boolean) as TextRun[];
  const sizes = runs.map((t) => t.size);
  if (l.tags) sizes.push(l.tags.size);
  return Math.min(...sizes);
}
