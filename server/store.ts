// The Crossbill server's data folder:
//
//   app/<name>.json          the app's own files (settings, wallets' public keys and history, labels, contacts),
//                            as the iPhone keeps them in Library/NoCloud
//   vault.json               what the iPhone keeps in the Keychain, less the seed words: two-factor, the Lightning key
//   auth.json                the login password's hash
//   server-settings.json     settings only StartOS changes, such as whether Lightning payments are on
//   initial-password.txt     the password made at first start, until it's changed
//
// Every write goes to a temporary file first and is renamed into place, so a crash never leaves half a file.
// The vault and the login are readable by the server's own user only.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A name the app uses for one of its files: settings.json, wallet-<id>.json, lightning.json and the like. */
const APP_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
/** A key the app stores in the Keychain: rpc-password, two-factor, app-pin, lightning.apiKey, seed:<id>. */
const VAULT_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export class StoreError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface ServerSettings {
  lightningPayments: boolean;
}

function writeAtomic(path: string, data: string, mode: number): void {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function readJsonFile<T>(path: string): T | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(text) as T;
}

export class DataStore {
  readonly dir: string;
  private readonly appDir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.appDir = join(dir, 'app');
    mkdirSync(this.appDir, { recursive: true, mode: 0o700 });
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  // ------------------------------------------------------------------------------------------- the app's files

  private appPath(name: string): string {
    if (!APP_FILE.test(name) || name.includes('..')) throw new StoreError('Not a name the app uses for its files', 'bad-name', 400);
    return join(this.appDir, name);
  }

  readApp(name: string): unknown {
    return readJsonFile<unknown>(this.appPath(name));
  }

  writeApp(name: string, value: unknown): void {
    writeAtomic(this.appPath(name), JSON.stringify(value), 0o600);
  }

  removeApp(name: string): void {
    rmSync(this.appPath(name), { force: true });
  }

  // ------------------------------------------------------------------------------------------- the vault

  private checkKey(key: string): void {
    if (!VAULT_KEY.test(key)) throw new StoreError('Not a key the app uses', 'bad-name', 400);
    // Seed words never leave a Krux, or the iPhone, for this server. Wallets here are watch-only
    if (key.startsWith('seed:')) throw new StoreError('Crossbill on StartOS is watch-only and never keeps seed words.', 'watch-only', 403);
  }

  private vault(): Record<string, string> {
    return readJsonFile<Record<string, string>>(this.path('vault.json')) ?? {};
  }

  vaultGet(key: string): string | null {
    if (!VAULT_KEY.test(key)) throw new StoreError('Not a key the app uses', 'bad-name', 400);
    // Asking for seed words simply finds none
    if (key.startsWith('seed:')) return null;
    return this.vault()[key] ?? null;
  }

  vaultSet(key: string, value: string): void {
    this.checkKey(key);
    const v = this.vault();
    v[key] = value;
    writeAtomic(this.path('vault.json'), JSON.stringify(v), 0o600);
  }

  vaultDelete(key: string): void {
    if (!VAULT_KEY.test(key)) throw new StoreError('Not a key the app uses', 'bad-name', 400);
    const v = this.vault();
    if (!(key in v)) return;
    delete v[key];
    writeAtomic(this.path('vault.json'), JSON.stringify(v), 0o600);
  }

  // ------------------------------------------------------------------------------------------- server settings

  settings(): ServerSettings {
    const s = readJsonFile<Partial<ServerSettings>>(this.path('server-settings.json'));
    return { lightningPayments: s?.lightningPayments === true };
  }

  updateSettings(patch: Partial<ServerSettings>): ServerSettings {
    const next = { ...this.settings(), ...patch };
    writeAtomic(this.path('server-settings.json'), JSON.stringify(next, null, 2), 0o600);
    return next;
  }

  // ------------------------------------------------------------------------------------------- raw files, for auth

  readRaw<T>(name: string): T | null {
    return readJsonFile<T>(this.path(name));
  }

  writeRaw(name: string, value: unknown): void {
    writeAtomic(this.path(name), JSON.stringify(value, null, 2), 0o600);
  }

  writeText(name: string, text: string): void {
    writeAtomic(this.path(name), text, 0o600);
  }

  remove(name: string): void {
    rmSync(this.path(name), { force: true });
  }

  /** When a file last changed, in ms, or 0 if it doesn't exist */
  changedAt(name: string): number {
    try {
      return statSync(this.path(name)).mtimeMs;
    } catch {
      return 0;
    }
  }
}
