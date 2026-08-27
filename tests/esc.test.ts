import { describe, it, expect } from 'vitest';
import { esc } from '../src/core/esc';

describe('esc', () => {
  it('escapes the four characters that can break text or a double-quoted attribute', () => {
    expect(esc('<b a="x">&</b>')).toBe('&lt;b a=&quot;x&quot;&gt;&amp;&lt;/b&gt;');
  });

  it('leaves everything else alone, including single quotes (double-quoted attributes only)', () => {
    // `'` is deliberately not escaped: every attribute in the app is double-quoted,
    // so an apostrophe in a name ("O'Brien") reads naturally.
    expect(esc("O'Brien & Sons")).toBe("O'Brien &amp; Sons");
    expect(esc('plain text 123')).toBe('plain text 123');
    expect(esc('')).toBe('');
  });
});
