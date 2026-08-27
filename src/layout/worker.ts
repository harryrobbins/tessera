/// <reference lib="webworker" />
/**
 * Layout worker. Owns a copy of the columnar data (typed arrays, structured-cloned
 * once) and returns target positions as a transferable Float32Array, so the main
 * thread never blocks on a re-sort.
 */
import { computeLayout, type LayoutData, type LayoutSpec, type LayoutResult } from './layouts';

let data: LayoutData | null = null;

export type WorkerRequest =
  | { type: 'load'; id: number; data: LayoutData }
  | { type: 'layout'; id: number; spec: LayoutSpec; mask: Uint8Array | null; aspect: number };

export type WorkerResponse =
  | { type: 'loaded'; id: number; n: number }
  | {
      type: 'layout';
      id: number;
      positions: Float32Array;
      bounds: LayoutResult['bounds'];
      visible: number;
      pitch: number;
      cardSize: number;
      xAxis?: LayoutResult['xAxis'];
      yAxis?: LayoutResult['yAxis'];
      solveMs: number;
    }
  | { type: 'error'; id: number; message: string };

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'load') {
    data = msg.data;
    (self as unknown as Worker).postMessage({ type: 'loaded', id: msg.id, n: data.n } satisfies WorkerResponse);
    return;
  }
  if (msg.type === 'layout') {
    // A throw here would surface only as a worker `error` event and leave the
    // caller's promise pending forever; report it as a reply instead.
    try {
      if (!data) throw new Error('layout requested before load');
      const t0 = performance.now();
      const r = computeLayout(data, msg.spec, msg.mask, msg.aspect);
      const solveMs = performance.now() - t0;
      const res: WorkerResponse = {
        type: 'layout',
        id: msg.id,
        positions: r.positions,
        bounds: r.bounds,
        visible: r.visible,
        pitch: r.pitch,
        cardSize: r.cardSize,
        xAxis: r.xAxis,
        yAxis: r.yAxis,
        solveMs,
      };
      (self as unknown as Worker).postMessage(res, [r.positions.buffer]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      (self as unknown as Worker).postMessage({ type: 'error', id: msg.id, message } satisfies WorkerResponse);
    }
  }
};
