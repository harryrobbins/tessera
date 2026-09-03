/**
 * The one place the tour is bound to a dataset's schema. Column and value
 * names here must match src/data/taxCases.ts (workstream B); a test loads
 * that generator and checks them, and tests/tour-story.test.ts checks every
 * number the narration claims against the same data. Narration mentions
 * these names in bold, so renaming any of them means regenerating clips.
 */
export const TOUR_DATASET = 'tax-cases:3000';

export const COL = {
  customer: 'Customer',
  town: 'Town',
  longitude: 'Longitude',
  latitude: 'Latitude',
  topic: 'Topic',
  channel: 'Channel',
  priority: 'Priority',
  status: 'Status',
  escalated: 'Escalated',
  contacts: 'Contacts',
  opened: 'Opened',
  ageBand: 'Age band',
  areaType: 'Area type',
  hours: 'Resolution hours',
  satisfaction: 'Satisfaction',
} as const;

export const VAL = {
  paye: 'PAYE',
  phone: 'Phone',
  post: 'Post',
  open: 'Open',
  high: 'High',
} as const;

/** UI labels the narration may bold that are not columns. */
export const UI = {
  review: 'Review action',
} as const;

/**
 * The birds tour's binding, to the 2,000-row bake.
 *
 * At 2,000 rows the renderer's base card slot is 64 px rather than 900's
 * 128 px (`slotFor`, `src/gl/atlas.ts`, keyed on row count alone) — most of
 * the tour reads as a colour mosaic rather than individually legible
 * photographs, sharpening only once a card is flown to and zoomed (the
 * `one-bird` step) or opened in the modal, which always fetches full
 * resolution from Commons regardless of dataset size. A deliberate trade for
 * the bigger collection, not an oversight.
 *
 * The 2,000 bake also carries a small "Unknown" level in Habitat, Diet,
 * Trophic level and Migration that the 900 one does not (about 0.2–0.6 % of
 * rows) — small enough that every share the narration quotes is still, in
 * effect, a share of birds actually classified.
 */
export const BIRD_TOUR_DATASET = 'birds:2000';

export const BIRD_COL = {
  commonName: 'Common name',
  scientificName: 'Scientific name',
  order: 'Order',
  family: 'Family',
  habitat: 'Habitat',
  diet: 'Diet',
  trophic: 'Trophic level',
  lifestyle: 'Lifestyle',
  migration: 'Migration',
  density: 'Habitat density',
  massBand: 'Mass band',
  mass: 'Mass',
  wing: 'Wing length',
  beak: 'Beak length',
  tail: 'Tail length',
  handWing: 'Hand-wing index',
  range: 'Range size',
  longitude: 'Longitude',
  latitude: 'Latitude',
  photographer: 'Photographer',
} as const;

export const BIRD_VAL = {
  forest: 'Forest',
  marine: 'Marine',
  passeriformes: 'Passeriformes',
  nectar: 'Nectar',
  vertebrates: 'Vertebrates',
  aquaticPrey: 'Aquatic prey',
  sedentary: 'Sedentary',
  migratory: 'Migratory',
} as const;
