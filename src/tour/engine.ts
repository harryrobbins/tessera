/**
 * The tour's state machine, free of any DOM so vitest can drive it. Each step:
 * spotlight → run the action (errors are logged, never fatal) → play the clip
 * (resolves on ended, on a fallback timer, or at once when aborted) → advance.
 */
/** A screen rectangle in CSS pixels, for spotlighting things that are not elements (a card on the canvas). */
import { TOUR_KEY, TOUR_DONE, markTourDone } from './store';

export { TOUR_DONE };

export interface SpotRect { left: number; top: number; width: number; height: number }

export interface TourStep {
  id: string;
  /** Short bold heading on the card; the narration does not read it. */
  title?: string;
  text: string;
  /** Selector or resolver for the element (or rect) to spotlight; none = card only. */
  target?: string | (() => Element | SpotRect | null);
  /** The action; `signal` aborts when the user moves on (next/back/skip) mid-step. */
  run?: (signal: AbortSignal) => Promise<void> | void;
  /** Floor on how long the caption stays up when audio cannot play. */
  minMs?: number;
}

export interface TourPlayer {
  play(id: string, text: string, signal: AbortSignal, minMs?: number): Promise<void>;
  preload?(id: string): void;
  /** Called on the first user gesture so browsers allow later autoplay. */
  unlock?(): void;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type TourEndReason = 'done' | 'skip';

export interface TourEngineOptions {
  player: TourPlayer;
  spotlight?: (step: TourStep, index: number, phase: 'before' | 'after') => void;
  onStep?: (step: TourStep, index: number) => void;
  onDone?: (reason: TourEndReason) => void;
  onError?: (err: unknown, step: TourStep) => void;
  store?: KeyValueStore | null;
  storeKey?: string;
}

/** How long a caption stays up when the clip cannot play: reading pace, floored. */
export function fallbackMs(text: string, minMs = 0, wordsPerSecond = 2.5): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(minMs, Math.round((words / wordsPerSecond) * 1000));
}

export class TourEngine {
  readonly steps: TourStep[];
  index = -1;
  running = false;
  /** 'acting' while a step's action runs; 'playing' while its clip plays. */
  phase: 'idle' | 'acting' | 'playing' = 'idle';
  private ctrl: AbortController | null = null;
  private seq = 0;
  private readonly o: TourEngineOptions;

  constructor(steps: TourStep[], options: TourEngineOptions) {
    this.steps = steps;
    this.o = options;
  }

  get current(): TourStep | undefined {
    return this.steps[this.index];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.goto(0);
  }

  next(): void {
    if (!this.running) return;
    if (this.index + 1 >= this.steps.length) this.finish('done');
    else void this.goto(this.index + 1);
  }

  back(): void {
    if (!this.running || this.index <= 0) return;
    void this.goto(this.index - 1);
  }

  skip(): void {
    if (!this.running) return;
    this.finish('skip');
  }

  private async goto(i: number): Promise<void> {
    const seq = ++this.seq;
    this.ctrl?.abort();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.index = i;
    const step = this.steps[i];
    if (!step) { this.finish('done'); return; }
    this.o.onStep?.(step, i);
    this.o.spotlight?.(step, i, 'before');
    this.phase = 'acting';
    try {
      await step.run?.(ctrl.signal);
    } catch (err) {
      this.o.onError?.(err, step);
    }
    if (seq !== this.seq || !this.running) return;
    this.o.spotlight?.(step, i, 'after');
    const nextStep = this.steps[i + 1];
    if (nextStep) this.o.player.preload?.(nextStep.id);
    this.phase = 'playing';
    try {
      await this.o.player.play(step.id, step.text, ctrl.signal, step.minMs);
    } catch (err) {
      this.o.onError?.(err, step);
    }
    if (seq !== this.seq || !this.running) return;
    this.next();
  }

  private finish(reason: TourEndReason): void {
    this.running = false;
    this.phase = 'idle';
    this.seq++;
    this.ctrl?.abort();
    this.ctrl = null;
    markTourDone(this.o.store ?? null, this.o.storeKey ?? TOUR_KEY);
    this.o.onDone?.(reason);
  }
}
