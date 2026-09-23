import type { LayoutData, LayoutSpec, LayoutResult } from './layouts';
import type { WorkerRequest, WorkerResponse } from './worker';

export interface LayoutSolution {
  positions: Float32Array;
  bounds: LayoutResult['bounds'];
  visible: number;
  /** World units per card cell (see LayoutResult.pitch). */
  pitch: number;
  /** World units a card is drawn at (see LayoutResult.cardSize). */
  cardSize: number;
  xAxis?: LayoutResult['xAxis'];
  yAxis?: LayoutResult['yAxis'];
  solveMs: number;
}

/** What `PivotApp` needs from a layout engine: the worker client below, the
 *  in-thread `InlineLayoutEngine`, or the `ResilientLayoutEngine` that starts on
 *  one and falls back to the other (`./engine.ts`). */
export interface LayoutEngineLike {
  /** Where solves run now. */
  readonly kind: 'worker' | 'inline';
  load(data: LayoutData): Promise<void>;
  solve(spec: LayoutSpec, mask: Uint8Array | null, aspect: number): Promise<LayoutSolution>;
  dispose(): void;
}

/**
 * Main-thread handle on the layout worker. Only the newest request is honoured.
 *
 * The worker is *given*, not built here: a worker constructed from a URL
 * relative to the module is bundler syntax, and the library must bundle as-is
 * under esbuild. The Vite demo passes that expression from `main.ts`; an
 * embedder passes whatever its sandbox allows (a `data:` URL worker).
 */
export class LayoutEngine implements LayoutEngineLike {
  readonly kind = 'worker' as const;
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (s: LayoutSolution) => void; reject: (e: Error) => void }>();
  /** Outstanding `load` calls by id: each resolves on its own `loaded` reply,
   *  so two quick dataset changes both settle instead of the first hanging. */
  private loading = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  /** The newest load; `solve` waits on this one. */
  private loaded: Promise<void> = Promise.resolve();

  /** Fired on a worker-level `error` event, after pending requests are rejected. */
  onFatal?: (err: Error) => void;
  /** Fired on the first reply of any kind: the worker is evidently alive. */
  onAlive?: () => void;
  private alive = false;

  constructor(createWorker: () => Worker) {
    this.worker = createWorker();
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (!this.alive) { this.alive = true; this.onAlive?.(); }
      if (msg.type === 'loaded') {
        const done = this.loading.get(msg.id);
        this.loading.delete(msg.id);
        done?.resolve();
        return;
      }
      if (msg.type === 'error' && this.loading.has(msg.id)) {
        const done = this.loading.get(msg.id)!;
        this.loading.delete(msg.id);
        done.reject(new Error(msg.message));
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === 'error') { p.reject(new Error(msg.message)); return; }
      p.resolve({
        positions: msg.positions,
        bounds: msg.bounds,
        visible: msg.visible,
        pitch: msg.pitch,
        cardSize: msg.cardSize,
        xAxis: msg.xAxis,
        yAxis: msg.yAxis,
        solveMs: msg.solveMs,
      });
    };
    // A failure outside the per-request try/catch (module load, a bad
    // structured clone, OOM while loading) would otherwise leave every
    // pending load and solve hanging — and every later solve, which awaits
    // `loaded`, with it.
    this.worker.onerror = (e) => {
      const err = new Error(`layout worker failed: ${e.message || 'unknown error'}`);
      for (const l of this.loading.values()) l.reject(err);
      this.loading.clear();
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.onFatal?.(err);
    };
  }

  /** Ship the columns to the worker. Arrays are cloned, not transferred: the
   *  main thread still needs them for the detail pane and colouring. */
  load(data: LayoutData): Promise<void> {
    const id = this.nextId++;
    this.loaded = new Promise<void>((resolve, reject) => { this.loading.set(id, { resolve, reject }); });
    // A rejected load is reported to its caller; `solve` re-raises it per call.
    this.loaded.catch(() => {});
    this.worker.postMessage({ type: 'load', id, data } satisfies WorkerRequest);
    return this.loaded;
  }

  async solve(spec: LayoutSpec, mask: Uint8Array | null, aspect: number): Promise<LayoutSolution> {
    await this.loaded;
    const id = this.nextId++;
    return new Promise<LayoutSolution>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'layout', id, spec, mask, aspect } satisfies WorkerRequest);
    });
  }

  /** Stops the worker and rejects every outstanding load and solve, which
   *  would otherwise never settle. */
  dispose() {
    this.worker.terminate();
    const err = new Error('disposed');
    for (const l of this.loading.values()) l.reject(err);
    this.loading.clear();
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
