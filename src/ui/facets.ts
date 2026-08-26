import type { Dataset } from '../data/columnar';
import { getNumeric, histogram, shortNumber } from '../data/columnar';
import { categoricalColor } from '../core/palette';

export type FilterState = Map<string, Set<number>>;

/**
 * Facet sidebar. Counts are recomputed against the *other* facets' filters
 * (cross-filtering), so a category's number always answers "what would I get if
 * I ticked this?".
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
    this.render();
  };

  private onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    if (t.tagName !== 'BUTTON' || !t.dataset.clear) return;
    this.filters.delete(t.dataset.clear);
    this.onChange?.();
    this.render();
  };

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

  render() {
    const ds = this.ds;
    if (!ds) return;
    const parts: string[] = [];
    for (const field of ds.facets) {
      const col = ds.columns[field];
      if (!col) continue;
      if (col.kind === 'category') {
        const counts = histogram(col, this.maskExcept(field) ?? undefined);
        const max = Math.max(1, ...counts);
        const active = this.filters.get(field);
        const order = Array.from(counts, (c, i) => [c, i] as [number, number])
          .sort((a, b) => b[0] - a[0])
          .slice(0, 24);
        parts.push(`<section class="facet"><h3>${esc(field)}${
          active ? `<button data-clear="${esc(field)}">clear</button>` : ''
        }</h3>`);
        for (const [count, code] of order) {
          const checked = active?.has(code) ? 'checked' : '';
          const swatch = this.colorBy === field
            ? `<i class="swatch" style="background:${categoricalColor(code)}"></i>` : '';
          parts.push(
            `<label class="facet-row">
               <input type="checkbox" data-field="${esc(field)}" data-code="${code}" ${checked}>
               <span class="label">${swatch}${esc(col.categories[code] ?? '—')}</span>
               <span class="count">${count.toLocaleString()}</span>
               <span class="bar"><i style="width:${(count / max) * 100}%"></i></span>
             </label>`,
          );
        }
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
  }
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
