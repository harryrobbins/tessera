/**
 * Geometry of the customer-record card — a pure function of the box, so the
 * same table paints the 64/128 px base slot and the 256–1024 px hi-res tiers
 * without re-flowing, and so vitest can check it without a canvas.
 *
 * Everything is a fraction of `h` (slots are square) rounded to whole px;
 * text baselines are rounded too, which keeps glyph edges on the pixel grid.
 */
export type Density = 'tiny' | 'compact' | 'full';

export interface Rect { x: number; y: number; w: number; h: number }

export interface TextRun {
  /** Anchor x; `align` says which edge sits on it. */
  x: number;
  /** Alphabetic baseline. */
  y: number;
  size: number;
  weight: number;
  align: 'left' | 'right';
  maxW: number;
  family: 'sans' | 'mono';
}

/** A vertical band one row of content occupies — for the overlap test. */
export interface Band { key: string; top: number; bottom: number }

export interface TaxCardLayout {
  w: number;
  h: number;
  density: Density;
  inset: number;
  right: number;
  /** Stroke width for glyphs, star outlines and dashed tracks. */
  stroke: number;
  header: Rect;
  tile: Rect & { radius: number };
  topic: TextRun;
  caseRef?: TextRun;
  name: TextRun;
  address: TextRun;
  chips: { y: number; h: number; size: number; padX: number; gap: number; dot: number };
  stars?: { x: number; y: number; size: number; gap: number };
  contacts?: TextRun;
  opened?: TextRun;
  bar: Rect & { radius: number };
  barLabel?: TextRun;
  foot: Rect;
  bands: Band[];
}

/** The smallest run we will draw: 9 px is the legibility floor for the atlas at 1:1. */
export const FONT_FLOOR = 9;

export function densityFor(h: number): Density {
  return h < 96 ? 'tiny' : h < 192 ? 'compact' : 'full';
}

export function layoutTaxCard(w: number, h: number = w): TaxCardLayout {
  const density = densityFor(h);
  const r = (f: number) => Math.round(h * f);
  const font = (f: number) => Math.max(FONT_FLOOR, Math.round(h * f));
  const inset = r(0.06);
  const right = w - inset;
  const stroke = Math.max(1, h * 0.012);
  const run = (x: number, y: number, size: number, weight: number, align: 'left' | 'right', maxW: number, family: 'sans' | 'mono' = 'sans'): TextRun =>
    ({ x, y, size, weight, align, maxW, family });

  const header: Rect = { x: 0, y: 0, w, h: r(0.26) };
  const tile = { x: inset, y: r(0.055), w: r(0.15), h: r(0.15), radius: r(0.03) };
  const topicX = r(0.245);
  const bands: Band[] = [];

  if (density === 'tiny') {
    // 64 px base slot of the 3,000-row default: only what survives at 9 px.
    const topic = run(topicX, r(0.165), font(0.085), 600, 'left', right - topicX);
    const name = run(inset, r(0.42), font(0.105), 650, 'left', right - inset);
    const address = run(inset, r(0.6), font(0.07), 400, 'left', right - inset);
    const chips = { y: r(0.76), h: r(0.17), size: font(0.058), padX: r(0.05), gap: r(0.04), dot: Math.max(1.5, h * 0.02) };
    const footH = Math.max(2, r(0.02));
    const bar = { x: inset, y: r(0.87), w: right - inset, h: Math.max(2, r(0.045)), radius: Math.max(1, r(0.02)) };
    const foot = { x: 0, y: h - footH, w, h: footH };
    bands.push(band('topic', topic), band('name', name), band('address', address),
      { key: 'chips', top: chips.y - chips.h / 2, bottom: chips.y + chips.h / 2 },
      { key: 'bar', top: bar.y, bottom: bar.y + bar.h }, { key: 'foot', top: foot.y, bottom: h });
    return { w, h, density, inset, right, stroke, header, tile, topic, name, address, chips, bar, foot, bands };
  }

  const full = density === 'full';
  // Two header lines beside the tile: the topic, then the case ref in mono.
  const topic = run(topicX, r(0.125), font(0.068), 600, 'left', right - topicX);
  const caseRef = run(topicX, r(0.215), font(0.058), 500, 'left', right - topicX, 'mono');
  const name = run(inset, r(0.375), font(0.105), 650, 'left', right - inset);
  const address = run(inset, r(0.48), font(0.07), 400, 'left', right - inset);
  const chips = { y: r(0.585), h: r(0.09), size: font(0.058), padX: r(0.045), gap: r(0.04), dot: Math.max(1.5, h * 0.02) };
  const stars = { x: inset, y: r(0.71), size: r(0.07), gap: r(0.015) };
  const contacts = run(right, r(0.735), font(0.065), 400, 'right', w * 0.5);
  const opened = full ? run(inset, r(0.825), font(0.065), 400, 'left', right - inset) : undefined;
  const labelW = r(0.2);
  const bar = { x: inset, y: r(0.87), w: r(0.88 - 0.2 - 0.03), h: Math.max(2, r(0.045)), radius: Math.max(1, r(0.02)) };
  const barLabel = run(right, r(0.905), font(0.06), 500, 'right', labelW);
  const footH = Math.max(2, r(0.02));
  const foot = { x: 0, y: h - footH, w, h: footH };

  bands.push(band('topic', topic), band('caseRef', caseRef), band('name', name), band('address', address),
    { key: 'chips', top: chips.y - chips.h / 2, bottom: chips.y + chips.h / 2 },
    { key: 'stars', top: Math.min(stars.y - stars.size / 2, contacts.y - contacts.size), bottom: Math.max(stars.y + stars.size / 2, contacts.y + contacts.size * 0.22) });
  if (opened) bands.push(band('opened', opened));
  bands.push({ key: 'bar', top: Math.min(bar.y, barLabel.y - barLabel.size), bottom: Math.max(bar.y + bar.h, barLabel.y + barLabel.size * 0.22) },
    { key: 'foot', top: foot.y, bottom: h });

  return { w, h, density, inset, right, stroke, header, tile, topic, caseRef, name, address, chips, stars, contacts, opened, bar, barLabel, foot, bands };
}

/** Vertical extent of a text run: ascender to descender, in the card's px. */
export function band(key: string, t: TextRun): Band {
  return { key, top: t.y - t.size, bottom: t.y + t.size * 0.22 };
}

/** Smallest font on the card. */
export function smallestFont(l: TaxCardLayout): number {
  const runs = [l.topic, l.caseRef, l.name, l.address, l.contacts, l.opened, l.barLabel].filter(Boolean) as TextRun[];
  return Math.min(l.chips.size, ...runs.map((t) => t.size));
}
