#!/usr/bin/env node
// Pre-generates the guided tour's narration with ElevenLabs and writes
// public/audio/tour/<id>.mp3 plus manifest.json. Idempotent: a clip is only
// regenerated when its text, voice, model, or settings hash has changed.
// Never runs in CI; the mp3s are committed.
//
// Usage: pnpm voiceover [--dry-run] [--force] [--only <id>] [--list-voices] [--add-voice]
//   --add-voice adds the shared-library voice named in VOICE to the workspace
//   (free; required once before a library voice can be used for TTS).
// Needs ELEVENLABS_API_KEY in .env.local (never printed, never shipped).

import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NARRATION, VOICE, spokenText } from '../src/tour/script.ts';
import { hashLine } from '../src/tour/hash.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'audio', 'tour');
const MANIFEST = path.join(OUT, 'manifest.json');

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    only: { type: 'string' },
    'list-voices': { type: 'boolean', default: false },
    'add-voice': { type: 'boolean', default: false },
  },
});

try { process.loadEnvFile(path.join(ROOT, '.env.local')); } catch { /* rely on the environment */ }
const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey && !args['dry-run']) {
  console.error('ELEVENLABS_API_KEY is not set (put it in .env.local).');
  process.exit(1);
}

const voice = { voiceId: VOICE.voiceId, modelId: VOICE.modelId, outputFormat: VOICE.outputFormat, settings: VOICE.settings };

async function readManifest() {
  try { return JSON.parse(await fs.readFile(MANIFEST, 'utf8')); } catch { return {}; }
}

async function client() {
  const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
  return new ElevenLabsClient({ apiKey });
}

if (args['list-voices']) {
  const c = await client();
  const res = await c.voices.search({ pageSize: 100 });
  for (const v of res.voices ?? []) {
    const labels = Object.entries(v.labels ?? {}).map(([k, x]) => `${k}=${x}`).join(' ');
    console.log(`${v.voiceId}  ${v.name.padEnd(14)} ${labels}`);
  }
  process.exit(0);
}

if (args['add-voice']) {
  const c = await client();
  const mine = await c.voices.search({ pageSize: 100 });
  if ((mine.voices ?? []).some((v) => v.voiceId === VOICE.voiceId)) {
    console.log(`${VOICE.name} (${VOICE.voiceId}) is already in the workspace.`);
  } else {
    if (!VOICE.publicOwnerId) { console.error('VOICE.publicOwnerId is empty; find it with voices.getShared.'); process.exit(1); }
    const r = await c.voices.share(VOICE.publicOwnerId, VOICE.voiceId, { newName: VOICE.name });
    console.log(`added ${VOICE.name} to the workspace as ${r.voiceId ?? VOICE.voiceId}`);
  }
  process.exit(0);
}

const manifest = await readManifest();
const lines = NARRATION.filter((l) => !args.only || l.id === args.only);
if (lines.length === 0) {
  console.error(`--only ${args.only}: no narration line has that id (${NARRATION.map((l) => l.id).join(', ')}).`);
  process.exit(1);
}
const plan = lines.map((l) => {
  const text = spokenText(l.text);
  const hash = hashLine(text, voice);
  const stale = args.force || manifest[l.id]?.hash !== hash;
  return { id: l.id, text, hash, stale };
});

const todo = plan.filter((p) => p.stale);
const chars = todo.reduce((n, p) => n + p.text.length, 0);
console.log(`${lines.length} lines, ${todo.length} to generate (${chars} characters), voice ${VOICE.name} (${VOICE.voiceId}), ${VOICE.modelId} ${VOICE.outputFormat}`);
for (const p of plan) console.log(`  ${p.stale ? 'GEN ' : 'skip'} ${p.id.padEnd(9)} ${p.text.length} chars  ${p.hash}`);
if (args['dry-run']) process.exit(0);
await fs.mkdir(OUT, { recursive: true });

/** Write the manifest in narration order, dropping ids that no longer exist. */
async function writeManifest() {
  const ordered = Object.fromEntries(NARRATION.filter((l) => manifest[l.id]).map((l) => [l.id, manifest[l.id]]));
  await fs.writeFile(MANIFEST, JSON.stringify(ordered, null, 2) + '\n');
  return Object.keys(ordered).length;
}

if (todo.length) {
  const c = await client();
  for (const p of todo) {
    const i = lines.findIndex((l) => l.id === p.id);
    const prev = i > 0 ? spokenText(lines[i - 1].text) : undefined;
    const next = i < lines.length - 1 ? spokenText(lines[i + 1].text) : undefined;
    process.stdout.write(`generating ${p.id}… `);
    let stream;
    try {
      stream = await c.textToSpeech.convert(VOICE.voiceId, {
        text: p.text,
        modelId: VOICE.modelId,
        outputFormat: VOICE.outputFormat,
        voiceSettings: VOICE.settings,
        previousText: prev,
        nextText: next,
        seed: VOICE.seed,
      });
    } catch (err) {
      // Clips generated so far are already in the manifest (written per clip
      // below), so a rerun picks up here rather than billing them again.
      const status = err?.statusCode ?? err?.status;
      const body = JSON.stringify(err?.body ?? err?.message ?? '');
      console.error(`\nfailed on ${p.id}${status ? ` (HTTP ${status})` : ''}: ${body}`);
      if (status >= 400 && status < 500 && /voice/i.test(body)) {
        console.error(`The voice ${VOICE.name} (${VOICE.voiceId}) may not be in the workspace yet: run 'pnpm voiceover --add-voice' first.`);
      }
      process.exit(1);
    }
    const buf = Buffer.from(await new Response(stream).arrayBuffer());
    await fs.writeFile(path.join(OUT, `${p.id}.mp3`), buf);
    manifest[p.id] = { hash: p.hash, voice: VOICE.voiceId, model: VOICE.modelId, chars: p.text.length, bytes: buf.length };
    await writeManifest();
    console.log(`${buf.length} bytes`);
  }
}

// Drop clips for lines that no longer exist.
if (!args.only) {
  const ids = new Set(NARRATION.map((l) => l.id));
  for (const id of Object.keys(manifest)) if (!ids.has(id)) delete manifest[id];
  for (const f of await fs.readdir(OUT)) {
    if (f.endsWith('.mp3') && !ids.has(f.slice(0, -4))) { await fs.unlink(path.join(OUT, f)); console.log(`removed orphan ${f}`); }
  }
}
console.log(`manifest written: ${await writeManifest()} clips`);
