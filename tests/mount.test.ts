// @vitest-environment jsdom
/**
 * Mount smoke test. jsdom has no WebGL2, so the engine (`PivotApp`) is replaced
 * by a stand-in that resolves collections through the injected resolver and
 * reports its layout engine; everything else — the chrome, the menus, the
 * handle, the option switches — is the real library.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Dataset } from '../src/data/columnar';
import { numeric, category, text } from '../src/data/columnar';

vi.mock('../src/app', () => {
  class FakeApp {
    dataset: Dataset | null = null;
    datasetName = '';
    datasetKey = '';
    colorBy = '';
    mask: Uint8Array | null = null;
    isRasterView = false;
    renderer = { transitionMs: 0, setSelected() {}, uploadStyleAt() {}, positionOf: () => [0, 0] };
    camera = { current: { zoom: 100 }, focus() {} };
    engine: { kind: 'worker' | 'inline'; dispose(): void };
    disposed = false;
    started = false;
    onDataset?: (ds: Dataset) => void;
    onLayout?: unknown; onSelect?: unknown; onHover?: unknown; onFocusCard?: unknown; onFrame?: unknown;
    private resolve: (k: string) => Promise<Dataset>;
    constructor(_c: HTMLCanvasElement, o: { engine: FakeApp['engine']; resolve: (k: string) => Promise<Dataset> }) {
      this.engine = o.engine;
      this.resolve = o.resolve;
    }
    async loadDataset(key: string) {
      const ds = await this.resolve(key);
      this.dataset = ds; this.datasetName = ds.name; this.datasetKey = key;
      this.colorBy = ds.facets.find((f) => ds.columns[f]?.kind === 'category') ?? '';
      this.onDataset?.(ds);
    }
    defaultLayout() { return { type: 'grid' as const }; }
    defaultSort() { return undefined; }
    defaultBucket() { return this.dataset?.facets[0] ?? ''; }
    defaultAxisY() { return this.dataset?.facets[1] ?? ''; }
    async setLayout() { return null; }
    async setMask(m: Uint8Array | null) { this.mask = m; }
    setColorBy(f: string) { this.colorBy = f; }
    setCardOptions() {}
    fit() {}
    zoomStep() {}
    cardScreenRect() { return null; }
    start() { this.started = true; }
    dispose() { this.disposed = true; this.engine.dispose(); }
  }
  return { PivotApp: FakeApp, TRUE_COLOUR: '__truecolour__' };
});

const { mountTessera } = await import('../src/lib');

const ds = (name: string): Dataset => ({
  name, n: 3,
  columns: { Name: text('Name', ['a', 'b', 'c']), Kind: category('Kind', ['x', 'y', 'x']), V: numeric('V', [1, 2, 3]) },
  labelColumn: 'Name', facets: ['Kind', 'V'],
});

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  root = document.getElementById('host')!;
  delete window.pivot;
  delete window.tessera;
});

const sandboxed = { storage: null, urlSync: false, tour: false, bench: false } as const;

describe('mountTessera', () => {
  it('injects the chrome into root and hides the tour and benchmark buttons when off', async () => {
    const h = mountTessera(root, { ...sandboxed, families: ['titanic'], initialDataset: 'src:a' });
    h.registerDataset('src:a', 'Table A', ds('A'));
    await h.ready;
    expect(root.querySelector('#gl')).not.toBeNull();
    expect(root.querySelector<HTMLElement>('#tourBtn')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#benchBtn')!.hidden).toBe(true);
    expect(h.currentDatasetKey()).toBe('src:a');
    expect(h.app.dataset?.name).toBe('A');
    // Families filter + the Connected group.
    const groups = [...root.querySelectorAll('#dataset optgroup')].map((g) => g.getAttribute('label'));
    expect(groups).toEqual(['Titanic', 'Connected']);
    expect(root.querySelector<HTMLSelectElement>('#dataset')!.value).toBe('src:a');
    // No globals without bench.
    expect(window.pivot).toBeUndefined();
    expect(window.tessera).toBeUndefined();
    expect(h.layoutEngine()).toBe('inline');
    h.dispose();
  });

  it('loads runtime datasets, reports view changes, and applies a view', async () => {
    const seen: Array<[unknown, string]> = [];
    const h = mountTessera(root, { ...sandboxed, families: [], initialDataset: 'src:a', onViewChange: (v, k) => seen.push([v, k]) });
    h.registerDataset('src:a', 'A', ds('A'));
    h.registerDataset('src:b', 'B', async () => ds('B'));
    await h.ready;
    await h.load('src:b');
    expect(h.currentDatasetKey()).toBe('src:b');
    await h.applyView({ layout: 'bars', bucket: 'Kind' });
    expect(h.getView()).toMatchObject({ layout: 'bars' });
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.at(-1)?.[1]).toBe('src:b');
    expect(seen.at(-1)?.[0]).toMatchObject({ layout: 'bars' });
    h.unregisterDataset('src:a');
    expect([...root.querySelectorAll('#dataset option')].map((o) => (o as HTMLOptionElement).value)).toEqual(['src:b']);
    h.dispose();
  });

  it('puts host controls in the menu slot', async () => {
    const h = mountTessera(root, { ...sandboxed, families: ['titanic'], fetchAsset: async () => new Response('x') });
    const btn = document.createElement('button');
    btn.textContent = 'Data';
    h.setMenuExtras(btn);
    expect(root.querySelector('#menuExtras')!.contains(btn)).toBe(true);
    h.setMenuExtras(null);
    expect(root.querySelector('#menuExtras')!.childElementCount).toBe(0);
    await h.ready.catch(() => {});
    h.dispose();
  });

  it('dispose removes the window keydown listener, empties root, and disposes the engine', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const h = mountTessera(root, { ...sandboxed, families: [], initialDataset: 'src:a' });
    h.registerDataset('src:a', 'A', ds('A'));
    await h.ready;
    const keyHandler = add.mock.calls.find((c) => (c[0] as string) === 'keydown')?.[1];
    expect(keyHandler).toBeDefined();
    h.dispose();
    expect(remove).toHaveBeenCalledWith('keydown', keyHandler);
    expect(root.innerHTML).toBe('');
    expect((h.app as unknown as { disposed: boolean }).disposed).toBe(true);
    add.mockRestore();
    remove.mockRestore();
  });

  it('sets the bench globals only when bench is on', async () => {
    const h = mountTessera(root, { storage: null, urlSync: false, tour: false, bench: true, families: [], initialDataset: 'src:a' });
    h.registerDataset('src:a', 'A', ds('A'));
    await h.ready;
    expect(window.pivot).toBe(h.app);
    h.dispose();
    expect(window.pivot).toBeUndefined();
  });

  it('keeps the menu on the collection being built while a load is in flight, then on the loaded one', async () => {
    const h = mountTessera(root, { ...sandboxed, families: [], initialDataset: 'src:a' });
    h.registerDataset('src:a', 'A', ds('A'));
    let finish!: (d: Dataset) => void;
    h.registerDataset('src:b', 'B', () => new Promise<Dataset>((r) => { finish = r; }));
    await h.ready;
    const sel = root.querySelector<HTMLSelectElement>('#dataset')!;
    const loading = h.load('src:b');
    // A host registering a dataset mid-load rebuilds the menu: it must not
    // snap back to the stale collection.
    h.registerDataset('src:c', 'C', ds('C'));
    expect(sel.value).toBe('src:b');
    finish(ds('B'));
    await loading;
    // Rebuilt again after the load: still the loaded collection.
    h.registerDataset('src:d', 'D', ds('D'));
    expect(h.currentDatasetKey()).toBe('src:b');
    expect(sel.value).toBe('src:b');
    h.dispose();
  });

  it('sets no globals when disposed while boot is still applying the initial view', async () => {
    const h = mountTessera(root, {
      storage: null, urlSync: false, tour: false, bench: true, families: [],
      initialDataset: 'src:a', initialView: { layout: 'bars', bucket: 'Kind' },
    });
    h.registerDataset('src:a', 'A', ds('A'));
    const app = h.app as unknown as { setLayout: () => Promise<null> };
    app.setLayout = async () => { h.dispose(); return null; };
    await h.ready.catch(() => {});
    expect(window.pivot).toBeUndefined();
    expect(window.pivotBenchReady).toBeUndefined();
    expect((h.app as unknown as { started: boolean }).started).toBe(false);
  });

  it('never touches history when urlSync is off', async () => {
    const spy = vi.spyOn(history, 'replaceState');
    const h = mountTessera(root, { ...sandboxed, families: [], initialDataset: 'src:a' });
    h.registerDataset('src:a', 'A', ds('A'));
    await h.ready;
    await h.applyView({ layout: 'bars' });
    await new Promise((r) => setTimeout(r, 200));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    h.dispose();
  });
});
