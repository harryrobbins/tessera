/**
 * The dense customer-record card for the tax customer-service collection —
 * ten painted elements for one record. It earns its keep on a collection small
 * enough to read one card, which is why `tax-cases` opts into it below 3,000
 * rows (`Dataset.card.custom`) and gets the quiet card above that.
 *
 * One painter serves the base slot (64/128 px) and every hi-res tier
 * (256–1024 px) because all geometry comes from `layoutTaxCard`.
 */
import {
  BG, INK, INK_DIM, INK_MUTE, CHIP_HIGH, CHIP_STANDARD, CHIP_LOW, STATUS_OPEN, STATUS_RESOLVED, STAR,
  SANS, MONO, clip, initials, mixHex, rgba, rrect, inkOn, drawCover, type CardPainter, type CardSpec,
} from '../atlas';
import type { Dataset, CategoryColumn, NumericColumn, TextColumn } from '../../data/columnar';
import { drawGlyph } from './glyphs';
import { layoutTaxCard, type TaxCardLayout, type TextRun } from './layout';

// `inkOn` used to live here; painters and tests still reach for it by this path.
export { inkOn };

/** Resolution-hours bar: log scale from 6 minutes to ten days. */
const HOURS_LO = Math.log10(0.1);
const HOURS_HI = Math.log10(240);

type Chip = { text: string; color: string; kind: 'pill' | 'dot' };

/** Everything the painter needs, in display form; built per row or per category. */
interface Content {
  accent: string;
  /** Channel glyph on the tile, or initials when there is no channel. */
  glyph: string | null;
  tileText: string;
  topic: string;
  caseRef: string;
  name: string;
  address: string;
  addressFull: string;
  chips: Chip[];
  chipsFull: Chip[];
  /** 0..5 (fractions allowed), or null for "not surveyed". */
  stars: number | null;
  contacts: string;
  /** Candidate lines, longest first; the first that fits is drawn. */
  opened: string[];
  /** Hours for the bar, or null when the case is still open. */
  hours: number | null;
}

export function taxCasePainter(ds: Dataset): CardPainter {
  const c = ds.columns;
  const cat = (n: string) => (c[n]?.kind === 'category' ? (c[n] as CategoryColumn) : null);
  const num = (n: string) => (c[n]?.kind === 'number' ? (c[n] as NumericColumn) : null);
  const txt = (n: string) => (c[n]?.kind === 'text' ? (c[n] as TextColumn) : null);
  const customer = txt('Customer');
  const caseRef = txt('Case');
  const postcode = txt('Postcode');
  const town = cat('Town');
  const topic = cat('Topic');
  const team = cat('Team');
  const channel = cat('Channel');
  const priority = cat('Priority');
  const status = cat('Status');
  const escalated = cat('Escalated');
  const ageBand = cat('Age band');
  const contacts = num('Contacts');
  const satisfaction = num('Satisfaction');
  const hours = num('Resolution hours');
  const opened = num('Opened');
  const label = (col: CategoryColumn | null, i: number) => (col ? col.categories[col.codes[i]] ?? '' : '');
  const fmt = (col: NumericColumn | null, v: number) => (col?.format ? col.format(v) : String(v));

  function recordContent(spec: CardSpec, i: number): Content {
    const pr = label(priority, i);
    const st = label(status, i);
    const esc = label(escalated, i) === 'Yes';
    const k = contacts ? contacts.values[i] : NaN;
    const sat = satisfaction ? satisfaction.values[i] : NaN;
    const hrs = hours ? hours.values[i] : NaN;
    const isOpen = st === 'Open' || !Number.isFinite(hrs);
    const chips: Chip[] = [];
    if (pr) chips.push({ text: pr, color: priorityColor(pr), kind: 'pill' });
    if (st) chips.push({ text: st, color: isOpen ? STATUS_OPEN : STATUS_RESOLVED, kind: 'dot' });
    const chipsFull = esc ? [...chips, { text: 'Escalated', color: CHIP_HIGH, kind: 'dot' as const }] : chips;
    const pc = postcode?.at(i) ?? '';
    const tn = label(town, i);
    const age = label(ageBand, i);
    const address = [pc, tn].filter(Boolean).join(' · ');
    const openedText = opened && Number.isFinite(opened.values[i]) ? `Opened ${fmt(opened, opened.values[i])}` : '';
    const tm = label(team, i);
    return {
      accent: spec.accent,
      glyph: channel ? label(channel, i) : null,
      tileText: initials(spec.title),
      topic: label(topic, i) || spec.subtitle || '',
      caseRef: caseRef?.at(i) ?? '',
      name: customer?.at(i) || spec.title,
      address,
      addressFull: [address, age && `${age}`].filter(Boolean).join(' · '),
      chips,
      chipsFull,
      stars: Number.isFinite(sat) ? sat : null,
      contacts: Number.isFinite(k) ? `${k} contact${k === 1 ? '' : 's'}` : '',
      opened: [[openedText, tm].filter(Boolean).join(' · '), openedText],
      hours: isOpen ? null : hrs,
    };
  }

  return (ctx, w, h, spec) => {
    // Every card is a record now. A spec with no row is a *group cover* — the
    // base atlas's label for a category — and covers are not this design's job.
    if (spec.row === undefined || spec.cover) {
      const c = spec.cover;
      return drawCover(ctx, w, h, c?.label ?? spec.title, c?.accent ?? spec.accent);
    }
    paint(ctx, layoutTaxCard(w, h), recordContent(spec, spec.row));
  };
}

// ------------------------------------------------------------------ painting

function paint(ctx: CanvasRenderingContext2D, L: TaxCardLayout, c: Content) {
  const { w, h, density } = L;
  const full = density === 'full';
  const tiny = density === 'tiny';
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  // Header: accent gradient, glyph tile, topic, case ref.
  const grad = ctx.createLinearGradient(0, 0, w, L.header.h);
  grad.addColorStop(0, c.accent);
  grad.addColorStop(1, mixHex(c.accent, BG, 0.35));
  ctx.fillStyle = grad;
  ctx.fillRect(L.header.x, L.header.y, L.header.w, L.header.h);
  const headInk = inkOn(c.accent);

  ctx.fillStyle = headInk === INK ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.45)';
  rrect(ctx, L.tile.x, L.tile.y, L.tile.w, L.tile.h, L.tile.radius);
  ctx.fill();
  if (c.glyph && drawGlyph(ctx, c.glyph, L.tile, headInk, L.stroke)) {
    // drawn
  } else {
    ctx.fillStyle = headInk;
    ctx.font = `600 ${Math.max(FONT_MIN, Math.round(L.tile.h * 0.5))}px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(c.tileText, Math.round(L.tile.x + L.tile.w / 2), Math.round(L.tile.y + L.tile.h / 2));
  }
  text(ctx, L.topic, c.topic, headInk);
  if (L.caseRef && c.caseRef) text(ctx, L.caseRef, c.caseRef, headInk, 0.85);

  // Body.
  text(ctx, L.name, c.name, INK);
  text(ctx, L.address, full ? c.addressFull : c.address, INK_DIM);
  drawChips(ctx, L, full ? c.chipsFull : c.chips, tiny ? 1 : Infinity);

  if (L.stars) {
    if (c.stars === null) {
      ctx.fillStyle = INK_MUTE;
      ctx.font = `400 ${L.chips.size}px ${SANS}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('not surveyed', L.stars.x, L.stars.y);
    } else {
      drawStars(ctx, L.stars.x, L.stars.y, L.stars.size, L.stars.gap, c.stars);
    }
  }
  if (L.contacts && c.contacts) text(ctx, L.contacts, c.contacts, INK_DIM);
  if (L.opened) textFit(ctx, L.opened, c.opened, INK_DIM);

  drawHoursBar(ctx, L, c.hours, c.accent);

  // Foot rule.
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = c.accent;
  ctx.fillRect(L.foot.x, L.foot.y, L.foot.w, L.foot.h);
  ctx.globalAlpha = 1;
}

const FONT_MIN = 8;

function text(ctx: CanvasRenderingContext2D, run: TextRun, s: string, color: string, alpha = 1) {
  if (!s) return;
  ctx.font = `${run.weight} ${run.size}px ${run.family === 'mono' ? MONO : SANS}`;
  ctx.textAlign = run.align;
  ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillText(clip(ctx, s, run.maxW), Math.round(run.x), Math.round(run.y));
  ctx.globalAlpha = 1;
}

/** Draw the first candidate that fits without clipping (else clip the last). */
function textFit(ctx: CanvasRenderingContext2D, run: TextRun, candidates: string[], color: string) {
  ctx.font = `${run.weight} ${run.size}px ${run.family === 'mono' ? MONO : SANS}`;
  const fits = candidates.find((s) => s && ctx.measureText(s).width <= run.maxW);
  text(ctx, run, fits ?? candidates[candidates.length - 1] ?? '', color);
}

function drawChips(ctx: CanvasRenderingContext2D, L: TaxCardLayout, chips: Chip[], max: number) {
  const { y, h, size, padX, gap, dot } = L.chips;
  ctx.font = `600 ${size}px ${SANS}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let x = L.inset;
  let n = 0;
  for (const chip of chips) {
    if (n++ >= max) break;
    const tw = ctx.measureText(chip.text).width;
    if (chip.kind === 'pill') {
      const pw = Math.round(tw + padX * 2);
      if (x + pw > L.right) break;
      ctx.fillStyle = rgba(chip.color, 0.2);
      rrect(ctx, x, y - h / 2, pw, h, h / 2);
      ctx.fill();
      ctx.fillStyle = chip.color;
      ctx.fillText(chip.text, Math.round(x + padX), Math.round(y));
      x += pw + gap;
    } else {
      const dw = dot * 2 + gap * 0.6;
      if (x + dw + tw > L.right) break;
      ctx.fillStyle = chip.color;
      ctx.beginPath();
      ctx.arc(x + dot, y, dot, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = INK_DIM;
      ctx.font = `500 ${size}px ${SANS}`;
      ctx.fillText(chip.text, Math.round(x + dw), Math.round(y));
      ctx.font = `600 ${size}px ${SANS}`;
      x += dw + tw + gap;
    }
  }
}

function drawStars(ctx: CanvasRenderingContext2D, x0: number, cy: number, size: number, gap: number, value: number) {
  const R = size / 2;
  for (let i = 0; i < 5; i++) {
    const cx = x0 + R + i * (size + gap);
    const fill = Math.max(0, Math.min(1, value - i));
    starPath(ctx, cx, cy, R);
    ctx.fillStyle = INK_MUTE;
    ctx.fill();
    if (fill > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx - R, cy - R, size * fill, size);
      ctx.clip();
      starPath(ctx, cx, cy, R);
      ctx.fillStyle = STAR;
      ctx.fill();
      ctx.restore();
    }
  }
}

function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number) {
  const r = R * 0.45;
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rad = k % 2 === 0 ? R : r;
    const px = cx + Math.cos(a) * rad;
    const py = cy + Math.sin(a) * rad;
    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawHoursBar(ctx: CanvasRenderingContext2D, L: TaxCardLayout, hours: number | null, accent: string) {
  const b = L.bar;
  if (hours === null) {
    // Still open: a dashed track and no fill.
    ctx.strokeStyle = rgba(STATUS_OPEN, 0.7);
    ctx.lineWidth = Math.max(1, L.stroke);
    ctx.setLineDash([L.stroke * 2.5, L.stroke * 2.5]);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y + b.h / 2);
    ctx.lineTo(b.x + b.w, b.y + b.h / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (L.barLabel) text(ctx, L.barLabel, 'open', STATUS_OPEN);
    return;
  }
  ctx.fillStyle = 'rgba(245,245,242,0.10)';
  rrect(ctx, b.x, b.y, b.w, b.h, b.radius);
  ctx.fill();
  const t = Math.max(0, Math.min(1, (Math.log10(Math.max(0.1, hours)) - HOURS_LO) / (HOURS_HI - HOURS_LO)));
  const fw = Math.max(b.h, Math.round(b.w * t));
  ctx.fillStyle = accent;
  rrect(ctx, b.x, b.y, fw, b.h, b.radius);
  ctx.fill();
  if (L.barLabel) text(ctx, L.barLabel, fmtHours(hours), INK);
}

export function fmtHours(v: number): string {
  if (v >= 48) return `${Math.round(v / 24)} d`;
  return v < 10 ? `${v.toFixed(1)} h` : `${Math.round(v)} h`;
}

// ------------------------------------------------------------------- helpers

export function priorityColor(p: string): string {
  return p === 'High' ? CHIP_HIGH : p === 'Low' ? CHIP_LOW : CHIP_STANDARD;
}
