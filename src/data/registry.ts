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
  load?: (size?: number) => Dataset | Promise<Dataset>;
  /** Plural noun for the "Building …" toast; default "cards". */
  buildingNoun?: string;
  /** Override the menu entries (families whose keys carry more than a size). */
  menu?: () => { key: string; label: string }[];
  /** Override the toast description for a key. */
  describe?: (key: string) => string;
}

export interface MenuEntry { key: string; label: string; group?: string }

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
    load: () => loadTitanic(),
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

export async function resolveDataset(key: string): Promise<Dataset> {
  if (!familyOf(key)) key = DEFAULT_DATASET_KEY;
  const parsed = parseKey(key);
  const family = familyOf(key)!;
  if (family.prefix === 'pixels') {
    const image = (PIXEL_IMAGES as readonly string[]).includes(parsed.image ?? '') ? (parsed.image as PixelImage) : PIXEL_IMAGES[0];
    return loadPixels(image, parsed.size);
  }
  if (!family.load) throw new Error(`${family.prefix} keys need an image: ${family.prefix}:<image>:<size>`);
  return family.load(parsed.size);
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
