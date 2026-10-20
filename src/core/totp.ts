// Time-based one-time codes (RFC 6238, the scheme every authenticator app speaks) and one-time recovery codes.
// The secret is made on the phone, shown once as a QR code for the authenticator, and kept in the Keychain.

import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base32nopad } from '@scure/base';
import { toHex } from './bytes';

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
/** Codes one step either side of now are accepted, for a phone and an authenticator whose clocks differ a little. */
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 8;

/** 160 random bits, the size RFC 4226 recommends for HMAC-SHA1. */
export function newTotpSecret(): Uint8Array {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return b;
}

export function encodeSecret(secret: Uint8Array): string {
  return base32nopad.encode(secret);
}

/** Accepts what a person might type: lower case, spaces, dashes and trailing padding. */
export function decodeSecret(text: string): Uint8Array {
  return base32nopad.decode(text.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, ''));
}

/** The secret in groups of four, for typing into an authenticator by hand. */
export function groupSecret(b32: string): string {
  return (b32.match(/.{1,4}/g) ?? []).join(' ');
}

export function timeStep(unixSeconds: number, period = TOTP_PERIOD): number {
  return Math.floor(unixSeconds / period);
}

/** HOTP (RFC 4226) for one counter value. */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const mac = hmac(sha1, secret, msg);
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totp(secret: Uint8Array, unixSeconds: number, digits = TOTP_DIGITS): string {
  return hotp(secret, timeStep(unixSeconds), digits);
}

/** Just the digits of what was typed, or pasted with a space in the middle as some apps show it. */
export function cleanCode(text: string): string {
  return text.replace(/[\s-]/g, '');
}

/**
 * Checks a code against the steps around now. Returns the step it matched, or null. A step at or before
 * `lastUsed` is refused, so a code seen over someone's shoulder can't be used a second time.
 */
export function verifyTotp(secret: Uint8Array, code: string, unixSeconds: number, lastUsed: number | null = null, window = TOTP_WINDOW): number | null {
  const c = cleanCode(code);
  if (!/^\d{6}$/.test(c)) return null;
  const now = timeStep(unixSeconds);
  for (let d = -window; d <= window; d++) {
    const step = now + d;
    if (lastUsed != null && step <= lastUsed) continue;
    if (constantTimeEqual(hotp(secret, step), c)) return step;
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The otpauth:// link authenticator apps read from a QR code (the Key Uri Format). */
export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD) });
  return `otpauth://totp/${label}?${q.toString().replace(/\+/g, '%20')}`;
}

// Recovery codes: ten characters from an alphabet without look-alikes (no 0/O, 1/I/L), shown as XXXXX-XXXXX.
// Only their hashes are kept, and each works once.

const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const out: string[] = [];
  while (out.length < count) {
    const b = new Uint8Array(10);
    crypto.getRandomValues(b);
    // 256 isn't a multiple of 31; dropping bytes of 248 or more keeps every character equally likely
    if (b.some((x) => x >= 248)) continue;
    const s = Array.from(b, (x) => RECOVERY_ALPHABET[x % RECOVERY_ALPHABET.length]).join('');
    out.push(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return out;
}

export function normalizeRecoveryCode(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function looksLikeRecoveryCode(text: string): boolean {
  const n = normalizeRecoveryCode(text);
  return n.length === 10 && [...n].every((ch) => RECOVERY_ALPHABET.includes(ch));
}

export function hashRecoveryCode(text: string): string {
  return toHex(sha256(new TextEncoder().encode(`shrike-recovery:${normalizeRecoveryCode(text)}`)));
}

/** Index of the stored hash this code matches, or -1. */
export function matchRecoveryCode(hashes: string[], text: string): number {
  if (!looksLikeRecoveryCode(text)) return -1;
  return hashes.indexOf(hashRecoveryCode(text));
}

/** Seconds a person must wait after `failures` wrong codes in a row. */
export function lockoutSeconds(failures: number): number {
  if (failures < 5) return 0;
  if (failures < 10) return 30;
  if (failures < 15) return 300;
  return 3600;
}
