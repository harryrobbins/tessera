import { describe, it, expect } from 'vitest';
import { DatasetRegistry, DEFAULT_DATASET_KEY, RUNTIME_GROUP } from '../src/data/registry';
import { numeric, text, type Dataset } from '../src/data/columnar';

const tiny = (name: string): Dataset => ({
  name, n: 2, columns: { t: text('t', ['a', 'b']), v: numeric('v', [1, 2]) }, labelColumn: 't', facets: ['v'],
});

describe('DatasetRegistry: runtime datasets', () => {
  it('resolves a registered key before the default fallback', async () => {
    const r = new DatasetRegistry();
    r.register('src:procgen:orders', 'Orders', tiny('Orders'));
    expect(r.canonical('src:procgen:orders')).toBe('src:procgen:orders');
    expect((await r.resolve('src:procgen:orders')).name).toBe('Orders');
    expect(r.describe('src:procgen:orders')).toBe('Orders');
  });

  it('accepts a lazy loader', async () => {
    const r = new DatasetRegistry();
    let calls = 0;
    r.register('src:x', 'X', async () => { calls++; return tiny('X'); });
    expect(calls).toBe(0);
    expect((await r.resolve('src:x')).name).toBe('X');
    expect(calls).toBe(1);
  });

  it('lists runtime entries after the built-ins, under "Connected" unless a group is given', () => {
    const r = new DatasetRegistry({ families: ['titanic'] });
    r.register('src:a', 'A', tiny('A'));
    r.register('src:b', 'B', tiny('B'), { group: 'Mine' });
    const m = r.menuEntries();
    expect(m[0].key).toBe('titanic');
    expect(m.slice(1)).toEqual([
      { key: 'src:a', label: 'A', group: RUNTIME_GROUP },
      { key: 'src:b', label: 'B', group: 'Mine' },
    ]);
  });

  it('unregisters, after which the key falls back to the default again', () => {
    const r = new DatasetRegistry();
    r.register('src:a', 'A', tiny('A'));
    expect(r.unregister('src:a')).toBe(true);
    expect(r.canonical('src:a')).toBe(DEFAULT_DATASET_KEY);
  });

  it('refuses a key that collides with a built-in family', () => {
    expect(() => new DatasetRegistry().register('titanic', 'T', tiny('T'))).toThrow(/collides/);
  });
});

describe('DatasetRegistry: families filter', () => {
  it('still sends unknown keys to the default', () => {
    const r = new DatasetRegistry();
    expect(r.canonical('nope:1')).toBe(DEFAULT_DATASET_KEY);
    expect(r.canonical('tax-cases:5000')).toBe('tax-cases:5000');
  });

  it('filters the menu to the allowed families', () => {
    const r = new DatasetRegistry({ families: ['payments', 'titanic'] });
    const groups = new Set(r.menuEntries().map((e) => e.group));
    expect(groups).toEqual(new Set(['Card payments', 'Titanic']));
  });

  it('moves the default into an allowed family, and refuses keys from a disallowed one', () => {
    const r = new DatasetRegistry({ families: ['titanic', 'payments'] });
    // tax-cases is filtered out, so its key cannot be the default.
    expect(r.defaultKey).toBe(r.menuEntries()[0].key);
    expect(r.defaultKey.startsWith('tax-cases')).toBe(false);
    expect(r.canonical('birds:900')).toBe(r.defaultKey);
    expect(r.canonical('titanic')).toBe('titanic');
  });

  it('falls back to a runtime dataset when no family is allowed', async () => {
    const r = new DatasetRegistry({ families: [] });
    expect(r.defaultKey).toBe('');
    await expect(r.resolve('anything')).rejects.toThrow(/No collection/);
    r.register('src:only', 'Only', tiny('Only'));
    expect(r.defaultKey).toBe('src:only');
    expect((await r.resolve('anything')).name).toBe('Only');
  });

  it('passes fetchAsset through to the Titanic loader instead of fetch', async () => {
    const asked: string[] = [];
    const csv = 'PassengerId,Survived,Pclass,Name,Sex,Age,SibSp,Parch,Ticket,Fare,Cabin,Embarked\n1,0,3,"Braund, Mr. Owen Harris",male,22,1,0,A/5 21171,7.25,,S\n';
    const r = new DatasetRegistry({
      families: ['titanic'],
      fetchAsset: async (p) => { asked.push(p); return new Response(csv); },
    });
    const ds = await r.resolve('titanic').catch((e: unknown) => e);
    expect(asked).toEqual(['data/titanic.csv']);
    // Whatever the parser makes of a one-row CSV, it came through fetchAsset.
    expect(ds).toBeDefined();
  });
});
