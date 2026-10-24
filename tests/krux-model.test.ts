// The app model's Krux support: linking a wallet to the Krux (keeping or removing the phone's seed words),
// wallets that sign only on the Krux, the send that waits for the Krux's signature, and backups. The native
// plugin is a fake with an in-memory Keychain, and the node is a fake that records what it's sent.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const state = {
    vault: new Map<string, string>(),
    reads: [] as string[],
    sent: [] as string[],
    spent: false,
  };
  const native = {
    vaultSet: async ({ key, value }: { key: string; value: string }) => void state.vault.set(key, value),
    vaultGet: async ({ key }: { key: string }) => {
      state.reads.push(key);
      return { value: state.vault.get(key) ?? null };
    },
    vaultDelete: async ({ key }: { key: string }) => void state.vault.delete(key),
    authenticate: async () => ({ ok: true }),
    biometryTrust: async () => ({ changed: false }),
    torStatus: async () => ({ state: 'off', progress: 0 }),
    torCheck: async () => ({ state: 'off', controller: false, socks: false, circuit: false }),
    widgetsUpdate: async () => ({ ok: true }),
    widgetsInstalled: async () => ({ ok: true, widgets: [] }),
  };
  const rpc = {
    batch: async (calls: unknown[]) => calls.map(() => ({ ok: true, result: state.spent ? null : { value: 0.001 } })),
    call: async (method: string, params: unknown[]) => {
      if (method === 'testmempoolaccept') return [{ allowed: true }];
      if (method === 'sendrawtransaction') {
        state.sent.push(params[0] as string);
        return 'ok';
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { state, native, rpc };
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

const { AppModel, signerOf } = await import('../src/app/model');
const { checkBackupContents } = await import('../src/app/backup');
const { deriveAccount } = await import('../src/core/keys');
const { NETWORKS } = await import('../src/core/network');
const { outputScript, encodeAddress, decodeAddress } = await import('../src/core/script');
const { toHex, concat, u8 } = await import('../src/core/bytes');
const { signDraft } = await import('../src/core/signer');
const { parsePsbt, serializePsbt, PSBT_IN } = await import('../src/core/psbt');
type Model = InstanceType<typeof AppModel>;
type Runtime = Model['wallets'][number];

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const net = NETWORKS.mainnet;
const ACCT = deriveAccount(WORDS, '', 'P2WPKH', net);
/** What this seed's Krux shows for Native Segwit, account 0 (the BIP84 test key) */
const KRUX_KEY = '[73c5da0a/84h/0h/0h]zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const OTHER = deriveAccount(WORDS, 'another passphrase', 'P2WPKH', net);

async function model() {
  const m = new AppModel();
  await m.init();
  const priv = m as unknown as Record<string, unknown>;
  priv.getRpc = async () => fake.rpc;
  priv.refresh = async () => undefined;
  m.node = {
    blocks: 970_000,
    headers: 970_000,
    initialBlockDownload: false,
    mempoolMinFee: 1,
    minRelayFee: 1,
    incrementalFee: 1,
    replayDecision: 'OPTED_IN',
  } as Model['node'];
  return m;
}

/** A real wallet runtime (keys, address index) with two coins, signed where `signer` says. */
function addWallet(m: Model, id: string, signer: 'phone' | 'krux' | 'both', acct = ACCT): Runtime {
  const config = { id, name: id, network: 'mainnet' as const, scriptType: 'P2WPKH' as const, fingerprint: acct.fingerprint, derivation: acct.derivation, xpub: acct.xpub, gapLimit: 20, createdAt: 1, hasPassphrase: false, signer };
  const w = (m as unknown as { runtimeFor: (c: typeof config, f: null) => Runtime }).runtimeFor(config, null);
  const utxos = [0, 1].map((i) => {
    const script = outputScript('P2WPKH', w.key.pubKey(0, i));
    return { txid: String(i + 1).repeat(64), vout: 0, value: 100_000, script: toHex(script), address: encodeAddress(script, net), chain: 0 as const, index: i, height: 960_000, confirmations: 10_000, coinbase: false, immature: false };
  });
  w.snapshot = { tipHeight: 970_000, balance: { confirmed: 200_000, unconfirmed: 0, immature: 0 }, txs: [], utxos, highestUsed: [1, -1] } as unknown as Runtime['snapshot'];
  m.wallets.push(w);
  if (signer !== 'krux') fake.state.vault.set(`seed:${id}`, JSON.stringify({ mnemonic: WORDS, passphrase: '' }));
  if (!m.activeId) m.activeId = id;
  return w;
}

const DEST = 'bc1qgfpyysjzgfpyysjzgfpyysjzgfpyysjz5t4fq5';
const pay = (m: Model, w: Runtime) => m.buildDraft(w, [{ address: DEST, scriptPubKey: decodeAddress(DEST, net).scriptPubKey, amount: 50_000 }], 2, null);

/** What the Krux hands back: this phone's own signatures, as partial signatures in the PSBT it was shown. */
function kruxReply(psbt: Uint8Array, draft: ReturnType<typeof pay>, w: Runtime): Uint8Array {
  const signed = signDraft(draft, { mnemonic: WORDS, passphrase: '' }, 'P2WPKH', ACCT.derivation, ACCT.fingerprint, net);
  const p = parsePsbt(psbt);
  draft.coins.forEach((c, i) => p.inputs[i].push({ key: concat(u8(PSBT_IN.PARTIAL_SIG), w.key.pubKey(c.chain, c.index)), value: signed.tx.inputs[i].witness[0] }));
  return serializePsbt(p);
}

beforeEach(() => {
  store.clear();
  fake.state.vault.clear();
  fake.state.reads = [];
  fake.state.sent = [];
  fake.state.spent = false;
});

describe('linking a wallet to the Krux', () => {
  it('keeps the seed words on the iPhone when asked, so either can sign', async () => {
    const m = await model();
    addWallet(m, 'a', 'phone');
    await m.linkKrux('a', m.readKruxKey(KRUX_KEY), false);
    expect(signerOf(m.walletById('a')!.config)).toBe('both');
    expect(fake.state.vault.has('seed:a')).toBe(true);
    await m.unlinkKrux('a');
    expect(signerOf(m.walletById('a')!.config)).toBe('phone');
  });

  it('takes the seed words off the iPhone when asked, so only the Krux signs', async () => {
    const m = await model();
    addWallet(m, 'a', 'phone');
    await m.linkKrux('a', m.readKruxKey(KRUX_KEY), true);
    expect(signerOf(m.walletById('a')!.config)).toBe('krux');
    expect(fake.state.vault.has('seed:a')).toBe(false);
    // It's saved that way
    const again = await model();
    expect(signerOf(again.wallets.find((w) => w.config.id === 'a')!.config)).toBe('krux');
  });

  it('refuses a Krux with other seed words or a passphrase, and changes nothing', async () => {
    const m = await model();
    addWallet(m, 'a', 'phone', OTHER);
    await expect(m.linkKrux('a', m.readKruxKey(KRUX_KEY), true)).rejects.toThrow(/different seed words, or a different passphrase/);
    expect(signerOf(m.walletById('a')!.config)).toBe('phone');
    expect(fake.state.vault.has('seed:a')).toBe(true);
  });

  it('puts seed words back on the iPhone for a wallet that signs only on the Krux', async () => {
    const m = await model();
    addWallet(m, 'a', 'krux');
    const r = await m.addWallet({ name: 'x', mnemonic: WORDS, passphrase: '', scriptType: 'P2WPKH', rescan: { kind: 'existing' } });
    expect(r).toBe('seed-back');
    expect(signerOf(m.walletById('a')!.config)).toBe('both');
    expect(fake.state.vault.has('seed:a')).toBe(true);
  });
});

describe('fixes from review', () => {
  it('puts seed words back on a Krux wallet that uses another account, and takes the fingerprint they give', async () => {
    const m = await model();
    const acct1 = deriveAccount(WORDS, '', 'P2WPKH', net, 1);
    const w = addWallet(m, 'k1', 'krux', { ...acct1, fingerprint: '00000000' });
    const r = await m.addWallet({ name: 'x', mnemonic: WORDS, passphrase: '', scriptType: 'P2WPKH', rescan: { kind: 'existing' } });
    expect(r).toBe('seed-back');
    expect(w.config).toMatchObject({ signer: 'both', fingerprint: ACCT.fingerprint, derivation: "m/84'/0'/1'" });
    expect(m.wallets).toHaveLength(1);
  });

  it('in a duress session, gives a Krux wallet nothing from a backup restored outside it', async () => {
    const m = await model();
    addWallet(m, 'k', 'krux');
    const contents = checkBackupContents(JSON.parse(JSON.stringify(m.backupContents())));
    contents.wallets[0].labels = [{ type: 'tx', ref: 'ab', label: 'Secret' }];
    const fresh = await model();
    await fresh.restoreBackup(contents);
    const opened = (fresh as unknown as { opened: (d: unknown) => void }).opened.bind(fresh);
    opened({ wallet: 'none', wallets: new Set(), contacts: new Set(), pinOff: false, duressShown: null });
    expect(fresh.kruxKeyFor(fresh.readKruxKey(KRUX_KEY)).waiting).toBeNull();
    const installed: Runtime[] = [];
    (fresh as unknown as Record<string, unknown>).installWallet = async (w: Runtime) => void installed.push(w);
    await fresh.addKruxWallet({ name: 'Cold', key: fresh.readKruxKey(KRUX_KEY), rescan: { kind: 'new' } });
    expect(installed[0].labels.all()).toEqual([]);
    expect(installed[0].config.name).toBe('Cold');
  });

  it('in a duress session, reports a hidden Krux wallet in a restored backup as any Krux wallet', async () => {
    const m = await model();
    addWallet(m, 'k', 'krux');
    addWallet(m, 'd', 'phone', OTHER);
    const contents = checkBackupContents(JSON.parse(JSON.stringify(m.backupContents())));
    const opened = (m as unknown as { opened: (d: unknown) => void }).opened.bind(m);
    opened({ wallet: 'd', wallets: new Set(['d']), contacts: new Set(), pinOff: false, duressShown: null });
    const s = await m.restoreBackup(contents);
    expect(s.kruxWaiting).toEqual(['k']);
    expect(s.waiting).toEqual([]);
  });

  it('says a send went once the node has it, even if saving afterwards fails', async () => {
    const m = await model();
    const w = addWallet(m, 'k', 'krux');
    const draft = pay(m, w);
    const s = await m.startKruxSigning(w, draft);
    const signed = m.acceptKruxSignature(kruxReply(s.psbt, draft, w));
    (m as unknown as Record<string, unknown>).afterBroadcast = async () => {
      throw new Error('disk full');
    };
    expect(await m.sendKruxSigned()).toBe(signed.txid);
    expect(m.kruxSigning).toBeNull();
  });
});

describe('a wallet that signs on the Krux', () => {
  it('sends with the Krux’s signatures, asking for no Face ID and no code', async () => {
    const m = await model();
    await m.updateSettings({ twoFactor: true });
    const w = addWallet(m, 'k', 'krux');
    const draft = pay(m, w);
    const s = await m.startKruxSigning(w, draft, 'Rent');
    expect(parsePsbt(s.psbt).inputs).toHaveLength(draft.coins.length);
    const signed = m.acceptKruxSignature(kruxReply(s.psbt, draft, w));
    expect(m.kruxSigning?.signed?.txid).toBe(signed.txid);
    const txid = await m.sendKruxSigned();
    expect(txid).toBe(signed.txid);
    expect(fake.state.sent).toEqual([signed.hex]);
    expect(m.kruxSigning).toBeNull();
    expect(w.labels.get('tx', txid)).toBe('Rent');
    // Nothing was read from the Keychain: no seed words, no Face ID, no two-factor key
    expect(fake.state.reads.filter((k) => k.startsWith('seed:'))).toEqual([]);
  });

  it('won’t sign on the phone, and won’t take a reply for another payment', async () => {
    const m = await model();
    const w = addWallet(m, 'k', 'krux');
    const draft = pay(m, w);
    await expect(m.signAndBroadcast(w, draft)).rejects.toThrow(/signs on your Krux/);
    const other = m.buildDraft(w, [{ address: DEST, scriptPubKey: decodeAddress(DEST, net).scriptPubKey, amount: 40_000 }], 2, null);
    const otherReply = kruxReply((await m.startKruxSigning(w, other)).psbt, other, w);
    await m.startKruxSigning(w, draft);
    expect(() => m.acceptKruxSignature(otherReply)).toThrow(/different transaction/);
    expect(m.kruxSigning?.signed).toBeNull();
  });

  it('refuses to start when replay protection is off, since the Krux wouldn’t sign', async () => {
    const m = await model();
    const w = addWallet(m, 'k', 'krux');
    m.node = { ...m.node!, replayDecision: 'SCHEDULE_MISMATCH' };
    await expect(m.startKruxSigning(w, pay(m, w))).rejects.toThrow(/only signs replay-protected transactions.*disagree/);
  });

  it('checks the coins are still unspent before showing the Krux, and again before sending', async () => {
    const m = await model();
    const w = addWallet(m, 'k', 'krux');
    const draft = pay(m, w);
    const s = await m.startKruxSigning(w, draft);
    m.acceptKruxSignature(kruxReply(s.psbt, draft, w));
    fake.state.spent = true;
    await expect(m.sendKruxSigned()).rejects.toThrow(/already been spent/);
    expect(fake.state.sent).toEqual([]);
  });

  it('keeps the waiting send across a lock, but never shows it in a duress session', async () => {
    const m = await model();
    const w = addWallet(m, 'k', 'krux');
    await m.startKruxSigning(w, pay(m, w));
    const opened = (m as unknown as { opened: (d: unknown) => void }).opened.bind(m);
    opened(null);
    expect(m.kruxSigning).not.toBeNull();
    opened({ wallet: 'k', wallets: new Set(['k']), contacts: new Set(), pinOff: false, duressShown: null });
    expect(m.kruxSigning).toBeNull();
  });

  it('a wallet linked with its seed words kept can still sign on the phone', async () => {
    const m = await model();
    const w = addWallet(m, 'b', 'both');
    const signed = await m.signAndBroadcast(w, pay(m, w));
    expect(fake.state.sent).toEqual([signed.hex]);
  });
});

describe('adding a Krux wallet', () => {
  it('holds only the public key, and says when the Krux is a wallet already here', async () => {
    const m = await model();
    const installed: Runtime[] = [];
    (m as unknown as Record<string, unknown>).installWallet = async (w: Runtime) => void installed.push(w);
    const key = m.readKruxKey(KRUX_KEY);
    await m.addKruxWallet({ name: 'Cold', key, rescan: { kind: 'new' } });
    expect(installed[0].config).toMatchObject({ name: 'Cold', signer: 'krux', xpub: ACCT.xpub, fingerprint: '73c5da0a', derivation: "m/84'/0'/0'" });
    expect(fake.state.vault.size).toBe(0);
    const m2 = await model();
    addWallet(m2, 'a', 'phone');
    expect(m2.kruxKeyFor(key).wallet?.config.id).toBe('a');
    await expect(m2.addKruxWallet({ name: 'Cold', key, rescan: { kind: 'new' } })).rejects.toThrow(/link the two/);
  });

  it('comes back from a backup with its signer, ready to add without seed words', async () => {
    const m = await model();
    addWallet(m, 'k', 'krux');
    const contents = checkBackupContents(JSON.parse(JSON.stringify(m.backupContents())));
    expect(contents.wallets[0].config.signer).toBe('krux');
    const fresh = new AppModel();
    await fresh.init();
    const summary = await fresh.restoreBackup(contents);
    expect(summary.kruxWaiting).toEqual(['k']);
    expect(summary.waiting).toEqual([]);
    expect(fresh.kruxKeyFor(fresh.readKruxKey(KRUX_KEY)).waiting?.config.name).toBe('k');
    // Something that isn't a signer reads as this iPhone
    const odd = JSON.parse(JSON.stringify(m.backupContents()));
    odd.wallets[0].config.signer = 'usb';
    expect(checkBackupContents(odd).wallets[0].config.signer).toBe('phone');
  });
});
