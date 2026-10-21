// The backup file: everything the app knows except secrets, sealed with a password. The key comes from the password
// through scrypt, and the contents are encrypted and authenticated with XChaCha20-Poly1305, so a wrong password or
// a changed byte is caught rather than read as garbage. The settings in the file's header are bound to the
// ciphertext too, so they can't be swapped either.

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { base64 } from '@scure/base';

export const BACKUP_FORMAT = 1;
export const BACKUP_MIN_PASSWORD = 8;

/** scrypt cost: 64 MiB of memory and about a second on a recent iPhone. */
const DEFAULT_KDF = { N: 2 ** 16, r: 8, p: 1 };
/** The most memory a file may ask scrypt for (128 × N × r bytes), so a crafted file can't exhaust the phone's. */
const MAX_KDF_BYTES = 256 * 1024 * 1024;

export interface BackupHeader {
  shrikeBackup: number;
  /** ISO time the file was made, readable before the password is entered */
  createdAt: string;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'xchacha20-poly1305';
  nonce: string;
}

export interface BackupFile extends BackupHeader {
  data: string;
}

export class BackupError extends Error {
  constructor(
    message: string,
    readonly kind: 'not-a-backup' | 'unsupported' | 'wrong-password',
  ) {
    super(message);
  }
}

function aad(h: BackupHeader): Uint8Array {
  return new TextEncoder().encode(`shrike-backup:${h.shrikeBackup}:${h.kdf.name}:${h.kdf.N}:${h.kdf.r}:${h.kdf.p}:${h.kdf.salt}:${h.cipher}:${h.nonce}:${h.createdAt}`);
}

async function keyFor(password: string, kdf: BackupHeader['kdf']): Promise<Uint8Array> {
  return scryptAsync(new TextEncoder().encode(password.normalize('NFKC')), base64.decode(kdf.salt), {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    dkLen: 32,
    maxmem: 128 * kdf.r * (kdf.N + kdf.p + 2) + 1024 * 1024,
  });
}

/** Seals `contents` (anything JSON can hold) with `password`. Returns the file's text. */
export async function encryptBackup(contents: unknown, password: string, kdf = DEFAULT_KDF, now = new Date()): Promise<string> {
  if (password.length < BACKUP_MIN_PASSWORD) throw new Error(`Use a password of at least ${BACKUP_MIN_PASSWORD} characters`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const header: BackupHeader = {
    shrikeBackup: BACKUP_FORMAT,
    createdAt: now.toISOString(),
    kdf: { name: 'scrypt', ...kdf, salt: base64.encode(salt) },
    cipher: 'xchacha20-poly1305',
    nonce: base64.encode(nonce),
  };
  const key = await keyFor(password, header.kdf);
  const sealed = xchacha20poly1305(key, nonce, aad(header)).encrypt(new TextEncoder().encode(JSON.stringify(contents)));
  key.fill(0);
  const file: BackupFile = { ...header, data: base64.encode(sealed) };
  return JSON.stringify(file, null, 1);
}

/** Reads a file's header without the password, to say what it is before asking for one. */
export function readBackupHeader(text: string): BackupFile {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new BackupError('This isn’t a Shrike backup file', 'not-a-backup');
  }
  const f = o as Partial<BackupFile> | null;
  if (!f || typeof f !== 'object' || typeof f.shrikeBackup !== 'number' || typeof f.data !== 'string') {
    throw new BackupError('This isn’t a Shrike backup file', 'not-a-backup');
  }
  if (f.shrikeBackup > BACKUP_FORMAT) throw new BackupError('This backup was made by a newer version of Shrike. Update the app first.', 'unsupported');
  const k = f.kdf;
  if (
    f.cipher !== 'xchacha20-poly1305' ||
    !k ||
    k.name !== 'scrypt' ||
    !Number.isInteger(k.N) ||
    k.N < 2 ||
    k.N > 2 ** 20 ||
    (k.N & (k.N - 1)) !== 0 ||
    !Number.isInteger(k.r) ||
    k.r < 1 ||
    k.r > 16 ||
    !Number.isInteger(k.p) ||
    k.p < 1 ||
    k.p > 2 ||
    128 * k.N * k.r > MAX_KDF_BYTES ||
    typeof k.salt !== 'string' ||
    typeof f.nonce !== 'string' ||
    typeof f.createdAt !== 'string'
  ) {
    throw new BackupError('This backup file is damaged or wasn’t made by Shrike', 'not-a-backup');
  }
  return f as BackupFile;
}

/** Opens a backup. Throws BackupError 'wrong-password' if the password is wrong or the file was changed. */
export async function decryptBackup(text: string, password: string): Promise<unknown> {
  const f = readBackupHeader(text);
  let nonce: Uint8Array;
  let sealed: Uint8Array;
  try {
    nonce = base64.decode(f.nonce);
    sealed = base64.decode(f.data);
    base64.decode(f.kdf.salt);
  } catch {
    throw new BackupError('This backup file is damaged', 'not-a-backup');
  }
  if (nonce.length !== 24) throw new BackupError('This backup file is damaged', 'not-a-backup');
  const key = await keyFor(password, f.kdf);
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(key, nonce, aad(f)).decrypt(sealed);
  } catch {
    throw new BackupError('That password doesn’t open this backup, or the file was changed since it was made', 'wrong-password');
  } finally {
    key.fill(0);
  }
  return JSON.parse(new TextDecoder().decode(plain));
}
