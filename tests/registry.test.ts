import { describe, it, expect, vi } from 'vitest';
import { valueAt } from '../src/data/columnar';
import { FAMILIES, menuEntries, parseKey, describeKey, resolveDataset, familyOf, DEFAULT_DATASET_KEY } from '../src/data/registry';
import { TAX_CASE_SIZES, TAX_CASE_FACETS } from '../src/data/taxCases';
import { BIRD_SIZES } from '../src/data/birds';

/**
 * The tax-cases family is the onboarding dataset. Workstream C's walkthrough
 * is written against these exact keys, column names and category orders —
 * changing any of them breaks the tour. Treat this file as a contract.
 */
describe('D1 contract (tax-cases)', () => {
  it('exposes the frozen keys and sizes', () => {
    expect(TAX_CASE_SIZES).toEqual([900, 3_000, 20_000, 100_000]);
    const keys = menuEntries().map((e) => e.key);
    for (const n of TAX_CASE_SIZES) expect(keys).toContain(`tax-cases:${n}`);
    expect(familyOf('tax-cases:3000')?.prefix).toBe('tax-cases');
  });

  it('has the frozen column names, kinds and category orders', async () => {
    const ds = await resolveDataset('tax-cases:900');
    expect(ds.name).toBe('Tax customer service (900)');
    expect(ds.labelColumn).toBe('Customer');
    expect(ds.facets).toEqual([
      'Topic', 'Reason', 'Channel', 'Priority', 'Region', 'Team', 'Adviser',
      'Status', 'Escalated', 'Reopened', 'Within SLA', 'Month',
      'Customer type', 'Age band', 'Area type', 'Language', 'Support needs', 'Town',
      'Longitude', 'Latitude', 'Resolution hours', 'Days waiting', 'Satisfaction',
      'Contacts', 'Handling minutes', 'Prior cases', 'Opened', 'Hour opened',
    ]);
    // The original D1 columns keep their relative order (the tour is built on them).
    const d1 = ['Topic', 'Channel', 'Priority', 'Region', 'Team', 'Status', 'Escalated', 'Month', 'Resolution hours', 'Satisfaction', 'Contacts', 'Opened'];
    expect(ds.facets.filter((f) => d1.includes(f))).toEqual(d1);
    expect(ds.facets).toEqual(TAX_CASE_FACETS);
    const cat = (name: string) => {
      const c = ds.columns[name];
      expect(c?.kind).toBe('category');
      return c!.kind === 'category' ? c.categories : [];
    };
    expect(cat('Topic')).toEqual(['Self Assessment', 'PAYE', 'VAT', 'Tax Credits', 'Corporation Tax', 'Payments & Refunds']);
    expect(cat('Channel')).toEqual(['Phone', 'Webchat', 'Web form', 'Post']);
    expect(cat('Priority')).toEqual(['Low', 'Standard', 'High']);
    expect(cat('Region')).toEqual(['London', 'South East', 'South West', 'Midlands', 'North West', 'North East & Yorkshire', 'Scotland', 'Wales & NI']);
    expect(cat('Team')).toEqual(['Personal Tax', 'Business Tax', 'Benefits & Credits', 'Debt & Payments', 'Digital Support', 'Complaints']);
    expect(cat('Status')).toEqual(['Resolved', 'Open']);
    expect(cat('Escalated')).toEqual(['No', 'Yes']);
    expect(cat('Month')).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
    expect(cat('Age band')).toEqual(['18–29', '30–44', '45–59', '60–74', '75+']);
    expect(cat('Area type')).toEqual(['Urban', 'Suburban', 'Rural']);
    expect(cat('Customer type')).toEqual(['Individual', 'Agent', 'Business']);
    expect(cat('Language')).toEqual(['English', 'Welsh']);
    expect(cat('Support needs')).toEqual(['Standard', 'Additional support']);
    expect(cat('Within SLA')).toEqual(['Met', 'Missed', 'In progress']);
    expect(cat('Reopened')).toEqual(['No', 'Yes']);
    expect(cat('Reason').length).toBe(37);
    expect(cat('Adviser').length).toBe(72);
    expect(cat('Town').length).toBeGreaterThan(150);
    for (const c of ['Longitude', 'Latitude', 'Resolution hours', 'Days waiting', 'Satisfaction',
      'Contacts', 'Handling minutes', 'Prior cases', 'Opened', 'Hour opened']) expect(ds.columns[c]?.kind).toBe('number');
    // Longitude/Latitude are the first two numeric columns, so the raw Scatter opens on the map.
    const nums = Object.keys(ds.columns).filter((k) => ds.columns[k].kind === 'number');
    expect(nums.slice(0, 2)).toEqual(['Longitude', 'Latitude']);
    expect(ds.columns.Case?.kind).toBe('text');
    expect(ds.columns.Customer?.kind).toBe('text');
    expect(ds.columns.Postcode?.kind).toBe('text');
    expect(ds.columns.Subject?.kind).toBe('text');
    expect(valueAt(ds, 'Case', 0)).toBe('CS-25-000001');
  });

  it('has the same shape at 100,000 rows as at 900', async () => {
    const big = await resolveDataset('tax-cases:100000');
    const small = await resolveDataset('tax-cases:900');
    expect(Object.keys(big.columns)).toEqual(Object.keys(small.columns));
    expect(big.labelColumn).toBe('Customer');
    expect(valueAt(big, 'Customer', 0)).toMatch(/\S \S/);
    expect(valueAt(big, 'Postcode', 0)).toMatch(/^[A-Z]{1,2}\d{1,2} \d[A-Z]{2}$/);
    expect(valueAt(big, 'Case', 99_999)).toBe('CS-25-100000');
    expect(big.name).toBe('Tax customer service (100,000)');
  });

  it('resolves tax-cases:3000 to a 3,000-row dataset with customer cards', async () => {
    const ds = await resolveDataset('tax-cases:3000');
    expect(ds.n).toBe(3000);
    expect(ds.name).toBe('Tax customer service (3,000)');
    expect(ds.columns.Customer?.kind).toBe('text');
    expect(ds.labelColumn).toBe('Customer');
    expect(ds.kind).toBe('tax-cases');
    expect(ds.geo).toEqual({ lon: 'Longitude', lat: 'Latitude' });
  });
});

describe('registry', () => {
  it('parses keys', () => {
    expect(parseKey('tax-cases')).toEqual({ prefix: 'tax-cases', size: undefined });
    expect(parseKey('products:10000')).toEqual({ prefix: 'products', size: 10000 });
    expect(parseKey('pixels:great-wave:250000')).toEqual({ prefix: 'pixels', image: 'great-wave', size: 250000 });
  });

  it('builds a grouped menu with unique keys covering every family', () => {
    const entries = menuEntries();
    const keys = entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of FAMILIES) expect(entries.some((e) => e.group === f.label)).toBe(true);
    expect(keys[0]).toBe('tax-cases:900');
    expect(keys).toContain('products:1000');
    expect(keys).toContain('pixels:great-wave:250000');
    for (const n of BIRD_SIZES) expect(keys).toContain(`birds:${n}`);
  });

  it('describes keys for the toast', () => {
    expect(describeKey(`birds:${BIRD_SIZES[0]}`)).toBe(`${BIRD_SIZES[0].toLocaleString()} birds`);
    expect(describeKey('nonsense')).toBe('3,000 customer-service cases');
    expect(describeKey('tax-cases:3000')).toBe('3,000 customer-service cases');
    expect(describeKey('products:10000')).toBe('10,000 product cards');
    expect(describeKey('pixels:great-wave:250000')).toContain('Great Wave');
  });

  it('falls back to the default collection for unknown keys', async () => {
    expect(DEFAULT_DATASET_KEY).toBe('tax-cases:3000');
    expect(FAMILIES[0].prefix).toBe('tax-cases');
    const ds = await resolveDataset('nonsense:42');
    expect(ds.n).toBe(3000);
    expect(ds.name).toBe('Tax customer service (3,000)');
  });

  it('resolves products with a size', async () => {
    const ds = await resolveDataset('products:1000');
    expect(ds.n).toBe(1000);
  });

  it('describes off-menu and unknown keys sensibly', () => {
    expect(describeKey('tax-cases:5000')).toBe('5,000 customer-service cases');
    expect(describeKey('tax-cases')).toBe(`${TAX_CASE_SIZES[0].toLocaleString()} customer-service cases`);
    expect(describeKey('pixels:no-such-image:250000')).toBe('250k pixels of no-such-image');
    expect(describeKey('pixels')).toBe('a picture');
  });

  it('pixels has no size-only loader; resolveDataset routes it to loadPixels with a known image', async () => {
    const pixels = FAMILIES.find((f) => f.prefix === 'pixels')!;
    expect(pixels.load).toBeUndefined();
    // jsdom has no fetch of data/*.jpg; the first thing loadPixels does is fetch, so
    // stub it and check the fallback image is requested for an unknown one.
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await expect(resolveDataset('pixels:no-such-image:1000')).rejects.toThrow(/starry-night/);
      expect(fetchSpy).toHaveBeenCalledWith('data/starry-night.jpg');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('birds', () => {
  it('is a family with an async loader over relative paths, one size list, no sub-key', () => {
    const birds = FAMILIES.find((f) => f.prefix === 'birds')!;
    expect(birds.sizes).toEqual(BIRD_SIZES);
    expect(typeof birds.load).toBe('function');
    expect(familyOf(`birds:${BIRD_SIZES[0]}`)?.prefix).toBe('birds');
    expect(parseKey('birds:900')).toEqual({ prefix: 'birds', size: 900 });
  });

  it('fetches data/birds-<n>.json without a leading slash — the sub-path mount depends on it', async () => {
    // Same guard as the pixels case below: jsdom has no fetch, and the first
    // thing loadBirds does is fetch, so stub it and read the URL back.
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await expect(resolveDataset(`birds:${BIRD_SIZES[0]}`)).rejects.toThrow(/birds-900\.json/);
      expect(fetchSpy).toHaveBeenCalledWith('data/birds-900.json');
      // An off-menu size falls back to the smallest rather than 404ing on a
      // file the pipeline never baked.
      await expect(resolveDataset('birds:42')).rejects.toThrow();
      expect(fetchSpy).toHaveBeenLastCalledWith(`data/birds-${BIRD_SIZES[0]}.json`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('faker chunk', () => {
  it('stays out of the main bundle: it is imported on demand, once, per module load', async () => {
    // Names exist at every size now, so every tax-cases size needs faker — but
    // it must still arrive as its own dynamically imported chunk rather than in
    // the entry bundle, and it must not be re-imported per collection.
    vi.resetModules();
    const fakerImport = vi.fn(async () => ({ faker: undefined }));
    vi.doMock('@faker-js/faker/locale/en_GB', fakerImport);
    try {
      const reg = await import('../src/data/registry');
      expect(fakerImport).not.toHaveBeenCalled();   // nothing at module load
      await reg.resolveDataset('tax-cases:900');
      expect(fakerImport).toHaveBeenCalledTimes(1);
      // The module system caches the chunk: a second collection does not refetch it.
      await reg.resolveDataset('tax-cases:3000');
      expect(fakerImport).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('@faker-js/faker/locale/en_GB');
      vi.resetModules();
    }
  });
});
