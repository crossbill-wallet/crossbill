// The Crossbill server's settings, from environment variables. On StartOS the package sets them; on a Mac they
// can be set by hand to try the server against a real node (docs/server.md).

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type NetworkName = 'mainnet' | 'testnet4' | 'regtest';

export interface SocksProxy {
  host: string;
  port: number;
}

export interface ServerConfig {
  /** The address the web page and API are served on */
  host: string;
  port: number;
  /** Where the app's files, the vault and the login live */
  dataDir: string;
  /** The StartOS build of the screens: `vite build --mode server` */
  staticDir: string;
  network: NetworkName;
  rpc: {
    /** Bitcoin Knots' RPC, such as http://10.0.3.1:8332 on StartOS's own network */
    url: URL;
    user: string;
    password: string;
    /**
     * Bitcoin's RPC cookie file (`user:password`), read again for every call: the node writes a new one each time it
     * starts. Set, it takes the place of the user and password
     */
    cookieFile: string | null;
    /** A root certificate to trust for an https RPC address that isn't an onion */
    ca: string | null;
  };
  lightning: {
    /** Lightning Fork's dashboard (its mobile API), reached through StartOS. Null: only an onion, through Tor */
    url: URL | null;
    ca: string | null;
    /** Set: paying on Lightning is on or off whatever the server's own setting says */
    paymentsOverride: boolean | null;
  };
  /** A Tor SOCKS proxy, for onion addresses and the price through Tor. Null: no Tor */
  tor: SocksProxy | null;
  /** RPC methods to allow besides the ones the app calls */
  extraRpcMethods: string[];
  version: string;
}

export class ConfigError extends Error {}

const HERE = dirname(fileURLToPath(import.meta.url));

function readSecret(env: NodeJS.ProcessEnv, name: string): string | null {
  const direct = env[name];
  if (direct != null && direct !== '') return direct;
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return null;
}

function parseUrl(name: string, value: string | undefined, required: true): URL;
function parseUrl(name: string, value: string | undefined, required: false): URL | null;
function parseUrl(name: string, value: string | undefined, required: boolean): URL | null {
  if (!value) {
    if (required) throw new ConfigError(`${name} is not set`);
    return null;
  }
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not an address: ${value}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError(`${name} must start with http:// or https://`);
  if (u.username || u.password) throw new ConfigError(`${name} must not carry a user or password; use the separate settings`);
  return u;
}

export function parseSocks(value: string | undefined): SocksProxy | null {
  if (!value) return null;
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(value.trim().replace(/^socks5h?:\/\//, ''));
  if (!m) throw new ConfigError(`CROSSBILL_TOR_SOCKS must be host:port, such as 10.0.3.1:9050`);
  const port = Number(m[2]);
  if (port < 1 || port > 65535) throw new ConfigError(`CROSSBILL_TOR_SOCKS has a port out of range`);
  return { host: m[1], port };
}

function onOff(name: string, value: string | undefined): boolean | null {
  if (value == null || value === '') return null;
  if (/^(on|true|1|yes)$/i.test(value)) return true;
  if (/^(off|false|0|no)$/i.test(value)) return false;
  throw new ConfigError(`${name} must be on or off`);
}

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const network = (env.CROSSBILL_NETWORK ?? 'mainnet') as NetworkName;
  if (!['mainnet', 'testnet4', 'regtest'].includes(network)) throw new ConfigError('CROSSBILL_NETWORK must be mainnet, testnet4 or regtest');
  const port = Number(env.CROSSBILL_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError('CROSSBILL_PORT must be a port number');
  const caFile = (name: string) => (env[name] ? readFileSync(env[name]!, 'utf8') : null);
  return {
    host: env.CROSSBILL_HOST ?? '0.0.0.0',
    port,
    dataDir: resolve(env.CROSSBILL_DATA_DIR ?? './data'),
    staticDir: resolve(env.CROSSBILL_STATIC_DIR ?? join(HERE, '..', 'dist-server')),
    network,
    rpc: {
      url: parseUrl('CROSSBILL_RPC_URL', env.CROSSBILL_RPC_URL, true),
      user: env.CROSSBILL_RPC_USER ?? '',
      password: readSecret(env, 'CROSSBILL_RPC_PASSWORD') ?? '',
      cookieFile: env.CROSSBILL_RPC_COOKIE_FILE ? resolve(env.CROSSBILL_RPC_COOKIE_FILE) : null,
      ca: caFile('CROSSBILL_RPC_CA_FILE'),
    },
    lightning: {
      url: parseUrl('CROSSBILL_LF_URL', env.CROSSBILL_LF_URL, false),
      ca: caFile('CROSSBILL_LF_CA_FILE'),
      paymentsOverride: onOff('CROSSBILL_LIGHTNING_PAYMENTS', env.CROSSBILL_LIGHTNING_PAYMENTS),
    },
    tor: parseSocks(env.CROSSBILL_TOR_SOCKS),
    extraRpcMethods: (env.CROSSBILL_RPC_EXTRA_METHODS ?? '')
      .split(',')
      .map((m) => m.trim().toLowerCase())
      .filter((m) => /^[a-z]+$/.test(m)),
    version: packageVersion(),
  };
}
