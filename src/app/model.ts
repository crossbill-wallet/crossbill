// The app model: settings, wallets, the node connection and everything the screens read and do. Screens
// subscribe through useApp() and call methods here; nothing in the UI talks to the node or the vault directly.

import { App as CapApp } from '@capacitor/app';
import { DEFAULT_EXPLORER } from '../core/explorer';
import { cormorantDescriptor, normalizeDescriptor, originDescriptor } from '../core/descriptor';
import { AccountKey, deriveAccount, normalizeMnemonic } from '../core/keys';
import { LabelStore, type LabelRecord, type LabelType } from '../core/labels';
import { NETWORKS, type NetworkName, type NetworkParams } from '../core/network';
import { chainDecision, isOptedIn, type ReplayDecision } from '../core/replay';
import { KnotsRpc, RpcError, TransportError, type HttpTransport } from '../core/rpc';
import { decodeAddress, encodeAddress, outputScript, type ScriptType, SCRIPT_TYPES } from '../core/script';
import { signDraft, type SignedTransaction } from '../core/signer';
import {
  AddressIndex,
  broadcast,
  computeSnapshot,
  emptySyncStore,
  ensureCormorantWallet,
  ensureGap,
  estimateFees,
  findDroppedUnconfirmed,
  importWalletDescriptors,
  listImportedDescriptors,
  addPendingTransaction,
  readNodeStatus,
  scanStatus,
  syncHistory,
  DEFAULT_GAP_LIMIT,
  DEFAULT_IMPORT_RANGE,
  type NodeStatus,
  type SyncStore,
  type WalletSnapshot,
  type WalletTx,
  type WalletUtxo,
} from '../core/sync';
import { buildTransaction, BuildError, type Coin, type DraftTransaction, type Payment } from '../core/txbuilder';
import type { Unit } from '../core/units';
import { fromHex, toHex } from '../core/bytes';
import { isNative, ShrikeNative } from './native';
import { readJson, removeJson, writeJson } from './storage';

export interface NodeSettings {
  host: string;
  port: number;
  user: string;
  useTor: boolean;
  tls: boolean;
}

export interface Settings {
  network: NetworkName;
  node: NodeSettings | null;
  unit: Unit;
  lockOnOpen: boolean;
  groupByAddress: boolean;
  /** Block explorer address for transaction links, as in desktop Shrike's settings. null turns the links off. */
  explorer: string | null;
}

export interface WalletConfig {
  id: string;
  name: string;
  network: NetworkName;
  scriptType: ScriptType;
  fingerprint: string;
  derivation: string;
  xpub: string;
  gapLimit: number;
  createdAt: number;
  hasPassphrase: boolean;
}

export interface WalletRuntime {
  config: WalletConfig;
  key: AccountKey;
  index: AddressIndex;
  store: SyncStore;
  labels: LabelStore;
  snapshot: WalletSnapshot | null;
  descriptors: { receive: string; change: string };
  /** Descriptor range on the node, once known. */
  importedRange: number | null;
}

export type ConnPhase = 'idle' | 'tor' | 'connecting' | 'importing' | 'syncing' | 'ready' | 'error';

export interface ConnState {
  phase: ConnPhase;
  message?: string;
  progress?: number;
  lastSync?: number;
}

interface WalletFile {
  store: SyncStore;
  scripts: [string[], string[]];
  labels: LabelRecord[];
  importedRange: number | null;
}

const SETTINGS_FILE = 'settings.json';
const WALLETS_FILE = 'wallets.json';
const RPC_PASSWORD_KEY = 'rpc-password';
const seedKey = (id: string) => `seed:${id}`;

const DEFAULT_SETTINGS: Settings = { network: 'mainnet', node: null, unit: 'BTC', lockOnOpen: true, groupByAddress: true, explorer: DEFAULT_EXPLORER };

export interface RescanChoice {
  kind: 'new' | 'date' | 'full' | 'existing';
  /** unix seconds, for 'date' */
  since?: number;
}

export function friendlyError(e: unknown): string {
  if (e instanceof BuildError) return e.message;
  if (e instanceof TransportError) return `Couldn't reach your node. ${e.message}`;
  if (e instanceof RpcError) return `Your node said: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

function randomId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return toHex(b);
}

export class AppModel {
  settings: Settings = { ...DEFAULT_SETTINGS };
  wallets: WalletRuntime[] = [];
  activeId: string | null = null;
  node: NodeStatus | null = null;
  conn: ConnState = { phase: 'idle' };
  fees: Record<number, number> | null = null;
  ready = false;
  locked = false;

  private rpc: KnotsRpc | null = null;
  private listeners = new Set<() => void>();
  private busy: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private backgroundedAt: number | null = null;
  version = 0;

  get net(): NetworkParams {
    return NETWORKS[this.settings.network];
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------------------------------------- startup

  async init(): Promise<void> {
    const s = await readJson<Settings>(SETTINGS_FILE);
    if (s) this.settings = { ...DEFAULT_SETTINGS, ...s };
    const configs = (await readJson<WalletConfig[]>(WALLETS_FILE)) ?? [];
    for (const c of configs) {
      const file = await readJson<WalletFile>(`wallet-${c.id}.json`);
      this.wallets.push(this.runtimeFor(c, file));
    }
    this.activeId = this.wallets.find((w) => w.config.network === this.settings.network)?.config.id ?? null;
    for (const w of this.wallets) if (w.store.mine.length) this.recompute(w);
    this.locked = this.settings.lockOnOpen && this.wallets.length > 0 && isNative;
    this.ready = true;
    this.emit();
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        this.backgroundedAt = Date.now();
      } else {
        const away = this.backgroundedAt ? Date.now() - this.backgroundedAt : 0;
        this.backgroundedAt = null;
        if (this.settings.lockOnOpen && this.wallets.length > 0 && isNative && away > 60_000) {
          this.locked = true;
          this.emit();
        } else if (this.settings.node) {
          void this.refresh();
        }
      }
    }).catch(() => undefined);
    if (!this.locked && this.settings.node) void this.connect();
  }

  async unlock(): Promise<boolean> {
    const res = await ShrikeNative.authenticate({ reason: 'Open Shrike' });
    if (res.ok) {
      this.locked = false;
      this.emit();
      if (this.settings.node) void (this.rpc ? this.refresh() : this.connect());
    }
    return res.ok;
  }

  private runtimeFor(c: WalletConfig, file: WalletFile | null): WalletRuntime {
    const net = NETWORKS[c.network];
    const key = new AccountKey(c.xpub, net);
    const src = { scriptType: c.scriptType, xpub: c.xpub, fingerprint: c.fingerprint, derivation: c.derivation };
    return {
      config: c,
      key,
      index: new AddressIndex(key, c.scriptType, file?.scripts),
      store: file?.store ?? emptySyncStore(),
      labels: new LabelStore(file?.labels ?? []),
      snapshot: null,
      descriptors: { receive: normalizeDescriptor(cormorantDescriptor(src, 0)), change: normalizeDescriptor(cormorantDescriptor(src, 1)) },
      importedRange: file?.importedRange ?? null,
    };
  }

  private async saveWallet(w: WalletRuntime): Promise<void> {
    const file: WalletFile = { store: w.store, scripts: w.index.export(), labels: w.labels.all(), importedRange: w.importedRange };
    await writeJson(`wallet-${w.config.id}.json`, file);
  }

  private async saveWalletList(): Promise<void> {
    await writeJson(WALLETS_FILE, this.wallets.map((w) => w.config));
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await writeJson(SETTINGS_FILE, this.settings);
    this.emit();
  }

  // ------------------------------------------------------------------------------------------- node

  /**
   * Over Tor, a request that fails at the network level gets one retry after asking Tor to reload: iOS can close
   * Tor's listening socket while the app is suspended, and a reload reopens it.
   */
  private transport(node: NodeSettings): HttpTransport {
    return async (req) => {
      try {
        return await ShrikeNative.httpRequest({ ...req, useTor: node.useTor });
      } catch (e) {
        if (!node.useTor || !req.retryable) throw e;
        await ShrikeNative.torRecover().catch(() => undefined);
        await this.waitForTor(30_000);
        return ShrikeNative.httpRequest({ ...req, useTor: node.useTor });
      }
    };
  }

  private async waitForTor(limitMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < limitMs) {
      const s = await ShrikeNative.torStatus();
      if (s.state === 'ready') return;
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  private async startTor(): Promise<void> {
    this.conn = { phase: 'tor', message: 'Starting Tor', progress: 0 };
    this.emit();
    await ShrikeNative.torStart();
    const started = Date.now();
    for (;;) {
      const s = await ShrikeNative.torStatus();
      if (s.state === 'ready') return;
      if (s.state === 'error') throw new Error(`Tor could not start: ${s.error ?? 'unknown error'}`);
      this.conn = { phase: 'tor', message: s.summary ? `Tor: ${s.summary}` : 'Starting Tor', progress: s.progress };
      this.emit();
      if (Date.now() - started > 180_000) throw new Error('Tor took too long to connect. Check the phone has internet access.');
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  /** Checks a node before saving it. Starts Tor if the settings need it. */
  async testNode(node: NodeSettings, password: string, network: NetworkName): Promise<NodeStatus> {
    if (node.useTor) await this.startTor();
    this.conn = { phase: 'connecting', message: 'Contacting your node' };
    this.emit();
    try {
      const rpc = new KnotsRpc({ ...node, password }, this.transport(node));
      const status = await readNodeStatus(rpc, NETWORKS[network]);
      this.conn = { phase: 'idle' };
      this.emit();
      return status;
    } catch (e) {
      this.conn = { phase: 'error', message: friendlyError(e) };
      this.emit();
      throw e;
    }
  }

  async saveNode(node: NodeSettings, password: string, network: NetworkName): Promise<void> {
    await ShrikeNative.vaultSet({ key: RPC_PASSWORD_KEY, value: password, requireAuth: false });
    await this.updateSettings({ node, network });
    this.rpc = null;
    if (!this.wallets.some((w) => w.config.id === this.activeId && w.config.network === network)) {
      this.activeId = this.wallets.find((w) => w.config.network === network)?.config.id ?? null;
    }
    await this.connect();
  }

  private async getRpc(): Promise<KnotsRpc> {
    if (this.rpc) return this.rpc;
    const node = this.settings.node;
    if (!node) throw new Error('No node is set up');
    if (node.useTor) {
      const s = await ShrikeNative.torStatus();
      if (s.state !== 'ready') await this.startTor();
    }
    const { value } = await ShrikeNative.vaultGet({ key: RPC_PASSWORD_KEY, prompt: 'Read the node password' });
    this.rpc = new KnotsRpc({ ...node, password: value ?? '' }, this.transport(node));
    return this.rpc;
  }

  /**
   * One node conversation at a time. A request that arrives while one is running is run again once it ends,
   * rather than folded into it, so a refresh asked for after a broadcast always reads the state after it.
   */
  private exclusive(task: () => Promise<void>): Promise<void> {
    if (this.busy) {
      this.rerun = task;
      return this.busy.then(() => this.drain());
    }
    this.busy = task().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private rerun: (() => Promise<void>) | null = null;

  private drain(): Promise<void> {
    const next = this.rerun;
    if (!next) return Promise.resolve();
    this.rerun = null;
    return this.exclusive(next);
  }

  connect(): Promise<void> {
    return this.exclusive(async () => {
      try {
        const rpc = await this.getRpc();
        this.conn = { phase: 'connecting', message: 'Contacting your node' };
        this.emit();
        this.node = await readNodeStatus(rpc, this.net);
        await ensureCormorantWallet(rpc);
        await this.syncAll(rpc);
        this.startPolling();
      } catch (e) {
        this.rpc = null;
        this.node = null;
        this.conn = { phase: 'error', message: friendlyError(e) };
        this.emit();
      }
    });
  }

  refresh(): Promise<void> {
    if (!this.settings.node || this.locked) return Promise.resolve();
    if (!this.rpc) return this.connect();
    return this.exclusive(async () => {
      try {
        const rpc = await this.getRpc();
        this.node = await readNodeStatus(rpc, this.net);
        await this.syncAll(rpc);
      } catch (e) {
        // Nothing stale is left to build on: sending waits until the node answers again
        this.node = null;
        this.conn = { phase: 'error', message: friendlyError(e) };
        this.emit();
      }
    });
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (!this.backgroundedAt && !this.locked) void this.refresh();
    }, 60_000);
  }

  private async syncAll(rpc: KnotsRpc): Promise<void> {
    // A wallet that has synced before is only being checked for new blocks and payments
    const firstTime = this.networkWallets().some((w) => !w.snapshot);
    this.conn = { phase: 'syncing', message: firstTime ? 'Reading wallet history' : 'Checking for new activity' };
    this.emit();
    for (const w of this.wallets.filter((x) => x.config.network === this.settings.network)) {
      await this.syncWallet(rpc, w);
    }
    try {
      this.fees = await estimateFees(rpc);
    } catch {
      this.fees = null;
    }
    this.conn = { phase: 'ready', lastSync: Date.now() };
    this.emit();
  }

  private async syncWallet(rpc: KnotsRpc, w: WalletRuntime): Promise<void> {
    const tip = this.node?.blocks ?? 0;
    const ctx = { rpc, net: this.net, descriptors: w.descriptors, index: w.index, gapLimit: w.config.gapLimit, tipHeight: tip };
    await syncHistory(ctx, w.store);
    const dropped = await findDroppedUnconfirmed(ctx, w.store);
    w.snapshot = computeSnapshot(w.store, w.index, this.net, tip, dropped);
    ensureGap(w.index, w.snapshot.highestUsed, w.config.gapLimit);
    await this.saveWallet(w);
  }

  private recompute(w: WalletRuntime): void {
    const tip = this.node?.blocks ?? Math.max(0, ...Object.values(w.store.metas).map((m) => m.blockheight ?? 0));
    w.snapshot = computeSnapshot(w.store, w.index, NETWORKS[w.config.network], tip);
  }

  replayDecision(): ReplayDecision {
    if (!this.node) return chainDecision(this.net, { height: null, tipIsV2: null, nodeActivationHeight: null });
    return this.node.replayDecision;
  }

  // ------------------------------------------------------------------------------------------- wallets

  get active(): WalletRuntime | null {
    return this.wallets.find((w) => w.config.id === this.activeId) ?? null;
  }

  networkWallets(): WalletRuntime[] {
    return this.wallets.filter((w) => w.config.network === this.settings.network);
  }

  selectWallet(id: string): void {
    this.activeId = id;
    this.emit();
  }

  /**
   * Which script types of this seed the node already watches in the cormorant wallet, meaning the desktop
   * app already has the wallet and the phone can use it without a rescan.
   */
  async findOnNode(mnemonic: string, passphrase: string): Promise<ScriptType[]> {
    const rpc = await this.getRpc();
    await ensureCormorantWallet(rpc);
    const imported = await listImportedDescriptors(rpc);
    const found: ScriptType[] = [];
    for (const type of SCRIPT_TYPES) {
      const acct = deriveAccount(mnemonic, passphrase, type, this.net);
      const d = normalizeDescriptor(cormorantDescriptor({ scriptType: type, ...acct }, 0));
      if (imported.has(d)) found.push(type);
    }
    return found;
  }

  async addWallet(input: { name: string; mnemonic: string; passphrase: string; scriptType: ScriptType; rescan: RescanChoice }): Promise<void> {
    const mnemonic = normalizeMnemonic(input.mnemonic);
    const acct = deriveAccount(mnemonic, input.passphrase, input.scriptType, this.net);
    if (this.wallets.some((w) => w.config.xpub === acct.xpub)) throw new Error('This wallet is already on the phone');
    const config: WalletConfig = {
      id: randomId(),
      name: input.name.trim() || 'Wallet',
      network: this.settings.network,
      scriptType: input.scriptType,
      fingerprint: acct.fingerprint,
      derivation: acct.derivation,
      xpub: acct.xpub,
      gapLimit: DEFAULT_GAP_LIMIT,
      createdAt: Date.now(),
      hasPassphrase: input.passphrase.length > 0,
    };
    const w = this.runtimeFor(config, null);

    // The seed goes to the Keychain first, behind Face ID, before anything else is saved
    await ShrikeNative.vaultSet({ key: seedKey(config.id), value: JSON.stringify({ mnemonic, passphrase: input.passphrase }), requireAuth: true });

    const rpc = await this.getRpc();
    await ensureCormorantWallet(rpc);
    const imported = await listImportedDescriptors(rpc);
    const have = imported.get(w.descriptors.receive);
    if (have && imported.has(w.descriptors.change)) {
      w.importedRange = have.range;
    } else {
      const since = input.rescan.kind === 'new' ? ('now' as const) : input.rescan.kind === 'date' ? input.rescan.since! : 0;
      this.conn = { phase: 'importing', message: since === 'now' ? 'Adding the wallet to your node' : 'Your node is scanning for this wallet’s history', progress: 0 };
      this.emit();
      try {
        await importWalletDescriptors(rpc, w.descriptors, since, DEFAULT_IMPORT_RANGE, since === 'now' ? 120_000 : 30_000);
      } catch (e) {
        // A long rescan outlives the request; the node keeps going, so follow it until it finishes
        const stillScanning = e instanceof RpcError && /rescanning|currently scanning/i.test(e.message);
        if (!(e instanceof TransportError) && !stillScanning) throw e;
      }
      await this.waitForScan(rpc);
      w.importedRange = DEFAULT_IMPORT_RANGE;
    }

    this.wallets.push(w);
    this.activeId = config.id;
    await this.saveWalletList();
    await this.saveWallet(w);
    this.node = await readNodeStatus(rpc, this.net);
    await this.syncAll(rpc);
  }

  private async waitForScan(rpc: KnotsRpc): Promise<void> {
    for (;;) {
      let s;
      try {
        s = await scanStatus(rpc);
      } catch (e) {
        if (e instanceof TransportError) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        throw e;
      }
      if (!s.scanning) return;
      this.conn = { phase: 'importing', message: 'Your node is scanning for this wallet’s history', progress: Math.round(s.progress * 100) };
      this.emit();
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  async renameWallet(id: string, name: string): Promise<void> {
    const w = this.wallets.find((x) => x.config.id === id);
    if (!w) return;
    w.config.name = name.trim() || w.config.name;
    await this.saveWalletList();
    this.emit();
  }

  /** Removes the wallet from this phone only. The node and the desktop app are untouched. */
  async removeWallet(id: string): Promise<void> {
    await ShrikeNative.vaultDelete({ key: seedKey(id) });
    await removeJson(`wallet-${id}.json`);
    this.wallets = this.wallets.filter((w) => w.config.id !== id);
    if (this.activeId === id) this.activeId = this.networkWallets()[0]?.config.id ?? null;
    await this.saveWalletList();
    this.emit();
  }

  /** Reads the seed words, behind Face ID, for showing them again. */
  async revealSeed(id: string, prompt = 'Show the seed words'): Promise<{ mnemonic: string; passphrase: string } | null> {
    const res = await ShrikeNative.vaultGet({ key: seedKey(id), prompt });
    return res.value ? JSON.parse(res.value) : null;
  }

  outputDescriptor(w: WalletRuntime, chain: 0 | 1): string {
    return originDescriptor({ scriptType: w.config.scriptType, xpub: w.config.xpub, fingerprint: w.config.fingerprint, derivation: w.config.derivation }, chain);
  }

  // ------------------------------------------------------------------------------------------- addresses

  freshReceive(w: WalletRuntime): { address: string; index: number } {
    const index = (w.snapshot?.highestUsed[0] ?? -1) + 1;
    return { address: this.addressAt(w, 0, index), index };
  }

  addressAt(w: WalletRuntime, chain: 0 | 1, index: number): string {
    return encodeAddress(outputScript(w.config.scriptType, w.key.pubKey(chain, index)), NETWORKS[w.config.network]);
  }

  // ------------------------------------------------------------------------------------------- coins and sending

  coins(w: WalletRuntime): (WalletUtxo & { frozen: boolean; label?: string })[] {
    return (w.snapshot?.utxos ?? []).map((u) => ({ ...u, frozen: w.labels.isFrozen(u.txid, u.vout), label: w.labels.coinLabel(u.txid, u.vout, u.address) }));
  }

  spendable(w: WalletRuntime): Coin[] {
    return this.coins(w)
      .filter((u) => !u.frozen && !u.immature)
      .map(toCoin);
  }

  replayOptIn(): boolean {
    return isOptedIn(this.replayDecision());
  }

  minFeeRate(): number {
    return Math.max(this.node?.mempoolMinFee ?? 1, this.node?.minRelayFee ?? 1, 0.1);
  }

  /** Why sending is off right now, or null. */
  sendBlocker(): string | null {
    if (!this.node) return 'Connect to your node first';
    if (this.node.initialBlockDownload || this.node.headers > this.node.blocks + 1) {
      return `Your node is still catching up (block ${this.node.blocks.toLocaleString('en-US')} of ${this.node.headers.toLocaleString('en-US')}). Sending is off until it’s done, so replay protection and balances are right.`;
    }
    return null;
  }

  buildDraft(w: WalletRuntime, payments: Payment[], feeRate: number, selected: Coin[] | null): DraftTransaction {
    const blocker = this.sendBlocker();
    if (blocker || !this.node) throw new BuildError(blocker ?? 'Connect to your node first');
    if (feeRate < this.minFeeRate()) throw new BuildError(`The fee rate is below what your node will relay (${this.minFeeRate().toFixed(2)} sat/vB)`);
    return buildTransaction({
      scriptType: w.config.scriptType,
      payments,
      feeRate,
      available: this.spendable(w),
      selected,
      pubKeyFor: (c, i) => w.key.pubKey(c, i),
      changeIndex: (w.snapshot?.highestUsed[1] ?? -1) + 1,
      unified: this.replayOptIn(),
      tipHeight: this.node.blocks,
      groupByAddress: this.settings.groupByAddress,
    });
  }

  /** A replacement for an unconfirmed send at a higher fee rate. cancel sends everything back to this wallet instead. */
  buildReplacement(w: WalletRuntime, t: WalletTx, feeRate: number, cancel = false): DraftTransaction {
    const blocker = this.sendBlocker();
    if (blocker || !this.node) throw new BuildError(blocker ?? 'Connect to your node first');
    if (!t.replaceable || !t.allInputsMine || t.fee == null) throw new BuildError('This transaction cannot be replaced');
    if (t.outputs.some((o) => o.spentBy)) {
      throw new BuildError('A later transaction spends this one’s change. Replacing this would cancel that one too, so raise the fee on the later one instead.');
    }
    const mustSpend: Coin[] = t.inputs.map((i) => ({
      txid: i.txid,
      vout: i.vout,
      value: i.value!,
      script: w.index.script(i.mine!.chain, i.mine!.index),
      chain: i.mine!.chain,
      index: i.mine!.index,
      height: w.store.metas[i.txid]?.blockheight ?? null,
    }));
    // BIP125 rule 2: a replacement may only add confirmed inputs
    const available = this.spendable(w).filter((c) => c.txid !== t.txid && c.height != null);
    const changeOut = t.outputs.find((o) => o.mine?.chain === 1);
    let payments: Payment[];
    if (cancel) {
      const back = this.freshReceive(w);
      payments = [{ address: back.address, scriptPubKey: decodeAddress(back.address, this.net).scriptPubKey, amount: 0, sendMax: true, label: 'Cancelled' }];
    } else {
      payments = t.outputs
        .filter((o) => !(o.mine && o.mine.chain === 1))
        .map((o) => ({ address: o.address ?? '', scriptPubKey: fromHex(o.script), amount: o.value }));
      if (payments.length === 0) throw new BuildError('Nothing to pay in this transaction');
    }
    const originalRate = t.fee / t.vsize;
    if (feeRate <= originalRate) throw new BuildError(`The new fee rate has to be above ${originalRate.toFixed(2)} sat/vB`);
    return buildTransaction({
      scriptType: w.config.scriptType,
      payments,
      feeRate,
      available: cancel ? [] : available,
      pubKeyFor: (c, i) => w.key.pubKey(c, i),
      changeIndex: changeOut?.mine?.index ?? (w.snapshot?.highestUsed[1] ?? -1) + 1,
      unified: this.replayOptIn(),
      tipHeight: this.node.blocks,
      replacing: { mustSpend, originalFee: t.fee, incrementalRate: this.node.incrementalFee },
    });
  }

  /** Asks for Face ID, signs, broadcasts and labels. Returns the txid. */
  async signAndBroadcast(w: WalletRuntime, draft: DraftTransaction, label?: string, replaces?: string): Promise<SignedTransaction> {
    if (draft.unified !== this.replayOptIn()) throw new Error('Replay protection changed since this was built. Go back and review it again.');
    const rpc = await this.getRpc();
    // Every coin must still be unspent. A replacement's coins are spent by the transaction it replaces, so for
    // those only the confirmed UTXO set is asked; for a normal send the mempool counts too.
    const checks = await rpc.batch(draft.coins.map((c) => ({ method: 'gettxout', params: [c.txid, c.vout, !replaces] })));
    if (checks.some((r) => !r.ok || r.result == null)) {
      void this.refresh();
      throw new Error('One of these coins has already been spent. The wallet is refreshing; review the payment again.');
    }
    const { value } = await ShrikeNative.vaultGet({ key: seedKey(w.config.id), prompt: 'Sign and send this transaction' });
    if (!value) {
      throw new Error('The seed words for this wallet are no longer in the Keychain, which happens if the iPhone passcode was turned off. Remove the wallet and add it again with your seed words.');
    }
    const secret = JSON.parse(value) as { mnemonic: string; passphrase: string };
    const signed = signDraft(draft, secret, w.config.scriptType, w.config.derivation, w.config.fingerprint, NETWORKS[w.config.network]);
    await broadcast(rpc, signed.hex);
    // Spent at once in this wallet's view, before the node's wallet catches up
    addPendingTransaction(w.store, signed.txid, signed.hex, replaces);
    this.recompute(w);
    const txLabel = label ?? draft.outputs.map((o) => o.payment?.label).filter(Boolean).join(', ');
    if (txLabel) w.labels.set('tx', signed.txid, txLabel);
    await this.saveWallet(w);
    this.emit();
    void this.refresh();
    return signed;
  }

  // ------------------------------------------------------------------------------------------- labels

  async setLabel(w: WalletRuntime, type: LabelType, ref: string, label: string): Promise<void> {
    w.labels.set(type, ref, label);
    await this.saveWallet(w);
    this.emit();
  }

  async setFrozen(w: WalletRuntime, txid: string, vout: number, frozen: boolean): Promise<void> {
    w.labels.setFrozen(txid, vout, frozen);
    await this.saveWallet(w);
    this.emit();
  }

  exportLabels(w: WalletRuntime): string {
    return w.labels.exportJsonl(w.config.name);
  }

  async importLabels(w: WalletRuntime, text: string): Promise<number> {
    const n = w.labels.importJsonl(text);
    await this.saveWallet(w);
    this.emit();
    return n;
  }

  txLabel(w: WalletRuntime, t: WalletTx): string | undefined {
    const own = w.labels.get('tx', t.txid);
    if (own) return own;
    for (const o of t.outputs) {
      if (o.mine && o.address) {
        const l = w.labels.get('output', `${t.txid}:${o.vout}`) ?? w.labels.get('addr', o.address);
        if (l) return l;
      }
    }
    return undefined;
  }
}

export function toCoin(u: WalletUtxo): Coin {
  return { txid: u.txid, vout: u.vout, value: u.value, script: u.script, chain: u.chain, index: u.index, height: u.height };
}

export const app = new AppModel();
