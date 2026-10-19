// What the seed words screen says while words are typed or pasted in. Kept out of the UI so it can be tested.

import { BIP39_WORDS, isValidMnemonic, normalizeMnemonic } from './keys';

/** The lengths BIP39 allows, as Shrike on the desktop offers them. */
export const WORD_COUNTS = [12, 15, 18, 21, 24] as const;

/**
 * What to say under the seed words box. The checksum is only judged once the chosen number of words is in and the
 * last one is finished, so a seed part way through never reads as wrong.
 */
export function seedWordsFeedback(text: string, count: number, settledLast: boolean): { error: string | null; hint: string; valid: boolean } {
  const list = normalizeMnemonic(text).split(' ').filter(Boolean);
  const finished = settledLast || /\s$/.test(text) ? list : list.slice(0, -1);
  const unknown = [...new Set(finished.filter((w) => !BIP39_WORDS.includes(w)))];
  const progress = `${list.length} of ${count} words, in order, separated by spaces.`;
  if (unknown.length) return { error: `Not a seed word: ${unknown.join(', ')}`, hint: progress, valid: false };
  if (list.length > count) return { error: `That’s ${list.length} words, more than the ${count} picked above.`, hint: progress, valid: false };
  if (list.length < count) return { error: null, hint: progress, valid: false };
  const valid = isValidMnemonic(list.join(' '));
  if (valid) return { error: null, hint: `All ${count} words are in and they check out.`, valid: true };
  if (finished.length < count) return { error: null, hint: progress, valid: false };
  return { error: `All ${count} words are in, but they don’t form a valid seed. A word is likely misspelled or out of order.`, hint: progress, valid: false };
}
