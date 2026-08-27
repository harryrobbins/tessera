/**
 * Turns a dataset's `CardTemplate` into a reader.
 *
 * The declarative form is compiled **once** per (dataset, colour-by, template)
 * into a closure that refills a **single reusable object**. Nothing allocates
 * per card at draw time except the strings `NumericColumn.format` unavoidably
 * produces — at the worst case that is a few thousand short-lived strings on
 * one settle, not per frame.
 */
import type { CardTemplate, MetricSpec, SlotRef, TagSpec, TagTone } from '../../data/card';
import { MAX_TAGS } from '../../data/card';
import { shortNumber, type CategoryColumn, type Dataset, type NumericColumn } from '../../data/columnar';
import { initials, type CardSpec } from '../atlas';

export interface Chip { text: string; tone: TagTone; shape: 'pill' | 'dot' }

/** Mutable and shared: one instance per compiled model, refilled per card. */
export interface CardContent {
  accent: string;
  topic: string;
  /** '' = draw `initials` instead. */
  glyph: string;
  initials: string;
  title: string;
  blurb: string;
  /** Always length 2; only the first `tagCount` entries are drawn. */
  tags: [Chip, Chip];
  tagCount: number;
  metric: string;
  metricLabel: string;
}

export type CardModel = (spec: CardSpec) => CardContent;

/** Reads one slot's display string for a row. */
type Reader = (i: number) => string;

/** What the Card settings popover can override on top of the declaration. */
export interface ModelOptions {
  /** false = compile no tags at all. */
  tags?: boolean;
  /** Column name to use as the title instead of the template's choice. */
  title?: string;
}

export function compileCard(ds: Dataset, template: CardTemplate | undefined, colorBy: string, opts: ModelOptions = {}): CardModel {
  const t = template ?? {};

  // ---- title: the declared slot, else the label column. Both may be missing
  // at scale (tax-cases:100000 drops Customer, Case and Postcode), so the
  // reader chain ends at `#<row>` rather than at an empty card.
  const title = reader(ds, opts.title || t.title) ?? reader(ds, ds.labelColumn);

  // ---- topic: the declared slot, else the colour-by value — it is what the
  // accent means, and the accent is the loudest thing on the card.
  const topic = reader(ds, t.topic) ?? reader(ds, colorBy);

  const blurb = reader(ds, t.blurb);

  // ---- mark: a glyph named by a column, or the title's initials.
  const glyph = typeof t.mark === 'object' ? reader(ds, t.mark.glyph) : null;

  const tags = opts.tags === false ? [] : compileTags(ds, t.tags ?? defaultTags(ds, t, colorBy));
  const metric = compileMetric(ds, t.metric ?? defaultMetric(ds));

  // One object, refilled. The two chips are refilled too.
  const content: CardContent = {
    accent: '',
    topic: '',
    glyph: '',
    initials: '',
    title: '',
    blurb: '',
    tags: [{ text: '', tone: 'neutral', shape: 'dot' }, { text: '', tone: 'neutral', shape: 'dot' }],
    tagCount: 0,
    metric: '',
    metricLabel: '',
  };

  return (spec: CardSpec): CardContent => {
    const i = spec.row ?? 0;
    content.accent = spec.accent;
    content.title = (title ? title(i) : '') || spec.title || `#${i}`;
    content.topic = (topic ? topic(i) : '') || spec.topic || spec.subtitle || '';
    // A collection that drops columns at scale can land the same value in both
    // slots — `tax-cases:100000` has no `Customer`, so the title falls back to
    // `Topic`, which is also the topic. Printing it twice says nothing twice.
    if (content.topic === content.title) content.topic = '';
    content.blurb = blurb ? blurb(i) : '';
    content.glyph = glyph ? glyph(i) : '';
    content.initials = initials(content.title);

    let k = 0;
    for (let s = 0; s < tags.length && k < MAX_TAGS; s++) {
      const text = tags[s].read(i);
      if (!text || tags[s].hidden(i)) continue;
      const chip = content.tags[k];
      chip.text = text;
      chip.tone = tags[s].tone(i);
      chip.shape = tags[s].shape;
      k++;
    }
    content.tagCount = k;

    content.metric = metric ? metric.read(i) : '';
    content.metricLabel = metric ? metric.label(i) : '';
    return content;
  };
}

/**
 * One row's card text, copied out of the shared `CardContent`. The cursor chip
 * and the live region use it, so what a viewer is told about a card is exactly
 * what the card would paint if it were big enough to read.
 */
export function cardTextOf(model: CardModel, i: number): { title: string; topic: string; tags: string[] } {
  const c = model({ title: '', accent: '', row: i });
  return { title: c.title, topic: c.topic, tags: c.tags.slice(0, c.tagCount).map((t) => t.text) };
}

// ------------------------------------------------------------------ readers

/** A column name or an accessor becomes a `(i) => string`; null when the
 *  column is absent, so the caller can fall back rather than print nothing. */
function reader(ds: Dataset, ref: SlotRef | undefined): Reader | null {
  if (!ref) return null;
  if (typeof ref === 'function') return ref;
  const col = ds.columns[ref];
  if (!col) return null;
  if (col.kind === 'category') {
    // Interned: `categories[codes[i]]` allocates nothing.
    const { categories, codes } = col;
    return (i) => categories[codes[i]] ?? '';
  }
  if (col.kind === 'text') return col.at;
  const { values, format } = col;
  return (i) => {
    const v = values[i];
    if (!Number.isFinite(v)) return '';
    return format ? format(v) : shortNumber(v);
  };
}

// --------------------------------------------------------------------- tags

interface CompiledTag {
  read: Reader;
  tone: (i: number) => TagTone;
  hidden: (i: number) => boolean;
  shape: 'pill' | 'dot';
}

function compileTags(ds: Dataset, specs: readonly TagSpec[]): CompiledTag[] {
  const out: CompiledTag[] = [];
  for (const spec of specs) {
    const read = reader(ds, spec.value);
    if (!read) continue;
    const col = typeof spec.value === 'string' ? ds.columns[spec.value] : undefined;
    const cat = col?.kind === 'category' ? col : undefined;
    out.push({
      read,
      tone: toneFn(spec.tone, cat, read),
      hidden: hiddenFn(spec.hideWhen, cat, read),
      shape: spec.shape ?? 'dot',
    });
  }
  return out;
}

/** A tone map over a category column is flattened to an array indexed by code,
 *  so resolving a tone is an array index rather than a hash lookup. */
function toneFn(tone: TagSpec['tone'], cat: CategoryColumn | undefined, read: Reader): (i: number) => TagTone {
  if (!tone) return () => 'neutral';
  if (typeof tone === 'string') return () => tone;
  if (cat) {
    const byCode: TagTone[] = cat.categories.map((c) => tone[c] ?? 'neutral');
    const { codes } = cat;
    return (i) => byCode[codes[i]] ?? 'neutral';
  }
  return (i) => tone[read(i)] ?? 'neutral';
}

/** `hideWhen` over a category column becomes a mask indexed by code. */
function hiddenFn(hideWhen: readonly string[] | undefined, cat: CategoryColumn | undefined, read: Reader): (i: number) => boolean {
  if (!hideWhen || hideWhen.length === 0) return () => false;
  if (cat) {
    const mask = new Uint8Array(cat.categories.length);
    cat.categories.forEach((c, k) => { if (hideWhen.includes(c)) mask[k] = 1; });
    const { codes } = cat;
    return (i) => mask[codes[i]] === 1;
  }
  return (i) => hideWhen.includes(read(i));
}

// ------------------------------------------------------------------- metric

function compileMetric(ds: Dataset, spec: MetricSpec | undefined): { read: Reader; label: Reader } | null {
  if (!spec) return null;
  const read = reader(ds, spec.value);
  if (!read) return null;
  const fixed = typeof spec.label === 'string' ? spec.label : '';
  const label = typeof spec.label === 'function' ? spec.label : () => fixed;
  return { read, label };
}

// ----------------------------------------------------------- §3.3 defaults

/** The first two categorical facets that are neither the label nor the accent
 *  — the two things about this record the board is not already telling you. */
function defaultTags(ds: Dataset, t: CardTemplate, colorBy: string): TagSpec[] {
  const titleCol = typeof t.title === 'string' ? t.title : ds.labelColumn;
  const out: TagSpec[] = [];
  for (const f of ds.facets) {
    if (out.length >= MAX_TAGS) break;
    if (f === titleCol || f === colorBy || f === ds.labelColumn) continue;
    if (ds.columns[f]?.kind !== 'category') continue;
    out.push({ value: f, shape: 'dot' });
  }
  return out;
}

/**
 * The first numeric facet, labelled with its own column name — preferring one
 * whose author gave it a formatter, because that is the signal that the column
 * was meant to be read by a human. Without it, products' first numeric facet
 * is `Year` and the card's one number reads "2.0k".
 */
function defaultMetric(ds: Dataset): MetricSpec | undefined {
  const numeric = (name: string) => ds.columns[name]?.kind === 'number';
  const f = ds.facets.find((name) => numeric(name) && (ds.columns[name] as NumericColumn).format)
    ?? ds.facets.find(numeric);
  return f ? { value: f, label: f } : undefined;
}
