import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { LayoutData } from '../src/layout/layouts';
import type { WorkerRequest, WorkerResponse } from '../src/layout/worker';

/**
 * A fake Worker that records requests and lets the test answer them in any
 * order — the real one is a module worker vitest cannot spin up in node.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  sent: WorkerRequest[] = [];
  terminated = false;
  constructor(_url: URL, _opts?: WorkerOptions) { FakeWorker.instances.push(this); }
  postMessage(msg: WorkerRequest) { this.sent.push(msg); }
  terminate() { this.terminated = true; }
  reply(msg: WorkerResponse) { this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>); }
  /** Answer a layout request with a trivial solution. */
  solve(id: number, visible = 1) {
    this.reply({
      type: 'layout', id, positions: new Float32Array(4 * visible),
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, visible, pitch: 1, cardSize: 0.86, solveMs: 0.5,
    });
  }
}

const data = (n: number): LayoutData => ({ n, columns: {} });
const tick = () => new Promise((r) => setTimeout(r, 0));

let LayoutEngine: typeof import('../src/layout/client').LayoutEngine;
const realWorker = (globalThis as { Worker?: unknown }).Worker;

beforeEach(async () => {
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  FakeWorker.instances = [];
  ({ LayoutEngine } = await import('../src/layout/client'));
});
afterEach(() => { (globalThis as { Worker?: unknown }).Worker = realWorker; });

describe('LayoutEngine.load', () => {
  it('keys each load by id so two quick loads both resolve (D-05)', async () => {
    const engine = new LayoutEngine();
    const w = FakeWorker.instances[0];
    const settled: string[] = [];
    const a = engine.load(data(10)).then(() => settled.push('a'));
    const b = engine.load(data(20)).then(() => settled.push('b'));
    const [ra, rb] = w.sent as Extract<WorkerRequest, { type: 'load' }>[];
    expect(ra.id).not.toBe(rb.id);
    // The worker answers in order; the first reply must settle the first load,
    // not the second.
    w.reply({ type: 'loaded', id: ra.id, n: 10 });
    await tick();
    expect(settled).toEqual(['a']);
    w.reply({ type: 'loaded', id: rb.id, n: 20 });
    await Promise.all([a, b]);
    expect(settled).toEqual(['a', 'b']);
    engine.dispose();
    expect(w.terminated).toBe(true);
  });

  it('ignores a loaded reply for an unknown id', async () => {
    const engine = new LayoutEngine();
    const w = FakeWorker.instances[0];
    let done = false;
    const p = engine.load(data(1)).then(() => { done = true; });
    w.reply({ type: 'loaded', id: 999, n: 1 });
    await tick();
    expect(done).toBe(false);
    w.reply({ type: 'loaded', id: (w.sent[0] as { id: number }).id, n: 1 });
    await p;
    expect(done).toBe(true);
  });
});

describe('LayoutEngine.solve', () => {
  it('waits for the newest load before posting the layout request', async () => {
    const engine = new LayoutEngine();
    const w = FakeWorker.instances[0];
    void engine.load(data(5));
    const p = engine.solve({ type: 'grid' }, null, 1.5);
    await tick();
    expect(w.sent.filter((m) => m.type === 'layout')).toHaveLength(0);
    w.reply({ type: 'loaded', id: (w.sent[0] as { id: number }).id, n: 5 });
    await tick();
    const req = w.sent.find((m) => m.type === 'layout') as Extract<WorkerRequest, { type: 'layout' }>;
    expect(req).toBeDefined();
    expect(req.aspect).toBe(1.5);
    w.solve(req.id, 5);
    const sol = await p;
    expect(sol.visible).toBe(5);
    expect(sol.solveMs).toBe(0.5);
  });

  it('resolves each request by id even when replies arrive out of order', async () => {
    const engine = new LayoutEngine();
    const w = FakeWorker.instances[0];
    const p1 = engine.solve({ type: 'grid' }, null, 1);
    const p2 = engine.solve({ type: 'grid', sortBy: 'x' }, null, 1);
    await tick();
    const [r1, r2] = w.sent as Extract<WorkerRequest, { type: 'layout' }>[];
    w.solve(r2.id, 2);
    w.solve(r1.id, 1);
    expect((await p1).visible).toBe(1);
    expect((await p2).visible).toBe(2);
  });
});

describe('LayoutEngine error handling (D-04)', () => {
  it('rejects the pending solve when the worker replies with an error', async () => {
    const engine = new LayoutEngine();
    const w = FakeWorker.instances[0];
    const p = engine.solve({ type: 'bars', by: 'nope' }, null, 1);
    await tick();
    const req = w.sent[0] as Extract<WorkerRequest, { type: 'layout' }>;
    w.reply({ type: 'error', id: req.id, message: 'unknown column nope' });
    await expect(p).rejects.toThrow('unknown column nope');
  });

  it('rejects every pending solve on a worker-level error event', async () => {
    const engine = new LayoutEngine();
    const w = FakeWorker.instances[0];
    const p1 = engine.solve({ type: 'grid' }, null, 1);
    const p2 = engine.solve({ type: 'grid' }, null, 1);
    await tick();
    w.onerror?.({ message: 'boom' } as ErrorEvent);
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');
  });

  it('carries the layout pitch through to the solution', async () => {
    const engine = new LayoutEngine();
    const w = FakeWorker.instances[0];
    const p = engine.solve({ type: 'grid' }, null, 1);
    await tick();
    w.solve((w.sent[0] as { id: number }).id, 3);
    expect((await p).pitch).toBe(1);
  });

  it('rejects a pending load on a worker-level error, and later solves with it (M-11)', async () => {
    const engine = new LayoutEngine();
    const w = FakeWorker.instances[0];
    const load = engine.load(data(1_000_000));
    const solve = engine.solve({ type: 'grid' }, null, 1);
    await tick();
    w.onerror?.({ message: 'out of memory' } as ErrorEvent);
    await expect(load).rejects.toThrow('out of memory');
    await expect(solve).rejects.toThrow('out of memory');
    // The engine is not wedged: a fresh load settles normally.
    const again = engine.load(data(3));
    await tick();
    const req = w.sent[w.sent.length - 1] as { id: number };
    w.reply({ type: 'loaded', id: req.id, n: 3 });
    await expect(again).resolves.toBeUndefined();
  });

  it('rejects a load when the worker answers it with an error reply', async () => {
    const engine = new LayoutEngine();
    const w = FakeWorker.instances[0];
    const load = engine.load(data(2));
    await tick();
    const req = w.sent[0] as { id: number };
    w.reply({ type: 'error', id: req.id, message: 'bad clone' });
    await expect(load).rejects.toThrow('bad clone');
  });
});
