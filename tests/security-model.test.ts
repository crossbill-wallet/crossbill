// The app model's 0.3.0 security features: the app PIN standing in for the passcode, the duress PIN's decoy
// session, backups and restoring them, and the recipient checks. The native plugin is a fake: an in-memory
// Keychain, and a Face ID that can be told to fail.

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    vault: new Map<string, string>(),
    faceId: true,
    passcode: true,
    /** A face was added since the app PIN trusted Face ID */
    faceAdded: false,
    reads: [] as { key: string; biometricsOnly: boolean }[],
    widgetWrites: 0,
  };
  const native = {
    vaultSet: async ({ key, value }: { key: string; value: string }) => void state.vault.set(key, value),
    vaultGet: async ({ key, biometricsOnly }: { key: string; biometricsOnly?: boolean }) => {
      state.reads.push({ key, biometricsOnly: !!biometricsOnly });
      if (biometricsOnly && (!state.faceId || state.faceAdded)) throw new NativeError('Face ID didn’t confirm it’s you', 'needs-pin');
      return { value: state.vault.get(key) ?? null };
    },
    vaultDelete: async ({ key }: { key: string }) => void state.vault.delete(key),
    authenticate: async ({ biometricsOnly }: { biometricsOnly?: boolean }) => {
      if (biometricsOnly && state.faceAdded) return { ok: false, pin: true, changed: true };
      if (biometricsOnly) return state.faceId ? { ok: true } : { ok: false, pin: true };
      return { ok: state.faceId || state.passcode };
    },
    biometryTrust: async ({ action }: { action: string }) => {
      if (action === 'set') state.faceAdded = false;
      return { changed: action === 'check' && state.faceAdded };
    },
    torStatus: async () => ({ state: 'off', progress: 0 }),
    torCheck: async () => ({ state: 'off', controller: false, socks: false, circuit: false }),
    widgetsUpdate: async () => {
      state.widgetWrites++;
      return { ok: true };
    },
    widgetsInstalled: async () => ({ ok: true, widgets: [] }),
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
const { deriveAccount } = await import('../src/core/keys');
const { NETWORKS } = await import('../src/core/network');
const { LabelStore } = await import('../src/core/labels');
type Model = InstanceType<typeof AppModel>;

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ACCT = deriveAccount(WORDS, '', 'P2WPKH', NETWORKS.mainnet);

let mono = 1000;

async function model() {
  const m = new AppModel();
  await m.init();
  return m;
}

/** A synced wallet, as the screens would have it, with a seed in the fake Keychain. */
function addWallet(m: Model, id: string, name: string, confirmed: number, txs: unknown[] = [], xpub = `xpub-${id}`) {
  m.wallets.push({
    config: { id, name, network: m.settings.network, scriptType: 'P2WPKH', fingerprint: '00000000', derivation: "m/84'/0'/0'", xpub, gapLimit: 20, createdAt: 1, hasPassphrase: false },
    labels: new LabelStore([]),
    importedRange: null,
    store: { mine: [] },
    index: { find: () => null, export: () => [[], []] },
    snapshot: { balance: { confirmed, unconfirmed: 0, immature: 0 }, txs, utxos: [], highestUsed: [-1, -1], tipHeight: 0 },
  } as unknown as Model['wallets'][number]);
  fake.state.vault.set(`seed:${id}`, JSON.stringify({ mnemonic: WORDS, passphrase: '' }));
  if (!m.activeId) m.activeId = id;
}

beforeEach(() => {
  store.clear();
  fake.state.vault.clear();
  fake.state.faceId = true;
  fake.state.passcode = true;
  fake.state.faceAdded = false;
  fake.state.reads = [];
  fake.state.widgetWrites = 0;
  mono = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => mono);
});

describe('the app PIN', () => {
  it('refuses an easy PIN, and turns on after iOS confirms it’s you', async () => {
    const m = await model();
    await expect(m.setPin('123456')).rejects.toThrow(/in order/);
    fake.state.faceId = false;
    fake.state.passcode = false;
    await expect(m.setPin('204816')).rejects.toThrow(/Cancelled/);
    fake.state.faceId = true;
    await m.setPin('204816');
    expect(m.settings.appPin).toBe(true);
    expect(fake.state.vault.get('app-pin')).not.toContain('204816');
  });

  it('opens with Face ID alone, and asks for the PIN, not the passcode, when Face ID fails', async () => {
    const m = await model();
    await m.setPin('204816');
    expect(await m.unlock()).toBe('ok');
    fake.state.faceId = false;
    expect(await m.unlock()).toBe('pin');
    await expect(m.unlockWithPin('111112')).rejects.toThrow(/isn’t right/);
    await m.unlockWithPin('204816');
    expect(m.locked).toBe(false);
    expect(m.inDecoy).toBe(false);
  });

  it('makes the next try wait after five wrong PINs, and keeps the count across a restart', async () => {
    const m = await model();
    await m.setPin('204816');
    for (let i = 0; i < 5; i++) await expect(m.unlockWithPin('000001')).rejects.toThrow();
    expect(m.pinWait()).toBe(30);
    await expect(m.unlockWithPin('204816')).rejects.toThrow(/Too many wrong PINs/);
    // Restarted app: the wait carries over, counted from the app's own clock
    m['savePinAttempts']();
    const again = await model();
    expect(again.pinWait()).toBeGreaterThan(0);
    mono += 31_000;
    await again.unlockWithPin('204816');
  });

  it('asks for the PIN before reading seed words when Face ID fails, then lets iOS ask for the passcode', async () => {
    const m = await model();
    addWallet(m, 'w1', 'Spending', 5);
    await m.setPin('204816');
    fake.state.faceId = false;
    const reveal = m.revealSeed('w1');
    await vi.waitFor(() => expect(m.pinAsk).not.toBeNull());
    expect(m.pinAsk!.reason).toBe('Show the seed words');
    await expect(m.answerPin('999990')).rejects.toThrow(/isn’t right/);
    await m.answerPin('204816');
    expect((await reveal)?.mnemonic).toBe(WORDS);
    expect(fake.state.reads.filter((r) => r.key === 'seed:w1')).toEqual([
      { key: 'seed:w1', biometricsOnly: true },
      { key: 'seed:w1', biometricsOnly: false },
    ]);
  });

  it('gives up reading the seed words when the PIN is cancelled', async () => {
    const m = await model();
    addWallet(m, 'w1', 'Spending', 5);
    await m.setPin('204816');
    fake.state.faceId = false;
    const reveal = m.revealSeed('w1');
    await vi.waitFor(() => expect(m.pinAsk).not.toBeNull());
    m.cancelPin();
    await expect(reveal).rejects.toThrow(/Cancelled/);
  });

  it('stops trusting Face ID when a face is added, until the PIN confirms it', async () => {
    const m = await model();
    addWallet(m, 'w1', 'Spending', 5);
    await m.setPin('204816');
    fake.state.faceAdded = true;
    expect(await m.unlock()).toBe('pin');
    expect(m.faceIdChanged).toBe(true);
    // Seed words too: the PIN is asked for even though Face ID would pass
    const reveal = m.revealSeed('w1');
    await vi.waitFor(() => expect(m.pinAsk).not.toBeNull());
    await m.answerPin('204816');
    await reveal;
    await expect(m.trustFaceId('000001')).rejects.toThrow(/isn’t right/);
    await m.trustFaceId('204816');
    expect(m.faceIdChanged).toBe(false);
    expect(await m.unlock()).toBe('ok');
  });

  it('needs the PIN to turn it off, and leaves seed reads as before once off', async () => {
    const m = await model();
    addWallet(m, 'w1', 'Spending', 5);
    await m.setPin('204816');
    await expect(m.disablePin('000001')).rejects.toThrow();
    await m.disablePin('204816');
    expect(m.settings.appPin).toBe(false);
    await m.revealSeed('w1');
    expect(fake.state.reads.at(-1)).toEqual({ key: 'seed:w1', biometricsOnly: false });
  });
});

describe('the duress PIN', () => {
  async function withDuress() {
    const m = await model();
    addWallet(m, 'real', 'Savings', 900_000_000);
    addWallet(m, 'decoy', 'Pocket', 20_000);
    m.contacts.push({ id: 'c1', name: 'Exchange', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', network: 'mainnet', createdAt: 1 });
    await m.updateSettings({ skinTier: 2, skin: 'northern' });
    await m.setPin('204816');
    await m.setDuress('204816', '583920', 'decoy');
    return m;
  }

  it('can’t be the same as the app PIN, and needs the app PIN to set', async () => {
    const m = await model();
    addWallet(m, 'decoy', 'Pocket', 1);
    await m.setPin('204816');
    await expect(m.setDuress('204816', '204816', 'decoy')).rejects.toThrow(/differ/);
    await expect(m.setDuress('111112', '583920', 'decoy')).rejects.toThrow(/isn’t right/);
    await m.setDuress('204816', '583920', 'decoy');
    expect(await m.duressWallet()).toBe('decoy');
  });

  it('opens a session that shows only the decoy wallet, and nothing that hints at the rest', async () => {
    const m = await withDuress();
    await m.unlockWithPin('583920');
    expect(m.inDecoy).toBe(true);
    expect(m.networkWallets().map((w) => w.config.name)).toEqual(['Pocket']);
    expect(m.active?.config.name).toBe('Pocket');
    expect(m.walletById('real')).toBeUndefined();
    expect(m.networkContacts()).toEqual([]);
    expect(m.totalConfirmed()).toBe(20_000);
    // The lock screen already showed the skin; changing it now would stand out
    expect(m.skin).toBe('northern');
    expect(await m.duressWallet()).toBeNull();
    expect(m.pinOn).toBe(true);
    await m.updateSettings({ widgetWallet: 'real' });
    const b = m.backupContents();
    expect(b.wallets.map((w) => w.config.name)).toEqual(['Pocket']);
    expect(b.contacts).toEqual([]);
    expect(b.settings.widgetWallet).toBeNull();
    // The widgets keep what they had
    const writes = fake.state.widgetWrites;
    await m.sendWidgets();
    m['queueWidgets']();
    await new Promise((r) => setTimeout(r, 450));
    expect(fake.state.widgetWrites).toBe(writes);
  });

  it('acts on the App PIN screen as a real session would, without touching the real PINs', async () => {
    const m = await withDuress();
    await m.unlockWithPin('583920');
    await m.setDuress('583920', '660011', 'decoy');
    expect(await m.duressWallet()).toBe('decoy');
    await m.disablePin('583920');
    expect(m.pinOn).toBe(false);
    expect(m.settings.appPin).toBe(true);
    // "Turning it on again" makes the new PIN the duress PIN
    await m.setPin('771133');
    expect(m.pinOn).toBe(true);
    await m.unlockWithPin('204816');
    expect(m.inDecoy).toBe(false);
    expect(await m.duressWallet()).toBe('decoy');
    await m.unlockWithPin('771133');
    expect(m.inDecoy).toBe(true);
  });

  it('moves the Balance widget to the decoy, and shows the decoy on the Widgets screen in a duress session', async () => {
    const m = await withDuress();
    expect(m.widgetWallet()?.config.name).toBe('Pocket');
    await m.unlockWithPin('583920');
    expect(m.widgetSnapshot?.balance?.wallet).toBe('Pocket');
  });

  it('reads seed words without the PIN once a duress session has “turned it off”, as a real one would', async () => {
    const m = await withDuress();
    await m.unlockWithPin('583920');
    await m.disablePin('583920');
    fake.state.reads = [];
    await m.revealSeed('decoy');
    expect(fake.state.reads.filter((r) => r.key.startsWith('seed:'))).toEqual([{ key: 'seed:decoy', biometricsOnly: false }]);
  });

  it('saves a contact that matches a hidden one as a new contact, without naming the hidden one', async () => {
    const m = await withDuress();
    await m.unlockWithPin('583920');
    const c = await m.saveContact({ name: 'Shop', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' });
    expect(c.name).toBe('Shop');
    expect(m.networkContacts().map((x) => x.name)).toEqual(['Shop']);
  });

  it('reports a restored backup’s hidden matches as if they were new', async () => {
    const m = await withDuress();
    const backup = m.backupContents();
    await m.unlockWithPin('583920');
    const s = await m.restoreBackup(backup);
    expect(s.contacts).toBe(1);
    expect(m.networkContacts().map((c) => c.name)).toEqual(['Exchange']);
    expect(s.waiting).toEqual(['Savings']);
    expect(m.waitingWallets()).toEqual([]);
  });

  it('in a decoy session, “changing the PIN” changes the duress PIN, and the real one still opens everything', async () => {
    const m = await withDuress();
    await m.unlockWithPin('583920');
    await m.changePin('583920', '740261');
    // Locked and opened again with the real PIN: everything is back
    await m.unlockWithPin('204816');
    expect(m.inDecoy).toBe(false);
    expect(m.networkWallets()).toHaveLength(2);
    expect(m.networkContacts()).toHaveLength(1);
    await m.unlockWithPin('740261');
    expect(m.inDecoy).toBe(true);
    await expect(m.unlockWithPin('583920')).rejects.toThrow(/isn’t right/);
  });

  it('drops a PIN request when the app locks, so it can’t be answered in the next session', async () => {
    const m = await withDuress();
    await m.unlockWithPin('204816');
    fake.state.faceId = false;
    const reveal = m.revealSeed('real');
    await vi.waitFor(() => expect(m.pinAsk).not.toBeNull());
    // The app locks, and is opened with the duress PIN
    m['decoy'] = null;
    m['session']++;
    m.cancelPin();
    await expect(reveal).rejects.toThrow(/Cancelled/);
    await m.unlockWithPin('583920');
    expect(m.pinAsk).toBeNull();
  });

  it('never shows a PIN request from a session that ended before Face ID answered', async () => {
    const m = await withDuress();
    await m.unlockWithPin('204816');
    fake.state.faceId = false;
    const reveal = m.revealSeed('real');
    // The app is opened again (with the duress PIN) before the Face ID failure comes back
    await m.unlockWithPin('583920');
    await expect(reveal).rejects.toThrow(/Cancelled/);
    expect(m.pinAsk).toBeNull();
  });

  it('takes only the duress PIN for a signature in a decoy session', async () => {
    const m = await withDuress();
    await m.unlockWithPin('583920');
    fake.state.faceId = false;
    const reveal = m.revealSeed('decoy');
    await vi.waitFor(() => expect(m.pinAsk).not.toBeNull());
    await expect(m.answerPin('204816')).rejects.toThrow(/isn’t right/);
    await m.answerPin('583920');
    expect((await reveal)?.mnemonic).toBe(WORDS);
  });

  it('is removed with its decoy wallet', async () => {
    const m = await withDuress();
    await m.unlockWithPin('204816');
    await m.removeWallet('decoy');
    expect(await m.duressWallet()).toBeNull();
    await expect(m.unlockWithPin('583920')).rejects.toThrow(/isn’t right/);
  });
});

describe('backups', () => {
  it('hold wallets, labels, contacts and settings, and nothing secret', async () => {
    const m = await model();
    addWallet(m, 'w1', 'Spending', 5);
    m.wallets[0].labels.set('tx', 'aa'.repeat(32), 'Rent');
    m.wallets[0].labels.setFrozen('bb'.repeat(32), 1, true);
    m.contacts.push({ id: 'c1', name: 'Exchange', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', network: 'mainnet', createdAt: 1 });
    await m.updateSettings({ node: { host: 'abc.onion', port: 443, user: 'phone', useTor: true, tls: true }, unit: 'sats' });
    fake.state.vault.set('rpc-password', 'hunter2-node');
    await m.setPin('204816');
    const { text, fileName } = await m.makeBackup('correct horse battery');
    expect(fileName).toMatch(/^shrike-backup-\d{4}-\d{2}-\d{2}\.json$/);
    for (const secret of ['abandon', 'hunter2', 'Rent', 'abc.onion', 'xpub-w1']) expect(text).not.toContain(secret);
    const b = await m.openBackup(text, 'correct horse battery');
    expect(b.wallets[0].config.name).toBe('Spending');
    expect(b.wallets[0].labels).toHaveLength(2);
    expect(b.contacts[0].name).toBe('Exchange');
    expect(b.settings).toMatchObject({ unit: 'sats', node: { host: 'abc.onion' } });
    expect(b.settings).not.toHaveProperty('appPin');
    expect(b.settings).not.toHaveProperty('twoFactor');
    expect(JSON.stringify(b)).not.toContain('abandon');
    expect(m.settings.lastBackupAt).not.toBeNull();
    await expect(m.openBackup(text, 'wrong password!')).rejects.toThrow(/doesn’t open/);
  });

  it('restores onto a new phone: settings and contacts now, wallets once their seed words are in', async () => {
    const old = await model();
    addWallet(old, 'w1', 'Spending', 5, [], ACCT.xpub);
    old.wallets[0].labels.set('addr', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'Salary');
    old.contacts.push({ id: 'c1', name: 'Exchange', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', network: 'mainnet', createdAt: 1 });
    await old.updateSettings({ node: { host: 'abc.onion', port: 443, user: 'phone', useTor: true, tls: true }, appearance: 'dark' });
    const { text } = await old.makeBackup('correct horse battery');

    store.clear();
    fake.state.vault.clear();
    const fresh = await model();
    const s = await fresh.restoreBackup(await fresh.openBackup(text, 'correct horse battery'));
    expect(s).toEqual({ settings: true, contacts: 1, labels: 0, waiting: ['Spending'] });
    expect(fresh.settings.node?.host).toBe('abc.onion');
    expect(fresh.settings.appearance).toBe('dark');
    expect(fresh.networkContacts()[0].name).toBe('Exchange');
    expect(fresh.waitingWallets().map((b) => b.config.name)).toEqual(['Spending']);
    expect(fresh.restoreMatch(WORDS, '')?.config.name).toBe('Spending');
    expect(fresh.restoreMatch(WORDS, 'a passphrase')).toBeNull();
    // Waiting wallets survive a restart
    const later = await model();
    expect(later.waitingWallets()).toHaveLength(1);
  });

  it('adds what’s missing on a phone that’s set up, and overwrites nothing', async () => {
    const m = await model();
    addWallet(m, 'w1', 'Spending', 5, [], ACCT.xpub);
    m.wallets[0].labels.set('tx', 'aa'.repeat(32), 'Rent');
    const backup = {
      kind: 'shrike-backup' as const,
      v: 1 as const,
      app: '0.3.0',
      createdAt: 1,
      settings: { unit: 'sats' as const },
      wallets: [
        {
          config: { ...m.wallets[0].config, name: 'Old name' },
          labels: [
            { type: 'tx' as const, ref: 'aa'.repeat(32), label: 'Something else' },
            { type: 'tx' as const, ref: 'cc'.repeat(32), label: 'Groceries' },
          ],
          importedRange: null,
        },
      ],
      contacts: [{ id: 'c9', name: 'Exchange', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', network: 'mainnet' as const, createdAt: 1 }],
    };
    const s = await m.restoreBackup(backup);
    expect(s).toEqual({ settings: false, contacts: 1, labels: 1, waiting: [] });
    expect(m.settings.unit).toBe('BTC');
    expect(m.wallets[0].config.name).toBe('Spending');
    expect(m.wallets[0].labels.get('tx', 'aa'.repeat(32))).toBe('Rent');
    expect(m.wallets[0].labels.get('tx', 'cc'.repeat(32))).toBe('Groceries');
    // Again: nothing new
    expect(await m.restoreBackup(backup)).toEqual({ settings: false, contacts: 0, labels: 0, waiting: [] });
  });
});

describe('recipient checks', () => {
  const paid = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  const lookalike = 'bc1qar0sxk9t3hy2u7pqzlm4w6d8ce5vn2gtzzwf5mdq'.slice(0, paid.length - 5) + 'f5mdq';
  const sent = {
    txid: '11'.repeat(32),
    time: 1_760_000_000,
    net: -50_000,
    coinbase: false,
    inputs: [{ txid: 'aa', vout: 0, value: 60_000, mine: { chain: 0, index: 0 }, address: 'bc1qown' }],
    outputs: [
      { vout: 0, value: 50_000, address: paid, mine: null },
      { vout: 1, value: 9_000, address: 'bc1qchangeaddressofmine0000000000000000000', mine: { chain: 1, index: 0 } },
    ],
  };
  const dust = { txid: '22'.repeat(32), time: 1_760_100_000, net: 546, coinbase: false, inputs: [{ txid: 'bb', vout: 0, value: null, mine: null, address: null }], outputs: [{ vout: 0, value: 546, address: 'bc1qmine', mine: { chain: 0, index: 1 } }] };

  it('knows addresses paid, and warns about one that looks like it', async () => {
    const m = await model();
    addWallet(m, 'w1', 'Spending', 5, [sent, dust]);
    expect(m.recipientCheck(paid).exact).toMatchObject({ kind: 'paid', when: 1_760_000_000 });
    const c = m.recipientCheck(lookalike);
    expect(c.exact).toBeNull();
    expect(c.lookalikes[0]).toMatchObject({ address: paid, kind: 'paid' });
  });

  it('calls a tiny payment from someone else dust, and not a send or a real payment', async () => {
    const m = await model();
    expect(m.isDust(dust as never)).toBe(true);
    expect(m.isDust(sent as never)).toBe(false);
    expect(m.isDust({ ...dust, net: 250_000 } as never)).toBe(false);
  });
});
