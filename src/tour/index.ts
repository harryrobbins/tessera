import { TourEngine, type TourStep } from './engine';
import { AudioPlayer } from './player';
import { TourUI } from './ui';
import { buildSteps, type TourHost } from './actions';
import { TOUR_KEY, safeStorage, markTourDone } from './store';

export { TOUR_KEY };

export interface TourController {
  readonly open: boolean;
  readonly index: number;
  readonly stepId: string | null;
  readonly running: boolean;
  /** 'acting' while the step's action runs, 'playing' once the caption is up. */
  readonly phase: 'idle' | 'acting' | 'playing';
  next(): void;
  back(): void;
  skip(): void;
}

let active: { engine: TourEngine | null; ui: TourUI; close(): void } | null = null;

/**
 * Auto-open on a first visit: `?tour=1` forces it; otherwise only when the
 * visitor has never finished or dismissed it, and is not deep-linking or
 * benchmarking.
 */
export function shouldAutoStart(
  params: URLSearchParams,
  storage: { getItem(k: string): string | null } | null = safeStorage(),
): boolean {
  if (params.get('tour') === '1') return true;
  if (params.get('tour') === '0') return false;
  if (params.get('bench') === '1' || params.has('dataset')) return false;
  try { return (storage?.getItem(TOUR_KEY) ?? null) === null; } catch { return true; }
}

/** Open the tour: a welcome card first, then the steps once Start is clicked. */
export function startTour(host: TourHost, opts: { force?: boolean } = {}): TourController {
  if (active) return controller();
  if (!opts.force && !shouldAutoStart(new URLSearchParams(location.search))) return controller();

  const player = new AudioPlayer();
  let engine: TourEngine | null = null;
  const ui = new TourUI(document.body, {
    onNext: () => engine?.next(),
    onBack: () => engine?.back(),
    onSkip: () => (engine ? engine.skip() : dismiss()),
    onMute: () => player.setMuted(!player.muted),
  });
  ui.setMuted(player.muted);
  player.onMutedChange = (m) => ui.setMuted(m);

  const close = () => {
    ui.destroy();
    player.dispose();
    active = null;
  };
  const dismiss = () => { markTourDone(); close(); };
  active = { engine: null, ui, close };

  ui.showWelcome(
    () => {
      player.unlock();
      const steps: TourStep[] = buildSteps(host);
      engine = new TourEngine(steps, {
        player,
        spotlight: (step, i, phase) => (phase === 'before' ? ui.showStep(step, i, steps.length) : ui.spotlight(step)),
        onDone: () => close(),
        onError: (err, step) => console.warn(`[tour] step "${step.id}" action failed:`, err),
        store: safeStorage(),
        storeKey: TOUR_KEY,
      });
      if (active) active.engine = engine;
      engine.start();
    },
    dismiss,
  );
  return controller();
}

function controller(): TourController {
  return {
    get open() { return active !== null; },
    get index() { return active?.engine?.index ?? -1; },
    get stepId() { return active?.engine?.current?.id ?? null; },
    get running() { return active?.engine?.running ?? false; },
    get phase() { return active?.engine?.phase ?? 'idle'; },
    next: () => active?.engine?.next(),
    back: () => active?.engine?.back(),
    skip: () => (active?.engine ? active.engine.skip() : active?.close()),
  };
}

declare global {
  interface Window {
    tessera?: { tour: TourController & { start(force?: boolean): TourController } };
  }
}

/** Expose a handle for the e2e script and the console. */
export function exposeTour(host: TourHost): void {
  const c = controller();
  window.tessera = {
    tour: Object.assign(c, { start: (force = true) => startTour(host, { force }) }),
  };
}
