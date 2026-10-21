// The app's own PIN: six digits that stand in for the iPhone passcode when Face ID doesn't work, so knowing the
// passcode alone doesn't open the wallet. A duress PIN, set beside it, opens a decoy wallet instead. Only salted
// PBKDF2 hashes are kept, in the Keychain on this device.

import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex, toHex } from './bytes';

export const PIN_LENGTH = 6;
/** PBKDF2 rounds. A guess takes a moment on the phone; the lockout does the rest. */
export const PIN_ROUNDS = 150_000;

export interface PinHash {
  salt: string;
  hash: string;
  rounds: number;
}

/** Why a PIN can't be used, or null. Same digits throughout and straight runs are refused. */
export function pinProblem(pin: string): string | null {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) return `Use ${PIN_LENGTH} digits`;
  if (/^(\d)\1+$/.test(pin)) return 'Too easy to guess: every digit is the same';
  const d = [...pin].map(Number);
  const step = d[1] - d[0];
  if ((step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step)) return 'Too easy to guess: the digits run in order';
  return null;
}

export async function hashPin(pin: string, salt?: Uint8Array, rounds = PIN_ROUNDS): Promise<PinHash> {
  const s = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const h = await pbkdf2Async(sha256, new TextEncoder().encode(pin), s, { c: rounds, dkLen: 32 });
  return { salt: toHex(s), hash: toHex(h), rounds };
}

export async function pinMatches(pin: string, stored: PinHash): Promise<boolean> {
  const h = await hashPin(pin, fromHex(stored.salt), stored.rounds);
  // Compared in full, not stopping at the first difference
  let diff = h.hash.length ^ stored.hash.length;
  for (let i = 0; i < Math.min(h.hash.length, stored.hash.length); i++) diff |= h.hash.charCodeAt(i) ^ stored.hash.charCodeAt(i);
  return diff === 0;
}
