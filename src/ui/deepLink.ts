/**
 * The view, as a URL.
 *
 * A Tessera link has to survive being pasted into a chat window, read by a
 * human and hand-edited, so the grammar is plain text rather than an encoded
 * blob:
 *
 *     ?dataset=birds:900&layout=bars&color=Habitat&filter=Habitat:Forest,Marine;Diet:Fruit
 *
 * Only *view* state travels: the collection, the layout kind, the colour, the
 * sort, the bars bucket, the two axes and the facet filters. The camera and
 * the open record are deliberately not here — a link is an invitation to look
 * at a chart, not a demand to stand in one spot.
 *
 * ## Why filters carry labels, not codes
 *
 * `FacetPanel.filters` holds category *codes*, and a code is a positional
 * index into `CategoryColumn.categories`. Those indices are a property of one
 * build of one collection, not of the data: the birds pipeline emits
 * categories frequency-descending, so `Trophic level` is
 * `[Carnivore, Herbivore, Omnivore, Scavenger]` at 900 rows and
 * `[Carnivore, Herbivore, Omnivore, Unknown, Scavenger]` at 2,000 — code 3 is
 * Scavenger in one and Unknown in the other. A URL carrying `3` would keep
 * working after a rebuild while quietly meaning something else, which is worse
 * than breaking, because it still looks like it worked. So the wire format is
 * the label, resolved to a code against the collection actually loaded.
 *
 * Anything that no longer resolves is dropped in silence: a stale label leaves
 * the rest of its filter standing, a stale field leaves the rest of the view
 * standing. Nothing in here throws — a mangled link opens the collection's
 * default view, never a broken app.
 */
import type { LayoutSpec } from '../layout/layouts';

/** One facet's active categories, by label. */
export interface FilterEntry {
  field: string;
  labels: string[];
}

/** Everything a link can say about the view. Absent = "whatever the collection opens on". */
export interface ViewState {
  layout?: LayoutSpec['type'];
  color?: string;
  sort?: string;
  bucket?: string;
  x?: string;
  y?: string;
  filters?: FilterEntry[];
}

/** The query keys this module owns. Every other param belongs to someone else. */
export const VIEW_PARAMS = ['layout', 'color', 'sort', 'bucket', 'x', 'y', 'filter'] as const;

const LAYOUTS: readonly LayoutSpec['type'][] = ['grid', 'bars', 'scatter', 'xy'];

/**
 * `;` separates facets, `:` a facet from its categories, `,` one category from
 * the next — and a backslash escapes any of them, for the labels that contain
 * one (`Mass band` runs to `500 g - 2 kg`, and a comma is one bad taxonomy
 * away). The escape is rare by construction, so the common URL stays readable.
 */
const SPECIAL = /[\\,;:]/g;

function escape(s: string): string {
  return s.replace(SPECIAL, (c) => `\\${c}`);
}

/**
 * Split on any of `seps`, stepping over backslash-escaped characters but
 * leaving the escapes in place — parsing is two levels deep (facets, then
 * categories) and unescaping here would let the inner split cut a label at an
 * escaped comma. `unescape` is applied to the leaves instead.
 *
 * `limit` caps the number of pieces: the rest of the string, separators and
 * all, lands in the last one, so a label may contain a colon unescaped.
 */
function split(s: string, seps: string, limit = Infinity): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[++i]; continue; }
    if (seps.includes(c) && out.length + 1 < limit) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

/** `Habitat:Forest,Marine;Diet:Fruit`. Facets with no categories are dropped. */
export function encodeFilters(filters: readonly FilterEntry[]): string {
  return filters
    .filter((f) => f.field && f.labels.length > 0)
    .map((f) => `${escape(f.field)}:${f.labels.map(escape).join(',')}`)
    .join(';');
}

/** The inverse. Never throws; anything malformed is simply not a filter. */
export function parseFilters(s: string): FilterEntry[] {
  const out: FilterEntry[] = [];
  for (const group of split(s, ';')) {
    if (!group.trim()) continue;
    const [field, rest] = split(group, ':', 2);
    if (!field || rest === undefined) continue;
    const labels: string[] = [];
    for (const raw of split(rest, ',')) {
      const label = unescape(raw);
      if (label !== '' && !labels.includes(label)) labels.push(label);
    }
    if (labels.length) out.push({ field: unescape(field), labels });
  }
  return out;
}

/**
 * Write `view` into `params` **in place**, deleting the keys it does not set.
 *
 * Mutating rather than rebuilding is the whole point: `?hires=0`, `?glow=0`,
 * `?cards=`, `?bench=1`, `?preserve=0` and the tour's `?tour=` are read by
 * other modules, and ticking a facet must not silently take a debug flag with
 * it.
 */
export function encodeView(params: URLSearchParams, view: ViewState): void {
  // `undefined` means "not in the link"; `''` is a value in its own right —
  // `&sort=` is the user having chosen *no* sort, which is not the same as
  // having left the collection's default alone.
  const put = (key: string, value: string | undefined) => {
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  };
  put('layout', view.layout);
  put('color', view.color);
  put('sort', view.sort);
  put('bucket', view.bucket);
  put('x', view.x);
  put('y', view.y);
  put('filter', view.filters?.length ? encodeFilters(view.filters) : undefined);
}

/**
 * Read a view out of a query string. Only keys that are present and plausible
 * come back, so `Object.keys(decodeView(p)).length === 0` means "no link state
 * here, open the default view". An unknown layout kind is ignored rather than
 * guessed at; every other value is a field or label name, which only the
 * loaded collection can judge, so it is passed through for the caller to
 * resolve.
 */
export function decodeView(params: URLSearchParams): ViewState {
  const view: ViewState = {};
  const str = (key: string) => {
    const v = params.get(key);
    return v && v.trim() ? v : undefined;
  };
  const layout = str('layout');
  if (layout && (LAYOUTS as readonly string[]).includes(layout)) view.layout = layout as LayoutSpec['type'];
  const color = str('color');
  if (color) view.color = color;
  // Present-but-empty is meaningful here alone: `&sort=` is "no sort".
  if (params.has('sort')) view.sort = params.get('sort') ?? '';
  const bucket = str('bucket');
  if (bucket) view.bucket = bucket;
  const x = str('x');
  if (x) view.x = x;
  const y = str('y');
  if (y) view.y = y;
  const filter = params.get('filter');
  if (filter) {
    const filters = parseFilters(filter);
    if (filters.length) view.filters = filters;
  }
  return view;
}

/**
 * `URLSearchParams.toString()`, with the three filter delimiters left as
 * themselves. Form encoding would spell `Habitat:Forest,Marine` as
 * `Habitat%3AForest%2CMarine`, which is correct, unreadable, and impossible to
 * hand-edit. None of `,;:` is a separator in a query string, so putting them
 * back changes nothing about how the URL parses — including for the params
 * this module does not own.
 */
export function serialiseQuery(params: URLSearchParams): string {
  return params.toString().replace(/%2C/g, ',').replace(/%3B/g, ';').replace(/%3A/g, ':');
}
