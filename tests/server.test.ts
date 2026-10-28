// The Crossbill server (server/), the StartOS build's back end: signing in, the app's files and vault (never seed
// words), and relaying the page's requests to a pretend Knots node, the pretend Lightning Fork dashboard
// (tools/lf-mock) and a pretend Tor proxy. Lightning is driven by the app's own LfClient, as the page would.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createNetServer, connect as netConnect, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type CrossbillServer } from '../server/app';
import { Auth, setPassword } from '../server/auth';
import type { ServerConfig } from '../server/config';
import { DataStore } from '../server/store';
import { isDefiniteRefusal, LfClient, LfError, newRequestId, parsePairingCode, type LfHttp } from '../src/core/lfapi';
import { MockNode } from '../tools/lf-mock/mock';

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

function listen(server: Server | NetServer): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

function readAll(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// ------------------------------------------------------------------------------------------- pretend servers

const knotsSeen: Seen[] = [];
const knots = createServer(async (req, res) => {
  const body = await readAll(req);
  knotsSeen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
  const calls = JSON.parse(body);
  const answer = (c: { id: number; method: string }) => ({ id: c.id, error: null, result: c.method === 'getblockchaininfo' ? { chain: 'main', blocks: 900_000 } : { ok: c.method } });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(Array.isArray(calls) ? calls.map(answer) : answer(calls)));
});

let node: MockNode;
const lfSeen: Seen[] = [];
const lf = createServer(async (req, res) => {
  const body = await readAll(req);
  lfSeen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
  const out = await node.handle({ method: req.method ?? 'GET', path: req.url ?? '/', headers, body });
  res.writeHead(out.status, { 'Content-Type': 'application/json' });
  res.end(out.body);
});

/** A SOCKS5 proxy that sends every connection to the pretend Lightning Fork, and notes the names asked for. */
const socksAsked: string[] = [];
let lfPort = 0;
const socks: NetServer = createNetServer((c) => {
  let stage = 0;
  c.on('data', function onData(d: Buffer) {
    if (stage === 0) {
      c.write(Buffer.from([5, 0]));
      stage = 1;
      return;
    }
    const len = d[4];
    socksAsked.push(`${d.subarray(5, 5 + len).toString('utf8')}:${d.readUInt16BE(5 + len)}`);
    c.off('data', onData);
    const up = netConnect(lfPort, '127.0.0.1', () => {
      c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      c.pipe(up).pipe(c);
    });
    up.on('error', () => c.destroy());
  });
});

let knotsPort = 0;
let socksPort = 0;
const dirs: string[] = [];

function config(dataDir: string, over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    staticDir: join(dataDir, 'no-build'),
    network: 'mainnet',
    rpc: { url: new URL(`http://127.0.0.1:${knotsPort}`), user: 'crossbill', password: 'node-secret', cookieFile: null, ca: null },
    lightning: { url: new URL(`http://127.0.0.1:${lfPort}`), ca: null, paymentsOverride: null },
    tor: null,
    extraRpcMethods: [],
    version: 'test',
    ...over,
  };
}

async function start(over: Partial<ServerConfig> = {}): Promise<CrossbillServer> {
  const dir = mkdtempSync(join(tmpdir(), 'crossbill-server-'));
  dirs.push(dir);
  return startServer(config(dir, over), { log: () => undefined });
}

beforeAll(async () => {
  knotsPort = await listen(knots);
  lfPort = await listen(lf);
  socksPort = await listen(socks);
});

afterAll(() => {
  knots.close();
  lf.close();
  socks.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  knotsSeen.length = 0;
  lfSeen.length = 0;
  socksAsked.length = 0;
  node = new MockNode({ ownBridge: { ready: true, availableSat: 196_500 } });
});

/** A signed-in page, as far as the server can tell. */
class Page {
  cookie = '';
  readonly base: string;
  constructor(port: number) {
    this.base = `http://127.0.0.1:${port}`;
  }

  async signIn(password: string): Promise<Response> {
    const res = await fetch(`${this.base}/login`, { method: 'POST', body: new URLSearchParams({ password }), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return res;
  }

  api(path: string, init: { method?: string; body?: unknown; header?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = { Cookie: this.cookie };
    if (init.header !== false) headers['X-Crossbill'] = '1';
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${this.base}/api/${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), redirect: 'manual' });
  }

  /** What server-native.ts sends for one native httpRequest */
  relay(ask: Record<string, unknown>): Promise<Response> {
    return this.api('http', { method: 'POST', body: { method: 'POST', headers: {}, body: '', timeoutMs: 10_000, useTor: false, ...ask } });
  }
}

async function signedIn(s: CrossbillServer): Promise<Page> {
  const p = new Page(s.port);
  const res = await p.signIn(s.initialPassword!);
  expect(res.status).toBe(303);
  return p;
}

// ------------------------------------------------------------------------------------------- signing in

describe('signing in', () => {
  it('makes a password at first start, kept for the server only, and never twice', async () => {
    const s = await start();
    expect(s.initialPassword).toMatch(/^([a-z0-9]{4}-){4}[a-z0-9]{4}$/);
    const file = s.store.path('initial-password.txt');
    expect(readFileSync(file, 'utf8').trim()).toBe(s.initialPassword);
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(statSync(s.store.path('auth.json')).mode & 0o077).toBe(0);
    const login = await (await fetch(`http://127.0.0.1:${s.port}/login`)).text();
    expect(login).toContain('first password');
    await s.close();
    const again = await startServer(config(s.store.dir), { log: () => undefined });
    expect(again.initialPassword).toBeNull();
    await again.close();
  });

  it('keeps everything but the health check and the sign-in page behind a session', async () => {
    const s = await start();
    const base = `http://127.0.0.1:${s.port}`;
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    const home = await fetch(`${base}/`, { redirect: 'manual' });
    expect(home.status).toBe(303);
    expect(home.headers.get('location')).toBe('/login');
    const p = new Page(s.port);
    expect((await p.api('info')).status).toBe(401);
    expect((await p.api('storage/settings.json', { method: 'PUT', body: { value: 1 } })).status).toBe(401);
    await s.close();
  });

  it('sets a session cookie a page on another site can’t use, and turns away calls without the header', async () => {
    const s = await start();
    const p = new Page(s.port);
    expect((await p.signIn('not the password')).status).toBe(401);
    const res = await p.signIn(s.initialPassword!);
    expect(res.status).toBe(303);
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect((await p.api('info')).status).toBe(200);
    const noHeader = await p.api('info', { header: false });
    expect(noHeader.status).toBe(403);
    await s.close();
  });

  it('says what the page needs to know, and nothing secret', async () => {
    const s = await start({ tor: { host: '127.0.0.1', port: socksPort } });
    const p = await signedIn(s);
    const info = await (await p.api('info')).json();
    expect(info).toEqual({ version: 'test', network: 'mainnet', node: { host: '127.0.0.1', port: knotsPort, tls: false }, tor: true, lightning: { reachable: true, payments: false } });
    expect(JSON.stringify(info)).not.toContain('node-secret');
    await s.close();
  });

  it('slows down after five wrong passwords, for everyone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crossbill-auth-'));
    dirs.push(dir);
    const store = new DataStore(dir);
    setPassword(store, 'correct horse battery');
    let t = 1_000_000;
    const auth = new Auth(store, () => t);
    for (let i = 0; i < 5; i++) expect(auth.login('wrong password')).toBeNull();
    expect(auth.login('correct horse battery')).toBe('wait');
    expect(auth.wait()).toBe(5);
    t += 5_000;
    expect(typeof auth.login('correct horse battery')).toBe('string');
  });

  it('signs out every session when the password changes, even from another process', async () => {
    const s = await start();
    const p = await signedIn(s);
    expect((await p.api('info')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    setPassword(new DataStore(s.store.dir), 'a brand new password');
    expect((await p.api('info')).status).toBe(401);
    expect(existsSync(s.store.path('initial-password.txt'))).toBe(false);
    expect((await p.signIn('a brand new password')).status).toBe(303);
    await s.close();
  });

  it('refuses a password shorter than twelve characters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crossbill-auth-'));
    dirs.push(dir);
    expect(() => setPassword(new DataStore(dir), 'short')).toThrow(/12 characters/);
  });
});

// ------------------------------------------------------------------------------------------- files and vault

describe('the app’s files and vault', () => {
  it('keeps the app’s files in the data folder', async () => {
    const s = await start();
    const p = await signedIn(s);
    expect(await (await p.api('storage/settings.json')).json()).toEqual({ value: null });
    expect((await p.api('storage/settings.json', { method: 'PUT', body: { value: { unit: 'sats' } } })).status).toBe(200);
    expect(await (await p.api('storage/settings.json')).json()).toEqual({ value: { unit: 'sats' } });
    expect(JSON.parse(readFileSync(join(s.store.dir, 'app', 'settings.json'), 'utf8'))).toEqual({ unit: 'sats' });
    expect((await p.api('storage/settings.json', { method: 'DELETE' })).status).toBe(200);
    expect(await (await p.api('storage/settings.json')).json()).toEqual({ value: null });
    await s.close();
  });

  it('takes only names the app uses', async () => {
    const s = await start();
    const p = await signedIn(s);
    for (const bad of ['..%2Fauth.json', 'notes.txt', '.hidden.json', '%2Fetc%2Fpasswd.json']) {
      const res = await p.api(`storage/${bad}`, { method: 'PUT', body: { value: 1 } });
      expect(res.status, bad).toBe(400);
    }
    await s.close();
  });

  it('keeps two-factor and the Lightning key, never seed words', async () => {
    const s = await start();
    const p = await signedIn(s);
    expect((await p.api('vault/two-factor', { method: 'PUT', body: { value: '{"k":1}' } })).status).toBe(200);
    expect(await (await p.api('vault/two-factor')).json()).toEqual({ value: '{"k":1}' });
    const seed = await p.api('vault/seed%3Aabc', { method: 'PUT', body: { value: 'abandon abandon …' } });
    expect(seed.status).toBe(403);
    expect((await seed.json()).error.code).toBe('watch-only');
    expect(await (await p.api('vault/seed%3Aabc')).json()).toEqual({ value: null });
    expect(readFileSync(s.store.path('vault.json'), 'utf8')).not.toContain('abandon');
    expect(statSync(s.store.path('vault.json')).mode & 0o077).toBe(0);
    await s.close();
  });
});

// ------------------------------------------------------------------------------------------- the node

describe('the node', () => {
  it('reaches Knots with the password only the server holds', async () => {
    const s = await start();
    const p = await signedIn(s);
    const res = await p.relay({
      kind: 'rpc',
      url: 'http://127.0.0.1:0/wallet/cormorant',
      headers: { authorization: 'Basic ' + btoa(':'), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'listsinceblock', params: [] }),
    });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).result).toEqual({ ok: 'listsinceblock' });
    expect(knotsSeen).toHaveLength(1);
    expect(knotsSeen[0].path).toBe('/wallet/cormorant');
    expect(knotsSeen[0].headers.authorization).toBe('Basic ' + Buffer.from('crossbill:node-secret').toString('base64'));
    expect(knotsSeen[0].headers.cookie).toBeUndefined();
    await s.close();
  });

  it('reads the node’s cookie file for every call, as the node rewrites it on each start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crossbill-cookie-'));
    dirs.push(dir);
    const cookie = join(dir, '.cookie');
    writeFileSync(cookie, '__cookie__:first\n');
    const s = await start({ rpc: { url: new URL(`http://127.0.0.1:${knotsPort}`), user: 'ignored', password: 'ignored', cookieFile: cookie, ca: null } });
    const p = await signedIn(s);
    const ask = () => p.relay({ kind: 'rpc', url: 'http://node/', body: JSON.stringify({ method: 'getblockchaininfo' }) });
    expect((await ask()).status).toBe(200);
    expect(knotsSeen[0].headers.authorization).toBe('Basic ' + Buffer.from('__cookie__:first').toString('base64'));
    writeFileSync(cookie, '__cookie__:second\n');
    expect((await ask()).status).toBe(200);
    expect(knotsSeen[1].headers.authorization).toBe('Basic ' + Buffer.from('__cookie__:second').toString('base64'));
    rmSync(cookie);
    const gone = await ask();
    expect(gone.status).toBe(502);
    expect((await gone.json()).error.message).toMatch(/cookie/);
    expect(knotsSeen).toHaveLength(2);
    await s.close();
  });

  it('passes on a batch of calls the app makes', async () => {
    const s = await start();
    const p = await signedIn(s);
    const body = JSON.stringify([
      { jsonrpc: '1.0', id: 1, method: 'getblockchaininfo', params: [] },
      { jsonrpc: '1.0', id: 2, method: 'estimatesmartfee', params: [2] },
    ]);
    const out = await (await p.relay({ kind: 'rpc', url: 'http://node/', body })).json();
    expect(JSON.parse(out.body)[0].result.chain).toBe('main');
    await s.close();
  });

  it('refuses calls the app never makes, and wallets other than cormorant', async () => {
    const s = await start();
    const p = await signedIn(s);
    for (const method of ['stop', 'dumpwallet', 'walletpassphrase', 'sendtoaddress', 'signrawtransactionwithwallet']) {
      const res = await p.relay({ kind: 'rpc', url: 'http://node/', body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params: [] }) });
      expect(res.status, method).toBe(403);
    }
    const batch = JSON.stringify([
      { method: 'getblockchaininfo', params: [] },
      { method: 'stop', params: [] },
    ]);
    expect((await p.relay({ kind: 'rpc', url: 'http://node/', body: batch })).status).toBe(403);
    const other = await p.relay({ kind: 'rpc', url: 'http://node/wallet/someone-else', body: JSON.stringify({ method: 'getwalletinfo' }) });
    expect(other.status).toBe(403);
    for (const name of ['spending', '']) {
      for (const method of ['createwallet', 'loadwallet']) {
        const res = await p.relay({ kind: 'rpc', url: 'http://node/', body: JSON.stringify({ method, params: [name] }) });
        expect(res.status, `${method} ${name}`).toBe(403);
      }
    }
    expect(knotsSeen).toHaveLength(0);
    const cormorant = await p.relay({ kind: 'rpc', url: 'http://node/', body: JSON.stringify({ method: 'loadwallet', params: ['cormorant', true] }) });
    expect(cormorant.status).toBe(200);
    expect(knotsSeen).toHaveLength(1);
    await s.close();
  });

  it('says plainly when the node can’t be reached', async () => {
    const s = await start({ rpc: { url: new URL('http://127.0.0.1:1'), user: 'u', password: 'p', cookieFile: null, ca: null } });
    const p = await signedIn(s);
    const res = await p.relay({ kind: 'rpc', url: 'http://node/', body: JSON.stringify({ method: 'getblockchaininfo' }) });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('network');
    await s.close();
  });
});

// ------------------------------------------------------------------------------------------- Lightning

/** The page's way to the Lightning node, as server-native.ts sends it, for the app's own LfClient. */
function pageHttp(p: Page): LfHttp {
  return async (r) => {
    const res = await p.relay({ kind: 'lightning', url: r.url, method: r.method, headers: r.headers, body: r.body, timeoutMs: r.timeoutMs, useTor: r.route === 'tor', pinPem: r.pinPem, captureRootSha256: r.captureRootSha256 });
    const out = await res.json();
    if (!res.ok) throw Object.assign(new Error(out.error.message), { code: out.error.code });
    return out;
  };
}

async function paired(p: Page): Promise<{ client: LfClient; key: string }> {
  const code = parsePairingCode(node.issueCode().json)!;
  const client = new LfClient({ onionUrl: code.onion, lanUrl: code.lan, lanIp: code.ip, caPem: null, caSha256: code.ca }, pageHttp(p), null, { lanLikely: () => false });
  const res = await client.pair(code.code, 'Crossbill on StartOS', newRequestId());
  client.setKey(res.apiKey);
  return { client, key: res.apiKey };
}

describe('Lightning', () => {
  it('pairs and reads the node through StartOS, whatever onion the code names', async () => {
    const s = await start();
    const p = await signedIn(s);
    const { client } = await paired(p);
    const boot = await client.bootstrap();
    expect(boot.apiVersion).toBe(1);
    expect(client.last).toMatch(/\.onion$/);
    expect(lfSeen.some((x) => x.path === '/api/v1/pair')).toBe(true);
    // Nothing of the page's own goes to the node
    expect(lfSeen.every((x) => x.headers.cookie === undefined && x.headers['x-crossbill'] === undefined)).toBe(true);
    await s.close();
  });

  it('never tries the home address: that’s the iPhone’s, pinned to the node’s root', async () => {
    const s = await start();
    const p = await signedIn(s);
    const res = await p.relay({ kind: 'lightning', url: 'https://lightning-fork.local:7157/api/v1/bootstrap', method: 'GET', captureRootSha256: 'AA:BB' });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('network');
    expect(lfSeen).toHaveLength(0);
    await s.close();
  });

  it('refuses to pay while payments are off, in a way the app knows moved nothing', async () => {
    const s = await start();
    const p = await signedIn(s);
    const { client } = await paired(p);
    const invoice = node.sample('xbt', 1250, 'Coffee', 600);
    let err: unknown = null;
    try {
      await client.pay({ request: invoice, requestId: newRequestId() });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LfError);
    expect((err as LfError).code).toBe('payments_off');
    expect(isDefiniteRefusal(err)).toBe(true);
    expect(lfSeen.some((x) => x.path === '/api/v1/lightning/pay')).toBe(false);
    for (const path of ['/api/v1/pay/bitcoin-invoice', '/api/v1/onchain/send']) {
      const res = await p.relay({ kind: 'lightning', url: `http://x.onion${path}`, body: '{}' });
      expect((await res.json()).status, path).toBe(409);
    }
    // Making an invoice and reading balances still work
    expect((await client.wallet()).lightning.outboundSat).toBeGreaterThan(0);
    expect((await client.createInvoice({ amountSat: 1000, memo: 'test' })).paymentHash).toBeTruthy();
    await s.close();
  });

  it('pays once payments are turned on for the server', async () => {
    const s = await start();
    const p = await signedIn(s);
    const { client } = await paired(p);
    s.store.updateSettings({ lightningPayments: true });
    expect((await (await p.api('info')).json()).lightning.payments).toBe(true);
    const r = await client.pay({ request: node.sample('xbt', 1250, 'Coffee', 600), requestId: newRequestId() });
    expect(r.status).toBeTruthy();
    expect(lfSeen.some((x) => x.path === '/api/v1/lightning/pay')).toBe(true);
    await s.close();
  });

  it('lets the setting on StartOS override the server’s own', async () => {
    const s = await start({ lightning: { url: new URL(`http://127.0.0.1:${lfPort}`), ca: null, paymentsOverride: false } });
    s.store.updateSettings({ lightningPayments: true });
    const p = await signedIn(s);
    expect((await (await p.api('info')).json()).lightning.payments).toBe(false);
    const res = await p.relay({ kind: 'lightning', url: 'http://x.onion/api/v1/lightning/pay', body: '{}' });
    expect((await res.json()).status).toBe(409);
    await s.close();
  });

  it('reaches an onion through Tor when StartOS has no way to the node', async () => {
    const s = await start({ lightning: { url: null, ca: null, paymentsOverride: null }, tor: { host: '127.0.0.1', port: socksPort } });
    const p = await signedIn(s);
    const { client } = await paired(p);
    await client.bootstrap();
    expect(socksAsked[0]).toMatch(/^mocklightningfork.*\.onion:80$/);
    await s.close();
  });

  it('answers, rather than falls over, when an onion behind Tor doesn’t speak HTTPS', async () => {
    const s = await start({ lightning: { url: null, ca: null, paymentsOverride: null }, tor: { host: '127.0.0.1', port: socksPort } });
    const p = await signedIn(s);
    const res = await p.relay({ kind: 'lightning', url: 'https://plain.onion/api/v1/bootstrap', method: 'GET' });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/doesn’t speak HTTPS/);
    // and the server is still there
    expect((await p.api('info')).status).toBe(200);
    await s.close();
  });

  it('says Lightning isn’t connected when there’s neither', async () => {
    const s = await start({ lightning: { url: null, ca: null, paymentsOverride: null } });
    const p = await signedIn(s);
    const res = await p.relay({ kind: 'lightning', url: 'http://x.onion/api/v1/bootstrap', method: 'GET' });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/isn’t connected/);
    await s.close();
  });
});

// ------------------------------------------------------------------------------------------- the price

describe('the price', () => {
  it('asks Neoxa Exchange only, and through Tor only when the server has it', async () => {
    const s = await start();
    const p = await signedIn(s);
    const elsewhere = await p.relay({ kind: 'price', method: 'GET', url: 'https://example.com/api/exchange/ticker/BTCB2_USDC' });
    expect(elsewhere.status).toBe(403);
    const plain = await p.relay({ kind: 'price', method: 'GET', url: 'http://neoxa.exchange/api/exchange/ticker/BTCB2_USDC' });
    expect(plain.status).toBe(403);
    const tor = await p.relay({ kind: 'price', method: 'GET', url: 'https://neoxa.exchange/api/exchange/ticker/BTCB2_USDC', useTor: true });
    expect(tor.status).toBe(502);
    expect((await tor.json()).error.message).toMatch(/no Tor proxy/);
    await s.close();
  });
});
