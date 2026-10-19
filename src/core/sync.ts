// Wallet sync against a Bitcoin Knots node, compatible with Shrike's Cormorant backend.
//
// Cormorant keeps one watch-only descriptor wallet on the node, named "cormorant", and imports every Shrike
// wallet's receive and change descriptors into it without key origin. Using the same wallet and the same
// descriptor strings means a wallet the desktop app already scanned is found on the node as it is: no
// import, no rescan, and the desktop keeps working alongside the phone.
//
// History is read with listsinceblock filtered by parent_descs, transactions are fetched once and cached by
// txid, and balances and coins are worked out here from the transactions themselves, as Sparrow does.

import { fromHex, toHex } from './bytes';
import { normalizeDescriptor } from './descriptor';
import { AccountKey } from './keys';
import { networkFromRpcChain, type NetworkName, type NetworkParams } from './network';
import { chainDecision, parseHeader, type HeaderSummary, type ReplayDecision } from './replay';
import { KnotsRpc, RpcError, RPC_CODES } from './rpc';
import { decodeAddress, outputScript, tryEncodeAddress, type ScriptType } from './script';
import { isCoinbase, parseTx, txid as computeTxid, vsize, type Tx } from './tx';

export const CORMORANT_WALLET = 'cormorant';
/** Cormorant's default descriptor range (DEFAULT_GAP_LIMIT in BitcoindClient). */
export const DEFAULT_IMPORT_RANGE = 1000;
export const DEFAULT_GAP_LIMIT = 20;

/** BTC per 1000 vB to sat/vB. */
const BTC_KVB_TO_SAT_VB = 100_000;

export interface NodeStatus {
  version: number;
  subversion: string;
  network: NetworkName;
  blocks: number;
  headers: number;
  bestBlockHash: string;
  initialBlockDownload: boolean;
  verificationProgress: number;
  pruned: boolean;
  tip: HeaderSummary;
  nodeActivationHeight: number | null;
  /** sat/vB */
  mempoolMinFee: number;
  minRelayFee: number;
  incrementalFee: number;
  replayDecision: ReplayDecision;
}

interface NetworkInfo {
  version: number;
  subversion: string;
}
interface BlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  initialblockdownload: boolean;
  verificationprogress: number;
  pruned: boolean;
}
interface MempoolInfo {
  mempoolminfee: number;
  minrelaytxfee: number;
  incrementalrelayfee?: number;
}

/** The activation height a node reports, read the way Shrike's DeploymentInfo reads it. */
export function readActivationHeight(info: unknown): number | null {
  if (!info || typeof info !== 'object') return null;
  const top = (info as { blake2b?: { height?: unknown } }).blake2b;
  if (top && typeof top.height === 'number') return top.height;
  const dep = (info as { deployments?: { blake2b?: { height?: unknown } } }).deployments?.blake2b;
  if (dep && typeof dep.height === 'number') return dep.height;
  return null;
}

export async function readNodeStatus(rpc: KnotsRpc, net: NetworkParams): Promise<NodeStatus> {
  const [ni, bi, di, mi] = await rpc.batch([
    { method: 'getnetworkinfo' },
    { method: 'getblockchaininfo' },
    { method: 'getdeploymentinfo' },
    { method: 'getmempoolinfo' },
  ]);
  if (!ni.ok) throw ni.error;
  if (!bi.ok) throw bi.error;
  if (!mi.ok) throw mi.error;
  const netInfo = ni.result as NetworkInfo;
  const chain = bi.result as BlockchainInfo;
  const mempool = mi.result as MempoolInfo;
  if (netInfo.version < 240000) throw new Error('Bitcoin Knots versions older than v24 are not supported');
  const network = networkFromRpcChain(chain.chain);
  if (network !== net.name) throw new Error(`The node is on ${chain.chain}, but this wallet is for ${net.name}`);
  const nodeActivationHeight = di.ok ? readActivationHeight(di.result) : null;
  const rawHeader = await rpc.call<string>('getblockheader', [chain.bestblockhash, false]);
  const tip = parseHeader(rawHeader);
  const replayDecision = chainDecision(net, { height: chain.blocks, tipIsV2: tip.isV2, nodeActivationHeight });
  return {
    version: netInfo.version,
    subversion: netInfo.subversion,
    network,
    blocks: chain.blocks,
    headers: chain.headers,
    bestBlockHash: chain.bestblockhash,
    initialBlockDownload: chain.initialblockdownload,
    verificationProgress: chain.verificationprogress,
    pruned: chain.pruned,
    tip,
    nodeActivationHeight,
    mempoolMinFee: mempool.mempoolminfee * BTC_KVB_TO_SAT_VB,
    minRelayFee: mempool.minrelaytxfee * BTC_KVB_TO_SAT_VB,
    incrementalFee: (mempool.incrementalrelayfee ?? 0.00001) * BTC_KVB_TO_SAT_VB,
    replayDecision,
  };
}

/** Loads the cormorant wallet, creating it exactly as Cormorant does if the node has none. */
export async function ensureCormorantWallet(rpc: KnotsRpc): Promise<'loaded' | 'created' | 'already'> {
  let loaded: string[];
  try {
    loaded = await rpc.call<string[]>('listwallets');
  } catch (e) {
    if (e instanceof RpcError && e.code === RPC_CODES.METHOD_NOT_FOUND) throw new Error('Wallet support must be enabled in Bitcoin Knots');
    throw e;
  }
  if (loaded.includes(CORMORANT_WALLET)) return 'already';
  try {
    await rpc.call('loadwallet', [CORMORANT_WALLET, true]);
    return 'loaded';
  } catch (e) {
    if (e instanceof RpcError && e.code === RPC_CODES.WALLET_NOT_FOUND) {
      // name, disable_private_keys, blank, passphrase, avoid_reuse, descriptors, load_on_startup, external_signer
      await rpc.call('createwallet', [CORMORANT_WALLET, true, true, '', true, true, true, false]);
      return 'created';
    }
    if (e instanceof RpcError && (e.code === RPC_CODES.WALLET_ALREADY_LOADED || /already loading|already loaded/i.test(e.message))) return 'already';
    throw e;
  }
}

export interface ImportedDescriptor {
  desc: string;
  /** Upper end of the range, or null for an unranged descriptor. */
  range: number | null;
  timestamp: number | null;
}

export async function listImportedDescriptors(rpc: KnotsRpc): Promise<Map<string, ImportedDescriptor>> {
  const res = await rpc.call<{ descriptors: { desc: string; timestamp?: number; range?: number[] }[] }>('listdescriptors', [false], { wallet: CORMORANT_WALLET });
  const out = new Map<string, ImportedDescriptor>();
  for (const d of res.descriptors) {
    const desc = normalizeDescriptor(d.desc);
    out.set(desc, { desc, range: d.range ? d.range[d.range.length - 1] : null, timestamp: d.timestamp ?? null });
  }
  return out;
}

export interface WalletDescriptors {
  /** Normalized, Cormorant form. */
  receive: string;
  change: string;
}

/**
 * Imports the wallet's descriptors in Cormorant's form. `rescanSince` is a unix time, or 'now' for a brand
 * new wallet with no history. A rescan runs on the node and continues even if this request times out; poll
 * scanStatus to follow it.
 */
export async function importWalletDescriptors(rpc: KnotsRpc, d: WalletDescriptors, rescanSince: number | 'now', range: number, timeoutMs = 120_000): Promise<void> {
  const requests = [
    { desc: d.receive, active: true, range, timestamp: rescanSince, internal: false },
    { desc: d.change, active: false, range, timestamp: rescanSince, internal: true },
  ];
  const results = await rpc.call<{ success: boolean; error?: { message: string } }[]>('importdescriptors', [requests], { wallet: CORMORANT_WALLET, timeoutMs });
  const failed = results.filter((r) => !r.success);
  if (failed.length) throw new Error(`The node could not import the wallet: ${failed.map((f) => f.error?.message ?? 'unknown error').join('; ')}`);
}

export async function scanStatus(rpc: KnotsRpc): Promise<{ scanning: false } | { scanning: true; progress: number; duration: number }> {
  const info = await rpc.call<{ scanning: false | { progress: number; duration: number } }>('getwalletinfo', [], { wallet: CORMORANT_WALLET });
  return info.scanning ? { scanning: true, progress: info.scanning.progress, duration: info.scanning.duration } : { scanning: false };
}

/** Cormorant's range rule: highest used index plus the gap limit, rounded up to the next 500, never under 1000. */
export function wantedRange(highestUsed: number, gapLimit: number): number {
  const maxIndex = highestUsed + gapLimit;
  const rounded = maxIndex % 500 === 0 ? maxIndex : (Math.floor(maxIndex / 500) + 1) * 500;
  return Math.max(rounded, DEFAULT_IMPORT_RANGE);
}

// ---------------------------------------------------------------------------------------------------------
// Address index: scriptPubKey to (chain, index), derived lazily from the account xpub and kept across syncs.

export interface AddrRef {
  chain: 0 | 1;
  index: number;
}

export class AddressIndex {
  private readonly scripts: [string[], string[]] = [[], []];
  private readonly lookup = new Map<string, AddrRef>();

  constructor(
    private readonly key: AccountKey,
    private readonly type: ScriptType,
    saved?: [string[], string[]],
  ) {
    if (saved) {
      for (const chain of [0, 1] as const) {
        saved[chain].forEach((s, i) => {
          this.scripts[chain].push(s);
          this.lookup.set(s, { chain, index: i });
        });
      }
    }
  }

  derivedCount(chain: 0 | 1): number {
    return this.scripts[chain].length;
  }

  /** Derives up to and including `index`. */
  ensure(chain: 0 | 1, index: number): void {
    for (let i = this.scripts[chain].length; i <= index; i++) {
      const s = toHex(outputScript(this.type, this.key.pubKey(chain, i)));
      this.scripts[chain].push(s);
      this.lookup.set(s, { chain, index: i });
    }
  }

  find(scriptHex: string): AddrRef | undefined {
    return this.lookup.get(scriptHex);
  }

  script(chain: 0 | 1, index: number): string {
    this.ensure(chain, index);
    return this.scripts[chain][index];
  }

  export(): [string[], string[]] {
    return [this.scripts[0].slice(), this.scripts[1].slice()];
  }
}

// ---------------------------------------------------------------------------------------------------------
// History

export interface TxMeta {
  txid: string;
  confirmations: number;
  blockheight: number | null;
  blocktime: number | null;
  time: number;
  replaceable: boolean;
  abandoned: boolean;
  /** Set by the node's wallet when another transaction replaced this one. */
  replacedBy?: string | null;
}

interface ListSinceBlockEntry {
  txid: string;
  address?: string;
  category: string;
  vout?: number;
  confirmations: number;
  blockheight?: number;
  blocktime?: number;
  time: number;
  parent_descs?: string[];
  'bip125-replaceable'?: string;
  abandoned?: boolean;
  replaced_by_txid?: string;
}

interface ListSinceBlock {
  transactions: ListSinceBlockEntry[];
  removed?: ListSinceBlockEntry[];
  lastblock: string;
}

export interface SyncStore {
  lastBlock: string | null;
  metas: Record<string, TxMeta>;
  /** Raw transactions by txid. Immutable, so cached for good. */
  hex: Record<string, string>;
  /** txids in this wallet's history. */
  mine: string[];
  /** Unconfirmed transactions the node no longer holds, from the last sync. Kept so a cold start agrees. */
  dropped?: string[];
}

export function emptySyncStore(): SyncStore {
  return { lastBlock: null, metas: {}, hex: {}, mine: [], dropped: [] };
}

/**
 * Records a transaction this wallet just broadcast, before the node's wallet reports it, so its inputs read as
 * spent at once. A replacement also marks the transaction it replaces as dropped.
 */
export function addPendingTransaction(store: SyncStore, txid: string, hex: string, replaces?: string): void {
  store.hex[txid] = hex;
  store.metas[txid] = { txid, confirmations: 0, blockheight: null, blocktime: null, time: Math.floor(Date.now() / 1000), replaceable: true, abandoned: false };
  if (!store.mine.includes(txid)) store.mine.push(txid);
  if (replaces) store.dropped = [...new Set([...(store.dropped ?? []), replaces])];
}

export interface WalletTxInput {
  txid: string;
  vout: number;
  value: number | null;
  mine: AddrRef | null;
  address: string | null;
}

export interface WalletTxOutput {
  vout: number;
  value: number;
  script: string;
  address: string | null;
  mine: AddrRef | null;
  spentBy: string | null;
}

export interface WalletTx {
  txid: string;
  height: number | null;
  confirmations: number;
  time: number;
  /** Change in this wallet's balance, in sats. */
  net: number;
  fee: number | null;
  vsize: number;
  inputs: WalletTxInput[];
  outputs: WalletTxOutput[];
  coinbase: boolean;
  /** Signals BIP125 and is unconfirmed. */
  replaceable: boolean;
  /** Every input belongs to this wallet, so the fee is known and this wallet can replace it. */
  allInputsMine: boolean;
  tx: Tx;
}

export interface WalletUtxo {
  txid: string;
  vout: number;
  value: number;
  script: string;
  address: string;
  chain: 0 | 1;
  index: number;
  height: number | null;
  confirmations: number;
  coinbase: boolean;
  /** Coinbase still short of the network's maturity depth. */
  immature: boolean;
}

export interface WalletSnapshot {
  tipHeight: number;
  txs: WalletTx[];
  utxos: WalletUtxo[];
  highestUsed: [number, number];
  balance: { confirmed: number; unconfirmed: number; immature: number };
}

export interface SyncContext {
  rpc: KnotsRpc;
  net: NetworkParams;
  descriptors: WalletDescriptors;
  index: AddressIndex;
  gapLimit: number;
  tipHeight: number;
  /** Highest index derivation will go to while looking for this wallet's addresses. */
  maxDerive?: number;
}

function isWalletEntry(e: ListSinceBlockEntry, mine: Set<string>): boolean {
  return !!e.parent_descs?.some((d) => mine.has(normalizeDescriptor(d)));
}

function metaFrom(e: ListSinceBlockEntry): TxMeta {
  return {
    txid: e.txid,
    confirmations: e.confirmations,
    blockheight: e.blockheight ?? null,
    blocktime: e.blocktime ?? null,
    time: e.time,
    replaceable: e['bip125-replaceable'] === 'yes',
    abandoned: !!e.abandoned,
    replacedBy: e.replaced_by_txid ?? null,
  };
}

async function fetchHex(ctx: SyncContext, store: SyncStore, txids: string[]): Promise<void> {
  const missing = [...new Set(txids)].filter((t) => !store.hex[t]);
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const res = await ctx.rpc.batch<{ hex: string }>(chunk.map((t) => ({ method: 'gettransaction', params: [t, true, false] })), { wallet: CORMORANT_WALLET });
    res.forEach((r, j) => {
      if (!r.ok) throw r.error;
      const hex = r.result.hex;
      if (computeTxid(parseTx(hex)) !== chunk[j]) throw new Error(`The node returned a transaction that does not match ${chunk[j]}`);
      store.hex[chunk[j]] = hex;
    });
  }
}

/**
 * Brings the store up to date with the node. A full read the first time (or after a reorg the incremental
 * read cannot follow), then only what changed since the last block seen.
 */
export async function syncHistory(ctx: SyncContext, store: SyncStore): Promise<void> {
  const mineDescs = new Set([ctx.descriptors.receive, ctx.descriptors.change]);
  let lsb: ListSinceBlock;
  try {
    lsb = await ctx.rpc.call<ListSinceBlock>('listsinceblock', [store.lastBlock, 1, true, true, true], { wallet: CORMORANT_WALLET, timeoutMs: 180_000 });
  } catch (e) {
    if (store.lastBlock && e instanceof RpcError && e.code === RPC_CODES.INVALID_ADDRESS_OR_KEY) {
      store.lastBlock = null;
      lsb = await ctx.rpc.call<ListSinceBlock>('listsinceblock', [null, 1, true, true, true], { wallet: CORMORANT_WALLET, timeoutMs: 180_000 });
    } else {
      throw e;
    }
  }

  // Reorged out: forget the metadata, keep nothing that claimed a block that is gone
  for (const r of lsb.removed ?? []) {
    const m = store.metas[r.txid];
    if (m && r.confirmations < 0) delete store.metas[r.txid];
  }

  const mine = new Set(store.mine);
  const receiveTxids: string[] = [];
  const sendTxids: string[] = [];
  for (const e of lsb.transactions) {
    if (e.category === 'send') {
      sendTxids.push(e.txid);
    } else if (isWalletEntry(e, mineDescs)) {
      receiveTxids.push(e.txid);
      mine.add(e.txid);
    }
    // Every entry refreshes the metadata of a transaction already known to be this wallet's
    store.metas[e.txid] = metaFrom(e);
  }

  // Index every address the node says is this wallet's. parent_descs names the descriptor, and so the chain;
  // derivation continues along that chain until the address turns up.
  const maxDerive = ctx.maxDerive ?? 20_000;
  for (const e of lsb.transactions) {
    if (!e.address || !isWalletEntry(e, mineDescs)) continue;
    const chain: 0 | 1 = e.parent_descs!.some((d) => normalizeDescriptor(d) === ctx.descriptors.change) ? 1 : 0;
    let script: string;
    try {
      script = toHex(decodeAddress(e.address, ctx.net).scriptPubKey);
    } catch {
      continue;
    }
    while (!ctx.index.find(script) && ctx.index.derivedCount(chain) < maxDerive) {
      ctx.index.ensure(chain, ctx.index.derivedCount(chain) + 199);
    }
  }

  // Receives first: they define which outputs are this wallet's, which is what decides whether a send is
  await fetchHex(ctx, store, receiveTxids);

  // Sends: this wallet's when they spend one of its outputs
  const ownedOutpoints = new Set<string>();
  for (const t of mine) {
    const hex = store.hex[t];
    if (!hex) continue;
    parseTx(hex).outputs.forEach((o, vout) => {
      if (ctx.index.find(toHex(o.script))) ownedOutpoints.add(`${t}:${vout}`);
    });
  }
  const candidates = [...new Set(sendTxids)].filter((t) => !mine.has(t));
  await fetchHex(ctx, store, candidates);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of candidates) {
      if (mine.has(t)) continue;
      const tx = parseTx(store.hex[t]);
      if (tx.inputs.some((i) => ownedOutpoints.has(`${i.prevout.txid}:${i.prevout.vout}`))) {
        mine.add(t);
        tx.outputs.forEach((o, vout) => {
          if (ctx.index.find(toHex(o.script))) ownedOutpoints.add(`${t}:${vout}`);
        });
        changed = true;
      }
    }
  }
  // Drop cached bodies of transactions that turned out not to be this wallet's
  for (const t of candidates) if (!mine.has(t)) delete store.hex[t];
  for (const t of Object.keys(store.metas)) if (!mine.has(t)) delete store.metas[t];

  store.mine = [...mine];
  store.lastBlock = lsb.lastblock;
}

/** Unconfirmed transactions the node no longer holds in its mempool (replaced or evicted). */
export async function findDroppedUnconfirmed(ctx: SyncContext, store: SyncStore): Promise<Set<string>> {
  const pending = store.mine.filter((t) => (store.metas[t]?.confirmations ?? 0) === 0);
  const dropped = new Set<string>();
  if (pending.length === 0) return dropped;
  const res = await ctx.rpc.batch(pending.map((t) => ({ method: 'getmempoolentry', params: [t] })));
  res.forEach((r, i) => {
    if (!r.ok && r.error.code === RPC_CODES.INVALID_ADDRESS_OR_KEY) dropped.add(pending[i]);
  });
  store.dropped = [...dropped];
  return dropped;
}

/** Works out transactions, coins and balances from the store. Pure: no node access. */
export function computeSnapshot(store: SyncStore, index: AddressIndex, net: NetworkParams, tipHeight: number, dropped: Set<string> = new Set(store.dropped ?? [])): WalletSnapshot {
  const txs = new Map<string, Tx>();
  for (const t of store.mine) {
    const meta = store.metas[t];
    const hex = store.hex[t];
    if (!meta || !hex) continue;
    if (meta.confirmations < 0 || meta.abandoned) continue;
    if (meta.confirmations === 0 && (dropped.has(t) || meta.replacedBy)) continue;
    txs.set(t, parseTx(hex));
  }

  // Outputs this wallet received, and what spends them
  const spentBy = new Map<string, string>();
  for (const [t, tx] of txs) for (const i of tx.inputs) spentBy.set(`${i.prevout.txid}:${i.prevout.vout}`, t);

  const confirmationsOf = (t: string): number => {
    const m = store.metas[t];
    if (!m || m.blockheight == null) return 0;
    return Math.max(0, tipHeight - m.blockheight + 1);
  };

  const highestUsed: [number, number] = [-1, -1];
  const walletTxs: WalletTx[] = [];
  const utxos: WalletUtxo[] = [];
  for (const [t, tx] of txs) {
    const meta = store.metas[t];
    const coinbase = isCoinbase(tx);
    const confirmations = confirmationsOf(t);
    const outputs: WalletTxOutput[] = tx.outputs.map((o, vout) => {
      const script = toHex(o.script);
      const ref = index.find(script) ?? null;
      if (ref) highestUsed[ref.chain] = Math.max(highestUsed[ref.chain], ref.index);
      return { vout, value: o.value, script, address: tryEncodeAddress(o.script, net), mine: ref, spentBy: spentBy.get(`${t}:${vout}`) ?? null };
    });
    const inputs: WalletTxInput[] = tx.inputs.map((i) => {
      const prev = txs.get(i.prevout.txid);
      const prevOut = prev?.outputs[i.prevout.vout];
      const ref = prevOut ? (index.find(toHex(prevOut.script)) ?? null) : null;
      return {
        txid: i.prevout.txid,
        vout: i.prevout.vout,
        value: prevOut ? prevOut.value : null,
        mine: ref,
        address: prevOut ? tryEncodeAddress(prevOut.script, net) : null,
      };
    });
    const received = outputs.filter((o) => o.mine).reduce((s, o) => s + o.value, 0);
    const spent = inputs.filter((i) => i.mine).reduce((s, i) => s + (i.value ?? 0), 0);
    const allInputsMine = !coinbase && inputs.every((i) => i.mine);
    const inputTotal = inputs.every((i) => i.value != null) ? inputs.reduce((s, i) => s + (i.value as number), 0) : null;
    const fee = coinbase ? 0 : inputTotal != null ? inputTotal - tx.outputs.reduce((s, o) => s + o.value, 0) : null;
    const size = vsize(tx);
    walletTxs.push({
      txid: t,
      height: meta.blockheight,
      confirmations,
      time: meta.blocktime ?? meta.time,
      net: received - spent,
      fee,
      vsize: size,
      inputs,
      outputs,
      coinbase,
      replaceable: confirmations === 0 && tx.inputs.some((i) => i.sequence < 0xfffffffe),
      allInputsMine,
      tx,
    });
    for (const o of outputs) {
      if (!o.mine || o.spentBy) continue;
      const immature = coinbase && confirmations < net.coinbaseMaturity;
      utxos.push({
        txid: t,
        vout: o.vout,
        value: o.value,
        script: o.script,
        address: o.address ?? '',
        chain: o.mine.chain,
        index: o.mine.index,
        height: meta.blockheight,
        confirmations,
        coinbase,
        immature,
      });
    }
  }
  walletTxs.sort((a, b) => {
    if (a.height == null && b.height == null) return b.time - a.time;
    if (a.height == null) return -1;
    if (b.height == null) return 1;
    return b.height - a.height || b.time - a.time;
  });
  const balance = { confirmed: 0, unconfirmed: 0, immature: 0 };
  for (const u of utxos) {
    if (u.immature) balance.immature += u.value;
    else if (u.height == null) balance.unconfirmed += u.value;
    else balance.confirmed += u.value;
  }
  return { tipHeight, txs: walletTxs, utxos, highestUsed, balance };
}

// ---------------------------------------------------------------------------------------------------------
// Fees and broadcast

/** Sparrow's target block range for its fee slider. */
export const FEE_TARGETS = [1, 2, 3, 4, 5, 10, 25, 50];

export async function estimateFees(rpc: KnotsRpc): Promise<Record<number, number>> {
  const res = await rpc.batch<{ feerate?: number }>(FEE_TARGETS.map((t) => ({ method: 'estimatesmartfee', params: [t] })));
  const out: Record<number, number> = {};
  res.forEach((r, i) => {
    if (r.ok && typeof r.result.feerate === 'number') out[FEE_TARGETS[i]] = r.result.feerate * 100_000;
  });
  return out;
}

export async function broadcast(rpc: KnotsRpc, hex: string): Promise<string> {
  const test = await rpc.call<{ txid: string; allowed: boolean; 'reject-reason'?: string }[]>('testmempoolaccept', [[hex]]);
  if (!test[0]?.allowed) throw new Error(`The node would not accept this transaction: ${test[0]?.['reject-reason'] ?? 'unknown reason'}`);
  return rpc.call<string>('sendrawtransaction', [hex]);
}

/** Keeps a gap of unused addresses derived past the highest used one on each chain. */
export function ensureGap(index: AddressIndex, highestUsed: [number, number], gapLimit: number): void {
  index.ensure(0, highestUsed[0] + gapLimit);
  index.ensure(1, highestUsed[1] + gapLimit);
}

export { fromHex };
