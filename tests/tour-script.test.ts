import { describe, it, expect } from 'vitest';
import { fs, path, testsDir } from './helpers/nodefs';
import { NARRATION, VOICE, spokenText } from '../src/tour/script';
import { COL, VAL, UI } from '../src/tour/columns';
import { hashLine, fnv1a64 } from '../src/tour/hash';
import { markup } from '../src/tour/ui';

// testsDir is tests/helpers, so it takes two steps to reach the repo root.
const AUDIO = path.resolve(testsDir, '..', '..', 'public', 'audio', 'tour');
const manifestPath = path.join(AUDIO, 'manifest.json');
const haveAudio = fs.existsSync(manifestPath);

describe('narration script', () => {
  it('has unique kebab-case ids', () => {
    const ids = NARRATION.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('keeps every line between 8 and 30 words', () => {
    for (const l of NARRATION) {
      const words = spokenText(l.text).split(/\s+/).filter(Boolean).length;
      expect(words, l.id).toBeGreaterThanOrEqual(8);
      expect(words, l.id).toBeLessThanOrEqual(30);
    }
  });

  it('has exactly sixteen lines', () => {
    expect(NARRATION.length).toBe(16);
  });

  it('only bolds column, value and UI names from columns.ts', () => {
    const known = new Set([...Object.values(COL), ...Object.values(VAL), ...Object.values(UI)].map((s) => s.toLowerCase()));
    // The dataset line names the collection rather than a column.
    known.add('tax customer-service cases');
    for (const l of NARRATION) {
      for (const m of l.text.matchAll(/\*\*(.+?)\*\*/g)) {
        expect(known.has(m[1].toLowerCase()), `${l.id}: **${m[1]}**`).toBe(true);
      }
    }
  });

  it('renders captions with bold terms and escaped markup', () => {
    expect(markup('a **b** & <c>')).toBe('a <b>b</b> &amp; &lt;c&gt;');
  });
});

describe('hash', () => {
  it('is the reference FNV-1a 64', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });
});

describe.skipIf(!haveAudio)('voiceover audio', () => {
  const manifest = haveAudio ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  const voice = { voiceId: VOICE.voiceId, modelId: VOICE.modelId, outputFormat: VOICE.outputFormat, settings: VOICE.settings };

  it('has a clip per line whose hash matches the current text and voice (else run pnpm voiceover)', () => {
    for (const l of NARRATION) {
      const file = path.join(AUDIO, `${l.id}.mp3`);
      expect(fs.existsSync(file), `${l.id}.mp3 missing`).toBe(true);
      expect(fs.statSync(file).size, `${l.id}.mp3 too small`).toBeGreaterThan(5_000);
      expect(manifest[l.id]?.hash, `${l.id}: narration or voice changed without regenerating`).toBe(hashLine(spokenText(l.text), voice));
    }
  });

  it('has no orphan clips', () => {
    const ids = new Set(NARRATION.map((l) => l.id));
    for (const f of fs.readdirSync(AUDIO)) {
      if (f.endsWith('.mp3')) expect(ids.has(f.slice(0, -4)), `orphan ${f}`).toBe(true);
    }
    for (const id of Object.keys(manifest)) expect(ids.has(id), `orphan manifest entry ${id}`).toBe(true);
  });

  it('keeps the total under 1.5 MB', () => {
    const total = fs.readdirSync(AUDIO).filter((f) => f.endsWith('.mp3'))
      .reduce((n, f) => n + fs.statSync(path.join(AUDIO, f)).size, 0);
    expect(total).toBeLessThan(1.5 * 1024 * 1024);
  });
});
