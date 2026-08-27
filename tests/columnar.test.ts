import { describe, it, expect } from 'vitest';
import {
  numeric,
  category,
  categoryFromCodes,
  text,
  histogram,
  shortNumber,
  valueAt,
  type Dataset,
} from '../src/data/columnar';

describe('numeric', () => {
  it('computes min/max ignoring NaN', () => {
    const col = numeric('v', [3, NaN, -5, 10, NaN, 0]);
    expect(col.min).toBe(-5);
    expect(col.max).toBe(10);
  });

  it('also ignores +/-Infinity when computing min/max', () => {
    const col = numeric('v', [Infinity, -Infinity, 4, -2]);
    expect(col.min).toBe(-2);
    expect(col.max).toBe(4);
  });

  it('falls back to min=max=0 when every value is non-finite', () => {
    const col = numeric('v', [NaN, NaN, Infinity, -Infinity]);
    expect(col.min).toBe(0);
    expect(col.max).toBe(0);
  });

  it('stores values as a Float32Array without copying an existing one', () => {
    const src = Float32Array.from([1, 2, 3]);
    const col = numeric('v', src);
    expect(col.values).toBe(src);
  });
});

describe('category', () => {
  it('dictionary-encodes values and round-trips', () => {
    const values = ['a', 'b', 'a', 'c', 'b', 'a'];
    const col = category('cat', values);
    expect(col.categories).toEqual(['a', 'b', 'c']);
    expect(Array.from(col.codes)).toEqual([0, 1, 0, 2, 1, 0]);
    for (let i = 0; i < values.length; i++) {
      expect(col.categories[col.codes[i]]).toBe(values[i]);
    }
  });

  it('handles an empty input', () => {
    const col = category('cat', []);
    expect(col.categories).toEqual([]);
    expect(col.codes.length).toBe(0);
  });
});

describe('histogram', () => {
  const col = categoryFromCodes('cat', Int32Array.from([0, 1, 0, 2, 1, 0, -1]), ['a', 'b', 'c']);

  it('counts occurrences per category code, ignoring -1', () => {
    const h = histogram(col);
    expect(Array.from(h)).toEqual([3, 2, 1]);
  });

  it('respects a mask', () => {
    // keep indices 0,1,2,3 only -> codes [0,1,0,2]
    const mask = Uint8Array.from([1, 1, 1, 1, 0, 0, 0]);
    const h = histogram(col, mask);
    expect(Array.from(h)).toEqual([2, 1, 1]);
  });

  it('returns all zeros for an all-masked-out column', () => {
    const mask = Uint8Array.from([0, 0, 0, 0, 0, 0, 0]);
    const h = histogram(col, mask);
    expect(Array.from(h)).toEqual([0, 0, 0]);
  });
});

describe('shortNumber', () => {
  it('formats billions, millions, thousands', () => {
    expect(shortNumber(2.5e9)).toBe('2.5B');
    expect(shortNumber(3.4e6)).toBe('3.4M');
    expect(shortNumber(1500)).toBe('1.5k');
  });

  it('formats values >= 10 with no decimals', () => {
    expect(shortNumber(42.7)).toBe('43');
    expect(shortNumber(10)).toBe('10');
  });

  it('formats small integers as plain strings, small non-integers to 2dp', () => {
    expect(shortNumber(7)).toBe('7');
    expect(shortNumber(0)).toBe('0');
    expect(shortNumber(3.14159)).toBe('3.14');
  });

  it('formats negative numbers symmetrically', () => {
    expect(shortNumber(-1500)).toBe('-1.5k');
    expect(shortNumber(-7)).toBe('-7');
    expect(shortNumber(-3.14159)).toBe('-3.14');
  });
});

describe('valueAt', () => {
  function makeDataset(): Dataset {
    return {
      name: 'ds',
      n: 3,
      columns: {
        cat: categoryFromCodes('cat', Int32Array.from([0, 1, 5]), ['x', 'y']), // code 5 is out of range
        num: numeric('num', [1234, NaN, 7]),
        numFmt: { kind: 'number', name: 'numFmt', values: Float32Array.from([2]), min: 2, max: 2, format: (v) => `<${v}>` },
        txt: text('txt', ['hello', 'world']), // index 2 is out of range
      },
      labelColumn: 'txt',
      facets: [],
    };
  }

  it('reads category columns as their label, falling back to "" for an out-of-range code', () => {
    const ds = makeDataset();
    expect(valueAt(ds, 'cat', 0)).toBe('x');
    expect(valueAt(ds, 'cat', 1)).toBe('y');
    expect(valueAt(ds, 'cat', 2)).toBe('');
  });

  it('reads text columns directly, falling back to "" out of range', () => {
    const ds = makeDataset();
    expect(valueAt(ds, 'txt', 0)).toBe('hello');
    expect(valueAt(ds, 'txt', 1)).toBe('world');
    expect(valueAt(ds, 'txt', 2)).toBe('');
  });

  it('reads numeric columns via shortNumber by default, "—" for non-finite', () => {
    const ds = makeDataset();
    expect(valueAt(ds, 'num', 0)).toBe(shortNumber(1234));
    expect(valueAt(ds, 'num', 1)).toBe('—');
    expect(valueAt(ds, 'num', 2)).toBe(shortNumber(7));
  });

  it('reads numeric columns via a custom formatter when provided', () => {
    const ds = makeDataset();
    expect(valueAt(ds, 'numFmt', 0)).toBe('<2>');
  });

  it('returns "" for an unknown column', () => {
    const ds = makeDataset();
    expect(valueAt(ds, 'nope', 0)).toBe('');
  });
});
