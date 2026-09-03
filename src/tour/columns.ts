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
 * The birds tour's binding, to the 900-row bake rather than the 2,000-row one.
 *
 * Two reasons, both about what the narration asks the viewer to look at. The
 * 900 sheet paints a 128 px tile per card, so the zoom, the one card and the
 * detail steps show a photograph that still holds together on screen; the
 * 2,000 sheet is a 64 px mosaic, which is the right trade for a wall of two
 * thousand birds and the wrong one for a tour that ends on a single bird's
 * face. And every category in the 900 bake is filled in, where the 2,000 one
 * carries an Unknown level in Habitat, Diet, Trophic level and Migration — so
 * every share the narration quotes is a share of birds actually classified,
 * with no silent "and the rest" bucket behind it.
 */
export const BIRD_TOUR_DATASET = 'birds:900';

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
