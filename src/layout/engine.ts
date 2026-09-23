/**
 * Layout engines that do not need a bundler's worker syntax.
 *
 * `InlineLayoutEngine` runs `computeLayout` on the main thread. It blocks the
 * page for the length of a solve (tens of ms at 100k cards), which is the
 * price of working anywhere — including a sandboxed iframe whose CSP refuses
 * the worker.
 *
 * `ResilientLayoutEngine` starts on a worker and falls back to the inline
 * engine when the worker never gets going. A worker failure is asynchronous —
 * a CSP refusal or a bad module fires `error` and never throws — so there are
 * three triggers: the factory throws, `error` fires before the first reply, or
 * nothing has answered within `timeoutMs` of the first request. On switching,
 * the newest load is replayed inline and every request still waiting on the
 * worker is answered by the inline engine instead, so the solve the app is
 * awaiting still lands.
 */
import { computeLayout, type LayoutData, type LayoutSpec } from './layouts';
import { LayoutEngine, type LayoutEngineLike, type LayoutSolution } from './client';

export class InlineLayoutEngine implements LayoutEngineLike {
  readonly kind = 'inline' as const;
  private data: LayoutData | null = null;

  load(data: LayoutData): Promise<void> {
    this.data = data;
    return Promise.resolve();
  }

  /** Synchronous under the hood; async so it is a drop-in for the worker. */
  async solve(spec: LayoutSpec, mask: Uint8Array | null, aspect: number): Promise<LayoutSolution> {
    if (!this.data) throw new Error('layout requested before load');
    const t0 = performance.now();
    const r = computeLayout(this.data, spec, mask, aspect);
    return {
      positions: r.positions,
      bounds: r.bounds,
      visible: r.visible,
      pitch: r.pitch,
      cardSize: r.cardSize,
      xAxis: r.xAxis,
      yAxis: r.yAxis,
      solveMs: performance.now() - t0,
    };
  }

  dispose(): void { this.data = null; }
}

/** A request still waiting on the worker, and how to answer it inline instead. */
interface Waiting {
  fallback: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export interface ResilientOptions {
  /** How long the first request may wait for any reply before the worker is
   *  written off. Default 3000 ms. */
  timeoutMs?: number;
  /** Told once, when the engine switches to inline, with the reason. */
  onFallback?: (reason: string) => void;
}

export class ResilientLayoutEngine implements LayoutEngineLike {
  private worker: LayoutEngine | null = null;
  private readonly inline = new InlineLayoutEngine();
  /** Once the worker has replied it is trusted; later failures are ordinary errors. */
  private confirmed = false;
  private lastData: LayoutData | null = null;
  private waiting = new Set<Waiting>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly timeoutMs: number;
  private readonly onFallback?: (reason: string) => void;
  /** Why the worker was abandoned, or null while it is in use. */
  fallbackReason: string | null = null;

  constructor(createWorker: (() => Worker) | null | undefined, opts: ResilientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.onFallback = opts.onFallback;
    if (!createWorker) { this.fallbackReason = 'no worker factory'; return; }
    try {
      const w = new LayoutEngine(createWorker);
      w.onAlive = () => {
        this.confirmed = true;
        this.clearTimer();
      };
      w.onFatal = (err) => { if (!this.confirmed) this.fallBack(err.message); };
      this.worker = w;
    } catch (err) {
      this.fallbackReason = `worker factory threw: ${err instanceof Error ? err.message : String(err)}`;
      this.onFallback?.(this.fallbackReason);
    }
  }

  get kind(): 'worker' | 'inline' { return this.worker ? 'worker' : 'inline'; }

  load(data: LayoutData): Promise<void> {
    this.lastData = data;
    if (!this.worker) return this.inline.load(data);
    // The inline answer to a load is simply to hold the newest data, which
    // `fallBack` already does before it answers anything.
    return this.viaWorker(() => this.worker!.load(data), () => Promise.resolve()) as Promise<void>;
  }

  solve(spec: LayoutSpec, mask: Uint8Array | null, aspect: number): Promise<LayoutSolution> {
    if (!this.worker) return this.inline.solve(spec, mask, aspect);
    return this.viaWorker(
      () => this.worker!.solve(spec, mask, aspect),
      () => this.inline.solve(spec, mask, aspect),
    ) as Promise<LayoutSolution>;
  }

  private viaWorker(run: () => Promise<unknown>, fallback: () => Promise<unknown>): Promise<unknown> {
    if (this.confirmed) return run();
    return new Promise((resolve, reject) => {
      const w: Waiting = { fallback, resolve, reject };
      this.waiting.add(w);
      this.armTimer();
      run().then(
        (v) => { if (this.waiting.delete(w)) resolve(v); },
        (e) => {
          // Before confirmation a rejection is the worker failing to start:
          // `fallBack` (via onFatal) answers this request inline. A request the
          // worker itself rejected with a reply is a real error.
          if (!this.waiting.has(w)) return;
          if (this.confirmed) { this.waiting.delete(w); reject(e); }
        },
      );
    });
  }

  private armTimer() {
    if (this.timer || this.confirmed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.confirmed) this.fallBack(`no reply from the layout worker within ${this.timeoutMs} ms`);
    }, this.timeoutMs);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private fallBack(reason: string) {
    if (!this.worker) return;
    this.clearTimer();
    this.fallbackReason = reason;
    try { this.worker.dispose(); } catch { /* already dead */ }
    this.worker = null;
    if (this.lastData) void this.inline.load(this.lastData);
    // Answer everything the app is still awaiting, oldest first; the app
    // ignores superseded solves itself, so replaying them all is harmless.
    const queued = [...this.waiting];
    this.waiting.clear();
    for (const w of queued) w.fallback().then(w.resolve, w.reject);
    this.onFallback?.(reason);
  }

  dispose(): void {
    this.clearTimer();
    this.worker?.dispose();
    this.worker = null;
    this.inline.dispose();
    for (const w of this.waiting) w.reject(new Error('layout engine disposed'));
    this.waiting.clear();
  }
}
