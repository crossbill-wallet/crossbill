// Signing in to the Crossbill server. One password, kept as a scrypt hash. At first start the server makes one
// at random, logs it and leaves it in initial-password.txt, so the page is never open to whoever reaches it
// first; `node server/main.ts set-password` changes it (StartOS runs that from an action). Changing it signs out
// every session, including ones in a server that's running.
//
// Sessions live in memory: restarting the server signs everyone out. Wrong passwords slow down quickly, for
// everyone at once, since on StartOS every visitor arrives from the same proxy address.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DataStore } from './store.ts';

interface PasswordRecord {
  scheme: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
  /** Changes with the password: sessions made before it stop working */
  epoch: string;
}

const AUTH_FILE = 'auth.json';
export const INITIAL_PASSWORD_FILE = 'initial-password.txt';
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const KEY_LEN = 32;
export const MIN_PASSWORD_LENGTH = 12;
/** A session ends after this long unused */
const IDLE_MS = 8 * 60 * 60_000;
/** and after this long in any case */
const MAX_MS = 30 * 24 * 60 * 60_000;

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, KEY_LEN, { ...params, maxmem: 128 * params.N * params.r * 2 });
}

/** A password for the first start: 20 letters and digits in groups of four, about 100 bits. */
export function randomPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) {
    if (i && i % 4 === 0) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export function setPassword(store: DataStore, password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`The password needs at least ${MIN_PASSWORD_LENGTH} characters`);
  const salt = randomBytes(16);
  const hash = derive(password, salt, SCRYPT);
  const record: PasswordRecord = { scheme: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), hash: hash.toString('base64'), epoch: randomBytes(12).toString('hex') };
  store.writeRaw(AUTH_FILE, record);
  store.remove(INITIAL_PASSWORD_FILE);
}

/** Makes a password if there is none. Returns it when it was just made, so the server can log it. */
export function ensurePassword(store: DataStore): string | null {
  if (store.readRaw<PasswordRecord>(AUTH_FILE)) return null;
  const password = randomPassword();
  setPassword(store, password);
  store.writeText(INITIAL_PASSWORD_FILE, `${password}\n`);
  return password;
}

interface Session {
  epoch: string;
  created: number;
  seen: number;
}

export class Auth {
  private readonly store: DataStore;
  private readonly sessions = new Map<string, Session>();
  private failures = 0;
  private waitUntil = 0;
  private record: { at: number; value: PasswordRecord | null } = { at: -1, value: null };
  private readonly now: () => number;

  constructor(store: DataStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  /** The password record, read again whenever the file changes (set-password runs in another process). */
  private current(): PasswordRecord | null {
    const at = this.store.changedAt(AUTH_FILE);
    if (at !== this.record.at) this.record = { at, value: this.store.readRaw<PasswordRecord>(AUTH_FILE) };
    return this.record.value;
  }

  /** Seconds before another password may be tried. */
  wait(): number {
    return Math.max(0, Math.ceil((this.waitUntil - this.now()) / 1000));
  }

  /** A new session's token for the right password; null for a wrong one; 'wait' while slowed down. */
  login(password: string): string | null | 'wait' {
    if (this.wait() > 0) return 'wait';
    const rec = this.current();
    if (!rec || typeof password !== 'string' || password.length > 1024) return null;
    const got = derive(password, Buffer.from(rec.salt, 'base64'), rec);
    const want = Buffer.from(rec.hash, 'base64');
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      this.failures++;
      // Five tries straight away, then 5 s, 10 s, 20 s… up to 15 minutes between tries
      if (this.failures >= 5) this.waitUntil = this.now() + Math.min(15 * 60, 5 * 2 ** (this.failures - 5)) * 1000;
      return null;
    }
    this.failures = 0;
    this.waitUntil = 0;
    const token = randomBytes(32).toString('base64url');
    const t = this.now();
    this.sessions.set(token, { epoch: rec.epoch, created: t, seen: t });
    return token;
  }

  check(token: string | null | undefined): boolean {
    if (!token) return false;
    const s = this.sessions.get(token);
    if (!s) return false;
    const t = this.now();
    const rec = this.current();
    if (!rec || rec.epoch !== s.epoch || t - s.seen > IDLE_MS || t - s.created > MAX_MS) {
      this.sessions.delete(token);
      return false;
    }
    s.seen = t;
    return true;
  }

  logout(token: string | null | undefined): void {
    if (token) this.sessions.delete(token);
  }
}
