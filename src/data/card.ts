/**
 * What a dataset says about its own records: six named slots for the small
 * card, a section list for the expanded modal.
 *
 * Pure data — no canvas, no GL, no columnar store — so both `src/gl/cards/*`
 * and `src/ui/detail/*` can import it without dragging the renderer along.
 */

/** One card slot's value: a column name, or a function of the row index.
 *  Accessors are called once per card *rasterised*, never once per frame. */
export type SlotRef = string | ((i: number) => string);

export type TagTone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';

export interface TagSpec {
  /** Column name or accessor. Empty string hides this tag entirely. */
  value: SlotRef;
  /** A fixed tone, or a map from the value's text to a tone. Default 'neutral'. */
  tone?: TagTone | Record<string, TagTone>;
  /** 'pill' = filled capsule with coloured text; 'dot' = coloured dot + dim text. */
  shape?: 'pill' | 'dot';
  /** Values that mean "nothing to say" — the tag is dropped (e.g. Escalated: No). */
  hideWhen?: readonly string[];
}

export interface MetricSpec {
  value: SlotRef;
  /** Short unit or noun. Omit to show the value alone. An accessor lets it
   *  agree with the value — "1 contact", "2 contacts". */
  label?: SlotRef;
}

/** Header tile: the title's initials, or a glyph named by a column's value.
 *  Glyph names are matched by `src/gl/cards/glyphs.ts`; an unknown name falls
 *  back to initials, so a dataset can name a glyph the app does not have yet. */
export type MarkSpec = 'initials' | { glyph: SlotRef };

/** Hand-painted designs registered in src/gl/cards/index.ts. Extend the union
 *  and register a factory to add one — there is deliberately no way for a
 *  dataset to pass a painter function, because datasets must stay cloneable. */
export type CustomCard = 'taxCase' | 'photo';

export interface CardTemplate {
  /** Eyebrow in the accent header. Default: the current colour-by value. */
  topic?: SlotRef;
  /** Default: 'initials'. */
  mark?: MarkSpec;
  /** Default: `Dataset.labelColumn`. */
  title?: SlotRef;
  /** Default: none. */
  blurb?: SlotRef;
  /** At most two are drawn; a third is ignored and flagged by the test suite. */
  tags?: readonly TagSpec[];
  /** Drawn at 'full' density only. */
  metric?: MetricSpec;
  /**
   * Opt into a bespoke painter. When set, the painter owns the whole face and
   * ignores every slot above — but the slots are still read by the modal
   * header and the hover chip, so a bespoke card and its modal can never
   * disagree about who the record is. Declare both.
   */
  custom?: CustomCard;
}

/** At most two tags are ever drawn; the rest of the array is ignored. */
export const MAX_TAGS = 2;

/**
 * Guidance to dataset authors, in characters. Nothing enforces these at draw
 * time — `clip()` does that with the real font metrics — but a slot that
 * routinely overruns is a slot that will read as an ellipsis on every card.
 */
export const SLOT_CHARS = {
  topic: 24,
  title: 40,
  blurb: 48,
  tag: 14,
  metric: 8,
  metricLabel: 12,
} as const;

// -------------------------------------------------------------- expanded view

export interface DetailField {
  /** Row label. Defaults to the column name when `value` is a column name. */
  label?: string;
  value: SlotRef;
  /** Render hint: 'mono' for identifiers, 'tag' for a chip, 'plain' otherwise. */
  as?: 'plain' | 'mono' | 'tag';
}

export interface DetailSection {
  title: string;
  /** A bare string is shorthand for `{ value: <column>, label: <column> }`.
   *  Fields naming a column the dataset does not have are skipped silently. */
  fields: ReadonlyArray<string | DetailField>;
}

export interface DetailAction {
  id: string;
  label: string;
  primary?: boolean;
}

/**
 * A picture for the expanded record — one image, with the credit that has to
 * travel with it.
 *
 * A bare `SlotRef` would have covered the URL and nothing else, and a record
 * picture is never just a URL: it needs alt text and, when it is somebody
 * else's photograph, a visible credit. Both are per-row, so both are `SlotRef`s
 * — the same shape `TagSpec` and `MetricSpec` already use for the card.
 *
 * The modal never waits for it: the record's text renders immediately, the box
 * holds its size so nothing reflows when the image lands, and an image that
 * never lands (offline, 404, blocked) hides itself rather than leaving a
 * broken-image icon or a hole. A dataset declaring this must still be complete
 * without it.
 */
export interface DetailImage {
  /** The image URL for a row. '' (or a missing column) draws nothing at all. */
  src: SlotRef;
  /** Alt text. Default: the record's title, as the card prints it. */
  alt?: SlotRef;
  /** A credit line under the picture — photographer, licence, source. */
  credit?: SlotRef;
}

export interface DetailTemplate {
  /** Under the title in the modal header. Default: the card's `blurb`. */
  subtitle?: SlotRef;
  /** A picture at the top of the body. Default: none. */
  image?: DetailImage;
  sections?: readonly DetailSection[];
  /** Categorical facets whose share of the filtered set is shown in Context.
   *  Default: the first three categorical facets. `[]` hides the section. */
  context?: readonly string[];
  /** Demo action links. Default: none (no actions, no <section class="actions">). */
  actions?: readonly DetailAction[];
  /** A renderer registered with `registerDetail`. Wins over `sections`. */
  custom?: string;
}
