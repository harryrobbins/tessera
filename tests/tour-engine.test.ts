import { describe, it, expect } from 'vitest';
import { TourEngine, fallbackMs, type TourStep, type TourPlayer } from '../src/tour/engine';
import { AudioPlayer, type AudioLike } from '../src/tour/player';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const until = async (pred: () => boolean, ms = 500) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await tick();
  }
};

/** A player that resolves only when told to (or when aborted). */
function fakePlayer() {
  const pending: Array<{ id: string; resolve: () => void }> = [];
  const played: string[] = [];
  const preloaded: string[] = [];
  const player: TourPlayer = {
    play(id, _text, signal) {
      played.push(id);
      return new Promise<void>((resolve) => {
        const entry = { id, resolve };
        pending.push(entry);
        signal.addEventListener('abort', () => resolve());
      });
    },
    preload: (id) => { preloaded.push(id); },
  };
  return { player, played, preloaded, end: () => pending.shift()?.resolve() };
}

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
}

function steps(log: string[], n = 3, opts: Partial<TourStep> = {}): TourStep[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    text: `step ${i} words here`,
    run: () => { log.push(`run:s${i}`); },
    ...opts,
  }));
}

describe('TourEngine', () => {
  it('runs actions in order, plays each clip, and auto-advances on ended', async () => {
    const log: string[] = [];
    const fp = fakePlayer();
    const store = memStore();
    let done: string | null = null;
    const e = new TourEngine(steps(log), { player: fp.player, store, storeKey: 'k', onDone: (r) => { done = r; } });
    e.start();
    await until(() => fp.played.length === 1);
    expect(e.index).toBe(0);
    expect(log).toEqual(['run:s0']);
    expect(fp.preloaded).toEqual(['s1']);
    fp.end();
    await until(() => fp.played.length === 2);
    fp.end();
    await until(() => fp.played.length === 3);
    fp.end();
    await until(() => done !== null);
    expect(done).toBe('done');
    expect(log).toEqual(['run:s0', 'run:s1', 'run:s2']);
    expect(store.m.get('k')).toBe('done');
    expect(e.running).toBe(false);
  });

  it('next() mid-clip aborts the clip and moves on without double-advancing', async () => {
    const log: string[] = [];
    const fp = fakePlayer();
    const e = new TourEngine(steps(log), { player: fp.player, store: null });
    e.start();
    await until(() => fp.played.length === 1);
    e.next();
    await until(() => fp.played.length === 2);
    expect(e.index).toBe(1);
    // The aborted first clip resolved, but must not have advanced again.
    await tick(); await tick();
    expect(e.index).toBe(1);
    expect(fp.played).toEqual(['s0', 's1']);
  });

  it('back() is a no-op at the first step and otherwise re-runs the previous action', async () => {
    const log: string[] = [];
    const fp = fakePlayer();
    const e = new TourEngine(steps(log), { player: fp.player, store: null });
    e.start();
    await until(() => fp.played.length === 1);
    e.back();
    await tick();
    expect(e.index).toBe(0);
    e.next();
    await until(() => fp.played.length === 2);
    e.back();
    await until(() => fp.played.length === 3);
    expect(e.index).toBe(0);
    expect(log).toEqual(['run:s0', 'run:s1', 'run:s0']);
  });

  it('skip() ends the tour and records completion', async () => {
    const fp = fakePlayer();
    const store = memStore();
    let done: string | null = null;
    const e = new TourEngine(steps([]), { player: fp.player, store, storeKey: 'tessera.tour.v1', onDone: (r) => { done = r; } });
    e.start();
    await until(() => fp.played.length === 1);
    e.skip();
    expect(done).toBe('skip');
    expect(store.m.get('tessera.tour.v1')).toBe('done');
    expect(e.running).toBe(false);
    e.next();
    expect(fp.played.length).toBe(1);
  });

  it('a throwing action is reported and does not stop the tour', async () => {
    const fp = fakePlayer();
    const errors: string[] = [];
    const st = steps([]);
    st[0].run = () => { throw new Error('boom'); };
    st[1].run = async () => { throw new Error('async boom'); };
    const e = new TourEngine(st, { player: fp.player, store: null, onError: (_e, s) => errors.push(s.id) });
    e.start();
    await until(() => fp.played.length === 1);
    fp.end();
    await until(() => fp.played.length === 2);
    expect(errors).toEqual(['s0', 's1']);
    expect(e.index).toBe(1);
  });

  it('aborts the running action on back()/skip(): the old action never mutates the host again (H-03)', async () => {
    const fp = fakePlayer();
    const mutations: string[] = [];
    let release: (() => void) | null = null;
    const st = steps([]);
    st[1].run = async (signal) => {
      await new Promise<void>((r) => { release = r; });
      if (signal.aborted) return;
      mutations.push('s1');
    };
    const e = new TourEngine(st, { player: fp.player, store: null });
    e.start();
    await until(() => fp.played.length === 1);
    e.next();
    await until(() => release !== null);
    expect(e.phase).toBe('acting');
    e.back();
    await until(() => fp.played.length === 2);
    release!();
    await tick(); await tick();
    expect(mutations).toEqual([]);
    expect(e.index).toBe(0);
    expect(fp.played).toEqual(['s0', 's0']);
  });

  it('skip() during an action aborts its signal and the tour stays finished', async () => {
    const fp = fakePlayer();
    let seen: AbortSignal | null = null;
    let release: (() => void) | null = null;
    const st = steps([], 1);
    st[0].run = async (signal) => { seen = signal; await new Promise<void>((r) => { release = r; }); };
    let done: string | null = null;
    const e = new TourEngine(st, { player: fp.player, store: null, onDone: (r) => { done = r; } });
    e.start();
    await until(() => release !== null);
    e.skip();
    expect(seen!.aborted).toBe(true);
    expect(done).toBe('skip');
    release!();
    await tick(); await tick();
    expect(fp.played).toEqual([]);
    expect(e.running).toBe(false);
  });

  it('finishes at once with no steps instead of running an undefined step (L-11)', () => {
    const fp = fakePlayer();
    let done: string | null = null;
    const e = new TourEngine([], { player: fp.player, store: null, onDone: (r) => { done = r; } });
    e.start();
    expect(done).toBe('done');
    expect(e.running).toBe(false);
  });

  it('spotlights before and after the action', async () => {
    const fp = fakePlayer();
    const phases: string[] = [];
    const e = new TourEngine(steps([], 1), {
      player: fp.player, store: null,
      spotlight: (s, i, phase) => phases.push(`${s.id}:${i}:${phase}`),
    });
    e.start();
    await until(() => fp.played.length === 1);
    expect(phases).toEqual(['s0:0:before', 's0:0:after']);
  });
});

describe('fallbackMs', () => {
  it('reads at 2.5 words a second, floored by minMs', () => {
    expect(fallbackMs('one two three four five')).toBe(2000);
    expect(fallbackMs('one two', 3000)).toBe(3000);
    expect(fallbackMs('   ')).toBe(0);
  });
});

function fakeAudio(behaviour: 'ended' | 'reject' | 'error' | 'hang', duration?: number) {
  const listeners = new Map<string, Set<() => void>>();
  const a: AudioLike & { fire(t: string): void; paused: boolean } = {
    src: '', preload: '', muted: false, currentTime: 0, paused: true, duration,
    play() {
      a.paused = false;
      if (behaviour === 'reject') return Promise.reject(new Error('NotAllowedError'));
      if (behaviour === 'error') { setTimeout(() => a.fire('error'), 0); return Promise.resolve(); }
      if (behaviour === 'ended') setTimeout(() => a.fire('ended'), 5);
      return Promise.resolve();
    },
    pause() { a.paused = true; },
    addEventListener(t, fn) { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(fn); },
    removeEventListener(t, fn) { listeners.get(t)?.delete(fn); },
    fire(t) { for (const fn of listeners.get(t) ?? []) fn(); },
  };
  return a;
}

describe('AudioPlayer', () => {
  it('resolves when the clip ends', async () => {
    const a = fakeAudio('ended');
    const p = new AudioPlayer({ createAudio: () => a, storage: null, fastMs: null });
    const t0 = Date.now();
    await p.play('welcome', 'a long caption of many many words', new AbortController().signal, 5000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(a.src).toBe('audio/tour/tax/welcome.mp3');
  });

  it('falls back to a reading-pace timer when play() rejects', async () => {
    const a = fakeAudio('reject');
    const p = new AudioPlayer({ createAudio: () => a, storage: null, fastMs: 40 });
    const t0 = Date.now();
    await p.play('x', 'one two three four five', new AbortController().signal);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
  });

  it('falls back when the file 404s (error event)', async () => {
    const a = fakeAudio('error');
    const p = new AudioPlayer({ createAudio: () => a, storage: null, fastMs: 30 });
    const t0 = Date.now();
    await p.play('x', 'words', new AbortController().signal);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });

  it('muted: never touches audio and resolves after minMs', async () => {
    let created = 0;
    const p = new AudioPlayer({ createAudio: () => { created++; return fakeAudio('hang'); }, storage: null, fastMs: 40 });
    p.setMuted(true);
    const t0 = Date.now();
    await p.play('x', 'a b', new AbortController().signal);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(created).toBe(0);
    expect(p.muted).toBe(true);
  });

  it('abort resolves at once and pauses the element', async () => {
    const a = fakeAudio('hang');
    const p = new AudioPlayer({ createAudio: () => a, storage: null, fastMs: null });
    const ctrl = new AbortController();
    const done = p.play('x', 'many words in this caption', ctrl.signal, 10_000);
    await tick();
    ctrl.abort();
    await done;
    expect(a.paused).toBe(true);
  });

  it('a stalled stream (no ended, no error) resolves at the ceiling (M-07)', async () => {
    const a = fakeAudio('hang');
    const p = new AudioPlayer({ createAudio: () => a, storage: null, fastMs: 200 });
    const t0 = Date.now();
    await p.play('x', 'words', new AbortController().signal);
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(450);
    expect(dt).toBeLessThan(2000);
  });

  it('a clip that runs longer than its caption reads is not cut short', async () => {
    // 10 s of audio behind a caption the reading-pace guess would cap at 500 ms:
    // once the metadata is in, the cap has to follow the clip, not the words.
    const a = fakeAudio('hang', 10);
    const p = new AudioPlayer({ createAudio: () => a, storage: null, fastMs: 20 });
    const t0 = Date.now();
    const done = p.play('x', 'words', new AbortController().signal);
    a.fire('loadedmetadata');
    setTimeout(() => a.fire('ended'), 700);
    await done;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(650);
  });

  it('a rejected play() that nevertheless plays keeps the step for the whole clip', async () => {
    // Chrome rejects play() with AbortError when a previous load is still
    // unwinding, and then plays the clip anyway; the fallback timer must go.
    const a = fakeAudio('reject');
    const p = new AudioPlayer({ createAudio: () => a, storage: null, fastMs: 20 });
    const t0 = Date.now();
    const done = p.play('x', 'words', new AbortController().signal);
    setTimeout(() => a.fire('playing'), 5);
    setTimeout(() => a.fire('ended'), 300);
    await done;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it('dispose() releases the preloaded and playback elements (L-12)', () => {
    const made: ReturnType<typeof fakeAudio>[] = [];
    const p = new AudioPlayer({ createAudio: () => { const a = fakeAudio('hang'); made.push(a); return a; }, storage: null, fastMs: 10 });
    p.unlock();
    p.preload('a');
    p.preload('b');
    expect(made.length).toBe(3);
    p.dispose();
    expect(made.every((a) => a.paused && a.src === '')).toBe(true);
    p.preload('a');
    expect(made.length).toBe(4);
  });

  it('persists the muted flag and reads fastMs from storage', () => {
    const store = memStore();
    store.setItem('tessera.tour.fastMs', '25');
    const p = new AudioPlayer({ createAudio: () => fakeAudio('hang'), storage: store });
    expect(p.durationFor('lots of words', 9000)).toBe(25);
    p.setMuted(true);
    expect(store.m.get('tessera.tour.muted')).toBe('1');
    const q = new AudioPlayer({ createAudio: () => fakeAudio('hang'), storage: store });
    expect(q.muted).toBe(true);
  });
});
