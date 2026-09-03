/**
 * Picks the card design for a dataset. A dataset now *says* what it wants
 * (`Dataset.card.custom`) rather than being guessed at by sniffing its columns,
 * and anything that says nothing gets the quiet card.
 */
import type { CardPainter } from '../atlas';
import type { CustomCard } from '../../data/card';
import type { Dataset } from '../../data/columnar';
import { photoPainter } from './photo';
import { quietPainter, type QuietOptions } from './quiet';
import { taxCasePainter } from './taxCase';

/** Hand-painted designs. Extend `CustomCard` and add a factory to register one.
 *  The options are the Card settings popover's, so a bespoke design honours the
 *  Tags and Title choices too; a factory that does not care just ignores them. */
const CUSTOM: Record<CustomCard, (ds: Dataset, opts: CardPainterOptions) => CardPainter> = {
  taxCase: taxCasePainter,
  photo: photoPainter,
};

export interface CardPainterOptions extends QuietOptions {
  /** The Card settings popover's choice; overrides the dataset's own. */
  design?: CustomCard | 'quiet';
}

export function cardPainterFor(ds: Dataset, opts: CardPainterOptions = {}): CardPainter {
  const pick = opts.design ?? ds.card?.custom;
  if (pick && pick !== 'quiet' && CUSTOM[pick]) return CUSTOM[pick](ds, opts);
  return quietPainter(ds, opts);
}

/** Whether `Detailed` is offered for this dataset in the Card settings. */
export function customCardFor(ds: Dataset): CustomCard | undefined {
  return ds.card?.custom;
}
