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
