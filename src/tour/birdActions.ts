import type { Dataset } from '../data/columnar';
import type { TourStep } from './engine';
import type { TourHost } from './actions';
import { cardRect, css, settle, sleep, stepHelpers, visible } from './actions';
import { BIRDS_NARRATION } from './script';
import { BIRD_COL, BIRD_TOUR_DATASET, BIRD_VAL } from './columns';
import { TRUE_COLOUR } from '../app';
import { FLIP_MS } from '../ui/detail/flip';

/**
 * The bird the tour lands on: of the rows passing `mask`, the one with the
 * highest hand-wing index, the heavier bird first, lowest index as the final
 * tie-break — so the same bird every time, and the last card of a grid sorted
 * by Hand-wing index, which is where the caption says to look.
 */
export function featuredBird(ds: Dataset, mask: Uint8Array | null = null): number {
  const rows: number[] = [];
  for (let i = 0; i < ds.n; i++) if (!mask || mask[i]) rows.push(i);
  if (rows.length === 0) return -1;
  const hwi = ds.columns[BIRD_COL.handWing];
  const mass = ds.columns[BIRD_COL.mass];
  const h = hwi?.kind === 'number' ? hwi.values : null;
  const m = mass?.kind === 'number' ? mass.values : null;
  return rows.reduce((best, i) => {
    if (h) {
      if (h[i] > h[best]) return i;
      if (h[i] < h[best]) return best;
    }
    if (m) {
      if (m[i] > m[best]) return i;
      if (m[i] < m[best]) return best;
    }
    return best;
  }, rows[0]);
}

/**
 * Bind the birds narration to actions, on the same terms as `buildSteps`: the
 * shared helpers guard on every column and check the abort signal, and each
 * step sets absolute state so `back()` re-running an earlier action is safe.
 *
 * Where this tour differs from the tax one is that the cards are photographs.
 * Two steps are shaped by that. The map opens in **True colour** — each card
 * drawn in the average colour of its own picture, which at that zoom is nine
 * hundred coloured points of real plumage — before the next step recolours it
 * by Habitat, so the viewer sees the engine repaint a picture they have
 * already read. And the two filter steps refit the camera, which the tax tour
 * never needs: those filters run in the grid, where dropping from nine hundred
 * cards to eleven leaves the survivors as a speck in the middle of a board
 * still framed for the whole collection.
 */
export function buildBirdSteps(host: TourHost): TourStep[] {
  const { has, tween, live, layoutBtn, facetRow, tick, flyTo, ensureDataset, closeRecord, toMap } = stepHelpers(host);
  const fit = async (signal: AbortSignal) => {
    if (!live(signal)) return;
    host.app.fit();
    await settle(host.app, 3000, signal);
  };
  /**
   * Frame what a filter has just left behind. `toggleFacet` returns before the
   * layout worker has solved the new board and there is no promise here to
   * await, so fitting in the same tick would frame the *old* bounds; a beat
   * first means the camera frames the cards the caption is talking about.
   */
  const refit = async (signal: AbortSignal) => {
    await sleep(tween(400), signal);
    await fit(signal);
  };

  const actions: Record<string, Pick<TourStep, 'target' | 'run' | 'minMs'>> = {
    // The opening line is about birds and photographs, so the birds have to be
    // on the board before it is spoken — unlike the tax tour, whose first line
    // is deliberately about no collection in particular and can play over
    // whatever happens to be loaded.
    open: {
      minMs: 1200,
      run: async (signal) => {
        // Nothing else may be driving the app while the tour narrates it.
        host.stopBenchmark?.();
        closeRecord();
        await ensureDataset(BIRD_TOUR_DATASET, signal);
        if (!live(signal)) return;
        // The tour asserts a specific look; a returning viewer's saved "labels
        // off" would desynchronise it from the narration.
        host.resetCardSettings?.();
        host.clearFacets();
      },
    },
    world: {
      target: '#dataset',
      minMs: 1200,
      run: async (signal) => {
        await ensureDataset(BIRD_TOUR_DATASET, signal);
        if (!live(signal)) return;
        // True colour is only offered for a collection that ships per-row
        // colours, and setSelect ignores a value the menu does not hold, so a
        // build without them simply opens the map in its default colour.
        await host.setSelect('colorBy', TRUE_COLOUR);
        await toMap(BIRD_COL.longitude, BIRD_COL.latitude, signal);
      },
    },
    habitat: {
      target: '#colorBy',
      run: async () => { if (has(BIRD_COL.habitat)) await host.setSelect('colorBy', BIRD_COL.habitat); },
    },
    orders: {
      target: layoutBtn('bars'),
      run: async (signal) => {
        await host.setLayout('bars');
        if (has(BIRD_COL.order) && live(signal)) await host.setSelect('barBy', BIRD_COL.order);
      },
    },
    bands: {
      target: '#barField',
      run: async (signal) => {
        await host.setLayout('bars');
        if (has(BIRD_COL.massBand) && live(signal)) await host.setSelect('barBy', BIRD_COL.massBand);
      },
    },
    diet: {
      target: layoutBtn('scatter'),
      run: async (signal) => {
        await host.setLayout('scatter');
        if (has(BIRD_COL.diet) && live(signal)) await host.setSelect('axisX', BIRD_COL.diet);
        if (has(BIRD_COL.massBand) && live(signal)) await host.setSelect('axisY', BIRD_COL.massBand);
      },
    },
    dispersal: {
      // Mass runs from a two-gram woodstar to a thirty-five-kilo cassowary and
      // Range size from a single island to a third of the planet, so raw
      // coordinates would pile every card into one corner. The cross-tab bins
      // both by rank, which is what makes the migratory colours climb the
      // diagonal instead of hiding in a smear. The axis menus are what changes
      // between this step and the last, so they are what the spotlight follows.
      target: '#xField',
      run: async (signal) => {
        await host.setLayout('scatter');
        if (has(BIRD_COL.handWing) && live(signal)) await host.setSelect('axisX', BIRD_COL.handWing);
        if (has(BIRD_COL.range) && live(signal)) await host.setSelect('axisY', BIRD_COL.range);
        if (has(BIRD_COL.migration) && live(signal)) await host.setSelect('colorBy', BIRD_COL.migration);
        if (live(signal)) host.app.fit();
      },
    },
    wall: {
      target: layoutBtn('grid'),
      run: async (signal) => {
        await host.setLayout('grid');
        if (has(BIRD_COL.handWing) && live(signal)) {
          await host.setSelect('sortBy', BIRD_COL.handWing);
          if (live(signal)) await host.setSelect('colorBy', BIRD_COL.handWing);
        }
      },
    },
    ocean: {
      target: facetRow(BIRD_COL.habitat, BIRD_VAL.marine),
      run: async (signal) => {
        tick(BIRD_COL.habitat, BIRD_VAL.marine);
        await refit(signal);
      },
    },
    voyagers: {
      target: facetRow(BIRD_COL.migration, BIRD_VAL.migratory),
      run: async (signal) => {
        tick(BIRD_COL.habitat, BIRD_VAL.marine);
        // A beat between the two ticks: the caption says the filters combine,
        // and the board should be seen doing it rather than jumping straight
        // to the answer.
        await sleep(tween(350), signal);
        if (!live(signal)) return;
        tick(BIRD_COL.migration, BIRD_VAL.migratory);
        await refit(signal);
      },
    },
    closer: {
      target: '#zoomSeg',
      run: async (signal) => {
        host.app.zoomStep(1);
        await sleep(tween(450), signal);
        if (live(signal)) host.app.zoomStep(1);
      },
    },
    'one-bird': {
      target: () => {
        const ds = host.app.dataset;
        return (ds && cardRect(host.app, featuredBird(ds, host.app.mask))) ?? host.el('#gl');
      },
      minMs: 1400,
      run: async (signal) => {
        const ds = host.app.dataset;
        if (!ds) return;
        const i = featuredBird(ds, host.app.mask);
        if (i < 0) return;
        // Fly to the card and leave it on screen: the narration is about the
        // bird on the card. Opening the record here would cover it — the modal
        // expands over the middle of the board — so that is the next step's
        // job. Wider than the tax tour's card, because here the thing being
        // pointed at is a photograph rather than four lines of text.
        await flyTo(i, 360, 1000, signal);
        await settle(host.app, 3000, signal);
      },
    },
    credit: {
      // The picture section is removed when Commons does not answer
      // (`wireDetailImage`), so the spotlight falls back to the modal itself
      // rather than to a rectangle that is no longer there.
      target: () => visible(host, '#detail .photo figure') ?? host.el('#detail'),
      run: async (signal) => {
        const ds = host.app.dataset;
        if (!ds || !live(signal)) return;
        const i = featuredBird(ds, host.app.mask);
        if (i < 0) return;
        host.select(i);
        // The modal expands out of the card (a FLIP transform). Measuring the
        // photograph mid-flight spotlights a shrunken rectangle of empty
        // dialog, so wait for the expansion to land before the caption asks
        // where it is.
        await sleep(tween(FLIP_MS + 120), signal);
      },
    },
    'nothing-lost': {
      // Not the clear link: the action removes it, so by the time the caption
      // is up the spotlight would fall back to the whole sidebar. The Habitat
      // facet is where the counts visibly go back to nine hundred.
      target: () => host.el(`#facets .facet[data-field="${css(BIRD_COL.habitat)}"]`) ?? host.el('#facets'),
      minMs: 1200,
      // The record modal is still open from the previous step, and it makes
      // the whole app inert: spotlighting a control the viewer could not click
      // would be a lie. It reads better with the modal gone anyway.
      run: () => {
        closeRecord();
        host.clearFacets();
      },
    },
    frame: { target: '#fitBtn', run: (signal) => fit(signal) },
    'your-turn': { target: '#tourBtn' },
  };

  return BIRDS_NARRATION.map((line) => ({ id: line.id, title: line.title, text: line.text, ...(actions[line.id] ?? {}) }));
}
