import type { LayoutData, LayoutSpec, LayoutResult } from './layouts';
import type { WorkerRequest, WorkerResponse } from './worker';

export interface LayoutSolution {
  positions: Float32Array;
  bounds: LayoutResult['bounds'];
  visible: number;
  xAxis?: LayoutResult['xAxis'];
  yAxis?: LayoutResult['yAxis'];
  solveMs: number;
}

/** Main-thread handle on the layout worker. Only the newest request is honoured. */
export class LayoutEngine {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, (s: LayoutSolution) => void>();
  private loadedResolve: (() => void) | null = null;
  private loaded: Promise<void> = Promise.resolve();

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'loaded') { this.loadedResolve?.(); return; }
      const fn = this.pending.get(msg.id);
      if (!fn) return;
      this.pending.delete(msg.id);
      fn({
        positions: msg.positions,
        bounds: msg.bounds,
        visible: msg.visible,
        xAxis: msg.xAxis,
        yAxis: msg.yAxis,
        solveMs: msg.solveMs,
      });
    };
  }

  /** Ship the columns to the worker. Arrays are cloned, not transferred: the
   *  main thread still needs them for the detail pane and colouring. */
  load(data: LayoutData): Promise<void> {
    this.loaded = new Promise((res) => { this.loadedResolve = res; });
    this.worker.postMessage({ type: 'load', data } satisfies WorkerRequest);
    return this.loaded;
  }

  async solve(spec: LayoutSpec, mask: Uint8Array | null, aspect: number): Promise<LayoutSolution> {
    await this.loaded;
    const id = this.nextId++;
    return new Promise<LayoutSolution>((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ type: 'layout', id, spec, mask, aspect } satisfies WorkerRequest);
    });
  }

  dispose() { this.worker.terminate(); }
}
