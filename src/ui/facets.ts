import type { Dataset } from '../data/columnar';
import { getNumeric, histogram, shortNumber } from '../data/columnar';
import { fieldColors } from '../core/palette';
import { esc } from '../core/esc';

export type FilterState = Map<string, Set<number>>;

/** Categories listed per facet; the rest are summarised as "+N more". */
export const MAX_ROWS = 24;

/**
 * Facet sidebar. Counts are recomputed against the *other* facets' filters
 * (cross-filtering), so a category's number always answers "what would I get if
 * I ticked this?".
 *
 * The DOM is built once per dataset (`render`); a filter change only rewrites
 * counts, bars and checked state in place (`update`), so the focused checkbox
 * survives and keyboard users keep their place. Row order is therefore fixed
 * at render time (by unfiltered count) rather than re-sorted on every tick.
 */
export class FacetPanel {
  private el: HTMLElement;
  private ds: Dataset | null = null;
  filters: FilterState = new Map();
  colorBy: string | null = null;
  onChange?: () => void;

  constructor(el: HTMLElement) {
    this.el = el;
    el.addEventListener('change', this.onInput);
    el.addEventListener('click', this.onClick);
  }

  setDataset(ds: Dataset) {
    this.ds = ds;
    this.filters = new Map();
    this.render();
  }

  private onInput = (e: Event) => {
    const t = e.target as HTMLInputElement;
    if (t.type !== 'checkbox') return;
    const field = t.dataset.field!;
    const code = Number(t.dataset.code);
    let set = this.filters.get(field);
    if (!set) { set = new Set(); this.filters.set(field, set); }
    t.checked ? set.add(code) : set.delete(code);
    if (set.size === 0) this.filters.delete(field);
    this.onChange?.();
    this.update();
  };

  private onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    if (t.tagName !== 'BUTTON' || !t.dataset.clear) return;
    this.filters.delete(t.dataset.clear);
    this.onChange?.();
    this.update();
  };

  /** Tick or untick one category by its label, exactly as a click would. */
  toggle(field: string, label: string): void {
    const col = this.ds?.columns[field];
    if (!col || col.kind !== 'category') return;
    const code = col.categories.indexOf(label);
    if (code < 0) return;
    let set = this.filters.get(field);
    if (!set) { set = new Set(); this.filters.set(field, set); }
    set.has(code) ? set.delete(code) : set.add(code);
    if (set.size === 0) this.filters.delete(field);
    this.onChange?.();
    this.update();
  }

  /**
   * The active filters as category *labels*, in the collection's facet order,
   * each field's labels in category order. Codes are positional indices into
   * `CategoryColumn.categories` and differ between builds and sizes of the
   * same collection, so labels are the only form that survives leaving this
   * session — see `deepLink.ts`.
   */
  filterLabels(): { field: string; labels: string[] }[] {
    const ds = this.ds;
    if (!ds) return [];
    const out: { field: string; labels: string[] }[] = [];
    for (const field of ds.facets) {
      const codes = this.filters.get(field);
      const col = ds.columns[field];
      if (!codes || !col || col.kind !== 'category') continue;
      const labels = [...codes]
        .sort((a, b) => a - b)
        .map((c) => col.categories[c])
        .filter((l): l is string => l !== undefined);
      if (labels.length) out.push({ field, labels });
    }
    return out;
  }

  /**
   * Replace every filter, resolving labels against the loaded collection. A
   * field that is not a categorical facet here, or a label that no longer
   * exists, is dropped in silence — the rest of the filter still applies.
   *
   * Deliberately does not fire `onChange`: the caller (a deep link being
   * restored) sets the rest of the view too and re-solves the layout once.
   */
  setFilterLabels(entries: readonly { field: string; labels: readonly string[] }[]): void {
    const ds = this.ds;
    this.filters = new Map();
    if (ds) {
      for (const { field, labels } of entries) {
        const col = ds.columns[field];
        if (!col || col.kind !== 'category') continue;
        const set = new Set<number>();
        for (const label of labels) {
          const code = col.categories.indexOf(label);
          if (code >= 0) set.add(code);
        }
        if (set.size) this.filters.set(field, set);
      }
    }
    this.update();
  }

  /** Drop every filter, as if each clear link had been clicked. */
  clearAll(): void {
    if (this.filters.size === 0) return;
    this.filters = new Map();
    this.onChange?.();
    this.update();
  }

  /** Rows passing every active filter. Returns null when nothing is filtered. */
  mask(): Uint8Array | null {
    const ds = this.ds;
    if (!ds || this.filters.size === 0) return null;
    const m = new Uint8Array(ds.n).fill(1);
    for (const [field, allowed] of this.filters) {
      const col = ds.columns[field];
      if (!col || col.kind !== 'category') continue;
      const codes = col.codes;
      for (let i = 0; i < ds.n; i++) {
        if (m[i] && !allowed.has(codes[i])) m[i] = 0;
      }
    }
    return m;
  }

  /** Mask ignoring one field — the basis for that field's own cross-filtered counts. */
  private maskExcept(field: string): Uint8Array | null {
    const ds = this.ds;
    if (!ds) return null;
    const others = [...this.filters.keys()].filter((f) => f !== field);
    if (others.length === 0) return null;
    const m = new Uint8Array(ds.n).fill(1);
    for (const f of others) {
      const col = ds.columns[f];
      if (!col || col.kind !== 'category') continue;
      const allowed = this.filters.get(f)!;
      for (let i = 0; i < ds.n; i++) if (m[i] && !allowed.has(col.codes[i])) m[i] = 0;
    }
    return m;
  }

  /** Rebuild the sidebar from scratch: on dataset change, or when the colour field changes. */
  render() {
    const ds = this.ds;
    if (!ds) return;
    const parts: string[] = [];
    for (const field of ds.facets) {
      const col = ds.columns[field];
      if (!col) continue;
      if (col.kind === 'category') {
        const counts = histogram(col);
        const order = Array.from(counts, (c, i) => [c, i] as [number, number])
          .sort((a, b) => b[0] - a[0])
          .slice(0, MAX_ROWS);
        const hidden = counts.length - order.length;
        parts.push(`<section class="facet" data-field="${esc(field)}"><h3>${esc(field)}<button data-clear="${esc(field)}" hidden>clear</button></h3>`);
        const swatches = this.colorBy === field ? fieldColors(ds, field) : [];
        for (const [, code] of order) {
          const swatch = this.colorBy === field
            ? `<i class="swatch" style="background:${swatches[code]}"></i>` : '';
          parts.push(
            `<label class="facet-row">
               <input type="checkbox" data-field="${esc(field)}" data-code="${code}" data-label="${esc(col.categories[code] ?? '')}">
               <span class="label">${swatch}${esc(col.categories[code] ?? '—')}</span>
               <span class="count"></span>
               <span class="bar"><i></i></span>
             </label>`,
          );
        }
        if (hidden > 0) parts.push(`<div class="facet-more">+${hidden.toLocaleString()} more</div>`);
        parts.push('</section>');
      } else if (col.kind === 'number') {
        const n = getNumeric(ds, field);
        parts.push(
          `<section class="facet"><h3>${esc(field)}</h3>
             <div class="facet-row" style="grid-template-columns:1fr auto">
               <span class="label">range</span>
               <span class="count">${shortNumber(n.min)} – ${shortNumber(n.max)}</span>
             </div>
           </section>`,
        );
      }
    }
    this.el.innerHTML = parts.join('');
    this.update();
  }

  /** Refresh counts, bars, ticks and clear buttons without touching the DOM structure. */
  update() {
    const ds = this.ds;
    if (!ds) return;
    const sections = this.el.querySelectorAll<HTMLElement>('section.facet[data-field]');
    for (const section of sections) {
      const field = section.dataset.field!;
      const col = ds.columns[field];
      if (!col || col.kind !== 'category') continue;
      const counts = histogram(col, this.maskExcept(field) ?? undefined);
      let max = 1;
      for (let i = 0; i < counts.length; i++) if (counts[i] > max) max = counts[i];
      const active = this.filters.get(field);
      const clear = section.querySelector<HTMLButtonElement>('button[data-clear]');
      if (clear) clear.hidden = !active;
      for (const input of section.querySelectorAll<HTMLInputElement>('input[data-code]')) {
        const code = Number(input.dataset.code);
        const count = counts[code] ?? 0;
        const checked = active?.has(code) ?? false;
        if (input.checked !== checked) input.checked = checked;
        const row = input.parentElement!;
        const countEl = row.querySelector<HTMLElement>('.count')!;
        const text = count.toLocaleString();
        if (countEl.textContent !== text) countEl.textContent = text;
        row.querySelector<HTMLElement>('.bar i')!.style.width = `${(count / max) * 100}%`;
      }
    }
  }
}
