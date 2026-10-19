// End to end against a real Bitcoin Knots v29.4.1.knots20260508 node in regtest, with the BLAKE2b fork
// (and the unified opt-in signature hash with it) activating at height 20, as Shrike's docs set it up.
//
// Runs only when KNOTS_BIN points at a directory holding bitcoind and bitcoin-cli:
//   KNOTS_BIN=/path/to/build/bin npx vitest run tests/regtest.e2e.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NETWORKS } from '../src/core/network';
import { AccountKey, deriveAccount } from '../src/core/keys';
import { cormorantDescriptor, normalizeDescriptor } from '../src/core/descriptor';
import { decodeAddress, encodeAddress, outputScript, type ScriptType } from '../src/core/script';
import { fetchTransport, KnotsRpc } from '../src/core/rpc';
import {
  AddressIndex,
  broadcast,
  computeSnapshot,
  emptySyncStore,
  ensureCormorantWallet,
  ensureGap,
  estimateFees,
  findDroppedUnconfirmed,
  addPendingTransaction,
  importWalletDescriptors,
  listImportedDescriptors,
  readNodeStatus,
  syncHistory,
  type SyncStore,
  type WalletSnapshot,
} from '../src/core/sync';
import { isOptedIn } from '../src/core/replay';
import { buildTransaction, type Coin } from '../src/core/txbuilder';
import { signDraft } from '../src/core/signer';
import { signatureHashTypes } from '../src/core/sign';
import { parseTx } from '../src/core/tx';

const BIN = process.env.KNOTS_BIN;
const net = NETWORKS.regtest;
const PORT = 18543;
const RPC = { host: '127.0.0.1', port: PORT, user: 'regtest', password: 'regtest' };

const run = BIN ? describe : describe.skip;

run('Shrike mobile core against a BLAKE2b regtest node', () => {
  let datadir: string;
  let rpc: KnotsRpc;

  const cli = (...args: string[]): string =>
    execFileSync(join(BIN!, 'bitcoin-cli'), ['-regtest', `-datadir=${datadir}`, `-rpcport=${PORT}`, '-rpcuser=regtest', '-rpcpassword=regtest', ...args], { encoding: 'utf8' }).trim();
  const miner = (...args: string[]) => cli('-rpcwallet=miner', ...args);
  const mine = (n: number, addr?: string) => miner('generatetoaddress', String(n), addr ?? miner('getnewaddress'));

  beforeAll(async () => {
    datadir = mkdtempSync(join(tmpdir(), 'shrike-regtest-'));
    const p = spawn(join(BIN!, 'bitcoind'), [
      '-regtest',
      `-datadir=${datadir}`,
      `-rpcport=${PORT}`,
      '-port=18544',
      '-listen=0',
      '-blake2b_headline=BLAKE2b regtest',
      '-testactivationheight=blake2b@20',
      '-rpcuser=regtest',
      '-rpcpassword=regtest',
      '-fallbackfee=0.0001',
      '-txindex=0',
    ], { stdio: 'ignore', detached: true });
    p.unref();
    rpc = new KnotsRpc(RPC, fetchTransport());
    for (let i = 0; i < 60; i++) {
      try {
        await rpc.call('getblockchaininfo');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    cli('createwallet', 'miner');
  }, 60_000);

  afterAll(() => {
    try {
      cli('stop');
    } catch {
      // already stopped
    }
    setTimeout(() => rmSync(datadir, { recursive: true, force: true }), 3000);
  });

  it('declines the opt-in before activation and takes it after', async () => {
    mine(19);
    let status = await readNodeStatus(rpc, net);
    expect(status.blocks).toBe(19);
    expect(status.tip.isV2).toBe(false);
    expect(status.replayDecision).toBe('CHAIN_NOT_ACTIVATED');
    mine(1);
    status = await readNodeStatus(rpc, net);
    expect(status.tip.isV2).toBe(true);
    expect(status.tip.height).toBe(20);
    expect(status.nodeActivationHeight).toBe(20);
    expect(status.replayDecision).toBe('OPTED_IN');
    // Mature the miner's coinbases
    mine(110);
  });

  it('creates the cormorant wallet exactly as Shrike does', async () => {
    expect(await ensureCormorantWallet(rpc)).toBe('created');
    expect(await ensureCormorantWallet(rpc)).toBe('already');
    const info = JSON.parse(cli('-rpcwallet=cormorant', 'getwalletinfo'));
    expect(info.private_keys_enabled).toBe(false);
    expect(info.descriptors).toBe(true);
    expect(info.avoid_reuse).toBe(true);
  });

  const MNEMONIC = 'trouble stomach angle fiction fork tongue coconut enforce bridge pulse grit wild absorb cousin wolf toward vocal grape cable pride exist sad copper muscle';
  const PASSPHRASE = 'shrike passphrase';

  interface Fixture {
    type: ScriptType;
    acct: ReturnType<typeof deriveAccount>;
    key: AccountKey;
    index: AddressIndex;
    store: SyncStore;
    descs: { receive: string; change: string };
    snap?: WalletSnapshot;
  }
  const fixtures: Record<string, Fixture> = {};

  async function sync(f: Fixture): Promise<WalletSnapshot> {
    const status = await readNodeStatus(rpc, net);
    const ctx = { rpc, net, descriptors: f.descs, index: f.index, gapLimit: 20, tipHeight: status.blocks };
    await syncHistory(ctx, f.store);
    const dropped = await findDroppedUnconfirmed(ctx, f.store);
    const snap = computeSnapshot(f.store, f.index, net, status.blocks, dropped);
    ensureGap(f.index, snap.highestUsed, 20);
    f.snap = snap;
    return snap;
  }

  const TYPES: ScriptType[] = ['P2WPKH', 'P2TR', 'P2SH_P2WPKH', 'P2PKH'];

  it('imports each wallet in Cormorant form and finds it on the node', async () => {
    for (const type of TYPES) {
      const acct = deriveAccount(MNEMONIC, PASSPHRASE, type, net);
      const key = new AccountKey(acct.xpub, net);
      const src = { scriptType: type, ...acct };
      const descs = { receive: normalizeDescriptor(cormorantDescriptor(src, 0)), change: normalizeDescriptor(cormorantDescriptor(src, 1)) };
      await importWalletDescriptors(rpc, descs, 'now', 1000);
      fixtures[type] = { type, acct, key, index: new AddressIndex(key, type), store: emptySyncStore(), descs };
    }
    const imported = await listImportedDescriptors(rpc);
    for (const f of Object.values(fixtures)) {
      expect(imported.get(f.descs.receive)?.range).toBe(1000);
      expect(imported.has(f.descs.change)).toBe(true);
    }
  });

  it('sees payments to receive addresses, including one far along the chain', async () => {
    for (const f of Object.values(fixtures)) {
      const a0 = encodeAddress(outputScript(f.type, f.key.pubKey(0, 0)), net);
      const a5 = encodeAddress(outputScript(f.type, f.key.pubKey(0, 5)), net);
      const a450 = encodeAddress(outputScript(f.type, f.key.pubKey(0, 450)), net);
      miner('sendtoaddress', a0, '0.5');
      miner('sendtoaddress', a5, '0.25');
      miner('sendtoaddress', a450, '0.01');
    }
    // One unconfirmed first
    const f = fixtures.P2WPKH;
    let snap = await sync(f);
    expect(snap.balance.unconfirmed).toBe(76_000_000);
    mine(1);
    for (const fx of Object.values(fixtures)) {
      snap = await sync(fx);
      expect(snap.balance.confirmed).toBe(76_000_000);
      expect(snap.utxos.length).toBe(3);
      expect(snap.highestUsed[0]).toBe(450);
      expect(snap.txs.every((t) => t.confirmations === 1)).toBe(true);
    }
  });

  for (const type of TYPES) {
    it(`${type}: sends with the unified opt-in and the node accepts it`, async () => {
      const f = fixtures[type];
      const status = await readNodeStatus(rpc, net);
      expect(isOptedIn(status.replayDecision)).toBe(true);
      const snap = f.snap!;
      const dest = decodeAddress(miner('getnewaddress'), net);
      const available: Coin[] = snap.utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, script: u.script, chain: u.chain, index: u.index, height: u.height }));
      const draft = buildTransaction({
        scriptType: type,
        payments: [{ address: 'miner', scriptPubKey: dest.scriptPubKey, amount: 30_000_000 }],
        feeRate: 3,
        available,
        pubKeyFor: (c, i) => f.key.pubKey(c, i),
        changeIndex: snap.highestUsed[1] + 1,
        unified: true,
        tipHeight: status.blocks,
      });
      const signed = signDraft(draft, { mnemonic: MNEMONIC, passphrase: PASSPHRASE }, type, f.acct.derivation, f.acct.fingerprint, net);
      expect(signatureHashTypes(signed.tx, type).every((h) => h === 0x21)).toBe(true);
      const txid = await broadcast(rpc, signed.hex);
      expect(txid).toBe(signed.txid);
      // The node's own view of the size agrees with ours, so the fee rate is what was shown
      const entry = JSON.parse(cli('getmempoolentry', txid));
      expect(entry.vsize).toBe(signed.vsize);
      expect(Math.round(entry.fees.base * 1e8)).toBe(draft.fee);
      mine(1);
      const after = await sync(f);
      const sent = after.txs.find((t) => t.txid === txid)!;
      expect(sent.confirmations).toBe(1);
      expect(sent.net).toBe(-(30_000_000 + draft.fee));
      expect(sent.fee).toBe(draft.fee);
      expect(after.balance.confirmed).toBe(76_000_000 - 30_000_000 - draft.fee);
      if (draft.change) expect(after.highestUsed[1]).toBe(draft.change.index);
    });
  }

  it('a legacy signature is still valid after activation, just not replay protected', async () => {
    const f = fixtures.P2WPKH;
    const status = await readNodeStatus(rpc, net);
    const dest = decodeAddress(miner('getnewaddress'), net);
    const available = f.snap!.utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, script: u.script, chain: u.chain, index: u.index, height: u.height }));
    const draft = buildTransaction({
      scriptType: 'P2WPKH',
      payments: [{ address: 'miner', scriptPubKey: dest.scriptPubKey, amount: 1_000_000 }],
      feeRate: 2,
      available,
      pubKeyFor: (c, i) => f.key.pubKey(c, i),
      changeIndex: f.snap!.highestUsed[1] + 1,
      unified: false,
      tipHeight: status.blocks,
    });
    const signed = signDraft(draft, { mnemonic: MNEMONIC, passphrase: PASSPHRASE }, 'P2WPKH', f.acct.derivation, f.acct.fingerprint, net);
    expect(signatureHashTypes(signed.tx, 'P2WPKH').every((h) => h === 0x01)).toBe(true);
    await broadcast(rpc, signed.hex);
    mine(1);
    await sync(f);
  });

  it('a signature stamped 0x21 over the legacy message is refused', async () => {
    const f = fixtures.P2WPKH;
    const status = await readNodeStatus(rpc, net);
    const dest = decodeAddress(miner('getnewaddress'), net);
    const available = f.snap!.utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, script: u.script, chain: u.chain, index: u.index, height: u.height }));
    const draft = buildTransaction({
      scriptType: 'P2WPKH',
      payments: [{ address: 'miner', scriptPubKey: dest.scriptPubKey, amount: 1_000_000 }],
      feeRate: 2,
      available,
      pubKeyFor: (c, i) => f.key.pubKey(c, i),
      changeIndex: f.snap!.highestUsed[1] + 1,
      unified: false,
      tipHeight: status.blocks,
    });
    const signed = signDraft(draft, { mnemonic: MNEMONIC, passphrase: PASSPHRASE }, 'P2WPKH', f.acct.derivation, f.acct.fingerprint, net);
    const forged = parseTx(signed.hex);
    for (const i of forged.inputs) i.witness[0][i.witness[0].length - 1] = 0x21;
    const { txToHex } = await import('../src/core/tx');
    await expect(broadcast(rpc, txToHex(forged))).rejects.toThrow(/would not accept/);
  });

  it('bumps the fee of an unconfirmed send and the original drops away', async () => {
    const f = fixtures.P2TR;
    const status = await readNodeStatus(rpc, net);
    const dest = decodeAddress(miner('getnewaddress'), net);
    const available = f.snap!.utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, script: u.script, chain: u.chain, index: u.index, height: u.height }));
    const payment = { address: 'miner', scriptPubKey: dest.scriptPubKey, amount: 2_000_000 };
    const first = buildTransaction({ scriptType: 'P2TR', payments: [payment], feeRate: 1, available, pubKeyFor: (c, i) => f.key.pubKey(c, i), changeIndex: f.snap!.highestUsed[1] + 1, unified: true, tipHeight: status.blocks });
    const s1 = signDraft(first, { mnemonic: MNEMONIC, passphrase: PASSPHRASE }, 'P2TR', f.acct.derivation, f.acct.fingerprint, net);
    await broadcast(rpc, s1.hex);
    let snap = await sync(f);
    const pending = snap.txs.find((t) => t.txid === s1.txid)!;
    expect(pending.confirmations).toBe(0);
    expect(pending.replaceable).toBe(true);
    expect(pending.allInputsMine).toBe(true);

    const bump = buildTransaction({
      scriptType: 'P2TR',
      payments: [payment],
      feeRate: 6,
      available: available.filter((c) => !first.coins.some((k) => k.txid === c.txid && k.vout === c.vout)),
      pubKeyFor: (c, i) => f.key.pubKey(c, i),
      changeIndex: first.change!.index,
      unified: true,
      tipHeight: status.blocks,
      replacing: { mustSpend: first.coins, originalFee: first.fee, incrementalRate: status.incrementalFee },
    });
    expect(bump.fee).toBeGreaterThan(first.fee);
    const s2 = signDraft(bump, { mnemonic: MNEMONIC, passphrase: PASSPHRASE }, 'P2TR', f.acct.derivation, f.acct.fingerprint, net);
    await broadcast(rpc, s2.hex);
    snap = await sync(f);
    expect(snap.txs.some((t) => t.txid === s1.txid)).toBe(false);
    expect(snap.txs.find((t) => t.txid === s2.txid)?.confirmations).toBe(0);
    mine(1);
    snap = await sync(f);
    expect(snap.txs.find((t) => t.txid === s2.txid)?.confirmations).toBe(1);
  });

  it('a coin is never offered again once spent, even before the node reports the spend', async () => {
    const f = fixtures.P2WPKH;
    const status = await readNodeStatus(rpc, net);
    const dest = decodeAddress(miner('getnewaddress'), net);
    const available = f.snap!.utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, script: u.script, chain: u.chain, index: u.index, height: u.height }));
    const d = buildTransaction({ scriptType: 'P2WPKH', payments: [{ address: 'm', scriptPubKey: dest.scriptPubKey, amount: 500_000 }], feeRate: 2, available, pubKeyFor: (c, i) => f.key.pubKey(c, i), changeIndex: f.snap!.highestUsed[1] + 1, unified: true, tipHeight: status.blocks });
    const s = signDraft(d, { mnemonic: MNEMONIC, passphrase: PASSPHRASE }, 'P2WPKH', f.acct.derivation, f.acct.fingerprint, net);
    await broadcast(rpc, s.hex);
    addPendingTransaction(f.store, s.txid, s.hex);
    const snap = computeSnapshot(f.store, f.index, net, status.blocks);
    for (const c of d.coins) expect(snap.utxos.some((u) => u.txid === c.txid && u.vout === c.vout)).toBe(false);
    // And after a real sync the same holds
    const synced = await sync(f);
    for (const c of d.coins) expect(synced.utxos.some((u) => u.txid === c.txid && u.vout === c.vout)).toBe(false);
    mine(1);
    await sync(f);
  });

  it('a replaced transaction stays out of a cold start, and the replacement is the one that counts', async () => {
    const f = fixtures.P2TR;
    // The bump test above replaced s1 with s2; a snapshot rebuilt from the stored data alone must agree with a live one
    const live = await sync(f);
    const cold = computeSnapshot(JSON.parse(JSON.stringify(f.store)), f.index, net, live.tipHeight);
    expect(cold.balance).toEqual(live.balance);
    expect(cold.utxos.map((u) => `${u.txid}:${u.vout}`).sort()).toEqual(live.utxos.map((u) => `${u.txid}:${u.vout}`).sort());
  });

  it('a fresh store reads the same history in one pass, and fee estimates come back', async () => {
    const f = fixtures.P2SH_P2WPKH;
    const fresh: Fixture = { ...f, index: new AddressIndex(f.key, f.type), store: emptySyncStore() };
    const a = await sync(f);
    const b = await sync(fresh);
    expect(b.balance).toEqual(a.balance);
    expect(b.txs.map((t) => t.txid).sort()).toEqual(a.txs.map((t) => t.txid).sort());
    const fees = await estimateFees(rpc);
    expect(typeof fees).toBe('object');
  });
});
