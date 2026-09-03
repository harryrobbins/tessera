import { TourEngine, type TourStep } from './engine';
import { AudioPlayer } from './player';
import { TourUI, type TourChoice } from './ui';
import type { TourHost } from './actions';
import { buildStepsFor } from './steps';
import { tourScript, TOUR_SCRIPTS } from './script';
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

export interface StartTourOptions {
  /** Open regardless of the first-visit gate (the Tour button, the console). */
  force?: boolean;
  /** Which of `TOUR_SCRIPTS` to narrate; unknown or absent means the default. */
  tourId?: string;
}

/**
 * Open the tour: a welcome card first, then the steps once Start is clicked.
 *
 * The tour id chooses the steps *and* the clip directory from the one place
 * that knows both, so a tour can never narrate one collection in another's
 * voice. Auto-start is unaffected: it opens the default tour, as it always has.
 */
export function startTour(host: TourHost, opts: StartTourOptions = {}): TourController {
  if (active) return controller();
  if (!opts.force && !shouldAutoStart(new URLSearchParams(location.search))) return controller();

  // Naming a tour skips the question; otherwise the welcome card asks, because
  // the tours narrate different collections and the visitor is the one who
  // knows which they came to see.
  const choices: TourChoice[] = opts.tourId
    ? []
    : TOUR_SCRIPTS.map((t) => ({ id: t.id, label: t.label, blurb: t.blurb }));

  let engine: TourEngine | null = null;
  // The clip directory follows the choice, so the player cannot be built until
  // Start is clicked — which is also the user gesture `unlock()` needs.
  let player: AudioPlayer | null = null;
  const ui = new TourUI(document.body, {
    onNext: () => engine?.next(),
    onBack: () => engine?.back(),
    onSkip: () => (engine ? engine.skip() : dismiss()),
    onMute: () => player?.setMuted(!player.muted),
  });

  const close = () => {
    ui.destroy();
    player?.dispose();
    active = null;
  };
  const dismiss = () => { markTourDone(); close(); };
  active = { engine: null, ui, close };

  ui.showWelcome(
    (chosen) => {
      const script = tourScript(chosen ?? opts.tourId);
      player = new AudioPlayer({ base: script.audioBase });
      player.onMutedChange = (m) => ui.setMuted(m);
      ui.setMuted(player.muted);
      player.unlock();
      const steps: TourStep[] = buildStepsFor(script.id, host);
      engine = new TourEngine(steps, {
        player,
        spotlight: (step, i, phase) => (phase === 'before' ? ui.showStep(step, i, steps.length) : ui.spotlight(step)),
        onDone: () => close(),
        onError: (err, step) => console.warn(`[tour] step "${step.id}" action failed:`, err),
        store: safeStorage(),
        // One key for both tours, not one each: it gates the first-visit
        // auto-open, and someone who has been shown around either collection
        // has been onboarded — a second welcome card would be a nag.
        storeKey: TOUR_KEY,
      });
      if (active) active.engine = engine;
      engine.start();
    },
    dismiss,
    choices,
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
    tessera?: { tour: TourController & { start(force?: boolean, tourId?: string): TourController } };
  }
}

/** Expose a handle for the e2e script and the console. */
export function exposeTour(host: TourHost): void {
  const c = controller();
  window.tessera = {
    tour: Object.assign(c, { start: (force = true, tourId?: string) => startTour(host, { force, tourId }) }),
  };
}
