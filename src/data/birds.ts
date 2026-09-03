/**
 * Birds of the world — the collection whose cards carry real photographs.
 *
 * AVONET traits (Tobias et al. 2022, CC BY 4.0) joined to Wikidata's image
 * index, with the photographs themselves filtered to public domain and CC0 and
 * prebaked into AVIF sheets by `pipeline/birds.py`. Everything here is *read*,
 * never generated: `parseBirds` turns one committed JSON file into a `Dataset`,
 * and `loadBirds` only fetches — the same split `titanic.ts` uses, so the tests
 * exercise the browser's code path against a fixture and never need the network.
 *
 * ## Why the shape is declared here rather than in the asset
 *
 * The JSON carries columns, codes and a sheet manifest. It does not carry the
 * facet order, the number formats, the card template or the detail sections:
 * those are decisions about *this engine*, and a data file that could change
 * them is a data file that can break the app. The contract between the two is
 * frozen in the column names below.
 *
 * ## Sheets
 *
 * `loadBirds` decodes every photo sheet before it resolves, because
 * `buildCards` (`src/app.ts`) is synchronous and paints each card in a `for`
 * loop that cannot await. `resolveDataset` is awaited, so the ordering holds.
 * The sheets go into the module registry in `src/gl/cards/sheet.ts` rather than
 * onto the `Dataset`, which has to stay structured-cloneable for the layout
 * worker. If a sheet fails to arrive the collection still opens — every card
 * falls back to the quiet design (`src/gl/cards/photo.ts`).
 */
import {
  Column, Dataset, categoryFromCodes, derivedText, numeric, shortNumber, text,
} from './columnar';
import { registerSheets, sheetGeometry, type SheetGeometry } from '../gl/cards/sheet';

/**
 * The sizes the pipeline bakes. 900 rows paints each card at a 128 px atlas
 * slot; the larger one paints a 64 px mosaic that resolves on the mildest zoom
 * (`docs/plans/image-card-datasets.md` §1).
 *
 * 2,000 rather than the plan's 3,000: the AVONET × Wikidata join came in at
 * 89.8 %, but the PD/CC0 licence filter yielded 19.5 % of Commons files rather
 * than the 24 % §2.1's 200-file sample projected, leaving 2,262 usable species.
 * Both sizes sit under the engine's 3,136-row per-item ceiling either way.
 */
export const BIRD_SIZES = [900, 2000] as const;

/** Family tag, and the key the decoded sheets are registered under. */
export const BIRDS_KIND = 'birds';

/**
 * Facet order — it drives the default colour, sort, bucket and axes.
 *
 * **`Habitat` leads, not `Order`.** The plan's first draft led with `Order`,
 * which has 36 levels; the categorical palette holds eight and folds the rest
 * into a single "Other" grey (`src/core/palette.ts`), so colouring or bucketing
 * by it would paint thirty of the thirty-six the same colour. `Habitat` is
 * eleven levels plus Unknown, semantically obvious, and it makes the opening
 * map read as a habitat map of the world. `Order` and `Family` stay as facets
 * and buckets — they are worth filtering and grouping by — just not first.
 *
 * The numerics come after the categoricals, `Mass` first, so the scatter's
 * default Y axis is the number a reader actually wants. `Longitude`/`Latitude`
 * are last: the map layout picks them up from `Dataset.geo`, not from here.
 */
export const BIRD_FACETS = [
  'Habitat', 'Order', 'Diet', 'Trophic level', 'Lifestyle',
  'Migration', 'Habitat density', 'Mass band', 'Family',
  'Mass', 'Hand-wing index', 'Wing length', 'Beak length', 'Tail length', 'Range size',
  'Longitude', 'Latitude',
];

/**
 * `Mass` runs from a 1.9 g hummingbird to a 111 kg ostrich, so a single unit
 * reads as either "0 kg" or "111000 g" over most of the range. The ordered
 * `Mass band` category is what the Bars and Cross-tab layouts bucket by;
 * this is for the card metric, the axis ticks and the detail pane.
 */
export function formatMass(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)} kg`;
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)} g`;
}

function formatMm(v: number): string {
  return `${v < 100 ? v.toFixed(1) : v.toFixed(0)} mm`;
}

function formatDegrees(v: number): string {
  return `${v.toFixed(1)}°`;
}

/** Per-column number formats. A column not listed here takes `shortNumber`. */
const FORMATS: Record<string, (v: number) => string> = {
  Mass: formatMass,
  'Wing length': formatMm,
  'Beak length': formatMm,
  'Tail length': formatMm,
  'Hand-wing index': (v) => v.toFixed(1),
  'Range size': (v) => `${shortNumber(v)} km²`,
  Longitude: formatDegrees,
  Latitude: formatDegrees,
};

/** The modal is 720 px wide less 20 px of padding either side, so the picture
 *  is drawn at 680 CSS px; 800 covers that with room for a denser display
 *  without asking Commons for the multi-megabyte original. */
export const PHOTO_WIDTH = 800;

/**
 * The one place in the app that fetches from a third party at runtime.
 *
 * Everything else Tessera draws is local: the cards' photographs are the
 * prebaked AVIF sheets next to the JSON, so the collection loads, paints,
 * lays out and filters completely offline. This URL is only the *modal's*
 * enhancement — one full-resolution copy of the photograph the card already
 * shows in miniature, fetched from Wikimedia Commons when the record is opened.
 * If it does not resolve the modal renders exactly as it would without it
 * (`wireDetailImage`, `src/ui/detail/template.ts`), so nothing depends on
 * Commons being reachable. Do not add a second such dependency.
 *
 * `Special:FilePath` is Commons' own redirect from a file name to the file:
 * no API call, no token, and none of the MD5 path bucketing
 * (`/a/a2/<name>`) that the upload host's real URLs need. Spaces become
 * underscores the way MediaWiki titles do, then the whole name is escaped.
 */
export function commonsImageUrl(file: string, width = PHOTO_WIDTH): string {
  const name = file.trim().replace(/ /g, '_');
  if (!name) return '';
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=${width}`;
}

/** What `parseBirds` reads out of one `birds-<n>.json`. */
export interface BirdsCollection {
  dataset: Dataset;
  /** Tile geometry and sheet file names — what `loadBirds` fetches next. */
  sheet: SheetGeometry;
}

/**
 * Build the collection from the parsed JSON. Pure: no fetch, no canvas, no
 * `ImageBitmap`, so the tests can run it against a synthetic fixture and check
 * exactly what the browser builds.
 */
export function parseBirds(json: unknown): BirdsCollection {
  const o = asObject(json);
  const raw = Array.isArray(o.columns) ? o.columns : [];
  if (raw.length === 0) throw new Error('birds: no columns');

  const columns: Record<string, Column> = {};
  let n = typeof o.n === 'number' && Number.isFinite(o.n) && o.n > 0 ? Math.floor(o.n) : 0;

  for (const entry of raw) {
    const c = asObject(entry);
    const name = typeof c.name === 'string' ? c.name : '';
    if (!name || columns[name]) continue;
    if (c.kind === 'category') {
      // Ordered categories (Migration, Habitat density, Mass band) arrive in
      // the order the pipeline intends. Never re-sorted — `categoryFromCodes`
      // takes the dictionary as given, which is the whole reason it exists.
      const categories = (Array.isArray(c.categories) ? c.categories : []).map((v) => String(v));
      const src = Array.isArray(c.codes) ? c.codes : [];
      const codes = new Int32Array(src.length);
      for (let i = 0; i < src.length; i++) {
        const k = Number(src[i]);
        codes[i] = Number.isFinite(k) && k >= 0 && k < categories.length ? Math.floor(k) : 0;
      }
      columns[name] = categoryFromCodes(name, codes, categories);
      if (!n) n = codes.length;
    } else if (c.kind === 'number') {
      const src = Array.isArray(c.values) ? c.values : [];
      const values = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) {
        // `null` means missing in the contract; NaN is what the engine reads.
        const v = src[i] === null || src[i] === undefined ? NaN : Number(src[i]);
        values[i] = Number.isFinite(v) ? v : NaN;
      }
      columns[name] = numeric(name, values, FORMATS[name]);
      if (!n) n = values.length;
    } else {
      const src = Array.isArray(c.values) ? c.values : [];
      const values = src.map((v) => (v === null || v === undefined ? '' : String(v)));
      columns[name] = text(name, values);
      if (!n) n = values.length;
    }
  }
  if (!n) throw new Error('birds: no rows');

  // The photo credits are a build record, one entry per row. They are read on
  // demand in the modal rather than materialised as three more string columns —
  // the same reasoning as `derivedText` everywhere else in the app.
  const credits = (Array.isArray(o.credits) ? o.credits : []).map(asObject);
  if (credits.length) {
    // Tidied on the way out, not in the file: `credits` is the build's record of
    // what Commons actually said, and rewriting it would make the shipped credit
    // disagree with the source it claims to quote. The artist field is HTML in
    // `extmetadata` and stripping the tags leaves the seams — "Duncan Wright ,
    // USFWS" — so collapse runs of space and close them up before punctuation.
    const field = (key: string) => (i: number) => {
      const v = credits[i]?.[key];
      return typeof v === 'string' ? v.replace(/\s+/g, ' ').replace(/ +([,;.])/g, '$1').trim() : '';
    };
    columns.Photograph = derivedText('Photograph', field('file'));
    columns.Photographer = derivedText('Photographer', field('artist'));
    columns['Photo licence'] = derivedText('Photo licence', field('licence'));
  }

  const label = (name: string): ((i: number) => string) => {
    const c = columns[name];
    if (!c) return () => '';
    if (c.kind === 'category') return (i) => c.categories[c.codes[i]] ?? '';
    if (c.kind === 'text') return c.at;
    return (i) => (Number.isFinite(c.values[i]) ? (c.format ?? shortNumber)(c.values[i]) : '');
  };
  const orderOf = label('Order');
  const familyOf = label('Family');
  const commonName = label('Common name');
  const photoOf = label('Photograph');
  const artistOf = label('Photographer');
  const licenceOf = label('Photo licence');

  const rgb = Array.isArray(o.rgb) && o.rgb.length === n * 3
    ? Uint8Array.from(o.rgb as number[], (v) => Math.max(0, Math.min(255, Math.round(Number(v)) || 0)))
    : undefined;

  const geo = columns.Longitude?.kind === 'number' && columns.Latitude?.kind === 'number'
    ? { lon: 'Longitude', lat: 'Latitude' }
    : undefined;

  const title = typeof o.name === 'string' && o.name ? o.name : 'Birds of the world';

  const dataset: Dataset = {
    name: `${title} (${n.toLocaleString()})`,
    n,
    columns,
    labelColumn: 'Common name',
    // A facet naming a column the build did not emit would break every layout
    // that offers it, so the declaration is filtered against what is here.
    facets: BIRD_FACETS.filter((f) => columns[f]),
    kind: BIRDS_KIND,
    geo,
    // Each row's mean thumbnail colour. The True-colour mode was built for the
    // pixel collections; three thousand birds in their own plumage is the
    // picture it was waiting for, and it is the default colour-by when present.
    rgb,

    card: {
      topic: 'Order',
      title: 'Common name',
      blurb: 'Scientific name',
      tags: [
        { value: 'Habitat', shape: 'pill' },
        { value: 'Diet', shape: 'dot' },
      ],
      // The format carries the unit (g or kg), so a separate label would print
      // it twice.
      metric: { value: 'Mass' },
      custom: 'photo',
    },

    detail: {
      subtitle: (i: number) => [orderOf(i), familyOf(i)].filter(Boolean).join(' · '),
      // The card paints a 64–128 px tile out of the local sheet; the modal is
      // where the photograph is worth seeing, so it asks Commons for a full one.
      // Absent credits (a build without them) means no `Photograph` column,
      // which means no URL, which means no picture — and no missing space.
      image: columns.Photograph
        ? {
          src: (i: number) => commonsImageUrl(photoOf(i)),
          // The species, not "a bird": the alt text a screen reader reads is
          // the same name the header prints.
          alt: (i: number) => commonName(i),
          // Credit where it is displayed, not only in `public/data/CREDITS.md`.
          credit: (i: number) => [artistOf(i), licenceOf(i), 'Wikimedia Commons'].filter(Boolean).join(' · '),
        }
        : undefined,
      sections: [
        { title: 'Taxonomy', fields: [{ label: 'Scientific name', value: 'Scientific name' }, 'Order', 'Family'] },
        { title: 'Ecology', fields: ['Habitat', 'Habitat density', 'Diet', 'Trophic level', 'Lifestyle'] },
        { title: 'Measurements', fields: ['Mass', 'Mass band', 'Wing length', 'Beak length', 'Tail length', 'Hand-wing index'] },
        { title: 'Where', fields: ['Range size', 'Longitude', 'Latitude', 'Migration'] },
        { title: 'Photograph', fields: [{ label: 'File', value: 'Photograph', as: 'mono' }, 'Photographer', 'Photo licence'] },
      ],
      context: ['Habitat', 'Diet', 'Order'],
    },
  };

  return { dataset, sheet: sheetGeometry(o.sheet, n) };
}

/**
 * Fetch one prebaked size, decode its photo sheets, register them and return
 * the collection.
 *
 * Every path is **relative** — `data/birds-900.json`, never `/data/…` — which
 * is what keeps the app working under GitHub Pages' `/tessera/` base, or under
 * any other sub-path mount (`src/data/pixels.ts` is the same shape).
 */
export async function loadBirds(size: number = BIRD_SIZES[0]): Promise<Dataset> {
  const n = (BIRD_SIZES as readonly number[]).includes(size) ? size : BIRD_SIZES[0];
  const url = `data/birds-${n}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const raw = await res.text();
  // A dev server with an SPA fallback answers 200 with index.html for a file
  // that is not there, so check it is really JSON before trusting it.
  if (raw.trimStart().startsWith('<')) throw new Error(`${url}: not a JSON file`);
  const { dataset, sheet } = parseBirds(JSON.parse(raw));

  const images = await decodeSheets(sheet);
  if (images) registerSheets(BIRDS_KIND, { ...sheet, images });

  return dataset;
}

/**
 * Decode every sheet, or none. A half-registered collection would paint some
 * cards with photographs and some without, which reads as a rendering bug
 * rather than as missing data; returning null makes every card the quiet
 * design, which reads as what it is.
 */
async function decodeSheets(sheet: SheetGeometry): Promise<ImageBitmap[] | null> {
  try {
    return await Promise.all(sheet.files.map(async (file) => {
      const res = await fetch(`data/${file}`);
      if (!res.ok) throw new Error(`failed to fetch data/${file}: ${res.status} ${res.statusText}`);
      // Real image bytes decode; an SPA fallback's HTML makes this reject.
      return createImageBitmap(await res.blob());
    }));
  } catch (e) {
    console.warn('birds: photo sheets unavailable, falling back to text cards', e);
    return null;
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
