// The StartOS build's page, end to end without a browser: the app model, with target.ts saying "server" and the
// native plugin answered by server-native.ts, against a real Crossbill server (server/) in front of the pretend
// Lightning Fork dashboard. The page's fetch goes to that server with its session cookie, as a browser's would.

import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { startServer } from '../server/app';
import { MockNode } from '../tools/lf-mock/mock';

vi.mock('../src/app/target', () => ({ TARGET: 'server', isServer: true }));
vi.mock('../src/app/native', async () => {
  const actual = await vi.importActual<typeof import('../src/app/native')>('../src/app/native');
  const { ShrikeNativeServer } = await vi.importActual<typeof import('../src/app/server-native')>('../src/app/server-native');
  return { ...actual, isNative: false, ShrikeNative: new ShrikeNativeServer() };
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

// A node that answers only the first question, so connecting stops there: syncing is covered elsewhere
const knots = createServer((_req, res) => {
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 1, result: null, error: { code: -28, message: 'Loading block index…' } }));
});
const node = new MockNode({ ownBridge: { ready: true, availableSat: 196_500 } });
const lf = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', async () => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    const out = await node.handle({ method: req.method ?? 'GET', path: req.url ?? '/', headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(out.body);
  });
});

const dir = mkdtempSync(join(tmpdir(), 'crossbill-model-'));
const knotsPort = await listen(knots);
const lfPort = await listen(lf);
const s = await startServer(
  {
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    staticDir: join(dir, 'no-build'),
    network: 'testnet4',
    rpc: { url: new URL(`http://127.0.0.1:${knotsPort}`), user: 'u', password: 'p', ca: null },
    lightning: { url: new URL(`http://127.0.0.1:${lfPort}`), ca: null, paymentsOverride: null },
    tor: null,
    extraRpcMethods: [],
    version: 'test',
  },
  { log: () => undefined },
);

// Signed in, as the login page leaves a browser
const login = await fetch(`http://127.0.0.1:${s.port}/login`, { method: 'POST', body: new URLSearchParams({ password: s.initialPassword! }), redirect: 'manual' });
const cookie = login.headers.get('set-cookie')!.split(';')[0];
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init: RequestInit = {}) =>
  realFetch(`http://127.0.0.1:${s.port}${url}`, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: cookie } })) as typeof fetch;

const { AppModel } = await import('../src/app/model');

afterAll(async () => {
  globalThis.fetch = realFetch;
  await s.close();
  knots.close();
  lf.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the StartOS page', () => {
  const app = new AppModel();

  it('starts with the node StartOS set, and no app PIN or Face ID to ask for', async () => {
    await app.init();
    expect(app.settings.network).toBe('testnet4');
    expect(app.settings.node).toEqual({ host: '127.0.0.1', port: knotsPort, user: '', useTor: false, tls: false });
    expect(app.locked).toBe(false);
    expect(app.torAvailable).toBe(false);
  });

  it('keeps its settings in the server’s data folder', async () => {
    await app.updateSettings({ unit: 'sats' });
    expect(JSON.parse(readFileSync(join(dir, 'app', 'settings.json'), 'utf8')).unit).toBe('sats');
    const again = new AppModel();
    await again.init();
    expect(again.settings.unit).toBe('sats');
  });

  it('won’t take seed words, or a node from the page', async () => {
    await expect(
      app.addWallet({ name: 'x', mnemonic: 'abandon '.repeat(11) + 'about', passphrase: '', scriptType: 'P2WPKH', rescan: { kind: 'new' } }),
    ).rejects.toThrow(/watch-only/);
    await expect(app.saveNode({ host: 'elsewhere', port: 1, user: 'u', useTor: false, tls: false }, 'pw', 'mainnet')).rejects.toThrow(/StartOS/);
  });

  it('pairs with Lightning Fork through the server, and keeps the key there', async () => {
    const link = await app.lightning.pair(node.issueCode().json);
    expect(link.last).toMatch(/\.onion$/);
    expect(link.label).toBe('Crossbill on StartOS');
    const vault = JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8'));
    expect(vault['lightning.apiKey']).toMatch(/.+/);
    await app.lightning.refresh();
    expect(app.lightning.state.wallet?.lightning.outboundSat).toBeGreaterThan(0);
  });

  it('says why a payment didn’t go while payments are off, and doesn’t ask about it again', async () => {
    const invoice = node.sample('xbt', 1250, 'Coffee', 600);
    expect((await app.lightning.decode(invoice)).kind).toBeTruthy();
    await expect(app.lightning.payLightning({ request: invoice, summary: '1,250 sats' })).rejects.toThrow(/turned off/);
    expect(app.lightning.state.pending).toBeNull();
    expect(readFileSync(join(dir, 'app', 'settings.json'), 'utf8')).toBeTruthy();
  });
});
