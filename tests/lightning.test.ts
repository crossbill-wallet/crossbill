// Lightning through a Lightning Fork node: reading pairing codes, the order the ways to the node are tried, the
// client's rules about which failures move on, and the app model pairing, reading and paying against a pretend
// dashboard (tools/lf-mock). The native plugin is a fake whose "home address" checks certificates the way the
// iPhone's pinned HTTPS does, and whose "onion" is reached only with Tor.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  class NativeError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  }
  type Node = { rootPem: string; handle: (r: { method: string; path: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; body: string }> };
  const state = {
    vault: new Map<string, string>(),
    faceId: true,
    passcode: true,
    path: { known: true, satisfied: true, wifi: true, wired: false, cellular: false, other: false },
    /** The home address answers: the iPhone is on the node's network */
    home: true,
    /** The onion answers */
    tor: true,
    /** What a server at the home address presents as its root; the node's own unless set */
    presentedRoot: null as string | null,
    node: null as Node | null,
    fingerprint: (_pem: string) => '',
    sent: [] as { url: string; useTor: boolean; pinned: boolean; capture: boolean; noRedirect: boolean; body: string }[],
    auths: [] as { reason: string; biometricsOnly: boolean }[],
    /** The next request to this kind of address reaches the node, and then its answer is lost this way */
    lose: null as null | { route: 'lan' | 'tor'; how: 'timeout' | 'proxy502'; restart?: boolean },
    /** The iPhone has no passcode */
    noPasscode: false,
  };
  const native = {
    vaultSet: async ({ key, value, whenPasscodeSet }: { key: string; value: string; whenPasscodeSet?: boolean }) => {
      if (whenPasscodeSet && state.noPasscode) throw new NativeError('Set a passcode on this iPhone first. Lightning needs one.', 'no-passcode');
      state.vault.set(key, value);
    },
    vaultGet: async ({ key }: { key: string }) => ({ value: state.vault.get(key) ?? null }),
    vaultDelete: async ({ key }: { key: string }) => void state.vault.delete(key),
    authenticate: async ({ reason, biometricsOnly, requirePasscode }: { reason: string; biometricsOnly?: boolean; requirePasscode?: boolean }) => {
      state.auths.push({ reason, biometricsOnly: !!biometricsOnly });
      if (biometricsOnly) return state.faceId ? { ok: true } : { ok: false, pin: true };
      if (state.noPasscode) return requirePasscode ? { ok: false, noPasscode: true } : { ok: true };
      return { ok: state.faceId || state.passcode };
    },
    biometryTrust: async () => ({ changed: false }),
    torStart: async () => undefined,
    torStatus: async () => ({ state: 'ready', progress: 100 }),
    torCheck: async () => ({ state: 'ready', controller: true, socks: true, circuit: true, port: 39050 }),
    torRepair: async () => ({ ok: true }),
    networkPath: async () => state.path,
    widgetsUpdate: async () => ({ ok: true }),
    widgetsInstalled: async () => ({ ok: true, widgets: [] }),
    httpRequest: async (req: { url: string; method?: string; headers: Record<string, string>; body: string; useTor: boolean; pinPem?: string; captureRootSha256?: string; noRedirect?: boolean }) => {
      const u = new URL(req.url);
      const onion = u.hostname.endsWith('.onion');
      state.sent.push({ url: req.url, useTor: req.useTor, pinned: !!req.pinPem, capture: !!req.captureRootSha256, noRedirect: !!req.noRedirect, body: req.body });
      if (onion && !req.useTor) throw new NativeError('An onion needs Tor', 'network');
      if (onion ? !state.tor : !state.home) throw new NativeError('Could not connect to the server. (-1001)', 'timeout');
      const node = state.node!;
      let rootPem: string | undefined;
      if (!onion) {
        const root = state.presentedRoot ?? node.rootPem;
        const presented = state.fingerprint(root);
        if (req.pinPem) {
          if (state.fingerprint(req.pinPem) !== presented) throw new NativeError('This node’s certificate isn’t the one this phone paired with', 'certificate');
        } else if (req.captureRootSha256) {
          if (req.captureRootSha256.toUpperCase() !== presented) throw new NativeError('This node’s certificate isn’t the one this phone paired with', 'certificate');
          rootPem = root;
        } else {
          throw new NativeError('The app never asks a home address without a pinned root', 'certificate');
        }
      }
      const out = await node.handle({ method: req.method ?? 'POST', path: u.pathname + u.search, headers: req.headers, body: req.body });
      const lose = state.lose;
      if (lose && lose.route === (onion ? 'tor' : 'lan') && req.method === 'POST') {
        state.lose = null;
        if (lose.restart) (node as unknown as { restart: () => void }).restart();
        if (lose.how === 'timeout') throw new NativeError('The request timed out. (-1001)', 'timeout');
        return { status: 502, body: '<html><body>502 Bad Gateway</body></html>' };
      }
      return { ...out, ...(rootPem ? { rootPem } : {}) };
    },
  };
  return { state, native };
});

vi.mock('../src/app/native', async () => {
  const actual = await vi.importActual<typeof import('../src/app/native')>('../src/app/native');
  return { ...actual, ShrikeNative: fake.native };
});

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
};

const { AppModel } = await import('../src/app/model');
const lf = await import('../src/core/lfapi');
const { LIGHTNING_KEY, LIGHTNING_FILE, LIGHTNING_PENDING_FILE } = await import('../src/app/lightning');
const { MockNode, MOCK_ROOT_PEM, OTHER_ROOT_PEM, pemSha256 } = await import('../tools/lf-mock/mock');
const { encodeSecret, newTotpSecret, totp, decodeSecret } = await import('../src/core/totp');

type Model = InstanceType<typeof AppModel>;

let now = 1_792_000_000_000;
let mono = 1_000;
let node: InstanceType<typeof MockNode>;

async function model(): Promise<Model> {
  const m = new AppModel();
  m.torAvailable = true;
  await m.init();
  return m;
}

async function paired(o: ConstructorParameters<typeof MockNode>[0] = {}): Promise<Model> {
  node = new MockNode({ now: () => now, ...o });
  fake.state.node = node;
  const m = await model();
  await m.lightning.pair(node.issueCode().json);
  await m.lightning.refresh();
  fake.state.sent = [];
  fake.state.auths = [];
  return m;
}

const saved = (name: string) => {
  const v = store.get(`shrike/${name}`);
  return v ? JSON.parse(v) : null;
};

beforeEach(() => {
  store.clear();
  fake.state.vault.clear();
  fake.state.faceId = true;
  fake.state.passcode = true;
  fake.state.path = { known: true, satisfied: true, wifi: true, wired: false, cellular: false, other: false };
  fake.state.home = true;
  fake.state.tor = true;
  fake.state.presentedRoot = null;
  fake.state.fingerprint = pemSha256;
  fake.state.sent = [];
  fake.state.auths = [];
  fake.state.lose = null;
  fake.state.noPasscode = false;
  now = 1_792_000_000_000;
  mono = 1_000;
  node = new MockNode({ now: () => now });
  fake.state.node = node;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(performance, 'now').mockImplementation(() => mono);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------------------------------- the client

describe('pairing codes', () => {
  it('reads the dashboard’s JSON and its lightningfork:// link alike', () => {
    const c = node.issueCode();
    const a = lf.parsePairingCode(c.json)!;
    const b = lf.parsePairingCode(c.link)!;
    expect(a).toEqual(b);
    expect(a.code).toBe(c.code);
    expect(a.ca).toBe(node.rootSha256);
    expect(a.lan).toBe('https://lightning-fork.local:7157');
    expect(a.onion).toMatch(/^http:\/\/.+\.onion$/);
  });

  it('keeps only scheme and host, and refuses what isn’t a pairing code', () => {
    const p = lf.parsePairingCode(JSON.stringify({ lf: 1, code: 'e_abcdefghij', lan: 'https://node.local:7157/some/path?x=1', ca: 'ab:'.repeat(31) + 'cd' }))!;
    expect(p.lan).toBe('https://node.local:7157');
    expect(p.ca).toBe('AB:'.repeat(31) + 'CD');
    expect(lf.parsePairingCode('lnbc1…')).toBeNull();
    expect(lf.parsePairingCode(JSON.stringify({ lf: 2, code: 'e_abcdefghij', lan: 'https://x.local' }))).toBeNull();
    expect(lf.parsePairingCode(JSON.stringify({ lf: 1, code: 'x_abcdefghij', lan: 'https://x.local' }))).toBeNull();
    // An onion where the home address goes, or the reverse, is dropped; with no address left it isn't a code
    expect(lf.parsePairingCode(JSON.stringify({ lf: 1, code: 'e_abcdefghij', lan: 'http://abc.onion' }))).toBeNull();
    // A fingerprint of the wrong shape is no fingerprint
    expect(lf.parsePairingCode(JSON.stringify({ lf: 1, code: 'e_abcdefghij', lan: 'https://x.local', ca: 'nonsense' }))!.ca).toBeNull();
  });

  it('fingerprints a certificate as openssl does', () => {
    expect(lf.certFingerprint(MOCK_ROOT_PEM)).toBe('CA:FF:FE:B1:C9:F6:87:87:0E:4D:C1:4E:0F:A9:99:15:22:EC:59:17:0E:64:88:6A:FD:DB:B1:66:E0:52:D2:5C');
    expect(lf.certFingerprint(OTHER_ROOT_PEM)).not.toBe(lf.certFingerprint(MOCK_ROOT_PEM));
  });
});

describe('the ways to the node', () => {
  const e = { onionUrl: 'http://abc.onion', lanUrl: 'https://node.local:7157', lanIp: 'https://192.168.1.20:7157', caPem: MOCK_ROOT_PEM, caSha256: null };

  it('tries home first on Wi-Fi, the onion first away, and an http onion as https too', () => {
    expect(lf.lfAttempts(e, { lanLikely: true }).map((a) => a.base)).toEqual(['https://node.local:7157', 'https://192.168.1.20:7157', 'http://abc.onion', 'https://abc.onion']);
    expect(lf.lfAttempts(e, { lanLikely: false }).map((a) => a.route)).toEqual(['tor', 'tor', 'lan', 'lan']);
  });

  it('puts the way that last worked first among its kind, never ahead of home when at home', () => {
    expect(lf.lfAttempts(e, { lanLikely: true, last: 'https://192.168.1.20:7157' })[0].base).toBe('https://192.168.1.20:7157');
    // Back home after a day away: home first, though the onion worked last
    expect(lf.lfAttempts(e, { lanLikely: true, last: 'http://abc.onion' }).map((a) => a.route)).toEqual(['lan', 'lan', 'tor', 'tor']);
    expect(lf.lfAttempts(e, { lanLikely: false, last: 'https://192.168.1.20:7157' }).map((a) => a.base)).toEqual(['http://abc.onion', 'https://abc.onion', 'https://192.168.1.20:7157', 'https://node.local:7157']);
  });

  it('sends a money call again by another way as a resume, and only a refusal in the node’s words is final', async () => {
    const bodies: string[] = [];
    const http = async (r: { route: string; body: string }) => {
      bodies.push(r.body);
      if (r.route === 'lan') throw new Error('timed out');
      return { status: 200, body: '{"txid":"ab"}' };
    };
    const c = new lf.LfClient(e, http as never, 'k', { lanLikely: () => true });
    await c.call('POST', '/onchain/send', { body: { address: 'x', requestId: 'abcdefgh' } });
    expect(JSON.parse(bodies[0]).resume).toBeUndefined();
    expect(bodies.slice(1).every((b) => JSON.parse(b).resume === true)).toBe(true);
    expect(lf.isDefiniteRefusal(new lf.LfError(400, 'No route', 'no_route', false, null, true))).toBe(true);
    expect(lf.isDefiniteRefusal(new lf.LfError(503, 'Not answering', null, false, null, true))).toBe(true);
    // A proxy's page, a revoked key, a lost answer: nothing known about the money
    expect(lf.isDefiniteRefusal(new lf.LfError(502, 'Bad gateway', null, false, null, false))).toBe(false);
    expect(lf.isDefiniteRefusal(new lf.LfError(401, 'Pair again', null, false, null, true))).toBe(false);
    expect(lf.isDefiniteRefusal(new lf.LfError(504, 'On its way', 'on_its_way', true, null, true))).toBe(false);
    expect(lf.isDefiniteRefusal(new lf.LfUnreachable())).toBe(false);
  });

  it('never tries a home address without a root or its hash, nor over plain HTTP', () => {
    expect(lf.lfAttempts({ ...e, caPem: null }, { lanLikely: true }).map((a) => a.route)).toEqual(['tor', 'tor']);
    expect(lf.lfAttempts({ ...e, caPem: null, caSha256: 'AB' }, { lanLikely: true })[0].route).toBe('lan');
    expect(lf.lfAttempts({ ...e, lanUrl: 'http://node.local:7157', lanIp: null }, { lanLikely: true }).map((a) => a.route)).toEqual(['tor', 'tor']);
  });

  it('moves on only when nothing answered: an HTTP error is the node’s answer', async () => {
    const tried: string[] = [];
    const http = async (r: { url: string; route: string }) => {
      tried.push(r.route);
      if (r.route === 'lan') throw new Error('timed out');
      return { status: 409, body: JSON.stringify({ error: 'The service asks more.', code: 'price_changed', details: { incomingSat: 5 } }) };
    };
    const c = new lf.LfClient(e, http as never, 'lf_x_y', { lanLikely: () => true });
    const err = (await c.call('POST', '/pay/bitcoin-invoice').catch((x) => x)) as InstanceType<typeof lf.LfError>;
    expect(err).toBeInstanceOf(lf.LfError);
    expect(err.code).toBe('price_changed');
    expect(err.details).toEqual({ incomingSat: 5 });
    // Two home addresses failed to connect, the onion answered; the https onion was never needed
    expect(tried).toEqual(['lan', 'lan', 'tor']);
  });

  it('calls a money move that may have arrived uncertain, and an onion with the wrong certificate a certificate problem', async () => {
    expect(lf.isUncertain(new lf.LfError(504, 'x', 'on_its_way', true))).toBe(true);
    expect(lf.isUncertain(new lf.LfUnreachable())).toBe(true);
    expect(lf.isUncertain(new lf.LfError(400, 'x', 'not_paid'))).toBe(false);
    const c = new lf.LfClient({ ...e, lanUrl: null, lanIp: null }, (async () => {
      throw new lf.LfCertificateError();
    }) as never, 'k', { lanLikely: () => true });
    const err = (await c.call('GET', '/wallet').catch((x) => x)) as InstanceType<typeof lf.LfUnreachable>;
    expect(err).toBeInstanceOf(lf.LfUnreachable);
    expect(err.certificate).toBe(true);
  });

  it('counts a quote’s time from when it was asked, less what the node needs to pay it', () => {
    expect(lf.quoteSecondsLeft({ secondsLeft: 35, minSecondsLeft: 10 }, 0, 5_000)).toBe(20);
    expect(lf.quoteSecondsLeft({ secondsLeft: 35, minSecondsLeft: 10 }, 0, 40_000)).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------- pairing

describe('pairing', () => {
  it('at home: takes the root whose hash the code carries, pins it, and keeps the key in the Keychain', async () => {
    const m = await model();
    const link = await m.lightning.pair(node.issueCode().json);
    expect(link.endpoints.caPem).toBe(node.rootPem);
    expect(link.endpoints.onionUrl).toBe(node.opts.onion);
    expect(fake.state.vault.get(LIGHTNING_KEY)).toMatch(/^lf_/);
    // Nothing secret on disk
    expect(JSON.stringify(saved(LIGHTNING_FILE))).not.toMatch(/lf_/);
    expect(m.lightning.paired).toBe(true);
    // The pairing itself went to the home address, pinned, never following a redirect
    const pairCall = fake.state.sent.find((s) => s.url.endsWith('/api/v1/pair'))!;
    expect(pairCall.useTor).toBe(false);
    expect(pairCall.pinned).toBe(true);
    expect(pairCall.noRedirect).toBe(true);
    expect(m.lightning.state.route).toBe('lan');
  });

  it('away: pairs through the onion and pins the root the node names, once it matches the code', async () => {
    fake.state.path = { known: true, satisfied: true, wifi: false, wired: false, cellular: true, other: false };
    fake.state.home = false;
    const m = await model();
    const link = await m.lightning.pair(node.issueCode().json);
    expect(link.endpoints.caPem).toBe(node.rootPem);
    expect(fake.state.sent.filter((s) => s.url.endsWith('/pair')).every((s) => s.useTor)).toBe(true);
    // Not even a look at the home address from a cellular connection
    expect(fake.state.sent.some((s) => !s.useTor)).toBe(false);
  });

  it('refuses a server at the home address with another root, and pairs through the onion instead', async () => {
    fake.state.presentedRoot = OTHER_ROOT_PEM;
    const m = await model();
    const link = await m.lightning.pair(node.issueCode().json);
    expect(link.endpoints.caPem).toBe(node.rootPem);
    expect(fake.state.sent.filter((s) => s.url.endsWith('/pair')).every((s) => s.useTor)).toBe(true);
  });

  it('refuses a node whose certificate doesn’t match the code, and gives the key straight back', async () => {
    fake.state.home = false;
    const m = await model();
    const code = JSON.parse(node.issueCode().json);
    code.ca = lf.certFingerprint(OTHER_ROOT_PEM);
    await expect(m.lightning.pair(JSON.stringify(code))).rejects.toThrow(/doesn’t match the pairing code/);
    expect(m.lightning.paired).toBe(false);
    expect(fake.state.vault.has(LIGHTNING_KEY)).toBe(false);
    expect(Array.from(node.devices.values()).every((d) => d.revoked)).toBe(true);
  });

  it('says plainly when a code has run out or isn’t one', async () => {
    const m = await model();
    await expect(m.lightning.pair(node.issueCode({ exp: now - 1 }).json)).rejects.toThrow(/run out/);
    await expect(m.lightning.pair('hello')).rejects.toThrow(/isn’t a Lightning Fork pairing code/);
    const used = node.issueCode().json;
    await m.lightning.pair(used);
    await expect(m.lightning.pair(used)).rejects.toThrow(/didn’t accept that code/);
  });

  it('a duress session neither shows nor pairs Lightning', async () => {
    const m = await paired();
    (m as unknown as { decoy: unknown }).decoy = { wallet: 'w', wallets: new Set(['w']), contacts: new Set(), pinOff: false, duressShown: null };
    expect(m.lightning.paired).toBe(false);
    await expect(m.lightning.pair(node.issueCode().json)).rejects.toThrow(/Can’t reach your Lightning node/);
    await expect(m.lightning.payLightning({ request: node.sample('xbt'), summary: 'x' })).rejects.toThrow();
    expect(node.calls.some((c) => c.path === '/lightning/pay')).toBe(false);
  });

  it('unpairs: the node forgets the key, and so does the iPhone', async () => {
    const m = await paired();
    const r = await m.lightning.unpair();
    expect(r.removedThere).toBe(true);
    expect(Array.from(node.devices.values()).every((d) => d.revoked)).toBe(true);
    expect(fake.state.vault.has(LIGHTNING_KEY)).toBe(false);
    expect(saved(LIGHTNING_FILE)).toBeNull();
    expect(m.lightning.paired).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- reading

describe('reading the node', () => {
  it('reads balances, activity and how SHA256 invoices are paid', async () => {
    const m = await paired({ ownBridge: { ready: true, availableSat: 196_500 } });
    await m.lightning.refresh();
    const s = m.lightning.state;
    expect(s.wallet?.lightning.outboundSat).toBe(2_199_670);
    expect(s.wallet?.onchain.confirmedSat).toBe(30_000);
    expect(s.activity?.length).toBeGreaterThan(0);
    expect(s.sha256?.ownBridge).toEqual({ ready: true, availableSat: 196_500 });
    expect(s.sha256?.configured).toBe(true);
    expect(s.sha256?.label).toBe('Pretend Bridge');
    expect(s.error).toBeNull();
  });

  it('goes through the onion when home doesn’t answer, and says to pair again when the key is refused', async () => {
    const m = await paired();
    fake.state.home = false;
    mono += 120_000;
    now += 120_000;
    await m.lightning.refresh();
    expect(m.lightning.state.route).toBe('tor');
    expect(m.lightning.state.error).toBeNull();
    node.revokeAll();
    await m.lightning.refresh();
    expect(m.lightning.state.needsPairing).toMatch(/Pair it again|not paired/);
  });

  it('a home address presenting another root is never trusted, even after pairing', async () => {
    const m = await paired();
    fake.state.presentedRoot = OTHER_ROOT_PEM;
    fake.state.tor = false;
    now += 120_000;
    await m.lightning.refresh();
    expect(m.lightning.state.error).toBeTruthy();
    expect(m.lightning.state.wallet).not.toBeNull(); // the earlier reading stays
  });
});

// ------------------------------------------------------------------------------------------- paying

describe('paying', () => {
  it('pays an invoice of this chain after Face ID, with a request id, and clears its record', async () => {
    const m = await paired();
    const request = node.sample('xbt', 1250);
    const o = await m.lightning.payLightning({ request, summary: '1,250 sats' });
    expect(o.kind).toBe('paid');
    expect(fake.state.auths).toHaveLength(1);
    const call = node.calls.find((c) => c.path === '/lightning/pay')!;
    expect((call.body as { requestId: string }).requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(saved(LIGHTNING_PENDING_FILE)).toBeNull();
    expect(m.lightning.state.pending).toBeNull();
  });

  it('sends nothing when Face ID is cancelled', async () => {
    const m = await paired();
    fake.state.faceId = false;
    fake.state.passcode = false;
    await expect(m.lightning.payLightning({ request: node.sample('xbt'), summary: 'x' })).rejects.toThrow(/Cancelled/);
    expect(node.calls.some((c) => c.path === '/lightning/pay')).toBe(false);
    expect(saved(LIGHTNING_PENDING_FILE)).toBeNull();
  });

  it('with two-factor on, needs a code first, and uses it up', async () => {
    const m = await paired();
    const secret = encodeSecret(newTotpSecret());
    const key = decodeSecret(secret);
    await m.enableTwoFactor(secret, totp(key, now / 1000));
    m.acknowledgeRecoveryCodes();
    now += 30_000;
    await expect(m.lightning.payLightning({ request: node.sample('xbt'), summary: 'x' })).rejects.toThrow(/Enter the code/);
    await expect(m.lightning.payLightning({ request: node.sample('xbt'), summary: 'x', code: '000000' })).rejects.toThrow(/doesn’t match/);
    expect(fake.state.auths).toHaveLength(0);
    mono += 120_000;
    const code = totp(key, now / 1000);
    const o = await m.lightning.payLightning({ request: node.sample('xbt'), summary: 'x', code });
    expect(o.kind).toBe('paid');
    await expect(m.lightning.payLightning({ request: node.sample('xbt'), summary: 'x', code })).rejects.toThrow(/used already/);
  });

  it('pays a SHA256 invoice from the node’s own bridge: nothing of this chain, no countdown', async () => {
    const m = await paired({ ownBridge: { ready: true, availableSat: 196_500 }, service: null });
    const request = node.sample('sha256', 1250);
    const t = await m.lightning.decode(request);
    expect(t.kind).toBe('bitcoin-invoice');
    expect(t.estimate?.source).toBe('own_bridge');
    const q = await m.lightning.quote(request);
    expect(q.maxIncomingSat).toBe(0);
    const before = node.outboundSat;
    const o = await m.lightning.payBitcoinInvoice({ request, maxIncomingSat: q.maxIncomingSat, summary: '1,250 sats (SHA256)' });
    expect(o.kind).toBe('paid');
    if (o.kind !== 'paid') return;
    expect(o.result.bitcoinInvoice?.source).toBe('own_bridge');
    expect(o.result.amountSat).toBe(0);
    expect(node.outboundSat).toBe(before);
    expect(node.opts.ownBridge!.availableSat).toBe(196_500 - 1252);
  });

  it('says why a SHA256 invoice can’t be paid when the bridge isn’t ready and there’s no service', async () => {
    const m = await paired({ ownBridge: { ready: false, availableSat: 0 }, service: null });
    const t = await m.lightning.decode(node.sample('sha256', 1250));
    expect(t.payable).toBe(false);
    expect(t.messageCode).toBe('own_bridge_not_ready');
  });

  it('through a service: a firm price first, and a price that went up is a definite refusal', async () => {
    const m = await paired({ ownBridge: null, service: { label: 'Pretend Bridge' } });
    const request = node.sample('sha256', 1250);
    const q = await m.lightning.quote(request);
    expect(q.source).toBe('service');
    expect(q.maxIncomingSat).toBeGreaterThan(0);
    node.payMode['bitcoin-invoice'] = 'price_changed';
    const err = await m.lightning.payBitcoinInvoice({ request, maxIncomingSat: q.maxIncomingSat, summary: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(lf.LfError);
    expect(err.code).toBe('price_changed');
    expect(m.lightning.state.pending).toBeNull();
    const o = await m.lightning.payBitcoinInvoice({ request, maxIncomingSat: q.maxIncomingSat, summary: 'x' });
    expect(o.kind).toBe('paid');
  });

  it('“on its way”: keeps the payment, asks again with the same id, and never pays twice', async () => {
    const m = await paired({ ownBridge: null });
    const request = node.sample('sha256', 1250);
    const q = await m.lightning.quote(request);
    node.payMode['bitcoin-invoice'] = 'on_its_way';
    const o = await m.lightning.payBitcoinInvoice({ request, maxIncomingSat: q.maxIncomingSat, summary: '1,250 sats (SHA256)' });
    expect(o.kind).toBe('waiting');
    if (o.kind === 'waiting') expect(o.note).toMatch(/24 hours/);
    const pending = saved(LIGHTNING_PENDING_FILE);
    expect(pending.requestId).toMatch(/^[0-9a-f]{32}$/);
    // A new payment waits until this one is settled
    await expect(m.lightning.payLightning({ request: node.sample('xbt'), summary: 'x' })).rejects.toThrow(/hasn’t finished/);

    // The app is closed and opened again: the record is still there, and it's asked about with the same id
    const again = await model();
    expect(again.lightning.state.pending?.requestId).toBe(pending.requestId);
    const r = await again.lightning.resumePending();
    expect(r?.kind).toBe('paid');
    const pays = node.calls.filter((c) => c.path === '/pay/bitcoin-invoice');
    expect(pays).toHaveLength(2);
    expect((pays[1].body as { requestId: string; resume: boolean }).requestId).toBe(pending.requestId);
    expect((pays[1].body as { resume: boolean }).resume).toBe(true);
    expect(saved(LIGHTNING_PENDING_FILE)).toBeNull();
    expect(node.activity.filter((a) => a.reference === node.samples.get(request)!.paymentHash)).toHaveLength(1);
  });

  it('an on-chain send cut off before the answer is asked about, not sent again', async () => {
    const m = await paired();
    node.payMode.onchain = 'cut_off';
    const before = node.onchainSat;
    const o = await m.lightning.sendOnchain({ address: node.sample('address'), amountSat: 10_000, satPerVbyte: 2, summary: '10,000 sats on chain' });
    expect(o.kind).toBe('waiting');
    const r = await m.lightning.resumePending();
    expect(r?.kind).toBe('sent');
    expect(before - node.onchainSat).toBe(10_000 + 2 * 141);
  });

  it('a payment the node refused outright leaves nothing pending', async () => {
    const m = await paired();
    node.payMode.lightning = 'not_paid';
    await expect(m.lightning.payLightning({ request: node.sample('xbt'), summary: 'x' })).rejects.toThrow(/No route/);
    expect(m.lightning.state.pending).toBeNull();
    expect(saved(LIGHTNING_PENDING_FILE)).toBeNull();
  });

  it('with the app PIN on, a Face ID failure asks for the PIN before anything is paid', async () => {
    const m = await paired();
    m.wallets.push({ config: { id: 'w', network: m.settings.network } } as unknown as Model['wallets'][number]);
    await m.setPin('204816');
    fake.state.faceId = false;
    const paying = m.lightning.payLightning({ request: node.sample('xbt'), summary: '1,250 sats' });
    await vi.waitFor(() => expect(m.pinAsk).not.toBeNull());
    expect(node.calls.some((c) => c.path === '/lightning/pay')).toBe(false);
    await m.answerPin('204816');
    expect((await paying).kind).toBe('paid');
  });
});

describe('payments whose outcome isn’t known', () => {
  it('a proxy’s 502 page in front of the node keeps the payment, and asking again never pays it twice', async () => {
    const m = await paired();
    fake.state.lose = { route: 'lan', how: 'proxy502' };
    fake.state.tor = false;
    const before = node.onchainSat;
    const o = await m.lightning.sendOnchain({ address: node.sample('address'), amountSat: 10_000, satPerVbyte: 2, summary: '10,000 sats on chain' });
    expect(o.kind).toBe('waiting');
    expect(m.lightning.state.pending?.known).toBe(false);
    expect(m.lightning.pendingCheck(m.lightning.state.pending!)).toBe('check-or-pay');
    // A new payment waits; a refresh doesn't ask about it by itself, since that could pay it
    await expect(m.lightning.sendOnchain({ address: node.sample('address'), amountSat: 10_000, satPerVbyte: 2, summary: 'again' })).rejects.toThrow(/hasn’t finished/);
    now += 120_000;
    await m.lightning.refresh();
    expect(node.calls.filter((c) => c.path === '/onchain/send')).toHaveLength(1);
    // Asked again by the person: the node finds the first one
    const r = await m.lightning.resumePending();
    expect(r?.kind).toBe('sent');
    expect(before - node.onchainSat).toBe(10_000 + 2 * 141);
  });

  it('an answer lost on the home network, then a dashboard restart: the next attempt is a resume and finds it', async () => {
    const m = await paired();
    fake.state.lose = { route: 'lan', how: 'timeout', restart: true };
    const before = node.onchainSat;
    const o = await m.lightning.sendOnchain({ address: node.sample('address'), amountSat: 10_000, satPerVbyte: 2, summary: '10,000 sats on chain' });
    expect(o.kind).toBe('sent');
    expect(before - node.onchainSat).toBe(10_000 + 2 * 141);
    // The second home address took the retry, as a resume
    const sends = fake.state.sent.filter((s) => s.url.endsWith('/onchain/send'));
    expect(sends).toHaveLength(2);
    expect(JSON.parse(sends[0].body).resume).toBeUndefined();
    expect(JSON.parse(sends[1].body).resume).toBe(true);
  });

  it('“on its way” is checked by itself on the next refresh', async () => {
    const m = await paired({ ownBridge: null });
    const request = node.sample('sha256', 1250);
    const q = await m.lightning.quote(request);
    node.payMode['bitcoin-invoice'] = 'on_its_way';
    await m.lightning.payBitcoinInvoice({ request, maxIncomingSat: q.maxIncomingSat, summary: 'x' });
    expect(m.lightning.state.pending?.known).toBe(true);
    now += 120_000;
    await m.lightning.refresh();
    await vi.waitFor(() => expect(m.lightning.state.pending).toBeNull());
  });

  it('a payment from an earlier pairing is never asked about under the new one', async () => {
    const m = await paired();
    fake.state.lose = { route: 'lan', how: 'proxy502' };
    await m.lightning.payLightning({ request: node.sample('xbt'), summary: 'x' });
    expect(m.lightning.state.pending).not.toBeNull();
    node.revokeAll();
    await m.lightning.pair(node.issueCode().json);
    const p = m.lightning.state.pending!;
    expect(m.lightning.pendingCheck(p)).toBe('other-pairing');
    expect(await m.lightning.resumePending()).toBeNull();
    expect(node.calls.filter((c) => c.path === '/lightning/pay')).toHaveLength(1);
  });

  it('two taps on Pay make one payment', async () => {
    const m = await paired();
    const request = node.sample('xbt');
    const [a, b] = await Promise.allSettled([m.lightning.payLightning({ request, summary: 'x' }), m.lightning.payLightning({ request, summary: 'x' })]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(node.calls.filter((c) => c.path === '/lightning/pay')).toHaveLength(1);
  });

  it('a price that ran out while confirming isn’t sent', async () => {
    const m = await paired({ ownBridge: null });
    const request = node.sample('sha256', 1250);
    const q = await m.lightning.quote(request);
    await expect(m.lightning.payBitcoinInvoice({ request, maxIncomingSat: q.maxIncomingSat, summary: 'x', stillValid: () => false })).rejects.toThrow(/price ran out/);
    expect(node.calls.some((c) => c.path === '/pay/bitcoin-invoice')).toBe(false);
    expect(m.lightning.state.pending).toBeNull();
  });
});

describe('without a passcode', () => {
  it('pays nothing when there’s nothing to check it’s you against', async () => {
    const m = await paired();
    fake.state.noPasscode = true;
    await expect(m.lightning.payLightning({ request: node.sample('xbt'), summary: 'x' })).rejects.toThrow(/Set a passcode/);
    expect(node.calls.some((c) => c.path === '/lightning/pay')).toBe(false);
  });

  it('doesn’t pair, and gives the key straight back', async () => {
    fake.state.noPasscode = true;
    const m = await model();
    await expect(m.lightning.pair(node.issueCode().json)).rejects.toThrow(/passcode/);
    expect(m.lightning.paired).toBe(false);
    expect(Array.from(node.devices.values()).every((d) => d.revoked)).toBe(true);
  });
});

describe('receiving', () => {
  it('makes an invoice and sees it paid', async () => {
    const m = await paired();
    const inv = await m.lightning.createInvoice({ amountSat: 5_000, memo: 'Lunch' });
    expect(inv.uri).toBe(`lightning:${inv.paymentRequest}`);
    expect((await m.lightning.invoiceStatus(inv.paymentHash)).state).toBe('open');
    node.settle(inv.paymentHash);
    const s = await m.lightning.invoiceStatus(inv.paymentHash);
    expect(s.state).toBe('settled');
    expect(s.amountPaidSat).toBe(5_000);
  });

  it('gives an on-chain address and an offer', async () => {
    const m = await paired();
    expect((await m.lightning.receiveAddress()).uri).toMatch(/^bitcoin:bc1/);
    expect((await m.lightning.createOffer({ description: 'Tips' })).uri).toMatch(/^bitcoin:\?lno=lno1/);
  });
});
