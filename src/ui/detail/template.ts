/**
 * The expanded card: a modal rendered from the dataset's own `detail`
 * declaration. It opens with the card's header — same slots, same order, same
 * colour — so the expansion reads as the card growing rather than as a
 * different view of the same row, then adds what the card had no room for.
 */
import type { DetailField, DetailSection } from '../../data/card';
import type { CategoryColumn, Dataset } from '../../data/columnar';
import { histogram, valueAt } from '../../data/columnar';
import type { DetailContext, DetailRenderer } from '../detail';

/** Reads one `SlotRef` for a row; '' when the column is absent. */
function read(ds: Dataset, ref: string | ((i: number) => string) | undefined, i: number): string {
  if (!ref) return '';
  if (typeof ref === 'function') return ref(i);
  return ds.columns[ref] ? valueAt(ds, ref, i) : '';
}

function initials(s: string): string {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Numeric facets, most-formatted first — the tiles under the header. */
export function summaryTiles(ds: Dataset, i: number, esc: (s: string) => string): string {
  const nums = ds.facets.filter((f) => ds.columns[f]?.kind === 'number').slice(0, 4);
  const tiles = nums
    .map((f) => [f, valueAt(ds, f, i)] as const)
    .filter(([, v]) => v !== '')
    .map(([f, v]) => `<div class="tile"><b>${esc(v)}</b><span>${esc(f)}</span></div>`);
  return tiles.length ? `<section class="summary">${tiles.join('')}</section>` : '';
}

function fieldRow(ds: Dataset, i: number, f: string | DetailField, esc: (s: string) => string): string {
  const spec: DetailField = typeof f === 'string' ? { value: f, label: f } : f;
  const label = spec.label ?? (typeof spec.value === 'string' ? spec.value : '');
  if (typeof spec.value === 'string' && !ds.columns[spec.value]) return '';
  const value = read(ds, spec.value, i);
  if (!value) return '';
  const cls = spec.as === 'mono' ? ' class="mono"' : spec.as === 'tag' ? ' class="tag"' : '';
  return `<dt>${esc(label)}</dt><dd${cls}>${esc(value)}</dd>`;
}

function sectionBlock(ds: Dataset, i: number, s: DetailSection, esc: (s: string) => string): string {
  const rows = s.fields.map((f) => fieldRow(ds, i, f, esc)).join('');
  return rows ? `<section><h3>${esc(s.title)}</h3><dl>${rows}</dl></section>` : '';
}

/**
 * The honest home of the aggregate card that used to be painted per category:
 * the record's own value for a facet, and how much of the *filtered* board
 * shares it. "Post — 10% of 3,000 cases" is a fact about this record; the same
 * number printed on 21,874 identical cards was not.
 */
export function contextBlock(ds: Dataset, i: number, ctx: DetailContext, fields: readonly string[]): string {
  const esc = ctx.esc;
  const rows: string[] = [];
  for (const f of fields) {
    const col = ds.columns[f];
    if (col?.kind !== 'category') continue;
    const counts = ctx.shares(f);
    if (!counts) continue;
    const code = (col as CategoryColumn).codes[i];
    const total = ctx.total;
    const n = counts[code] ?? 0;
    if (!total || code < 0) continue;
    const pct = (n / total) * 100;
    rows.push(
      `<li><span class="k">${esc(f)}</span>`
      + `<span class="v">${esc(col.categories[code] ?? '')}</span>`
      + `<span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span>`
      + `<span class="pct">${pct < 1 ? '<1' : Math.round(pct)}%</span></li>`,
    );
  }
  if (!rows.length) return '';
  return `<section class="context"><h3>In context</h3><ul>${rows.join('')}</ul>`
    + `<p class="note">Share of the ${ctx.total.toLocaleString()} ${ds.n === ctx.total ? 'records' : 'records on screen'}.</p></section>`;
}

export function actionsBlock(ds: Dataset, esc: (s: string) => string): string {
  const actions = ds.detail?.actions ?? [];
  if (!actions.length) return '';
  const links = actions
    .map((a) => `<a href="#" data-action="${esc(a.id)}"${a.primary ? ' class="primary"' : ''}>${esc(a.label)}</a>`)
    .join('');
  return `<section class="actions">${links}</section>`;
}

/** The record's title, as the card would print it. */
export function titleOf(ds: Dataset, i: number): string {
  return read(ds, ds.card?.title, i) || valueAt(ds, ds.labelColumn, i) || `Item ${i}`;
}

/**
 * The modal header: the card's own slots, in the card's own order and colour.
 * Both the template renderer and every bespoke one go through this, so an
 * expanded record can never disagree with the card it grew out of.
 */
export function modalHeader(ds: Dataset, i: number, ctx: DetailContext): string {
  const esc = ctx.esc;
  const card = ds.card ?? {};
  const title = titleOf(ds, i);
  let topic = read(ds, card.topic, i) || (ctx.colorBy ? valueAt(ds, ctx.colorBy, i) : '');
  // Same slot in both places (a collection that drops its label column at
  // scale): the eyebrow goes rather than repeat the title.
  if (topic === title) topic = '';
  const subtitle = read(ds, ds.detail?.subtitle, i) || read(ds, card.blurb, i);
  const tags = (card.tags ?? [])
    .map((tag) => read(ds, tag.value, i))
    .filter((v, k) => v && !(card.tags![k].hideWhen ?? []).includes(v))
    .slice(0, 2)
    .map((v) => `<span class="chip">${esc(v)}</span>`)
    .join('');
  return `
    <header style="background:${esc(ctx.accent)}">
      <div class="tile" aria-hidden="true">${esc(initials(title))}</div>
      <div class="who">
        ${topic ? `<p class="topic">${esc(topic)}</p>` : ''}
        <h2 id="detailTitle">${esc(title)}</h2>
        ${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}
      </div>
      ${tags ? `<div class="chips">${tags}</div>` : ''}
    </header>`;
}

/** The facets whose share of the filtered set the Context block reports. */
export function contextFields(ds: Dataset): readonly string[] {
  return ds.detail?.context ?? ds.facets.filter((f) => ds.columns[f]?.kind === 'category').slice(0, 3);
}

export const templateDetail: DetailRenderer = (ds, i, ctx) => {
  const esc = ctx.esc;
  const t = ds.detail ?? {};
  return modalHeader(ds, i, ctx) + `
    <div class="body">
      ${summaryTiles(ds, i, esc)}
      ${(t.sections ?? []).map((s) => sectionBlock(ds, i, s, esc)).join('')}
      ${contextBlock(ds, i, ctx, contextFields(ds))}
      ${actionsBlock(ds, esc)}
    </div>`;
};

/** Category counts over the current filter, memoised per (mask, field) so
 *  reopening a record under an unchanged filter costs nothing. */
export function shareCounter(ds: Dataset, mask: Uint8Array | null) {
  const cache = new Map<string, Int32Array>();
  return (field: string): Int32Array | null => {
    const col = ds.columns[field];
    if (col?.kind !== 'category') return null;
    let counts = cache.get(field);
    if (!counts) { counts = histogram(col, mask ?? undefined); cache.set(field, counts); }
    return counts;
  };
}
