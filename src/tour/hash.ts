/**
 * FNV-1a, 64-bit, as a 16-character lower-case hex string. Dependency-free so
 * the same function runs in the Node generator, the browser, and vitest.
 */
export function fnv1a64(s: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(s);
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}

export interface VoiceConfig {
  voiceId: string;
  modelId: string;
  outputFormat: string;
  settings: Record<string, number | boolean>;
}

/** Identity of one generated clip: the text plus everything that shaped its sound. */
export function hashLine(text: string, voice: VoiceConfig): string {
  return fnv1a64([text, voice.voiceId, voice.modelId, JSON.stringify(voice.settings), voice.outputFormat].join('|'));
}
