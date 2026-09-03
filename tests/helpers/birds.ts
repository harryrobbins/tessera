/**
 * A synthetic `birds-<n>.json` in exactly the shape the pipeline emits.
 *
 * The real asset is tens of megabytes of committed photographs and is built by
 * a separate `uv` script; a test that waited for it would be a test of the
 * build, not of the engine. This fixture is the frozen contract instead — same
 * column names, same kinds, same ordered categories, same sheet manifest — so
 * `parseBirds` is exercised on the code path the browser runs.
 *
 * Deterministic: every value is a function of the row index.
 */

export const ORDERS = [
  'Passeriformes', 'Caprimulgiformes', 'Anseriformes', 'Accipitriformes',
  'Piciformes', 'Charadriiformes', 'Psittaciformes', 'Columbiformes', 'Strigiformes',
];

export const FAMILIES = [
  'Tytonidae', 'Trochilidae', 'Anatidae', 'Accipitridae', 'Picidae',
  'Laridae', 'Psittacidae', 'Columbidae', 'Strigidae', 'Corvidae', 'Turdidae',
];

/** The contract's eleven habitats plus the explicit Unknown. */
export const HABITATS = [
  'Forest', 'Shrubland', 'Woodland', 'Grassland', 'Wetland', 'Marine',
  'Rock', 'Human modified', 'Coastal', 'Riverine', 'Desert', 'Unknown',
];

export const DIETS = [
  'Insects', 'Omnivore', 'Fruit', 'Aquatic prey', 'Seeds', 'Nectar',
  'Vertebrates', 'Aquatic plants', 'Plants', 'Scavenger', 'Unknown',
];

export const TROPHIC = ['Carnivore', 'Herbivore', 'Omnivore', 'Scavenger', 'Unknown'];
export const LIFESTYLES = ['Perching', 'Terrestrial', 'Aerial', 'Aquatic', 'Generalist'];

/** Ordered: the loader must not re-sort these into alphabetical order. */
export const MIGRATION = ['Sedentary', 'Partial', 'Migratory'];
export const DENSITY = ['Dense', 'Semi-open', 'Open'];
export const MASS_BANDS = [
  'Under 10 g', '10-25 g', '25-60 g', '60-150 g', '150-500 g', '500 g - 2 kg', 'Over 2 kg',
];

const NAMES = [
  'Barn owl', 'Ruby-throated hummingbird', 'Mallard', 'Golden eagle',
  'Great spotted woodpecker', 'Arctic tern', 'Rainbow lorikeet', 'Wood pigeon',
  'Tawny owl', 'Common raven', 'Song thrush', 'Ostrich',
];
const BINOMIALS = [
  'Tyto alba', 'Archilochus colubris', 'Anas platyrhynchos', 'Aquila chrysaetos',
  'Dendrocopos major', 'Sterna paradisaea', 'Trichoglossus moluccanus', 'Columba palumbus',
  'Strix aluco', 'Corvus corax', 'Turdus philomelos', 'Struthio camelus',
];

/** Grams, spanning the real range: 1.9 g to 111 kg. */
const MASSES = [350, 3.1, 1100, 4900, 85, 110, 133, 480, 470, 1200, 70, 111000];

/** Sheet geometry the pipeline would pick for `n` rows: 128 px tiles for the
 *  small collection, 96 px for the large one, packed into 4096² sheets. */
export function sheetFor(n: number): { tile: number; cols: number; rows: number; perSheet: number; files: string[] } {
  const tile = n <= 900 ? 128 : 96;
  const cols = Math.floor(4096 / tile);
  const perSheet = cols * cols;
  const files = Array.from({ length: Math.ceil(n / perSheet) }, (_, k) => `birds-${n}-${k}.avif`);
  return { tile, cols, rows: cols, perSheet, files };
}

/** Rows whose `Range size` is null — the contract's only missing numeric. */
export function missingRangeRow(n: number): number {
  return Math.min(3, n - 1);
}

export function birdsFixture(n = 12): Record<string, unknown> {
  const cat = (name: string, categories: string[], step: number) => ({
    name,
    kind: 'category',
    categories,
    codes: Array.from({ length: n }, (_, i) => (i * step) % categories.length),
  });
  const num = (name: string, at: (i: number) => number | null) => ({
    name,
    kind: 'number',
    values: Array.from({ length: n }, (_, i) => at(i)),
  });
  const noRange = missingRangeRow(n);

  return {
    name: 'Birds of the world',
    n,
    generated: '2026-09-03',
    sheet: sheetFor(n),
    columns: [
      { name: 'Common name', kind: 'text', values: Array.from({ length: n }, (_, i) => NAMES[i % NAMES.length]) },
      { name: 'Scientific name', kind: 'text', values: Array.from({ length: n }, (_, i) => BINOMIALS[i % BINOMIALS.length]) },
      cat('Order', ORDERS, 1),
      cat('Family', FAMILIES, 1),
      cat('Habitat', HABITATS, 1),
      cat('Diet', DIETS, 1),
      cat('Trophic level', TROPHIC, 1),
      cat('Lifestyle', LIFESTYLES, 1),
      cat('Migration', MIGRATION, 1),
      cat('Habitat density', DENSITY, 1),
      cat('Mass band', MASS_BANDS, 1),
      num('Mass', (i) => MASSES[i % MASSES.length]),
      num('Wing length', (i) => 60 + (i % 40) * 9.5),
      num('Beak length', (i) => 9 + (i % 17) * 2.5),
      num('Tail length', (i) => 40 + (i % 23) * 6),
      num('Hand-wing index', (i) => 0.1 + (i % 60) * 1.2),
      num('Range size', (i) => (i === noRange ? null : 1000 + i * 3571)),
      num('Longitude', (i) => -179 + ((i * 37) % 359)),
      num('Latitude', (i) => -55 + ((i * 17) % 130)),
    ],
    rgb: Array.from({ length: n * 3 }, (_, k) => (k * 37) % 256),
    credits: Array.from({ length: n }, (_, i) => ({
      file: `${BINOMIALS[i % BINOMIALS.length]} ${i}.jpg`,
      licence: 'Public domain',
      artist: `Photographer ${i}`,
    })),
  };
}
