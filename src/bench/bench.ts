import { FrameStats } from '../ui/hud';
import type { PivotApp } from '../app';

export interface PhaseResult {
  name: string;
  frames: number;
  ms: number;
  /** Frames per second actually presented (wall clock, GPU-paced). */
  fps: number;
  p50: number;
  p95: number;
  worst: number;
  /** GPU time for the card draw, from timer queries. -1 when unsupported. */
  gpuP50: number;
  gpuP95: number;
}

export interface RunResult {
  dataset: string;
  n: number;
  phases: PhaseResult[];
  layoutSolveMs: Record<string, number>;
}

export interface BenchResult {
  env: Record<string, unknown>;
  runs: RunResult[];
}

/** Frames discarded at the start of a phase, while caches and the GPU pipeline fill. */
const WARMUP_FRAMES = 5;

function collectEnv(app: PivotApp): Record<string, unknown> {
  const gl = app.renderer.gl;
  return {
    userAgent: navigator.userAgent,
    renderer: app.renderer.gpuHint,
    glVersion: gl.getParameter(gl.VERSION),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    devicePixelRatio: window.devicePixelRatio,
    canvas: [app.canvas.width, app.canvas.height],
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    screen: [screen.width, screen.height],
  };
}

/** Run one measured phase: pump `drive` every frame for `durationMs`, timing each. */
function phase(
  app: PivotApp,
  name: string,
  durationMs: number,
  drive?: (progress: number, dtMs: number) => void,
  signal?: AbortSignal,
): Promise<PhaseResult> {
  return new Promise((resolve, reject) => {
    const stats = new FrameStats(8192);
    const gpu = new FrameStats(8192);
    let elapsed = 0;
    let seen = 0;
    const hook = (dt: number) => {
      if (signal?.aborted) { app.frameHooks.delete(hook); reject(new BenchCancelled()); return; }
      seen++;
      elapsed += dt;
      drive?.(Math.min(1, elapsed / durationMs), dt);
      if (seen > WARMUP_FRAMES) {
        stats.push(dt);
        if (app.renderer.gpuMs >= 0) gpu.push(app.renderer.gpuMs);
      }
      if (elapsed >= durationMs) {
        app.frameHooks.delete(hook);
        resolve({
          name,
          frames: stats.count,
          ms: elapsed,
          fps: stats.fps(),
          p50: stats.percentile(0.5),
          p95: stats.percentile(0.95),
          worst: stats.worst(),
          gpuP50: gpu.count ? gpu.percentile(0.5) : -1,
          gpuP95: gpu.count ? gpu.percentile(0.95) : -1,
        });
      }
    };
    app.frameHooks.add(hook);
  });
}

/** Thrown by `runBench` when the caller cancels the suite mid-run. */
export class BenchCancelled extends Error {
  constructor() { super('benchmark cancelled'); this.name = 'BenchCancelled'; }
}

export interface BenchOptions {
  sizes?: number[];
  /** Include the small (900-card, per-row atlas) tax-cases target. */
  includeSmall?: boolean;
  /** Per-phase duration. Shorter runs are noisier; 2s is the floor worth trusting. */
  phaseMs?: number;
  onProgress?: (msg: string) => void;
  /**
   * Abort the suite. A run owns the whole app — it swaps the collection out
   * from under the UI four times — so anything else that wants to drive the
   * app (the guided tour) has to be able to stop it. Checked between phases
   * and targets, and inside a phase's frame hook, so a cancel lands within a
   * frame rather than at the end of a two-second window.
   */
  signal?: AbortSignal;
}

/**
 * The standard suite. Every machine runs the same phases so results are
 * comparable: a static frame, a layout morph, a pan, and a zoom sweep.
 */
export async function runBench(app: PivotApp, opts: BenchOptions = {}): Promise<BenchResult> {
  const sizes = opts.sizes ?? [1000, 10_000, 100_000, 500_000, 1_000_000];
  const phaseMs = opts.phaseMs ?? 2200;
  const runs: RunResult[] = [];
  const signal = opts.signal;
  const stop = () => { if (signal?.aborted) throw new BenchCancelled(); };
  const wasContinuous = app.alwaysRender;
  app.alwaysRender = true;

  const targets: Array<{ key: string; n: number }> = [];
  if (opts.includeSmall !== false) targets.push({ key: 'tax-cases:900', n: 900 });
  for (const n of sizes) targets.push({ key: `products:${n}`, n });

  try {
    for (const target of targets) {
      stop();
      opts.onProgress?.(`loading ${target.key}`);
      await app.loadDataset(target.key);
      stop();
      await app.setLayout({ type: 'grid', sortBy: app.defaultSort() });
      app.fit(false);
      await settle(app);

      const solve: Record<string, number> = {};
      const phases: PhaseResult[] = [];

      phases.push(await phase(app, 'static', phaseMs, undefined, signal));

      // Layout morphs: the expensive path — CPU re-solve, 32MB of buffer upload,
      // then every card in flight at once.
      const morph = await phase(app, 'morph', phaseMs * 2, morphDriver(app, solve), signal);
      phases.push(morph);

      await app.setLayout({ type: 'grid', sortBy: app.defaultSort() });
      app.fit(false);
      await settle(app);

      const cam = app.camera;
      const home = { ...cam.target };
      const span = 380 / cam.target.zoom;
      phases.push(await phase(app, 'pan', phaseMs, (p) => {
        cam.target.x = home.x + Math.cos(p * Math.PI * 4) * span;
        cam.target.y = home.y + Math.sin(p * Math.PI * 4) * span * 0.6;
        cam.current.x = cam.target.x;
        cam.current.y = cam.target.y;
      }, signal));
      cam.target = { ...home };
      cam.current = { ...home };

      phases.push(await phase(app, 'zoom', phaseMs, (p) => {
        const k = Math.exp(Math.sin(p * Math.PI * 2) * 2.2);
        cam.target.zoom = home.zoom * k;
        cam.current.zoom = cam.target.zoom;
      }, signal));
      cam.target = { ...home };
      cam.current = { ...home };

      runs.push({ dataset: app.datasetName, n: app.dataset?.n ?? target.n, phases, layoutSolveMs: solve });
      opts.onProgress?.(`${app.datasetName}: ${phases.map((f) => `${f.name} ${f.fps.toFixed(0)}fps`).join('  ')}`);
    }
  } finally {
    app.alwaysRender = wasContinuous;
  }

  return { env: collectEnv(app), runs };
}

/** Cycles grid -> bars -> cross-tab -> grid across the phase window. */
function morphDriver(app: PivotApp, solve: Record<string, number>) {
  const steps = [
    () => app.setLayout({ type: 'bars', by: app.defaultBucket() }),
    () => app.setLayout({ type: 'scatter', x: app.defaultBucket(), y: app.defaultAxisY() }),
    () => app.setLayout({ type: 'grid', sortBy: app.defaultSort() }),
  ];
  let fired = 0;
  return (progress: number) => {
    const want = Math.min(steps.length, Math.floor(progress * (steps.length + 0.4)));
    while (fired < want) {
      const i = fired++;
      void steps[i]().then((sol) => {
        // A superseded solve resolves null: credit only the one that landed.
        if (sol) solve[app.lastLayoutName] = sol.solveMs;
      });
    }
  };
}

function settle(app: PivotApp): Promise<void> {
  return new Promise((resolve) => {
    let n = 0;
    const hook = () => {
      if (++n >= 12) { app.frameHooks.delete(hook); resolve(); }
    };
    app.frameHooks.add(hook);
  });
}
