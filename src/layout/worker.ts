/// <reference lib="webworker" />
/**
 * Layout worker. Owns a copy of the columnar data (typed arrays, structured-cloned
 * once) and returns target positions as a transferable Float32Array, so the main
 * thread never blocks on a re-sort.
 */
import { computeLayout, type LayoutData, type LayoutSpec, type LayoutResult } from './layouts';

let data: LayoutData | null = null;

export type WorkerRequest =
  | { type: 'load'; data: LayoutData }
  | { type: 'layout'; id: number; spec: LayoutSpec; mask: Uint8Array | null; aspect: number };

export type WorkerResponse =
  | { type: 'loaded'; n: number }
  | {
      type: 'layout';
      id: number;
      positions: Float32Array;
      bounds: LayoutResult['bounds'];
      visible: number;
      xAxis?: LayoutResult['xAxis'];
      yAxis?: LayoutResult['yAxis'];
      solveMs: number;
    };

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'load') {
    data = msg.data;
    (self as unknown as Worker).postMessage({ type: 'loaded', n: data.n } satisfies WorkerResponse);
    return;
  }
  if (msg.type === 'layout') {
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
      xAxis: r.xAxis,
      yAxis: r.yAxis,
      solveMs,
    };
    (self as unknown as Worker).postMessage(res, [r.positions.buffer]);
  }
};
