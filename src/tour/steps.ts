import type { TourStep } from './engine';
import { buildSteps, type TourHost } from './actions';
import { buildBirdSteps } from './birdActions';
import { tourScript } from './script';

/**
 * Which builder narrates which tour. The keys are `TOUR_SCRIPTS` ids; they
 * live here rather than on the script because `script.ts` is loaded by the
 * voiceover generator under Node's type stripping and must stay import-free,
 * and a builder is the one part of a tour that has to reach for the app.
 */
const BUILDERS: Record<string, (host: TourHost) => TourStep[]> = {
  tax: buildSteps,
  birds: buildBirdSteps,
};

/**
 * The steps of one tour. The id is resolved through `tourScript`, so an
 * unknown one falls back to the default tour here and in the audio base
 * together — a tour that played the tax clips over the birds board would be
 * worse than one that quietly played the tax tour.
 */
export function buildStepsFor(tourId: string, host: TourHost): TourStep[] {
  return (BUILDERS[tourScript(tourId).id] ?? buildSteps)(host);
}
