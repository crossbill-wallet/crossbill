// Getting the price through Tor after iOS took back Tor's port, and the node transport's repair. The native
// plugin is replaced by a fake whose Tor can be healthy, have a dead SOCKS port, or be stuck.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Outcome = 'ok' | 'refused' | 'network' | 'timeout' | 'offline' | 'blocked';

const fake = vi.hoisted(() => {
  class NativeError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  }
  const state = {
    socks: true,
    controller: true,
    repair: { ok: true, stage: undefined as string | undefined },
    outcomes: [] as string[],
    requests: [] as { url: string; useTor: boolean }[],
    repairs: [] as boolean[],
  };
  const ticker = JSON.stringify({ success: true, ticker: { lastPrice: '570.25', changePercent: '-1.5' } });
  const native = {
    torStart: async () => undefined,
    torStatus: async () => ({ state: 'ready', progress: 100 }),
    torCheck: async () => ({ state: 'ready', controller: state.controller, socks: state.socks, circuit: true, port: 39050 }),
    torRepair: async ({ newCircuit }: { newCircuit: boolean }) => {
      state.repairs.push(newCircuit);
      if (state.repair.ok) {
        const reopened = !state.socks;
        state.socks = true;
        state.controller = true;
        return { ok: true, reopened };
      }
      return { ok: false, stage: state.repair.stage };
    },
    httpRequest: async (req: { url: string; useTor: boolean }) => {
      state.requests.push({ url: req.url, useTor: req.useTor });
      if (req.useTor && !state.socks) throw new NativeError('Could not connect to the server. (-1004, 61)', 'refused');
      const next = state.outcomes.shift() ?? 'ok';
      if (next === 'ok') return { status: 200, body: req.url.includes('ticker') ? ticker : '{"result":1,"error":null,"id":1}' };
      if (next === 'blocked') return { status: 403, body: '<html>Access denied</html>' };
      throw new NativeError(`Request failed (${next})`, next);
    },
    vaultGet: async () => ({ value: null }),
    vaultSet: async () => undefined,
    vaultDelete: async () => undefined,
    authenticate: async () => ({ ok: true }),
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

async function model(tor = true) {
  const m = new AppModel();
  await m.init();
  m.torAvailable = tor;
  m.priceTiming = { beat: 0, settle: 0, backoff: [0, 0], circuitWait: 0, askTimeout: 1000 };
  return m;
}

function set(o: Partial<typeof fake.state> & { outcomes?: Outcome[] }) {
  Object.assign(fake.state, o);
}

beforeEach(() => {
  store.clear();
  set({ socks: true, controller: true, repair: { ok: true, stage: undefined }, outcomes: [], requests: [], repairs: [] });
});

describe('price through Tor', () => {
  it('goes through the steps and shows them when there is no price yet', async () => {
    const m = await model();
    const seen: string[] = [];
    m.subscribe(() => {
      const s = m.price.steps?.map((x) => `${x.id}:${x.status}`).join(',');
      if (s && seen[seen.length - 1] !== s) seen.push(s);
    });
    await m.loadPrice(true);
    expect(m.price.ticker?.last).toBe(570.25);
    expect(m.price.problem).toBeNull();
    expect(m.price.steps).toBeNull();
    expect(seen).toContain('tor:active,route:pending,ask:pending');
    expect(seen).toContain('tor:done,route:done,ask:active');
    expect(seen).toContain('tor:done,route:done,ask:done');
    expect(fake.state.requests[0].useTor).toBe(true);
  });

  it('reopens Tor’s port when iOS took it back, then gets the price', async () => {
    set({ socks: false });
    const m = await model();
    let note: string | undefined;
    m.subscribe(() => {
      const tor = m.price.steps?.find((x) => x.id === 'tor');
      if (tor?.status === 'done') note = tor.note;
    });
    await m.loadPrice(true);
    expect(fake.state.repairs).toEqual([false]);
    expect(note).toMatch(/Reopened/);
    expect(m.price.ticker?.last).toBe(570.25);
  });

  it('tries new routes when a request fails, and succeeds on the third', async () => {
    set({ outcomes: ['network', 'timeout', 'ok'] });
    const m = await model();
    await m.loadPrice(true);
    expect(m.price.ticker?.last).toBe(570.25);
    expect(fake.state.repairs).toEqual([true, true]);
    expect(fake.state.requests).toHaveLength(3);
    expect(m.price.failures).toBe(0);
  });

  it('after three failed routes, says so and offers to go without Tor', async () => {
    set({ outcomes: ['network', 'network', 'network'] });
    const m = await model();
    await m.loadPrice(true);
    expect(m.price.problem?.kind).toBe('route');
    expect(m.price.problem?.canGoDirect).toBe(true);
    expect(m.price.failures).toBe(1);
    expect(m.price.showSteps).toBe(true);
    expect(m.price.steps?.find((x) => x.id === 'ask')?.status).toBe('failed');
  });

  it('stops at once when Tor can’t be reattached, and says to reopen the app', async () => {
    set({ controller: false, socks: false, repair: { ok: false, stage: 'control' } });
    const m = await model();
    await m.loadPrice(true);
    expect(m.price.problem?.kind).toBe('tor-stuck');
    expect(m.price.problem?.detail).toMatch(/swipe it away/);
    expect(fake.state.requests).toHaveLength(0);
    expect(m.price.steps?.find((x) => x.id === 'tor')?.status).toBe('failed');
  });

  it('gets the price once without Tor when asked', async () => {
    const m = await model();
    await m.loadPrice(true, { direct: true });
    expect(fake.state.requests[0].useTor).toBe(false);
    expect(m.price.ticker?.last).toBe(570.25);
  });

  it('keeps routine refreshes quiet', async () => {
    const m = await model();
    await m.loadPrice(true);
    let shown = false;
    m.subscribe(() => {
      if (m.price.showSteps) shown = true;
    });
    await m.loadPrice(true);
    expect(shown).toBe(false);
  });

  it('names a site that turns Tor away', async () => {
    set({ outcomes: ['blocked', 'blocked', 'blocked'] });
    const m = await model();
    await m.loadPrice(true);
    expect(m.price.problem?.kind).toBe('site');
    expect(m.price.problem?.title).toMatch(/turned the request away/);
  });

  it('doesn’t keep retrying while the phone is offline', async () => {
    set({ outcomes: ['offline', 'ok'] });
    const m = await model();
    await m.loadPrice(true);
    expect(m.price.problem?.kind).toBe('offline');
    expect(fake.state.requests).toHaveLength(1);
  });
});

describe('node requests through Tor', () => {
  const node = { host: 'abc.onion', port: 443, user: 'u', useTor: true, tls: true };
  const req = (retryable: boolean) => ({ url: 'https://abc.onion:443/', headers: {}, body: '{}', timeoutMs: 1000, retryable });
  type Transport = (r: ReturnType<typeof req>) => Promise<{ status: number; body: string }>;
  const transportOf = (m: InstanceType<typeof AppModel>) => (m as unknown as { transport: (n: typeof node) => Transport }).transport(node);

  it('resends even a broadcast that Tor’s dead port refused, since it never left the phone', async () => {
    set({ socks: false });
    const m = await model();
    const res = await transportOf(m)(req(false));
    expect(res.status).toBe(200);
    expect(fake.state.repairs).toEqual([false]);
    expect(fake.state.requests).toHaveLength(2);
  });

  it('doesn’t resend a broadcast that may have reached the node', async () => {
    set({ outcomes: ['network'] });
    const m = await model();
    await expect(transportOf(m)(req(false))).rejects.toThrow(/network/);
    expect(fake.state.requests).toHaveLength(1);
  });

  it('says to reopen the app when Tor can’t be reattached', async () => {
    set({ socks: false, controller: false, repair: { ok: false, stage: 'control' } });
    const m = await model();
    await expect(transportOf(m)(req(true))).rejects.toThrow(/swipe it away/);
  });
});
