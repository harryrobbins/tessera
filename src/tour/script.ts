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

/** Text as spoken: the caption markup stripped. */
export function spokenText(text: string): string {
  return text.replace(/\*\*/g, '');
}
