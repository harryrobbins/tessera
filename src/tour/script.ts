/**
 * Narration for the guided tour. Data only, erasable TypeScript, no imports:
 * scripts/generate-voiceover.mjs loads this file directly under Node's type
 * stripping, and the runtime imports it too, so the audio and the captions can
 * never disagree. Bold **terms** must name columns or values in columns.ts.
 */
export interface NarrationLine {
  id: string;
  /** Card heading; not spoken. */
  title: string;
  text: string;
}

export const VOICE = {
  /**
   * Isla Skye — female, authentic Edinburgh accent, soft and warm; a shared
   * library voice, so it must be added to the workspace before generation
   * (`pnpm voiceover --add-voice`). Alternatives from the library: Isla
   * (h8eW5xfRUGVJrZhAFxqK), Lynda (SB13jgWjPxi4e4JoTT1H), Piper Monroe
   * (InE4naNnowIxWA78Z5kE).
   */
  voiceId: 'TVmbglAk3F1GkiCoOq47',
  name: 'Isla Skye',
  /** Library owner id, needed once to add the voice to the workspace. */
  publicOwnerId: '6f218397af5a13818bb52830454303835860f5423582c876edd6da4945b96d81',
  modelId: 'eleven_multilingual_v2',
  outputFormat: 'mp3_44100_64',
  // A touch more stability than the default keeps the accent consistent
  // across sixteen short clips; slightly slower because the lines are dense.
  settings: { stability: 0.55, similarityBoost: 0.8, style: 0.2, speed: 0.97, useSpeakerBoost: true },
  seed: 4242,
};

export const NARRATION: NarrationLine[] = [
  { id: 'welcome', title: 'Welcome',
    text: 'Welcome to Tessera. Every tile is one record, and nothing is ever redrawn — the tiles simply fly to wherever you send them.' },
  { id: 'map', title: 'A country of cases',
    text: 'These are three thousand **tax customer-service cases**, plotted by **Longitude** and **Latitude**. Every light is one customer, somewhere in the UK.' },
  { id: 'colour', title: 'Who writes, who calls',
    text: 'Colour by **Channel**, and the countryside takes the colours of **Phone** and **Post**, while the cities glow with webchat. The map is already hinting at a story.' },
  { id: 'bars', title: 'How enquiries arrive',
    text: 'Bars stack the same cards by **Channel**: nearly half of all enquiries come by phone, and one in ten still arrives by post.' },
  { id: 'area', title: 'Town and country',
    text: 'Bucket by **Area type**. In rural areas one case in five arrives by post; in the cities it\'s one in sixteen. Same cards, a new question.' },
  { id: 'crosstab', title: 'Age against channel',
    text: 'Cross-tab **Age band** against **Channel**. Over-seventy-fives send a quarter of their enquiries by post and almost none by webchat; under-thirties do the reverse.' },
  { id: 'scatter', title: 'The slow lane',
    text: 'Scatter **Resolution hours** against **Satisfaction**. A typical webchat closes in half an hour; a typical letter takes five and a half days, and satisfaction sinks with the wait.' },
  { id: 'facet', title: 'Follow the paper',
    text: 'So let\'s follow the paper. Tick **Post** under **Channel**, and every layout and every count updates to those three hundred cases.' },
  { id: 'facet2', title: 'Twelve people waiting',
    text: 'Filters combine. Add **Open** under **Status** and **High** under **Priority**: twelve urgent cases, still waiting, on paper.' },
  { id: 'grid', title: 'Who has chased the most',
    text: 'Back to the grid, sorted and coloured by **Contacts**: the darker the card, the more often that customer has had to chase. The most persistent sit at the far end.' },
  { id: 'zoom', title: 'Closer',
    text: 'Zoom with the wheel or the plus and minus buttons, and drag to pan. Up close, each card shows its own summary: name, town, topic and priority.' },
  { id: 'record', title: 'One customer',
    text: 'Click a card. This one is a **PAYE** case, **High** priority, sent by **Post**, five contacts already — and still open. That is what the numbers were about.' },
  { id: 'detail', title: 'The whole journey',
    text: 'The detail view shows the whole journey, from first contact to resolution, with actions like **Review action** to hand — demo buttons here, real ones in yours.' },
  { id: 'clear', title: 'Nothing lost',
    text: 'Clear the filters, and all three thousand return to their places. Filters never destroy anything; they only choose what you are looking at.' },
  { id: 'fit', title: 'The whole country',
    text: 'Press F, or the Fit button, to frame the whole collection again whenever you get lost.' },
  { id: 'finish', title: 'Your turn',
    text: 'That\'s the tour: from a map of a country to one person\'s case. Replay it any time from the Tour button, then choose a collection of your own.' },
];

/**
 * The birds tour. A second collection, a second story: the tax cases are a map
 * of one country in flat colour, and this is two thousand pictures of real
 * animals, so the steps that show colour, the grid and one card up close are
 * doing quite different work here.
 *
 * The pictures are Commons images filtered to public domain and CC0, which is
 * in effect a date filter: about half are nineteenth-century lithographic
 * plates rather than photographs. So the narration says "picture", never
 * "photograph" — tests/tour-birds-story.test.ts holds that line. Same rules as above — bold **terms** must
 * name a column or a category value in columns.ts, and every number is checked
 * against `public/data/birds-2000.json` by tests/tour-birds-story.test.ts.
 */
export const BIRDS_NARRATION: NarrationLine[] = [
  { id: 'open', title: 'Welcome',
    text: 'Welcome to Tessera. Every tile is one bird, and every picture is that bird — a photograph, or a nineteenth-century plate. Nothing is ever redrawn; the tiles simply fly.' },
  { id: 'world', title: 'A world of birds',
    text: 'Two thousand species, plotted by **Longitude** and **Latitude**. Every light is one bird, in the average colour of its own picture, and half live south of the equator.' },
  { id: 'habitat', title: 'Where they live',
    text: 'Colour by **Habitat**, and the forest takes over: close to two in three are **Forest** birds, while only sixty-five — the **Marine** ones — live out on the open sea.' },
  { id: 'orders', title: 'Thirty-one orders',
    text: 'Bars stack the same cards by **Order**. There are thirty-one of them, and more than half are **Passeriformes** — perching birds.' },
  { id: 'bands', title: 'Two grams to a hundred and eleven kilos',
    text: 'Bucket by **Mass band**: seven rungs, from under ten grams to over two kilos. The lightest here is a two-gram woodstar, the heaviest a hundred-and-eleven-kilo ostrich.' },
  { id: 'diet', title: 'What they eat',
    text: 'Cross-tab **Diet** against **Mass band**. Every **Nectar** feeder is tiny — seven grams is typical — while the birds that take **Vertebrates** weigh seventy times more.' },
  { id: 'dispersal', title: 'The shape of a wing',
    text: '**Hand-wing index** measures how far a wing can carry a bird. A **Sedentary** species scores twenty; a **Migratory** one, forty-one, over a range sixteen times wider.' },
  { id: 'wall', title: 'Two thousand pictures',
    text: 'Back to the grid, sorted and coloured by **Hand-wing index**: short round wings at one end, and at the other the birds that cross oceans.' },
  { id: 'ocean', title: 'Out to sea',
    text: 'Tick **Marine** under **Habitat**. Sixty-five seabirds are left, and their typical **Hand-wing index** is sixty — the highest of any habitat here.' },
  { id: 'voyagers', title: 'The twenty',
    text: 'Filters combine. Add **Migratory** under **Migration** and twenty birds remain: five shearwaters and petrels, six storm-petrels, five auks, two eiders, a skua, and a tropicbird.' },
  { id: 'closer', title: 'Closer',
    text: 'Zoom with the wheel, or the plus and minus buttons, and drag to pan. Up close each card shows the bird, its species, and what it weighs.' },
  { id: 'one-bird', title: 'One bird',
    text: 'Click the card at the far end. A red-tailed tropicbird: **Marine**, **Migratory**, hunting **Aquatic prey**, with a **Hand-wing index** of sixty-nine — the highest of the twenty.' },
  { id: 'credit', title: 'The whole bird',
    text: 'The detail view opens the full picture, with the taxonomy, the measurements, the range — and the **Photographer** and licence that let us show it.' },
  { id: 'nothing-lost', title: 'Nothing lost',
    text: 'Clear the filters, and all two thousand birds return to their places. Filters never destroy anything; they only choose what you are looking at.' },
  { id: 'frame', title: 'The whole world again',
    text: 'Press F, or the Fit button, and the whole world of birds is back in frame.' },
  { id: 'your-turn', title: 'Your turn',
    text: 'That is the tour: two thousand birds, and one tropicbird at the end of it. Replay it any time from the Tour button, then choose a collection of your own.' },
];

/**
 * One narrated tour: its lines and the directory its clips live in.
 *
 * Audio bases must differ, because ids may not: two tours are free to both
 * have a `welcome`, and the generator writes `<audioBase><id>.mp3` under each
 * one's own manifest. Adding a tour here is all it takes for the generator to
 * voice it and for `startTour({ tourId })` to play it.
 */
export interface TourScript {
  id: string;
  /** Menu label; the collection, not the tour. */
  label: string;
  /** One line on what the tour shows, for whatever offers the choice. */
  blurb: string;
  /** Clip directory, relative so it resolves under a sub-path deploy. */
  audioBase: string;
  lines: NarrationLine[];
}

export const TOUR_SCRIPTS: TourScript[] = [
  {
    id: 'tax',
    label: 'Tax customer service',
    blurb: 'Three thousand customer-service cases, from a map of the country down to one person waiting.',
    audioBase: 'audio/tour/tax/',
    lines: NARRATION,
  },
  {
    id: 'birds',
    label: 'Birds of the world',
    blurb: 'Two thousand species, each with its own portrait, from a world map down to one ocean-crossing tropicbird.',
    audioBase: 'audio/tour/birds/',
    lines: BIRDS_NARRATION,
  },
];

/** The tour that opens when none is named: the onboarding collection's own. */
export const DEFAULT_TOUR_ID = 'tax';

/** The named tour, or the default one — an unknown id is never fatal. */
export function tourScript(id: string = DEFAULT_TOUR_ID): TourScript {
  return TOUR_SCRIPTS.find((t) => t.id === id) ?? TOUR_SCRIPTS[0];
}

/** Text as spoken: the caption markup stripped. */
export function spokenText(text: string): string {
  return text.replace(/\*\*/g, '');
}
