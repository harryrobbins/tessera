import { describe, it, expect } from 'vitest';
import { fs, path, testsDir } from './helpers/nodefs';
import { NARRATION, TOUR_SCRIPTS, VOICE, spokenText, type TourScript } from '../src/tour/script';
import { COL, VAL, UI } from '../src/tour/columns';
import { hashLine, fnv1a64 } from '../src/tour/hash';
import { markup } from '../src/tour/ui';

// testsDir is tests/helpers, so it takes two steps to reach the repo root.
const PUBLIC = path.resolve(testsDir, '..', '..', 'public');
const audioDir = (tour: TourScript) => path.join(PUBLIC, tour.audioBase);
const manifestOf = (tour: TourScript) => path.join(audioDir(tour), 'manifest.json');

/** Every tour gets the same structural rules and the same audio contract. */
for (const tour of TOUR_SCRIPTS) {
  describe(`narration script (${tour.id})`, () => {
    it('has unique kebab-case ids', () => {
      const ids = tour.lines.map((l) => l.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    });

    it('keeps every line between 8 and 30 words', () => {
      for (const l of tour.lines) {
        const words = spokenText(l.text).split(/\s+/).filter(Boolean).length;
        expect(words, l.id).toBeGreaterThanOrEqual(8);
        expect(words, l.id).toBeLessThanOrEqual(30);
      }
    });

    it('has exactly sixteen lines', () => {
      expect(tour.lines.length).toBe(16);
    });
  });
}

describe('tour registry', () => {
  it('gives every tour its own id, label and clip directory', () => {
    for (const key of ['id', 'label', 'blurb', 'audioBase'] as const) {
      const seen = TOUR_SCRIPTS.map((t) => t[key]);
      expect(new Set(seen).size, `two tours share a ${key}`).toBe(seen.length);
    }
    // A base that is a prefix of another's would put one tour's clips inside
    // the other's directory, where the orphan sweep below would delete them.
    for (const a of TOUR_SCRIPTS) {
      for (const b of TOUR_SCRIPTS) {
        if (a === b) continue;
        expect(a.audioBase.startsWith(b.audioBase), `${a.id} nests inside ${b.id}`).toBe(false);
      }
    }
  });
});

describe('narration script', () => {
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

for (const tour of TOUR_SCRIPTS) {
  const manifestPath = manifestOf(tour);
  const AUDIO = audioDir(tour);
  const haveAudio = fs.existsSync(manifestPath);

  describe.skipIf(!haveAudio)(`voiceover audio (${tour.id})`, () => {
    const manifest = haveAudio ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
    const voice = { voiceId: VOICE.voiceId, modelId: VOICE.modelId, outputFormat: VOICE.outputFormat, settings: VOICE.settings };

    it('has a clip per line whose hash matches the current text and voice (else run pnpm voiceover)', () => {
      for (const l of tour.lines) {
        const file = path.join(AUDIO, `${l.id}.mp3`);
        expect(fs.existsSync(file), `${tour.id}/${l.id}.mp3 missing`).toBe(true);
        expect(fs.statSync(file).size, `${tour.id}/${l.id}.mp3 too small`).toBeGreaterThan(5_000);
        expect(manifest[l.id]?.hash, `${tour.id}/${l.id}: narration or voice changed without regenerating`)
          .toBe(hashLine(spokenText(l.text), voice));
      }
    });

    it('has no orphan clips', () => {
      const ids = new Set(tour.lines.map((l) => l.id));
      for (const f of fs.readdirSync(AUDIO)) {
        // A sibling tour's directory lives in here; only mp3s are ours.
        if (f.endsWith('.mp3')) expect(ids.has(f.slice(0, -4)), `orphan ${tour.id}/${f}`).toBe(true);
      }
      for (const id of Object.keys(manifest)) expect(ids.has(id), `orphan manifest entry ${tour.id}/${id}`).toBe(true);
    });

    it('keeps the total under 1.5 MB', () => {
      const total = fs.readdirSync(AUDIO).filter((f) => f.endsWith('.mp3'))
        .reduce((n, f) => n + fs.statSync(path.join(AUDIO, f)).size, 0);
      expect(total).toBeLessThan(1.5 * 1024 * 1024);
    });
  });
}
