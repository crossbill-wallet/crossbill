// The app model handing the widgets their snapshot: only when something on it changed, fetching the price and
// the day's chart for a price widget, the balance setting, and the links a tapped widget opens. The native plugin
// is a fake that records what it's handed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const state = {
    installed: [] as { kind: string; family: string }[],
    appGroup: true,
    writes: [] as (string | null)[],
    requests: [] as string[],
  };
  const ticker = JSON.stringify({ success: true, ticker: { lastPrice: '570.25', changePercent: '1.5' } });
  const candles = JSON.stringify({
    success: true,
    candles: Array.from({ length: 96 }, (_, i) => ({ time: 1_760_000_000 + i * 900, open: 500, high: 600, low: 400, close: 500 + i, volume: 1 })),
  });
  const native = {
    torStart: async () => undefined,
    torStatus: async () => ({ state: 'ready', progress: 100 }),
    torCheck: async () => ({ state: 'ready', controller: true, socks: true, circuit: true, port: 39050 }),
    torRepair: async () => ({ ok: true }),
    httpRequest: async (req: { url: string }) => {
      state.requests.push(req.url);
      return { status: 200, body: req.url.includes('candles') ? candles : ticker };
    },
    vaultGet: async () => ({ value: null }),
    vaultSet: async () => undefined,
    vaultDelete: async () => undefined,
    authenticate: async () => ({ ok: true }),
    widgetsUpdate: async ({ snapshot }: { snapshot: string | null }) => {
      if (!state.appGroup) return { ok: false, reason: 'no-app-group' as const };
      state.writes.push(snapshot);
      return { ok: true };
    },
    widgetsInstalled: async () => ({ ok: state.appGroup, reason: state.appGroup ? undefined : ('no-app-group' as const), widgets: state.installed }),
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
type Model = InstanceType<typeof AppModel>;

async function model() {
  const m = new AppModel();
  await m.init();
  m.torAvailable = true;
  m.priceTiming = { beat: 0, settle: 0, backoff: [0, 0], circuitWait: 0, askTimeout: 1000 };
  return m;
}

/** A wallet that has synced once, as the Wallet tab would have it. */
function addWallet(m: Model, id: string, name: string, confirmed: number) {
  m.wallets.push({
    config: { id, name, network: m.settings.network },
    snapshot: { balance: { confirmed, unconfirmed: 0, immature: 0 } },
  } as unknown as Model['wallets'][number]);
}

const last = () => JSON.parse(fake.state.writes[fake.state.writes.length - 1] ?? 'null');

beforeEach(() => {
  store.clear();
  Object.assign(fake.state, { installed: [], appGroup: true, writes: [], requests: [] });
});

describe('handing the widgets a snapshot', () => {
  it('hands over the balance and the price, and nothing more until something changes', async () => {
    const m = await model();
    addWallet(m, 'w1', 'Spending', 12_345_678);
    await m.sendWidgets();
    expect(last().balance).toMatchObject({ wallet: 'Spending', amount: '0.12 345 678', unit: 'BTC' });
    expect(last().price).toBeNull();
    await m.loadPrice(true);
    await m.sendWidgets();
    expect(last().price).toMatchObject({ price: '$570.25', change: '+1.50%' });
    expect(last().balance.usd).toBe('$70.40');
    const n = fake.state.writes.length;
    await m.sendWidgets();
    await m.sendWidgets();
    expect(fake.state.writes).toHaveLength(n);
    expect(m.widgets.status).toBe('ok');
  });

  it('follows the unit, the chosen wallet and the balance setting', async () => {
    const m = await model();
    addWallet(m, 'w1', 'Spending', 12_345_678);
    addWallet(m, 'w2', 'Savings', 250_000_000);
    await m.updateSettings({ unit: 'sats' });
    await m.sendWidgets();
    expect(last().balance).toMatchObject({ wallet: 'Spending', amount: '12,345,678', unit: 'sats' });
    await m.updateSettings({ widgetWallet: 'w2' });
    await m.sendWidgets();
    expect(last().balance.wallet).toBe('Savings');
    await m.updateSettings({ widgetBalance: false });
    await m.sendWidgets();
    expect(last()).toMatchObject({ showBalance: false, balance: null });
    expect(fake.state.writes[fake.state.writes.length - 1]).not.toContain('250,000,000');
  });

  it('goes back to the first wallet when the chosen one is removed', async () => {
    const m = await model();
    addWallet(m, 'w1', 'Spending', 1);
    addWallet(m, 'w2', 'Savings', 2);
    await m.updateSettings({ widgetWallet: 'w2' });
    await m.removeWallet('w2');
    expect(m.settings.widgetWallet).toBeNull();
    expect(m.widgetWallet()?.config.id).toBe('w1');
  });

  it('remembers the last price across a restart', async () => {
    const m = await model();
    await m.loadPrice(true);
    await m.sendWidgets();
    const again = await model();
    addWallet(again, 'w1', 'Spending', 5);
    await again.sendWidgets();
    expect(last().price.price).toBe('$570.25');
  });

  it('says so when the build has no App Group', async () => {
    fake.state.appGroup = false;
    const m = await model();
    addWallet(m, 'w1', 'Spending', 5);
    await m.checkWidgets();
    await m.sendWidgets();
    expect(m.widgets.status).toBe('no-app-group');
  });
});

describe('the price for a price widget', () => {
  it('isn’t fetched when there is no price widget', async () => {
    const m = await model();
    await m.checkWidgets();
    expect(fake.state.requests).toHaveLength(0);
  });

  it('is fetched for a price widget, with the day’s chart for the sizes that draw it', async () => {
    fake.state.installed = [{ kind: 'ShrikePrice', family: 'systemSmall' }];
    const m = await model();
    await m.checkWidgets();
    await vi.waitFor(() => expect(fake.state.requests.some((u) => u.includes('candles'))).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    await m.sendWidgets();
    expect(last().price.points).toHaveLength(48);
    expect(last().price.points[47]).toBe(570.25);
    // Not again within the minute, nor the chart within fifteen
    const n = fake.state.requests.length;
    await m.checkWidgets();
    expect(fake.state.requests).toHaveLength(n);
  });

  it('isn’t fetched while prices are off', async () => {
    fake.state.installed = [{ kind: 'ShrikePrice', family: 'accessoryCircular' }];
    const m = await model();
    await m.updateSettings({ prices: false });
    fake.state.requests = [];
    await m.checkWidgets();
    expect(fake.state.requests).toHaveLength(0);
  });

  it('gets no chart for the Lock Screen sizes, which don’t draw one', async () => {
    fake.state.installed = [{ kind: 'ShrikePrice', family: 'accessoryRectangular' }];
    const m = await model();
    await m.checkWidgets();
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.state.requests.some((u) => u.includes('ticker'))).toBe(true);
    expect(fake.state.requests.some((u) => u.includes('candles'))).toBe(false);
  });
});

describe('a tapped widget', () => {
  it('asks for its tab once', async () => {
    const m = await model();
    m.openLink('crossbill://market');
    expect(m.takePendingTab()).toBe('market');
    expect(m.takePendingTab()).toBeNull();
    m.openLink('crossbill://wallet');
    expect(m.takePendingTab()).toBe('home');
  });

  it('ignores any other link', async () => {
    const m = await model();
    for (const url of ['crossbill://send?to=bc1q', 'https://example.com', 'crossbill://market/../send', 'shrike://market', 'bitcoin:bc1q']) m.openLink(url);
    expect(m.pendingTab).toBeNull();
  });
});
