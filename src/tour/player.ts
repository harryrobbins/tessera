import { fallbackMs, type TourPlayer } from './engine';
import { safeStorage } from './store';

/** The slice of HTMLAudioElement the player uses; tests supply a fake. */
export interface AudioLike {
  src: string;
  preload: string;
  muted: boolean;
  currentTime: number;
  /** Seconds, once the browser has the clip's metadata; NaN or absent before that. */
  readonly duration?: number;
  play(): Promise<void>;
  pause(): void;
  load?(): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface AudioPlayerOptions {
  createAudio?: () => AudioLike;
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null;
  /** Where clips live, relative so it resolves under a sub-path deploy. */
  base?: string;
  /** Fallback caption time override (e2e); read from storage when omitted. */
  fastMs?: number | null;
}

export const MUTED_KEY = 'tessera.tour.muted';
export const FAST_KEY = 'tessera.tour.fastMs';

// A ~40 ms silent WAV: playing it inside a click handler unlocks audio on
// Safari and iOS, after which the same element may play real clips later.
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

/**
 * How long a playing clip may make no progress — buffering, stalled, a decode
 * that never completes — before the tour gives up on it and moves on.
 */
export const STALL_GRACE_MS = 4000;

/**
 * Plays one narration clip at a time. Resolves when the clip ends, when the
 * caller aborts (next/skip), or — when audio is muted, missing, or blocked by
 * autoplay policy — after a reading-pace timer so the tour still advances.
 *
 * A caption's word count only ever *estimates* how long its clip runs: across
 * the two tours the same voice reads between 1.7 and 3.4 words a second, so a
 * clip can run half as long again as its caption reads. Nothing that can cut a
 * clip short is therefore allowed to rest on that estimate once the browser
 * knows the real length — see `play`.
 */
export class AudioPlayer implements TourPlayer {
  private readonly create: () => AudioLike;
  private readonly storage: AudioPlayerOptions['storage'];
  private readonly base: string;
  private readonly fastMs: number | null;
  private el: AudioLike | null = null;
  private preloaded = new Map<string, AudioLike>();
  private _muted = false;
  onMutedChange?: (muted: boolean) => void;

  constructor(opts: AudioPlayerOptions = {}) {
    this.create = opts.createAudio ?? (() => new Audio() as unknown as AudioLike);
    this.storage = opts.storage === undefined ? safeStorage() : opts.storage;
    this.base = opts.base ?? 'audio/tour/tax/';
    this.fastMs = opts.fastMs !== undefined ? opts.fastMs : readFast(this.storage);
    try { this._muted = this.storage?.getItem(MUTED_KEY) === '1'; } catch { /* ignore */ }
  }

  get muted(): boolean {
    return this._muted;
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this.el) this.el.muted = muted;
    try { this.storage?.setItem(MUTED_KEY, muted ? '1' : '0'); } catch { /* private mode */ }
    this.onMutedChange?.(muted);
  }

  url(id: string): string {
    return `${this.base}${id}.mp3`;
  }

  /** Must be called from a user gesture. Safe to call more than once. */
  unlock(): void {
    if (this.el) return;
    try {
      const a = this.create();
      a.preload = 'auto';
      a.muted = this._muted;
      a.src = SILENCE;
      a.play().catch(() => { /* still locked; the fallback timer covers it */ });
      this.el = a;
    } catch { /* no Audio in this environment */ }
  }

  preload(id: string): void {
    if (this._muted || this.preloaded.has(id)) return;
    try {
      const a = this.create();
      a.preload = 'auto';
      a.src = this.url(id);
      a.load?.();
      this.preloaded.set(id, a);
    } catch { /* ignore */ }
  }

  /** Release every Audio element (the tour is closed; a new tour builds a new player). */
  dispose(): void {
    for (const a of this.preloaded.values()) { try { a.pause(); a.src = ''; } catch { /* ignore */ } }
    this.preloaded.clear();
    if (this.el) { try { this.el.pause(); this.el.src = ''; } catch { /* ignore */ } }
    this.el = null;
  }

  /** Reading-pace duration for a caption, or the e2e override. */
  durationFor(text: string, minMs = 0): number {
    return this.fastMs !== null ? this.fastMs : fallbackMs(text, minMs);
  }

  play(id: string, text: string, signal: AbortSignal, minMs = 0): Promise<void> {
    const ms = this.durationFor(text, minMs);
    if (signal.aborted) return Promise.resolve();
    if (this._muted) return wait(ms, signal);
    if (!this.el) this.unlock();
    const a = this.el;
    if (!a) return wait(ms, signal);

    return new Promise<void>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        clearTimeout(ceiling);
        a.removeEventListener('ended', finish);
        a.removeEventListener('error', onFail);
        a.removeEventListener('loadedmetadata', onMeta);
        a.removeEventListener('durationchange', onMeta);
        a.removeEventListener('playing', onProgress);
        a.removeEventListener('timeupdate', onProgress);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => { try { a.pause(); } catch { /* ignore */ } finish(); };
      /** Milliseconds of clip still to play, or null while the browser cannot say. */
      const left = (): number | null => {
        const d = a.duration;
        if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return null;
        const at = Number.isFinite(a.currentTime) ? a.currentTime : 0;
        return Math.max(0, d - at) * 1000;
      };
      // The clip could not play (404, decode failure, autoplay refused): hold
      // the caption for as long as the clip would have run, or for the reading
      // pace when even that is unknown.
      const onFail = () => { if (!done && timer === null) timer = setTimeout(finish, left() ?? ms); };
      // A stalled stream (buffering forever, no 'ended' or 'error') must not
      // leave the step up indefinitely. Until the browser has the clip's
      // metadata this cap can only guess at its length — 3x the reading pace —
      // and `onMeta` replaces the guess with the truth the moment there is
      // one, so a clip that runs longer than its caption reads is never cut
      // off mid-sentence.
      let ceiling = setTimeout(finish, Math.max(3 * ms, 500));
      const onMeta = () => {
        const rest = left();
        if (rest === null) return;
        clearTimeout(ceiling);
        ceiling = setTimeout(finish, rest + STALL_GRACE_MS);
      };
      // Sound is coming out. `play()` can reject with an AbortError while the
      // clip nevertheless plays — a previous load still unwinding — so proof
      // of playback retires the failure timer; and each `timeupdate` pushes
      // the stall cap out with the playhead, which turns it into a detector
      // for a clip that has *stopped* progressing rather than one that is
      // merely long.
      const onProgress = () => {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        onMeta();
      };
      signal.addEventListener('abort', onAbort);
      a.addEventListener('ended', finish);
      a.addEventListener('error', onFail);
      a.addEventListener('loadedmetadata', onMeta);
      a.addEventListener('durationchange', onMeta);
      a.addEventListener('playing', onProgress);
      a.addEventListener('timeupdate', onProgress);
      try {
        a.pause();
        a.src = this.url(id);
        a.currentTime = 0;
        a.muted = this._muted;
        a.play().then(() => { /* playing; 'ended' or abort ends the step */ }, onFail);
      } catch {
        onFail();
      }
    });
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done);
  });
}

function readFast(storage: AudioPlayerOptions['storage']): number | null {
  try {
    const v = storage?.getItem(FAST_KEY);
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch { return null; }
}
