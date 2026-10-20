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
import { candlesUrl, parseCandles, parseTicker, tickerUrl, CHART_RANGES, PriceError, PRICE_MAX_AGE_MS, type Candle, type CandleInterval, type Ticker } from '../core/price';
import {
  decodeSecret,
  hashRecoveryCode,
  lockoutSeconds,
  looksLikeRecoveryCode,
  matchRecoveryCode,
  newRecoveryCodes,
  verifyTotp,
  cleanCode,
} from '../core/totp';
import { skinIndex, tierFor, SKINS, type Appearance, type FontId, type SkinId } from './look';
import { errorKind, isNative, ShrikeNative, type TorHealth } from './native';
import { readJson, removeJson, writeJson } from './storage';
import {
  buildWidgetSnapshot,
  CHART_FAMILIES,
  PRICE_WIDGET,
  WIDGET_CHART_MAX_AGE_MS,
  type WidgetInput,
  type WidgetSnapshot,
} from './widgets';

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
  appearance: Appearance;
  skin: SkinId;
  font: FontId;
  /** The most skins past the first a confirmed mainnet balance has opened. Never goes down. */
  skinTier: number;
  /** Whether the app asks Neoxa Exchange for the XBT price at all, and whether it asks through Tor. */
  prices: boolean;
  pricesOverTor: boolean;
  /** What the balance on the Wallet tab shows: coins, or their worth in US dollars. Tapping it switches. */
  balanceView: 'coin' | 'usd';
  /** A code from an authenticator app is needed to send and to show seed words. The key is in the Keychain. */
  twoFactor: boolean;
  /** Set once two-factor setup has been offered, so it's offered once and not again. */
  twoFactorOffered: boolean;
  /** Whether the Balance widget shows the balance. Off, it says the balance is hidden. */
  widgetBalance: boolean;
  /** The wallet the Balance widget shows. null means the first one on this network, the one the app opens to. */
  widgetWallet: string | null;
}

/** The iPhone widgets as the app sees them, for the Widgets screen in Settings. */
export interface WidgetState {
  /** ok: they get what the app hands them. no-app-group: this build can't share with them. web: not an iPhone */
  status: 'unknown' | 'ok' | 'no-app-group' | 'web';
  /** The Shrike widgets on the Home Screen and Lock Screen */
  installed: { kind: string; family: string }[];
  /** unix ms the app last handed the widgets something new */
  sentAt: number;
}

/** Tabs a widget can open the app on. */
export type LinkTab = 'home' | 'market';

export interface Contact {
  id: string;
  name: string;
  address: string;
  network: NetworkName;
  note?: string;
  createdAt: number;
  lastUsed?: number;
}

export type PriceStepId = 'tor' | 'route' | 'ask';
export type PriceStepStatus = 'pending' | 'active' | 'done' | 'failed';

/** One step of getting the price, shown on the Market tab while reconnecting. */
export interface PriceStep {
  id: PriceStepId;
  label: string;
  status: PriceStepStatus;
  /** A few words on how it went, under the label */
  note?: string;
}

/** Why the price couldn't be loaded, in words for the Market tab. */
export interface PriceProblem {
  kind: 'tor-stuck' | 'route' | 'site' | 'offline' | 'other';
  title: string;
  /** A few words for the step that failed */
  short: string;
  detail: string;
  /** Offer to ask once without Tor: when the trouble is the route through Tor, not the phone */
  canGoDirect: boolean;
  /** The error itself, for a bug report */
  technical?: string;
}

export interface PriceState {
  ticker: Ticker | null;
  /** unix ms of the last good answer */
  at: number;
  /** Short form of the last problem, for the Wallet tab's dollar balance */
  error: string | null;
  problem: PriceProblem | null;
  loading: boolean;
  /** The steps of the current or last load. Shown when it isn't a routine refresh */
  steps: PriceStep[] | null;
  showSteps: boolean;
  /** Which of up to three tries is running */
  attempt: number;
  /** Loads in a row that ended without a price, for spacing out automatic retries */
  failures: number;
  /** Whether the current or last load went through Tor */
  viaTor: boolean;
}

/** Tor on the phone can't be reattached from inside the app. Only closing and reopening the app helps. */
class TorStuckError extends Error {}

const TOR_STUCK =
  'Tor on this iPhone stopped responding while Shrike was in the background, and the app can’t restart it by itself. Close Shrike (swipe it away in the app switcher) and open it again.';

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

interface TwoFactorRecord {
  secret: string;
  /** SHA-256 hashes of the recovery codes; a used one is emptied */
  recovery: string[];
  /** The last time step a code was accepted for, so no code works twice */
  lastStep: number | null;
  createdAt: number;
}

interface TwoFactorAttempts {
  failures: number;
  /** Seconds of lockout still to wait when this was saved. They count down only while the app is open */
  remaining: number;
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
const CONTACTS_FILE = 'contacts.json';
const TWO_FACTOR_ATTEMPTS_FILE = 'two-factor-attempts.json';
/** What the widgets were last handed, so a restart neither blanks the price nor rewrites them for nothing */
const WIDGETS_FILE = 'widgets.json';
/** The Market chart's one-day range, which is also what the price widget draws */
const DAY_CHART = CHART_RANGES[0];
/** While the app is open and past Face ID, how often the price is fetched again for a price widget */
const WIDGET_PRICE_EVERY_MS = 5 * 60_000;
const RPC_PASSWORD_KEY = 'rpc-password';
const TWO_FACTOR_KEY = 'two-factor';
const seedKey = (id: string) => `seed:${id}`;

const DEFAULT_SETTINGS: Settings = {
  network: 'mainnet',
  node: null,
  unit: 'BTC',
  lockOnOpen: true,
  groupByAddress: true,
  explorer: DEFAULT_EXPLORER,
  appearance: 'system',
  skin: 'shrike',
  font: 'atkinson',
  skinTier: 0,
  prices: true,
  pricesOverTor: true,
  balanceView: 'coin',
  twoFactor: false,
  twoFactorOffered: false,
  widgetBalance: true,
  widgetWallet: null,
};

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
  contacts: Contact[] = [];
  price: PriceState = { ticker: null, at: 0, error: null, problem: null, loading: false, steps: null, showSteps: false, attempt: 0, failures: 0, viaTor: false };
  /** Whether the embedded Tor exists here: the iPhone app. Tests and the browser stand-in can turn it on */
  torAvailable = isNative;
  /** Pauses in the price steps, so each can be seen. Tests set them to zero */
  priceTiming = { beat: 350, settle: 900, backoff: [2500, 5000], circuitWait: 20_000, askTimeout: 30_000 };
  /** Screens showing the price right now, which want it fetched again when the app comes back */
  private priceWatchers = 0;
  /** Recovery codes still unused, while two-factor is on */
  recoveryLeft = 0;
  /** New recovery codes not yet confirmed as saved. Kept here so locking the app doesn't lose them */
  pendingRecoveryCodes: string[] | null = null;
  /** A skin a sync just opened, for the Wallet tab to mention once */
  newSkin: SkinId | null = null;
  private failures = 0;
  /** performance.now() when the current lockout ends. Not the wall clock, which can be set forward */
  private lockDeadline = 0;
  /** Code checks run one at a time, so two can't both accept the same code */
  private twoFactorQueue: Promise<unknown> = Promise.resolve();
  private priceReq: Promise<void> | null = null;
  widgets: WidgetState = { status: 'unknown', installed: [], sentAt: 0 };
  /** A tab a widget asked to open, for the screens to go to once Face ID has opened the app */
  pendingTab: LinkTab | null = null;
  private widgetLast: WidgetSnapshot | null = null;
  private widgetJson = '';
  private widgetTimer: ReturnType<typeof setTimeout> | null = null;
  private widgetQueue: Promise<void> = Promise.resolve();
  /** The day's closing prices, for the price widget's chart */
  private dayChart: { closes: number[]; at: number } | null = null;
  private dayChartReq: Promise<void> | null = null;

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
    this.queueWidgets();
  }

  // ------------------------------------------------------------------------------------------- startup

  async init(): Promise<void> {
    const s = await readJson<Settings>(SETTINGS_FILE);
    if (s) this.settings = { ...DEFAULT_SETTINGS, ...s };
    const savedConfigs = await readJson<WalletConfig[]>(WALLETS_FILE);
    const configs = savedConfigs ?? [];
    for (const c of configs) {
      const file = await readJson<WalletFile>(`wallet-${c.id}.json`);
      this.wallets.push(this.runtimeFor(c, file));
    }
    this.activeId = this.wallets.find((w) => w.config.network === this.settings.network)?.config.id ?? null;
    for (const w of this.wallets) if (w.store.mine.length) this.recompute(w);
    this.contacts = (await readJson<Contact[]>(CONTACTS_FILE)) ?? [];
    const attempts = await readJson<Partial<TwoFactorAttempts>>(TWO_FACTOR_ATTEMPTS_FILE);
    this.failures = attempts?.failures ?? 0;
    this.lockDeadline = performance.now() + (attempts?.remaining ?? 0) * 1000;
    await this.syncTwoFactorFlag(s == null && savedConfigs == null);
    this.widgetLast = await readJson<WidgetSnapshot>(WIDGETS_FILE);
    this.widgetJson = this.widgetLast ? JSON.stringify(this.widgetLast) : '';
    const day = this.widgetLast?.price;
    if (day?.points && day.pointsAt) this.dayChart = { closes: day.points, at: day.pointsAt };
    this.locked = this.settings.lockOnOpen && this.wallets.length > 0 && isNative;
    this.ready = true;
    this.emit();
    CapApp.addListener('appUrlOpen', ({ url }) => this.openLink(url)).catch(() => undefined);
    CapApp.getLaunchUrl()
      .then((r) => r?.url && this.openLink(r.url))
      .catch(() => undefined);
    void this.checkWidgets();
    setInterval(() => {
      if (!this.backgroundedAt && !this.locked) void this.priceForWidgets();
    }, WIDGET_PRICE_EVERY_MS);
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        this.backgroundedAt = Date.now();
        // A lockout counts down only while the app is open; save what's left in case iOS ends the app
        if (this.twoFactorWait() > 0) void this.saveAttempts();
      } else {
        const away = this.backgroundedAt ? Date.now() - this.backgroundedAt : 0;
        this.backgroundedAt = null;
        if (this.settings.lockOnOpen && this.wallets.length > 0 && isNative && away > 60_000) {
          this.locked = true;
          this.emit();
        } else {
          if (this.settings.node) void this.refresh();
          if (this.priceWatchers > 0) void this.loadPrice(true);
        }
        // Widgets may have been added or removed while the app was away
        void this.checkWidgets();
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
      if (this.priceWatchers > 0) void this.loadPrice(true);
      else void this.priceForWidgets();
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
   * Over Tor, a request that fails at the network level gets one retry after a repair: iOS takes back Tor's
   * SOCKS port from an app it has suspended, and the repair opens a fresh one. A request the port refused never
   * left the phone, so it's sent again even when it's a broadcast.
   */
  private transport(node: NodeSettings): HttpTransport {
    return async (req) => {
      try {
        return await ShrikeNative.httpRequest({ ...req, useTor: node.useTor });
      } catch (e) {
        const neverSent = errorKind(e) === 'refused';
        if (!node.useTor || !this.torAvailable || !(req.retryable || neverSent)) throw e;
        const fixed = await ShrikeNative.torRepair({ newCircuit: !neverSent }).catch(() => ({ ok: false, stage: undefined }));
        if (!fixed.ok && fixed.stage === 'control') throw new Error(TOR_STUCK);
        await this.waitForTor(30_000);
        return ShrikeNative.httpRequest({ ...req, useTor: node.useTor });
      }
    };
  }

  /**
   * Before talking to the node: if iOS took back Tor's SOCKS port or control connection while the app was
   * suspended, reopen them. Says so in the status banner only when there's something to fix.
   */
  private async healTor(): Promise<void> {
    if (!this.torAvailable || !this.settings.node?.useTor) return;
    let h: TorHealth;
    try {
      h = await ShrikeNative.torCheck();
    } catch {
      return;
    }
    if (h.state === 'off' || (h.controller && h.socks)) return;
    this.conn = { phase: 'tor', message: h.socks ? 'Reconnecting to Tor on this iPhone' : 'Reopening Tor’s connection on this iPhone' };
    this.emit();
    const r = await ShrikeNative.torRepair({ newCircuit: false }).catch(() => ({ ok: false, stage: undefined }));
    if (!r.ok && r.stage === 'control') throw new Error(TOR_STUCK);
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
      if (s.state === 'error') throw new Error(/control port/i.test(s.error ?? '') ? TOR_STUCK : `Tor could not start: ${s.error ?? 'unknown error'}`);
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
        await this.healTor();
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
        await this.healTor();
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
    await this.checkSkinTier();
    this.emit();
  }

  /** Opens skins as the confirmed mainnet balance across the phone's wallets passes each threshold. */
  private async checkSkinTier(): Promise<void> {
    if (this.settings.network !== 'mainnet') return;
    const total = this.wallets.filter((w) => w.config.network === 'mainnet').reduce((s, w) => s + (w.snapshot?.balance.confirmed ?? 0), 0);
    const tier = tierFor(total);
    if (tier > this.settings.skinTier) {
      this.newSkin = SKINS[tier].id;
      await this.updateSettings({ skinTier: tier });
    }
  }

  /** Whether a skin can be picked. On test networks every skin is open to try, since their coins have no value. */
  skinOpen(id: SkinId): boolean {
    return this.settings.network !== 'mainnet' || skinIndex(id) <= this.settings.skinTier;
  }

  /** The skin in use: the one picked, if it's open. */
  get skin(): SkinId {
    return this.skinOpen(this.settings.skin) ? this.settings.skin : 'shrike';
  }

  dismissNewSkin(): void {
    this.newSkin = null;
    this.emit();
  }

  /** Confirmed balance of the current network's wallets together. */
  totalConfirmed(): number {
    return this.networkWallets().reduce((s, w) => s + (w.snapshot?.balance.confirmed ?? 0), 0);
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
    if (this.settings.widgetWallet === id) this.settings = { ...this.settings, widgetWallet: null };
    await this.saveWalletList();
    await writeJson(SETTINGS_FILE, this.settings);
    this.emit();
  }

  /** Reads the seed words, behind Face ID, to show them. With two-factor on, a code is needed first. */
  async revealSeed(id: string, code?: string): Promise<{ mnemonic: string; passphrase: string } | null> {
    await this.checkSecondFactor(code);
    return this.readSeed(id, 'Show the seed words');
  }

  /**
   * Reads a wallet's seed words to open them with another passphrase. They aren't shown, but they're the seed
   * words, so two-factor guards this as it guards showing them.
   */
  async seedForPassphraseWallet(id: string, code?: string): Promise<{ mnemonic: string; passphrase: string } | null> {
    await this.checkSecondFactor(code);
    return this.readSeed(id, 'Use the seed words with a passphrase');
  }

  private async readSeed(id: string, prompt: string): Promise<{ mnemonic: string; passphrase: string } | null> {
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

  /** Whether an address belongs to one of the wallets on this phone. */
  isOwnAddress(address: string): boolean {
    try {
      const script = toHex(decodeAddress(address, this.net).scriptPubKey);
      return this.networkWallets().some((w) => w.index.find(script) != null);
    } catch {
      return false;
    }
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

  /**
   * Checks the two-factor code if it's on, asks for Face ID, signs, broadcasts and labels. Returns the txid.
   * Sends, fee raises and cancels all come through here.
   */
  async signAndBroadcast(w: WalletRuntime, draft: DraftTransaction, label?: string, replaces?: string, code?: string): Promise<SignedTransaction> {
    if (draft.unified !== this.replayOptIn()) throw new Error('Replay protection changed since this was built. Go back and review it again.');
    await this.checkSecondFactor(code);
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
    await this.touchContacts(draft.outputs.map((o) => o.payment?.address).filter((a): a is string => !!a));
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

  // ------------------------------------------------------------------------------------------- address book

  /** Saved addresses for the current network, the most recently paid first. */
  networkContacts(): Contact[] {
    return this.contacts
      .filter((c) => c.network === this.settings.network)
      .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || a.name.localeCompare(b.name));
  }

  contactFor(address: string): Contact | undefined {
    const a = address.trim();
    return this.contacts.find((c) => c.network === this.settings.network && c.address === a);
  }

  /** Adds or changes a saved address. The address must be valid on the current network. */
  async saveContact(input: { id?: string; name: string; address: string; note?: string }): Promise<Contact> {
    const name = input.name.trim();
    const address = input.address.trim();
    if (!name) throw new Error('Give it a name');
    decodeAddress(address, this.net);
    const same = this.contacts.find((c) => c.network === this.settings.network && c.address === address && c.id !== input.id);
    if (same) throw new Error(`This address is already saved as ${same.name}`);
    const existing = input.id ? this.contacts.find((c) => c.id === input.id) : undefined;
    const contact: Contact = existing
      ? { ...existing, name, address, note: input.note?.trim() || undefined }
      : { id: randomId(), name, address, network: this.settings.network, note: input.note?.trim() || undefined, createdAt: Date.now() };
    this.contacts = existing ? this.contacts.map((c) => (c.id === contact.id ? contact : c)) : [...this.contacts, contact];
    await writeJson(CONTACTS_FILE, this.contacts);
    this.emit();
    return contact;
  }

  async deleteContact(id: string): Promise<void> {
    this.contacts = this.contacts.filter((c) => c.id !== id);
    await writeJson(CONTACTS_FILE, this.contacts);
    this.emit();
  }

  private async touchContacts(addresses: string[]): Promise<void> {
    let changed = false;
    for (const a of addresses) {
      const c = this.contactFor(a);
      if (c) {
        c.lastUsed = Date.now();
        changed = true;
      }
    }
    if (changed) await writeJson(CONTACTS_FILE, this.contacts);
  }

  // ------------------------------------------------------------------------------------------- price

  /**
   * A screen that shows the price says so while it's open, so the price is fetched again when the app comes back
   * to the foreground. Returns the function that says it's gone.
   */
  watchPrice(): () => void {
    this.priceWatchers++;
    return () => {
      this.priceWatchers = Math.max(0, this.priceWatchers - 1);
    };
  }

  /**
   * Gets the XBT/USDC price, unless the last answer is under a minute old (or `force`). Through Tor it goes step
   * by step, so the Market tab can show where it is: check Tor on the phone (and reopen what iOS took back),
   * wait for a route, ask Neoxa Exchange. A failed try is followed by up to two more, each on a new route.
   * Routine refreshes stay quiet; the steps show when there's no price yet, after a failure, or with `show`.
   * `direct` asks once without Tor, when the person chooses to.
   */
  loadPrice(force = false, how: { show?: boolean; direct?: boolean } = {}): Promise<void> {
    if (!this.settings.prices) return Promise.resolve();
    if (!force && this.price.ticker && Date.now() - this.price.at < PRICE_MAX_AGE_MS) return Promise.resolve();
    if (this.priceReq) {
      if (how.show && !this.price.showSteps) {
        this.price = { ...this.price, showSteps: true };
        this.emit();
      }
      return this.priceReq;
    }
    this.priceReq = this.runPriceLoad(how).finally(() => {
      this.priceReq = null;
      this.emit();
      void this.chartForWidgets();
    });
    return this.priceReq;
  }

  private async runPriceLoad(how: { show?: boolean; direct?: boolean }): Promise<void> {
    const t = this.priceTiming;
    const viaTor = this.settings.pricesOverTor && this.torAvailable && !how.direct;
    const fresh = (): PriceStep[] => [
      ...(viaTor
        ? [
            { id: 'tor' as const, label: 'Check Tor on this iPhone', status: 'pending' as const },
            { id: 'route' as const, label: 'Open a route through Tor', status: 'pending' as const },
          ]
        : []),
      { id: 'ask', label: viaTor ? 'Ask Neoxa Exchange for the price' : 'Ask Neoxa Exchange, without Tor', status: 'pending' },
    ];
    const show = !!how.show || !!how.direct || !this.price.ticker || this.price.problem != null;
    this.price = { ...this.price, loading: true, steps: fresh(), showSteps: show, attempt: 1, viaTor };
    this.emit();

    const step = (id: PriceStepId, status: PriceStepStatus, patch: Partial<PriceStep> = {}) => {
      this.price = { ...this.price, steps: (this.price.steps ?? []).map((x) => (x.id === id ? { ...x, status, ...patch } : x)) };
      this.emit();
    };
    // Each finished step stays on screen a moment, so a fast reconnect still reads as one
    const beat = () => (this.price.showSteps ? sleep(t.beat) : Promise.resolve());

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) {
        this.price = { ...this.price, attempt, steps: fresh(), showSteps: true };
        this.emit();
      }
      let current: PriceStepId = viaTor ? 'tor' : 'ask';
      try {
        if (viaTor) {
          step('tor', 'active');
          const note = await this.readyTorForPrice(attempt > 1, (label) => step('tor', 'active', { label }));
          step('tor', 'done', { note });
          await beat();
          current = 'route';
          step('route', 'active');
          const circuit = await this.waitForCircuit(t.circuitWait);
          step('route', 'done', { note: circuit ? undefined : 'Still building, trying anyway' });
          await beat();
        }
        current = 'ask';
        step('ask', 'active');
        const res = await ShrikeNative.httpRequest({ url: tickerUrl(), method: 'GET', headers: { Accept: 'application/json' }, body: '', timeoutMs: t.askTimeout, useTor: viaTor });
        const ticker = parseTicker(res.body, res.status);
        step('ask', 'done');
        this.price = { ...this.price, ticker, at: Date.now(), error: null, problem: null, loading: false, failures: 0 };
        this.emit();
        if (this.price.showSteps) await sleep(t.settle);
        this.price = { ...this.price, steps: null, showSteps: false };
        return;
      } catch (e) {
        lastError = e;
        const p = this.priceProblem(e, viaTor);
        step(current, 'failed', { note: p.short });
        // Trying again in the app can't help a stuck Tor, or a phone with no connection
        if (p.kind === 'tor-stuck' || p.kind === 'offline' || attempt === 3) break;
        this.price = { ...this.price, showSteps: true };
        this.emit();
        await sleep(t.backoff[attempt - 1] ?? 0);
      }
    }
    const problem = this.priceProblem(lastError, viaTor);
    this.price = { ...this.price, loading: false, problem, error: problem.title, showSteps: true, failures: this.price.failures + 1 };
    this.emit();
  }

  /**
   * Gets Tor ready for a request: starts it if it isn't running, and reopens what iOS took back while the app was
   * suspended. On a second or third try, also asks Tor for a new route. Returns a note for the step.
   */
  private async readyTorForPrice(newRoute: boolean, label: (text: string) => void): Promise<string | undefined> {
    let h = await ShrikeNative.torCheck();
    if (h.state === 'off') {
      label('Start Tor on this iPhone');
      await ShrikeNative.torStart();
      await this.waitForTorProgress(120_000, label);
      h = await ShrikeNative.torCheck();
    }
    let note: string | undefined;
    if (!h.controller || !h.socks) {
      label(h.socks ? 'Reconnect to Tor on this iPhone' : 'Reopen Tor’s connection on this iPhone');
      const r = await ShrikeNative.torRepair({ newCircuit: newRoute });
      if (!r.ok) throw r.stage === 'socks' ? new TorStuckError('Tor couldn’t open a new local port') : new TorStuckError(TOR_STUCK);
      // Another request may have done the reopening a moment ago; what the check found is what happened
      note = !h.socks ? 'iOS had closed it while Shrike was in the background. Reopened' : 'Reconnected';
    } else if (newRoute) {
      label('Pick a new route through Tor');
      await ShrikeNative.torRepair({ newCircuit: true });
    }
    if (h.state !== 'ready') await this.waitForTorProgress(120_000, label);
    return note;
  }

  private async waitForTorProgress(limitMs: number, label: (text: string) => void): Promise<void> {
    const started = Date.now();
    for (;;) {
      const s = await ShrikeNative.torStatus();
      if (s.state === 'ready') return;
      if (s.state === 'error') throw /control port/i.test(s.error ?? '') ? new TorStuckError(TOR_STUCK) : new Error(`Tor could not start: ${s.error ?? 'unknown error'}`);
      label(`Start Tor on this iPhone (${s.progress}%)`);
      if (Date.now() - started > limitMs) throw new Error('Tor took too long to connect. Check the phone has internet access.');
      await sleep(600);
    }
  }

  /** Waits for Tor to have a circuit, up to `limitMs`. False if it still hadn't. */
  private async waitForCircuit(limitMs: number): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      const h = await ShrikeNative.torCheck().catch(() => null);
      if (h?.circuit) return true;
      if (Date.now() - started >= limitMs) return false;
      await sleep(800);
    }
  }

  /** Puts a failed price load in words: what happened, and what can be done about it. */
  private priceProblem(e: unknown, viaTor: boolean): PriceProblem {
    const technical = e instanceof Error ? e.message : e != null ? String((e as { message?: unknown }).message ?? e) : undefined;
    if (e instanceof TorStuckError) {
      return {
        kind: 'tor-stuck',
        title: 'Tor on this iPhone stopped responding',
        short: 'Couldn’t reattach to Tor',
        detail:
          'iOS closed Tor’s connections while Shrike was in the background, and this time the app couldn’t reopen them. Close Shrike (swipe it away in the app switcher) and open it again. Your wallets aren’t affected.',
        canGoDirect: viaTor,
        technical,
      };
    }
    if (e instanceof PriceError) {
      const blocked = /HTTP (403|429|503)/.test(e.message);
      return {
        kind: 'site',
        title: blocked ? 'Neoxa Exchange turned the request away' : 'Neoxa Exchange didn’t send a price',
        short: blocked ? `Turned away (${/HTTP \d+/.exec(e.message)?.[0] ?? 'refused'})` : 'No price in the answer',
        detail: blocked && viaTor ? 'Some sites turn away requests that come through Tor. Try again later, or get the price once without Tor.' : e.message,
        canGoDirect: viaTor,
        technical,
      };
    }
    const kind = errorKind(e);
    if (kind === 'offline') {
      return { kind: 'offline', title: 'This iPhone is offline', short: 'No internet connection', detail: 'Connect to Wi-Fi or mobile data, then try again.', canGoDirect: false, technical };
    }
    if (kind === 'timeout') {
      return {
        kind: 'route',
        title: 'Neoxa Exchange didn’t answer in time',
        short: 'No answer in time',
        detail: viaTor ? 'Three routes through Tor in a row were too slow. The Tor network or the exchange may be busy.' : 'The exchange may be busy or down.',
        canGoDirect: viaTor,
        technical,
      };
    }
    return {
      kind: viaTor ? 'route' : 'other',
      title: viaTor ? 'Couldn’t reach Neoxa Exchange through Tor' : 'Couldn’t reach Neoxa Exchange',
      short: viaTor ? 'This route didn’t get through' : 'Didn’t get through',
      detail: viaTor
        ? 'Tor on this iPhone is working, but three routes in a row couldn’t get through to the exchange. The exchange or the Tor network may be having trouble.'
        : 'The exchange may be down, or this network may block it.',
      canGoDirect: viaTor,
      technical,
    };
  }

  async loadCandles(interval: CandleInterval, limit: number): Promise<Candle[]> {
    const res = await this.publicGet(candlesUrl(interval, limit));
    const candles = parseCandles(res.body, res.status);
    // The Market tab's one-day chart is what the price widget draws too
    if (interval === DAY_CHART.interval && limit === DAY_CHART.limit && candles.length >= 2) {
      this.dayChart = { closes: candles.map((c) => c.close), at: Date.now() };
      this.queueWidgets();
    }
    return candles;
  }

  /**
   * A read-only request to a public site, through Tor when the price setting says so. If Tor's port on the phone
   * refused it, Tor is repaired and the request sent once more.
   */
  private async publicGet(url: string): Promise<{ status: number; body: string }> {
    const useTor = this.settings.pricesOverTor && this.torAvailable;
    const ask = () => ShrikeNative.httpRequest({ url, method: 'GET', headers: { Accept: 'application/json' }, body: '', timeoutMs: 45_000, useTor });
    try {
      if (useTor) await this.readyTorForPrice(false, () => undefined);
      try {
        return await ask();
      } catch (e) {
        if (!useTor || errorKind(e) !== 'refused') throw e;
        await ShrikeNative.torRepair({ newCircuit: false });
        return await ask();
      }
    } catch (e) {
      throw new Error(`Couldn’t reach Neoxa Exchange${useTor ? ' through Tor' : ''}. ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ------------------------------------------------------------------------------------------- widgets
  //
  // Widgets can't run Tor, so they show what the app last got: the price and one wallet's balance, with the time.
  // Every change to the app's state queues a fresh snapshot; it's handed over only when something on it changed.

  /** What the widgets were last handed. */
  get widgetSnapshot(): WidgetSnapshot | null {
    return this.widgetLast;
  }

  /** The wallet the Balance widget shows: the one picked in Settings, or the first on this network. */
  widgetWallet(): WalletRuntime | null {
    const list = this.networkWallets();
    return list.find((w) => w.config.id === this.settings.widgetWallet) ?? list[0] ?? null;
  }

  /** Whether a price widget is on the Home Screen or Lock Screen, so the price is worth fetching for it. */
  private priceWidgetShown(): boolean {
    return this.widgets.installed.some((w) => w.kind === PRICE_WIDGET);
  }

  private widgetInput(): WidgetInput {
    const w = this.widgetWallet();
    const bal = w?.snapshot?.balance;
    return {
      appearance: this.settings.appearance,
      skin: this.skin,
      unit: this.settings.unit,
      network: this.settings.network,
      prices: this.settings.prices,
      showBalance: this.settings.widgetBalance,
      ticker: this.price.ticker,
      priceAt: this.price.at,
      chart: this.dayChart,
      wallet: w && bal ? { id: w.config.id, name: w.config.name, confirmed: bal.confirmed, unconfirmed: bal.unconfirmed } : null,
      syncedAt: this.conn.lastSync ?? null,
      now: Date.now(),
    };
  }

  private queueWidgets(): void {
    if (!this.ready || this.widgetTimer) return;
    this.widgetTimer = setTimeout(() => {
      this.widgetTimer = null;
      void this.sendWidgets();
    }, 400);
  }

  /** Hands the widgets a new snapshot if anything on it changed. One at a time, in order. */
  sendWidgets(): Promise<void> {
    const run = this.widgetQueue.then(async () => {
      const snap = buildWidgetSnapshot(this.widgetInput(), this.widgetLast);
      const json = JSON.stringify(snap);
      if (json === this.widgetJson) return;
      this.widgetJson = json;
      this.widgetLast = snap;
      let status: WidgetState['status'] = this.widgets.status;
      try {
        const r = await ShrikeNative.widgetsUpdate({ snapshot: json });
        status = r.ok ? 'ok' : (r.reason ?? 'no-app-group');
      } catch {
        status = isNative ? 'no-app-group' : 'web';
      }
      await writeJson(WIDGETS_FILE, snap).catch(() => undefined);
      const changed = status !== this.widgets.status;
      this.widgets = { ...this.widgets, status, sentAt: status === 'ok' ? Date.now() : this.widgets.sentAt };
      if (changed) this.emit();
    });
    this.widgetQueue = run.catch(() => undefined);
    return run;
  }

  /** Asks iOS which Shrike widgets are on screen. A price widget gets the price fetched for it. */
  async checkWidgets(): Promise<void> {
    try {
      const r = await ShrikeNative.widgetsInstalled();
      const status: WidgetState['status'] = r.ok ? 'ok' : (r.reason ?? 'no-app-group');
      const installed = r.widgets ?? [];
      if (status !== this.widgets.status || JSON.stringify(installed) !== JSON.stringify(this.widgets.installed)) {
        this.widgets = { ...this.widgets, status, installed };
        this.emit();
      }
    } catch {
      if (this.widgets.status === 'unknown') {
        this.widgets = { ...this.widgets, status: isNative ? 'no-app-group' : 'web' };
        this.emit();
      }
    }
    if (!this.locked) await this.priceForWidgets();
  }

  /** Fetches the price for a price widget, unless the last one is under a minute old. Quiet, like a refresh. */
  priceForWidgets(): Promise<void> {
    if (!this.settings.prices || !this.priceWidgetShown()) return Promise.resolve();
    return this.loadPrice();
  }

  /** Fetches the day's chart for a price widget that draws one, at most every fifteen minutes. */
  private chartForWidgets(): Promise<void> {
    if (!this.settings.prices || !this.price.ticker || this.dayChartReq) return this.dayChartReq ?? Promise.resolve();
    if (!this.widgets.installed.some((w) => w.kind === PRICE_WIDGET && CHART_FAMILIES.has(w.family))) return Promise.resolve();
    if (this.dayChart && Date.now() - this.dayChart.at < WIDGET_CHART_MAX_AGE_MS) return Promise.resolve();
    this.dayChartReq = this.loadCandles(DAY_CHART.interval, DAY_CHART.limit)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.dayChartReq = null;
      });
    return this.dayChartReq;
  }

  /** A widget was tapped: shrike://market or shrike://wallet. Anything else is ignored. */
  openLink(url: string): void {
    const m = /^shrike:\/\/(market|wallet)\/?$/i.exec(url.trim());
    if (!m) return;
    this.pendingTab = m[1].toLowerCase() === 'market' ? 'market' : 'home';
    this.emit();
  }

  /** The tab a widget asked for, once. */
  takePendingTab(): LinkTab | null {
    const t = this.pendingTab;
    this.pendingTab = null;
    return t;
  }

  // ------------------------------------------------------------------------------------------- two-factor
  //
  // The Keychain item is the record of whether two-factor is on; settings.twoFactor mirrors it for the screens.
  // A code is used up the moment it's accepted, before the action it allows runs, so a send or a seed reveal that
  // fails or is cancelled afterwards doesn't leave a working code behind.

  /** The two-factor record, or null if there's none. Throws if the Keychain can't be read, so checks fail closed. */
  private async readTwoFactorOrNull(): Promise<TwoFactorRecord | null> {
    const { value } = await ShrikeNative.vaultGet({ key: TWO_FACTOR_KEY, prompt: 'Check the code' });
    return value ? (JSON.parse(value) as TwoFactorRecord) : null;
  }

  private async writeTwoFactor(r: TwoFactorRecord): Promise<void> {
    // Kept on this device only. Reading it needs no Face ID: the code itself is the second factor
    await ShrikeNative.vaultSet({ key: TWO_FACTOR_KEY, value: JSON.stringify(r), requireAuth: false });
    this.recoveryLeft = r.recovery.filter(Boolean).length;
  }

  /**
   * At launch: sets settings.twoFactor from the Keychain, so a settings file that's lost or unreadable can't
   * switch two-factor off. On a fresh install, a record left in the Keychain by an earlier install (iOS keeps
   * Keychain items when an app is deleted) is removed.
   */
  private async syncTwoFactorFlag(freshInstall: boolean): Promise<void> {
    let r: TwoFactorRecord | null;
    try {
      r = await this.readTwoFactorOrNull();
    } catch {
      return;
    }
    if (freshInstall) {
      if (r) await ShrikeNative.vaultDelete({ key: TWO_FACTOR_KEY });
      r = null;
    }
    this.recoveryLeft = r ? r.recovery.filter(Boolean).length : 0;
    if ((r != null) !== this.settings.twoFactor) {
      this.settings = { ...this.settings, twoFactor: r != null };
      await writeJson(SETTINGS_FILE, this.settings);
    }
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.twoFactorQueue.then(task, task);
    this.twoFactorQueue = run.catch(() => undefined);
    return run;
  }

  /** Turns two-factor on once the person shows their authenticator gives the right code. Returns the recovery codes. */
  enableTwoFactor(secretB32: string, code: string): Promise<string[]> {
    return this.serial(async () => {
      if (await this.readTwoFactorOrNull()) throw new Error('Two-factor is already on');
      const step = verifyTotp(decodeSecret(secretB32), code, Date.now() / 1000);
      if (step == null) {
        throw new Error('That code doesn’t match. Check the authenticator shows the Shrike entry you just added, and that this iPhone sets its clock automatically.');
      }
      const codes = newRecoveryCodes();
      await this.writeTwoFactor({ secret: secretB32, recovery: codes.map(hashRecoveryCode), lastStep: step, createdAt: Date.now() });
      this.pendingRecoveryCodes = codes;
      await this.updateSettings({ twoFactor: true });
      return codes;
    });
  }

  /** The person has saved the recovery codes on screen. */
  acknowledgeRecoveryCodes(): void {
    this.pendingRecoveryCodes = null;
    this.emit();
  }

  /** Seconds left before another code can be tried, after too many wrong ones. */
  twoFactorWait(): number {
    return Math.max(0, Math.ceil((this.lockDeadline - performance.now()) / 1000));
  }

  private saveAttempts(): Promise<void> {
    return writeJson(TWO_FACTOR_ATTEMPTS_FILE, { failures: this.failures, remaining: this.twoFactorWait() } satisfies TwoFactorAttempts);
  }

  /**
   * With two-factor on, checks a code from the authenticator, or a recovery code, and uses it up. Throws if
   * it's missing or wrong. With two-factor off, does nothing.
   */
  checkSecondFactor(code: string | undefined): Promise<void> {
    return this.serial(async () => {
      const r = await this.readTwoFactorOrNull();
      if (!r) {
        if (this.settings.twoFactor) throw new Error('The two-factor key is no longer in this iPhone’s Keychain. Close the app and open it again.');
        return;
      }
      const text = (code ?? '').trim();
      if (!text) throw new Error('Enter the code from your authenticator app');
      const wait = this.twoFactorWait();
      if (wait > 0) throw new Error(`Too many wrong codes. Try again in ${wait < 90 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.`);
      let ok = false;
      if (looksLikeRecoveryCode(text)) {
        const i = matchRecoveryCode(r.recovery, text);
        if (i >= 0) {
          r.recovery[i] = '';
          ok = true;
        }
      } else {
        const step = verifyTotp(decodeSecret(r.secret), cleanCode(text), Date.now() / 1000, r.lastStep);
        if (step != null) {
          r.lastStep = Math.max(r.lastStep ?? 0, step);
          ok = true;
        }
      }
      if (!ok) {
        this.failures++;
        this.lockDeadline = performance.now() + lockoutSeconds(this.failures) * 1000;
        await this.saveAttempts();
        this.emit();
        throw new Error(
          looksLikeRecoveryCode(text)
            ? 'That recovery code doesn’t match one that’s still unused.'
            : 'That code doesn’t match, or it was used already. Wait for the authenticator to show the next one.',
        );
      }
      // Used up before the action it allows runs
      await this.writeTwoFactor(r);
      if (this.failures) {
        this.failures = 0;
        this.lockDeadline = 0;
        await this.saveAttempts();
      }
      this.emit();
    });
  }

  /** Turns two-factor off. Needs a code or a recovery code. */
  async disableTwoFactor(code: string): Promise<void> {
    await this.checkSecondFactor(code);
    await ShrikeNative.vaultDelete({ key: TWO_FACTOR_KEY });
    this.recoveryLeft = 0;
    await this.updateSettings({ twoFactor: false });
  }

  /** Replaces the recovery codes with a new set. Needs a code from the authenticator or a recovery code. */
  async replaceRecoveryCodes(code: string): Promise<string[]> {
    await this.checkSecondFactor(code);
    return this.serial(async () => {
      const r = await this.readTwoFactorOrNull();
      if (!r) throw new Error('Two-factor is off');
      const codes = newRecoveryCodes();
      r.recovery = codes.map(hashRecoveryCode);
      await this.writeTwoFactor(r);
      this.pendingRecoveryCodes = codes;
      this.emit();
      return codes;
    });
  }

  async twoFactorSince(): Promise<number | null> {
    try {
      return (await this.readTwoFactorOrNull())?.createdAt ?? null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------- transaction labels

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
