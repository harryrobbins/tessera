import { describe, it, expect, vi, afterEach } from 'vitest';
import { InlineLayoutEngine, ResilientLayoutEngine } from '../src/layout/engine';
import type { LayoutData } from '../src/layout/layouts';
import type { WorkerRequest, WorkerResponse } from '../src/layout/worker';

class FakeWorker {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  sent: WorkerRequest[] = [];
  terminated = false;
  postMessage(msg: WorkerRequest) { this.sent.push(msg); }
  terminate() { this.terminated = true; }
  reply(msg: WorkerResponse) { this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>); }
}

const data = (n: number): LayoutData => ({ n, columns: {} });
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { vi.useRealTimers(); });

describe('InlineLayoutEngine', () => {
  it('solves a grid in-thread', async () => {
    const e = new InlineLayoutEngine();
    await e.load(data(9));
    const sol = await e.solve({ type: 'grid' }, null, 1);
    expect(sol.visible).toBe(9);
    expect(sol.positions.length).toBeGreaterThan(0);
    expect(e.kind).toBe('inline');
  });

  it('rejects a solve before any load', async () => {
    await expect(new InlineLayoutEngine().solve({ type: 'grid' }, null, 1)).rejects.toThrow(/before load/);
  });
});

describe('ResilientLayoutEngine fallback', () => {
  it('is inline with no factory', async () => {
    const e = new ResilientLayoutEngine(undefined);
    expect(e.kind).toBe('inline');
    await e.load(data(4));
    expect((await e.solve({ type: 'grid' }, null, 1)).visible).toBe(4);
  });

  it('falls back when the factory throws', async () => {
    const onFallback = vi.fn();
    const e = new ResilientLayoutEngine(() => { throw new Error('CSP says no'); }, { onFallback });
    expect(e.kind).toBe('inline');
    expect(onFallback).toHaveBeenCalledWith(expect.stringContaining('CSP says no'));
    await e.load(data(3));
    expect((await e.solve({ type: 'grid' }, null, 1)).visible).toBe(3);
  });

  it('falls back on an error event before the first reply, and replays the waiting requests', async () => {
    const w = new FakeWorker();
    const e = new ResilientLayoutEngine(() => w as unknown as Worker);
    expect(e.kind).toBe('worker');
    const load = e.load(data(5));
    const solve = e.solve({ type: 'grid' }, null, 1);
    await tick();
    w.onerror?.({ message: 'refused' } as ErrorEvent);
    await expect(load).resolves.toBeUndefined();
    expect((await solve).visible).toBe(5);
    expect(e.kind).toBe('inline');
    expect(w.terminated).toBe(true);
    expect(e.fallbackReason).toMatch(/refused/);
  });

  it('falls back after the timeout when the worker never answers', async () => {
    vi.useFakeTimers();
    const w = new FakeWorker();
    const e = new ResilientLayoutEngine(() => w as unknown as Worker, { timeoutMs: 3000 });
    const load = e.load(data(6));
    const solve = e.solve({ type: 'grid' }, null, 1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(e.kind).toBe('worker');
    await vi.advanceTimersByTimeAsync(2);
    expect(e.kind).toBe('inline');
    await load;
    expect((await solve).visible).toBe(6);
  });

  it('keeps the worker once it has replied; later errors are ordinary errors', async () => {
    vi.useFakeTimers();
    const w = new FakeWorker();
    const e = new ResilientLayoutEngine(() => w as unknown as Worker, { timeoutMs: 3000 });
    const load = e.load(data(2));
    await vi.advanceTimersByTimeAsync(0);
    w.reply({ type: 'loaded', id: (w.sent[0] as { id: number }).id, n: 2 });
    await load;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(e.kind).toBe('worker');
    const solve = e.solve({ type: 'bars', by: 'nope' }, null, 1);
    await vi.advanceTimersByTimeAsync(0);
    const req = w.sent.find((m) => m.type === 'layout') as { id: number };
    w.reply({ type: 'error', id: req.id, message: 'unknown column nope' });
    await expect(solve).rejects.toThrow('unknown column nope');
    expect(e.kind).toBe('worker');
  });
});
