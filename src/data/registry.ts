import type { Dataset } from './columnar';
import { generateProducts, PRODUCT_SIZES } from './products';
import { generateTaxCases, TAX_CASE_SIZES, TAX_CASE_SEED } from './taxCases';
import { generateTaxReturns, TAX_RETURN_SIZES } from './taxReturns';
import { generatePayments, PAYMENT_SIZES } from './payments';
import { generateInvoices, INVOICE_SIZES } from './invoices';
import { loadTitanic, TITANIC_SIZES } from './titanic';
import { loadBirds, BIRD_SIZES } from './birds';
import { loadPixels, PIXEL_IMAGES, PIXEL_TITLES, type PixelImage } from './pixels';

/**
 * Dataset registry. A key is `prefix` or `prefix:size` (pixel collections are
 * `pixels:<image>:<size>`); the UI menu, the URL deep link (`?dataset=`) and
 * the app's loader all go through here. Unknown keys fall back to the
 * default collection (tax-cases:3000, the onboarding dataset).
 */
export interface DatasetFamily {
  prefix: string;
  label: string;
  sizes: readonly number[];
  /** Absent for families whose keys carry more than a size (pixels: `resolveDataset` routes them itself). */
  load?: (size?: number, ctx?: LoadContext) => Dataset | Promise<Dataset>;
  /** Plural noun for the "Building …" toast; default "cards". */
  buildingNoun?: string;
  /** Override the menu entries (families whose keys carry more than a size). */
  menu?: () => { key: string; label: string }[];
  /** Override the toast description for a key. */
  describe?: (key: string) => string;
}

export interface MenuEntry { key: string; label: string; group?: string }

/** How a loader reaches its static assets. The default is `fetch`; an embedder
 *  whose sandbox blocks network access (`connect-src 'none'`) hands in its own. */
export type FetchAsset = (path: string) => Promise<Response>;

/** What `resolveDataset` passes through to a family's loader. */
export interface LoadContext { fetchAsset?: FetchAsset }

const PIXEL_SIZES = [250_000, 1_000_000] as const;

/** faker's en_GB locale, loaded on demand so it stays out of the main bundle. */
async function fakerGB() {
  return (await import('@faker-js/faker/locale/en_GB')).faker;
}

export const FAMILIES: DatasetFamily[] = [
  {
    prefix: 'tax-cases',
    label: 'Tax customer service',
    sizes: TAX_CASE_SIZES,
    load: async (size = 3_000) => generateTaxCases(size, TAX_CASE_SEED, await fakerGB()),
    buildingNoun: 'customer-service cases',
  },
  {
    prefix: 'tax-returns',
    label: 'Tax returns',
    sizes: TAX_RETURN_SIZES,
    load: (size = 10_000) => generateTaxReturns(size),
    buildingNoun: 'tax returns',
  },
  {
    prefix: 'payments',
    label: 'Card payments',
    sizes: PAYMENT_SIZES,
    load: (size = 10_000) => generatePayments(size),
    buildingNoun: 'card payments',
  },
  {
    prefix: 'invoices',
    label: 'Supplier invoices',
    sizes: INVOICE_SIZES,
    // faker at every size (100k too): the 36 supplier names are a category the
    // layouts group by, so they must be real names, unlike tax-cases where the
    // per-row customer name is dropped above 50k anyway.
    load: async (size = 10_000) => generateInvoices(size, 41, await fakerGB()),
    buildingNoun: 'invoices',
  },
  {
    prefix: 'titanic',
    label: 'Titanic',
    sizes: TITANIC_SIZES,
    load: (_size, ctx) => loadTitanic(ctx?.fetchAsset),
    buildingNoun: 'passengers',
    // One fixed collection, so its key carries no size — `?dataset=titanic`
    // is the obvious link, and it should match the menu rather than fall
    // through to the off-menu fallback.
    menu: () => [{ key: 'titanic', label: `Titanic — ${TITANIC_SIZES[0].toLocaleString()} passengers` }],
    describe: () => `the ${TITANIC_SIZES[0].toLocaleString()} passengers of the Titanic`,
  },
  {
    prefix: 'birds',
    label: 'Birds of the world',
    // Prebaked, like titanic: the JSON and the photo sheets are committed, and
    // `load` is async because it fetches and decodes them before `buildCards`.
    sizes: BIRD_SIZES,
    load: (size = BIRD_SIZES[0]) => loadBirds(size),
    buildingNoun: 'birds',
  },
  {
    prefix: 'products',
    label: 'Products',
    sizes: [...PRODUCT_SIZES, 2_000_000],
    load: (size = 1000) => generateProducts(size),
    buildingNoun: 'product cards',
  },
  {
    prefix: 'pixels',
    label: 'Pixels',
    sizes: PIXEL_SIZES,
    menu: () => PIXEL_IMAGES.flatMap((img) => PIXEL_SIZES.map((n) => ({
      key: `pixels:${img}:${n}`,
      label: `${PIXEL_TITLES[img]} — ${(n / 1000).toFixed(0)}k pixels`,
    }))),
    describe: (key) => {
      const { image, size } = parseKey(key);
      return `${size ? (size / 1000).toFixed(0) + 'k pixels of ' : ''}${(image && image in PIXEL_TITLES ? PIXEL_TITLES[image as PixelImage] : image ?? 'a picture')}`;
    },
  },
];

/** The collection that opens when no key (or an unknown one) is given. */
export const DEFAULT_DATASET_KEY = 'tax-cases:3000';

export interface ParsedKey { prefix: string; size?: number; image?: string }

/** `products:10000` → { prefix, size }; `pixels:great-wave:250000` → { prefix, image, size }. */
export function parseKey(key: string): ParsedKey {
  const parts = key.split(':');
  const prefix = parts[0] ?? '';
  if (prefix === 'pixels') {
    const size = parts[2] ? Number(parts[2]) : undefined;
    return { prefix, image: parts[1], size: Number.isFinite(size) ? size : undefined };
  }
  const size = parts[1] ? Number(parts[1]) : undefined;
  return { prefix, size: Number.isFinite(size) ? size : undefined };
}

export function familyOf(key: string): DatasetFamily | undefined {
  const { prefix } = parseKey(key);
  return FAMILIES.find((f) => f.prefix === prefix);
}

export function menuEntries(): MenuEntry[] {
  return FAMILIES.flatMap((f) => {
    const entries = f.menu
      ? f.menu()
      : f.sizes.map((n) => ({ key: `${f.prefix}:${n}`, label: `${f.label} — ${n.toLocaleString()}` }));
    return entries.map((e) => ({ ...e, group: f.label }));
  });
}

export async function resolveDataset(key: string, ctx?: LoadContext): Promise<Dataset> {
  if (!familyOf(key)) key = DEFAULT_DATASET_KEY;
  const parsed = parseKey(key);
  const family = familyOf(key)!;
  if (family.prefix === 'pixels') {
    const image = (PIXEL_IMAGES as readonly string[]).includes(parsed.image ?? '') ? (parsed.image as PixelImage) : PIXEL_IMAGES[0];
    return loadPixels(image, parsed.size);
  }
  if (!family.load) throw new Error(`${family.prefix} keys need an image: ${family.prefix}:<image>:<size>`);
  return family.load(parsed.size, ctx);
}

/** Human description for the "Building …" toast. */
export function describeKey(key: string): string {
  if (!familyOf(key)) key = DEFAULT_DATASET_KEY;
  const family = familyOf(key)!;
  if (family.describe) return family.describe(key);
  const { size } = parseKey(key);
  const n = size ?? family.sizes[0];
  return `${n ? n.toLocaleString() + ' ' : ''}${family.buildingNoun ?? 'cards'}`;
}

// ------------------------------------------------------------- per mount

/** A dataset registered at runtime by an embedder (`handle.registerDataset`). */
export interface RuntimeEntry {
  label: string;
  group: string;
  get: () => Promise<Dataset>;
}

export interface RegistryOptions {
  /** Family prefixes offered; absent = every family. */
  families?: readonly string[];
  fetchAsset?: FetchAsset;
}

/** The group runtime datasets are listed under unless they name their own. */
export const RUNTIME_GROUP = 'Connected';

/**
 * One mount's view of the registry: the built-in families it allows, plus the
 * datasets its host registered at runtime. Runtime keys are checked first, so
 * a key like `src:procgen:orders` never falls through to the default
 * collection; anything else unknown falls back to a default that is itself in
 * an allowed family.
 */
export class DatasetRegistry {
  private readonly allowed: DatasetFamily[];
  private readonly runtime = new Map<string, RuntimeEntry>();
  private readonly ctx: LoadContext;

  constructor(opts: RegistryOptions = {}) {
    const only = opts.families ? new Set(opts.families) : null;
    this.allowed = only ? FAMILIES.filter((f) => only.has(f.prefix)) : FAMILIES.slice();
    this.ctx = { fetchAsset: opts.fetchAsset };
  }

  /** Built-in family for `key`, only if this mount allows it. */
  familyOf(key: string): DatasetFamily | undefined {
    const f = familyOf(key);
    return f && this.allowed.includes(f) ? f : undefined;
  }

  has(key: string): boolean {
    return this.runtime.has(key) || !!this.familyOf(key);
  }

  isRuntime(key: string): boolean { return this.runtime.has(key); }

  register(key: string, label: string, source: Dataset | (() => Promise<Dataset>), opts: { group?: string } = {}): void {
    if (!key) throw new Error('registerDataset: key is required');
    if (familyOf(key)) throw new Error(`registerDataset: "${key}" collides with the built-in ${familyOf(key)!.prefix} family`);
    const get = typeof source === 'function' ? source : () => Promise.resolve(source);
    this.runtime.set(key, { label, group: opts.group ?? RUNTIME_GROUP, get });
  }

  unregister(key: string): boolean { return this.runtime.delete(key); }

  /** The collection a missing or unknown key opens: the global default when
   *  its family is allowed, else the first allowed family's first entry, else
   *  the first runtime dataset. */
  get defaultKey(): string {
    if (this.familyOf(DEFAULT_DATASET_KEY)) return DEFAULT_DATASET_KEY;
    const first = this.builtinEntries()[0];
    if (first) return first.key;
    const rt = this.runtime.keys().next();
    if (!rt.done) return rt.value;
    return '';
  }

  private builtinEntries(): MenuEntry[] {
    return this.allowed.flatMap((f) => {
      const entries = f.menu
        ? f.menu()
        : f.sizes.map((n) => ({ key: `${f.prefix}:${n}`, label: `${f.label} — ${n.toLocaleString()}` }));
      return entries.map((e) => ({ ...e, group: f.label }));
    });
  }

  /** Built-in entries (allowed families only), then runtime ones. */
  menuEntries(): MenuEntry[] {
    return [
      ...this.builtinEntries(),
      ...[...this.runtime].map(([key, e]) => ({ key, label: e.label, group: e.group })),
    ];
  }

  /** The key actually opened for `key`: itself when known, else the default. */
  canonical(key: string): string {
    return this.has(key) ? key : this.defaultKey;
  }

  async resolve(key: string): Promise<Dataset> {
    const rt = this.runtime.get(key);
    if (rt) return rt.get();
    const k = this.canonical(key);
    const rt2 = this.runtime.get(k);
    if (rt2) return rt2.get();
    if (!k) throw new Error('No collection is available: every built-in family is filtered out and none was registered');
    return resolveDataset(k, this.ctx);
  }

  describe(key: string): string {
    const rt = this.runtime.get(key);
    if (rt) return rt.label;
    const k = this.canonical(key);
    if (this.runtime.has(k)) return this.runtime.get(k)!.label;
    return k ? describeKey(k) : 'collection';
  }
}
