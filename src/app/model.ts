// The app model: settings, wallets, the node connection and everything the screens read and do. Screens
// subscribe through useApp() and call methods here; nothing in the UI talks to the node or the vault directly.

import { App as CapApp } from '@capacitor/app';
import { DEFAULT_EXPLORER } from '../core/explorer';
import { cormorantDescriptor, normalizeDescriptor, originDescriptor } from '../core/descriptor';
import { AccountKey, deriveAccount, deriveAccountPrivate, normalizeMnemonic } from '../core/keys';
import { LabelStore, type LabelRecord, type LabelType } from '../core/labels';
import { NETWORKS, type NetworkName, type NetworkParams } from '../core/network';
import { chainDecision, DECISION_TEXT, isOptedIn, type ReplayDecision } from '../core/replay';
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
import { formatAmount, unitLabel, type Unit } from '../core/units';
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
import { hashPin, pinMatches, pinProblem, type PinHash } from '../core/pin';
import { decryptBackup, encryptBackup, readBackupHeader } from '../core/backup';
import { checkRecipient, DUST_SATS, type KnownAddress, type RecipientCheck } from '../core/poison';
import { buildPsbt, finalizeFromDevice, type PsbtWallet, type SignedFromDevice } from '../core/psbt';
import { matchWallet, parseHardwareKey, type HardwareKey } from '../core/hwkey';
import { BACKUP_SETTINGS, checkBackupContents, type BackupContents, type BackupWallet } from './backup';
import { skinIndex, tierFor, SKINS, type Appearance, type FontId, type SkinId } from './look';
import { errorKind, isNative, ShrikeNative, type TorHealth } from './native';
import { serverInfo } from './server-api';
import { isServer } from './target';
import { readJson, removeJson, writeJson } from './storage';
import { LightningController } from './lightning';
import { DEFAULT_NOTIFY, Notifier, type NotifySettings } from './notify';
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
  /**
   * Coins, or their worth in US dollars at today's price: the balances on the Wallet and Lightning tabs and the
   * amounts in their lists. Dollars by default; tapping a balance switches. Coins whenever prices are off.
   */
  balanceView: 'coin' | 'usd';
  /** A code from an authenticator app is needed to send and to show seed words. The key is in the Keychain. */
  twoFactor: boolean;
  /** Set once two-factor setup has been offered, so it's offered once and not again. */
  twoFactorOffered: boolean;
  /** Whether the Balance widget shows the balance. Off, it says the balance is hidden. */
  widgetBalance: boolean;
  /** The wallet the Balance widget shows. null means the first one on this network, the one the app opens to. */
  widgetWallet: string | null;
  /** The app's own PIN is on. The Keychain record is what decides; this mirrors it for the screens. */
  appPin: boolean;
  /** unix ms of the last backup file saved, or null */
  lastBackupAt: number | null;
  /** Notifications from background checks (notify.ts). Not in backups: iOS asks on each phone */
  notify: NotifySettings;
}

/** What restoring a backup did, for the screen to say. */
export interface RestoreSummary {
  /** Settings and the node's address came back, on a phone with nothing set up yet */
  settings: boolean;
  contacts: number;
  /** Labels added to wallets already on this phone */
  labels: number;
  /** Wallets that come back with their labels once their seed words are entered */
  waiting: string[];
  /** Wallets that signed only on a Krux, which come back by scanning its key */
  kruxWaiting: string[];
}

/** What the app PIN's Keychain record holds: hashes only. The duress PIN and its decoy wallet live only here. */
interface PinRecord {
  pin: PinHash;
  duress: (PinHash & { wallet: string }) | null;
  createdAt: number;
}

/** A PIN typed at the lock screen or for a signature: the real one, the duress one, or neither. */
type PinResult = 'real' | 'duress' | null;

/** How opening the app went: open, or the PIN pad is needed, or Face ID (with the passcode) failed. */
export type UnlockResult = 'ok' | 'pin' | 'failed';

/** The iPhone widgets as the app sees them, for the Widgets screen in Settings. */
export interface WidgetState {
  /** ok: they get what the app hands them. no-app-group: this build can't share with them. web: not an iPhone */
  status: 'unknown' | 'ok' | 'no-app-group' | 'web';
  /** The Crossbill widgets on the Home Screen and Lock Screen */
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
  'Tor on this iPhone stopped responding while Crossbill was in the background, and the app can’t restart it by itself. Close Crossbill (swipe it away in the app switcher) and open it again.';

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
  /**
   * Where its transactions are signed: with the seed words on this iPhone, on a Krux hardware wallet, or either.
   * Absent on wallets from before 0.4.0, which means this iPhone.
   */
  signer?: Signer;
}

export type Signer = 'phone' | 'krux' | 'both';

export function signerOf(c: WalletConfig): Signer {
  return c.signer ?? 'phone';
}

/** A send waiting for the Krux's signature, kept here so locking the app doesn't lose it. */
export interface KruxSigning {
  walletId: string;
  draft: DraftTransaction;
  /** The PSBT shown to the Krux */
  psbt: Uint8Array;
  label?: string;
  /** For a fee bump or cancel: the transaction this replaces */
  replaces?: string;
  /** The transaction once the Krux's signatures are in, checked and ready to send */
  signed: SignedFromDevice | null;
  createdAt: number;
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
const DAY_CHART = CHART_RANGES.find((r) => r.id === '1d')!;
/** While the app is open and past Face ID, how often the price is fetched again for a price widget */
const WIDGET_PRICE_EVERY_MS = 5 * 60_000;
const RPC_PASSWORD_KEY = 'rpc-password';
const TWO_FACTOR_KEY = 'two-factor';
const PIN_KEY = 'app-pin';
const PIN_ATTEMPTS_FILE = 'pin-attempts.json';
/** Wallets from a restored backup, waiting for their seed words */
const RESTORE_FILE = 'restore-waiting.json';
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
  balanceView: 'usd',
  twoFactor: false,
  twoFactorOffered: false,
  widgetBalance: true,
  widgetWallet: null,
  appPin: false,
  lastBackupAt: null,
  notify: DEFAULT_NOTIFY,
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
  /**
   * Whether the embedded Tor exists here: the iPhone app. Tests and the browser stand-in can turn it on. On StartOS
   * it's whether the Crossbill server has a Tor proxy
   */
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
  /**
   * After the duress PIN: the decoy wallet, and anything added since, are all the screens show. Nothing about it is
   * saved, and it ends when the app locks again.
   */
  private decoy: {
    wallet: string;
    wallets: Set<string>;
    contacts: Set<string>;
    /** What the App PIN screen shows in this session, so it looks as it would in a real one. Never saved */
    pinOff: boolean;
    duressShown: string | null;
  } | null = null;
  /** Counts sessions, so a PIN asked for in one can't be answered in the next */
  private session = 0;
  /** Face ID's faces changed since the PIN was set, so Face ID alone doesn't open the app until they're trusted again */
  faceIdChanged = false;
  /** A screen asking for the app PIN before the seed words are read, when Face ID didn't confirm it's you */
  pinAsk: { reason: string; resolve: (ok: boolean) => void } | null = null;
  private pinFailures = 0;
  /** performance.now() when the PIN lockout ends */
  private pinDeadline = 0;
  private pinQueue: Promise<unknown> = Promise.resolve();
  /** Wallets from a restored backup, waiting for their seed words */
  private restoreWaiting: BackupWallet[] = [];
  /** A tab a widget asked to open, for the screens to go to once Face ID has opened the app */
  pendingTab: LinkTab | null = null;
  private widgetLast: WidgetSnapshot | null = null;
  private widgetJson = '';
  private widgetTimer: ReturnType<typeof setTimeout> | null = null;
  private widgetQueue: Promise<void> = Promise.resolve();
  /** The day's closing prices, for the price widget's chart */
  private dayChart: { closes: number[]; at: number } | null = null;
  private dayChartReq: Promise<void> | null = null;

  /** Lightning, through the person's own Lightning Fork node (lightning.ts) */
  readonly lightning: LightningController = new LightningController({
    // On StartOS the Crossbill server carries the onion route: through StartOS's own network to the node, or Tor
    torAvailable: () => this.torAvailable || isServer,
    ensureTor: async () => {
      if (!isNative) return;
      await this.readyTorForPrice(false, () => undefined);
    },
    inDecoy: () => this.decoy != null,
    confirmPresence: (reason) => this.confirmPresence(reason),
    checkSecondFactor: (code) => this.checkSecondFactor(code),
    changed: () => this.emit(),
    sawActivity: (items) => (this.decoy ? Promise.resolve() : this.notifier.lightning(items)),
    readableInBackground: () => this.settings.notify.on,
  });

  /** Notifications for confirmations and Lightning payments, from background checks (notify.ts) */
  private readonly notifier = new Notifier(
    () => this.settings.notify,
    (sats) => `${formatAmount(sats, this.settings.unit)} ${unitLabel(this.settings.unit)}`,
  );

  private rpc: KnotsRpc | null = null;
  private listeners = new Set<() => void>();
  private busy: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private backgroundedAt: number | null = null;
  /** performance.now() when the app went to the background: a clock that setting the time can't move */
  private backgroundedMono = 0;
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
    if (s) this.settings = { ...DEFAULT_SETTINGS, ...s, notify: { ...DEFAULT_NOTIFY, ...s.notify } };
    if (isServer) {
      // On StartOS the node is set there, and the server reaches it with a password only the server holds. Signing
      // in to the server opens the app, so there's no app PIN or Face ID to ask for
      const info = await serverInfo();
      this.torAvailable = info.tor;
      this.settings = {
        ...this.settings,
        network: info.network,
        node: { host: info.node.host, port: info.node.port, user: '', useTor: false, tls: info.node.tls },
        pricesOverTor: this.settings.pricesOverTor && info.tor,
        lockOnOpen: false,
        appPin: false,
      };
    }
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
    const pinAttempts = await readJson<Partial<TwoFactorAttempts>>(PIN_ATTEMPTS_FILE);
    this.pinFailures = pinAttempts?.failures ?? 0;
    this.pinDeadline = performance.now() + (pinAttempts?.remaining ?? 0) * 1000;
    await this.syncPinFlag(s == null && savedConfigs == null);
    this.restoreWaiting = (await readJson<BackupWallet[]>(RESTORE_FILE)) ?? [];
    await this.lightning.init();
    this.widgetLast = await readJson<WidgetSnapshot>(WIDGETS_FILE);
    this.widgetJson = this.widgetLast ? JSON.stringify(this.widgetLast) : '';
    const day = this.widgetLast?.price;
    if (day?.points && day.pointsAt) this.dayChart = { closes: day.points, at: day.pointsAt };
    this.locked = this.locksOnOpen();
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
        this.backgroundedMono = performance.now();
        // A lockout counts down only while the app is open; save what's left in case iOS ends the app
        if (this.twoFactorWait() > 0) void this.saveAttempts();
        if (this.pinWait() > 0) void this.savePinAttempts();
      } else {
        const wall = this.backgroundedAt ? Date.now() - this.backgroundedAt : 0;
        const mono = this.backgroundedAt ? performance.now() - this.backgroundedMono : 0;
        // The longer of the two: the wall clock can be set back, and the other may pause while the iPhone sleeps
        const away = wall < 0 ? wall : Math.max(wall, mono);
        this.backgroundedAt = null;
        // A clock set back while away reads as a negative time away: that locks too
        if (this.locksOnOpen() && (away > 60_000 || away < 0)) {
          this.locked = true;
          this.decoy = null;
          this.session++;
          this.cancelPin();
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
    if (!isServer) {
      try {
        ShrikeNative.addListener('backgroundCheck', ({ id, deadline }) => void this.backgroundCheck(id, deadline)).catch(() => undefined);
        // iOS forgets the request when the app is updated, so it's made again at each launch
        if (this.settings.notify.on) ShrikeNative.backgroundChecks({ on: true }).catch(() => undefined);
      } catch {
        // A stand-in without background checks
      }
    }
  }

  // ------------------------------------------------------------------------------------------- notifications

  /**
   * iOS woke the app for a short background check: reads the node and the Lightning node, which hands any
   * confirmations and finished payments to the notifier. iOS gives about 30 seconds, so it stops at 25.
   */
  private async backgroundCheck(id: string, deadline?: number): Promise<void> {
    let ok = false;
    try {
      // A duress session that went to the background: its checks see only the decoy wallet, so none are made
      if (this.settings.notify.on && !this.decoy) {
        let finished = false;
        const work = (async () => {
          await this.check();
          // A payment waiting for an answer is left for when the app is open
          if (this.lightning.paired && this.settings.notify.lightning) await this.lightning.refresh({ resume: false });
          finished = true;
        })();
        // iOS gives about 30 seconds from when it woke the app, which includes starting the page
        const left = deadline ? Math.max(1_000, deadline - Date.now()) : 25_000;
        await Promise.race([work, new Promise((r) => setTimeout(r, left))]);
        ok = finished && this.conn.phase === 'ready';
      }
    } finally {
      await ShrikeNative.backgroundCheckDone({ id, ok }).catch(() => undefined);
    }
  }

  /**
   * Turns notifications on or off. On asks iOS for permission, and stores the node's password and the Lightning key
   * so they can be read while the iPhone is locked (after it has been unlocked once since it was turned on): a
   * background check runs while it's locked. Off puts them back as they were, readable only while it's unlocked.
   */
  async setNotifications(on: boolean): Promise<void> {
    // Not from a duress session: nothing it does is kept, and notifications would show the hidden wallets' payments
    if (this.decoy) throw new Error('Notifications can’t be changed right now.');
    if (on) {
      const { granted } = await ShrikeNative.notifyPermission();
      if (!granted) throw new Error('Notifications are off for Crossbill. Turn them on in the iPhone’s Settings, Notifications, Crossbill, then try again.');
      try {
        await this.restoreSecrets(true);
      } catch (e) {
        // Back as they were, so the secrets and the setting agree
        await this.restoreSecrets(false).catch(() => undefined);
        throw e;
      }
      await this.notifier.reset();
      await this.updateSettings({ notify: { ...this.settings.notify, on: true } });
      await ShrikeNative.backgroundChecks({ on: true }).catch(() => undefined);
      // The first check after turning on only takes note of where things stand
      if (!this.locked) {
        void this.refresh();
        if (this.lightning.paired) void this.lightning.refresh();
      }
      return;
    }
    // Off: the checks stop first, so none runs with secrets it can no longer read
    await this.updateSettings({ notify: { ...this.settings.notify, on: false } });
    await ShrikeNative.backgroundChecks({ on: false }).catch(() => undefined);
    await this.restoreSecrets(false);
  }

  /** Stores the node's password and the Lightning key again, readable while locked or only while unlocked. */
  private async restoreSecrets(background: boolean): Promise<void> {
    if (isServer) return;
    if (this.settings.node) {
      const { value } = await ShrikeNative.vaultGet({ key: RPC_PASSWORD_KEY, prompt: 'Read the node password' });
      if (value != null) await ShrikeNative.vaultSet({ key: RPC_PASSWORD_KEY, value, requireAuth: false, afterFirstUnlock: background });
    }
    await this.lightning.storeKeyAgain(background);
  }

  async updateNotify(patch: Partial<NotifySettings>): Promise<void> {
    await this.updateSettings({ notify: { ...this.settings.notify, ...patch } });
  }

  /** Whether the app asks for Face ID (or the PIN) when it opens. Always, while the app PIN is on. */
  private locksOnOpen(): boolean {
    return (this.settings.lockOnOpen || this.settings.appPin) && this.wallets.length > 0 && isNative;
  }

  /**
   * Opens the app with Face ID. With the app PIN on, Face ID alone is asked for, and anything but success means the
   * PIN pad, never the iPhone passcode. Without it, the passcode works as before.
   */
  async unlock(): Promise<UnlockResult> {
    if (this.settings.appPin) {
      const res = await ShrikeNative.authenticate({ reason: 'Open Crossbill', biometricsOnly: true, fallbackTitle: 'Use PIN' });
      if (res.changed && !this.faceIdChanged) {
        this.faceIdChanged = true;
        this.emit();
      }
      if (!res.ok) return 'pin';
      this.opened(null);
      return 'ok';
    }
    const res = await ShrikeNative.authenticate({ reason: 'Open Crossbill' });
    if (!res.ok) return 'failed';
    this.opened(null);
    return 'ok';
  }

  /** Opens the app with the PIN typed on the lock screen. The duress PIN opens the decoy wallet alone. */
  async unlockWithPin(pin: string): Promise<void> {
    const r = await this.checkPin(pin, 'any');
    if (r === 'real') {
      this.opened(null);
      return;
    }
    const rec = await this.readPinRecord();
    this.opened(rec?.duress ? { wallet: rec.duress.wallet, wallets: new Set([rec.duress.wallet]), contacts: new Set(), pinOff: false, duressShown: null } : null);
  }

  private opened(decoy: AppModel['decoy']): void {
    this.session++;
    this.cancelPin();
    this.decoy = decoy;
    if (decoy) this.kruxSigning = null;
    if (decoy) {
      // Straight to the decoy wallet; if it isn't on this network, the app looks like it has none here yet
      this.activeId = this.networkWallets()[0]?.config.id ?? null;
    } else if (!this.active) {
      this.activeId = this.networkWallets()[0]?.config.id ?? null;
    }
    this.locked = false;
    this.emit();
    if (this.settings.node) void (this.rpc ? this.refresh() : this.connect());
    if (this.priceWatchers > 0) void this.loadPrice(true);
    else void this.priceForWidgets();
  }

  /** Whether a wallet shows in this session: always, unless the duress PIN opened the app. */
  private shows(w: WalletRuntime): boolean {
    return !this.decoy || this.decoy.wallets.has(w.config.id);
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
    if (isServer) throw new Error('On StartOS the node is set in Crossbill’s settings there.');
    await ShrikeNative.vaultSet({ key: RPC_PASSWORD_KEY, value: password, requireAuth: false, afterFirstUnlock: this.settings.notify.on });
    await this.updateSettings({ node, network });
    this.rpc = null;
    // A send waiting for the Krux was built on the old node and network
    this.kruxSigning = null;
    if (!this.networkWallets().some((w) => w.config.id === this.activeId)) {
      this.activeId = this.networkWallets()[0]?.config.id ?? null;
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
    return this.check();
  }

  /** Reads the node now, even while the app is locked: refresh() and the background checks. */
  private check(): Promise<void> {
    if (!this.settings.node) return Promise.resolve();
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
    for (const w of this.networkWallets()) {
      await this.syncWallet(rpc, w);
    }
    try {
      this.fees = await estimateFees(rpc);
    } catch {
      this.fees = null;
    }
    // A duress session sees only the decoy wallet: the notifier waits for a session that sees them all
    if (this.node && !this.decoy) {
      const txs = this.networkWallets().flatMap((w) => w.snapshot?.txs ?? []);
      await this.notifier.chain(this.settings.network, this.node.blocks, txs).catch(() => undefined);
    }
    this.conn = { phase: 'ready', lastSync: Date.now() };
    await this.checkSkinTier();
    this.emit();
  }

  /** Opens skins as the confirmed mainnet balance across the phone's wallets passes each threshold. */
  private async checkSkinTier(): Promise<void> {
    // A decoy session never opens skins: they'd be saved, and show what the hidden wallets hold
    if (this.settings.network !== 'mainnet' || this.decoy) return;
    const total = this.wallets.filter((w) => w.config.network === 'mainnet').reduce((s, w) => s + (w.snapshot?.balance.confirmed ?? 0), 0);
    const tier = tierFor(total);
    if (tier > this.settings.skinTier) {
      this.newSkin = SKINS[tier].id;
      await this.updateSettings({ skinTier: tier });
    }
  }

  /** Whether a skin can be picked. On test networks every skin is open to try, since their coins have no value. */
  skinOpen(id: SkinId): boolean {
    // Unchanged in a decoy session: the lock screen and widgets already showed the skin, and a change would stand out
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
    return this.wallets.find((w) => w.config.id === this.activeId && this.shows(w)) ?? null;
  }

  /** The wallets on this network that the screens show. */
  networkWallets(): WalletRuntime[] {
    return this.wallets.filter((w) => w.config.network === this.settings.network && this.shows(w));
  }

  /** A wallet by its ID, if this session shows it. */
  walletById(id: string): WalletRuntime | undefined {
    return this.wallets.find((w) => w.config.id === id && this.shows(w));
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

  /**
   * Adds a wallet from its seed words, which go into the Keychain. For a wallet already here that signs only on the
   * Krux, its seed words go back on this iPhone instead, so it can sign on either. Returns which happened.
   */
  async addWallet(input: { name: string; mnemonic: string; passphrase: string; scriptType: ScriptType; rescan: RescanChoice }): Promise<'added' | 'seed-back'> {
    if (isServer) throw new Error('Crossbill on StartOS is watch-only and never keeps seed words. Add the wallet from your Krux.');
    const mnemonic = normalizeMnemonic(input.mnemonic);
    const acct = deriveAccount(mnemonic, input.passphrase, input.scriptType, this.net);
    const already = this.wallets.find((w) => w.config.xpub === acct.xpub && w.config.network === this.settings.network);
    if (already && this.decoy && !this.shows(already)) {
      // Whoever typed these seed words can spend from the wallet anyway; saying it's already here would say more
      this.decoy.wallets.add(already.config.id);
      this.activeId = already.config.id;
      this.emit();
      return 'added';
    }
    // A wallet that signs only on the Krux, at whatever account it uses: these seed words go back on this iPhone
    const kruxOnly = this.networkWallets().find((w) => {
      if (signerOf(w.config) !== 'krux') return false;
      try {
        return deriveAccountPrivate(mnemonic, input.passphrase, w.config.derivation, this.net).account.publicExtendedKey === w.config.xpub;
      } catch {
        return false;
      }
    });
    if (kruxOnly) {
      await ShrikeNative.vaultSet({ key: seedKey(kruxOnly.config.id), value: JSON.stringify({ mnemonic, passphrase: input.passphrase }), requireAuth: true });
      kruxOnly.config.signer = 'both';
      kruxOnly.config.hasPassphrase = input.passphrase.length > 0;
      // Signing on this iPhone checks the fingerprint, so it's the one these seed words give
      kruxOnly.config.fingerprint = deriveAccountPrivate(mnemonic, input.passphrase, kruxOnly.config.derivation, this.net).fingerprint;
      this.activeId = kruxOnly.config.id;
      await this.saveWalletList();
      this.emit();
      return 'seed-back';
    }
    if (already) throw new Error('This wallet is already on the phone');
    // A wallet from a restored backup gets its labels, frozen coins and address window back
    const restored = this.waitingWallets().find((b) => b.config.xpub === acct.xpub);
    const config: WalletConfig = {
      // A restored wallet keeps its old ID, so settings that name it (the Balance widget's wallet) still do
      id: restored && !this.wallets.some((w) => w.config.id === restored.config.id) ? restored.config.id : randomId(),
      name: input.name.trim() || 'Wallet',
      network: this.settings.network,
      scriptType: input.scriptType,
      fingerprint: acct.fingerprint,
      derivation: acct.derivation,
      xpub: acct.xpub,
      gapLimit: restored ? Math.max(DEFAULT_GAP_LIMIT, restored.config.gapLimit) : DEFAULT_GAP_LIMIT,
      createdAt: restored?.config.createdAt ?? Date.now(),
      hasPassphrase: input.passphrase.length > 0,
      // A wallet the backup says was linked to the Krux is still on the Krux
      signer: restored && signerOf(restored.config) !== 'phone' ? 'both' : 'phone',
    };
    const w = this.runtimeFor(config, null);
    if (restored) w.labels = new LabelStore(restored.labels);

    // The seed goes to the Keychain first, behind Face ID, before anything else is saved
    await ShrikeNative.vaultSet({ key: seedKey(config.id), value: JSON.stringify({ mnemonic, passphrase: input.passphrase }), requireAuth: true });
    await this.installWallet(w, input.rescan, restored);
    return 'added';
  }

  /** Has the node watch a new wallet's addresses (scanning for its history if asked), then adds it to the phone. */
  private async installWallet(w: WalletRuntime, rescan: RescanChoice, restored: BackupWallet | undefined): Promise<void> {
    const config = w.config;
    const rpc = await this.getRpc();
    await ensureCormorantWallet(rpc);
    const imported = await listImportedDescriptors(rpc);
    const have = imported.get(w.descriptors.receive);
    if (have && imported.has(w.descriptors.change)) {
      w.importedRange = have.range;
    } else {
      const since = rescan.kind === 'new' ? ('now' as const) : rescan.kind === 'date' ? rescan.since! : 0;
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
    this.decoy?.wallets.add(config.id);
    this.activeId = config.id;
    await this.saveWalletList();
    await this.saveWallet(w);
    if (restored) {
      this.restoreWaiting = this.restoreWaiting.filter((b) => b !== restored);
      await writeJson(RESTORE_FILE, this.restoreWaiting);
    }
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
    const w = this.walletById(id);
    if (!w) return;
    w.config.name = name.trim() || w.config.name;
    await this.saveWalletList();
    this.emit();
  }

  /** Removes the wallet from this phone only. The node and the desktop app are untouched. */
  async removeWallet(id: string): Promise<void> {
    await ShrikeNative.vaultDelete({ key: seedKey(id) });
    if (this.kruxSigning?.walletId === id) this.kruxSigning = null;
    await removeJson(`wallet-${id}.json`);
    this.wallets = this.wallets.filter((w) => w.config.id !== id);
    if (this.activeId === id) this.activeId = this.networkWallets()[0]?.config.id ?? null;
    if (this.settings.widgetWallet === id) this.settings = { ...this.settings, widgetWallet: null };
    await this.saveWalletList();
    await writeJson(SETTINGS_FILE, this.settings);
    // A duress PIN whose decoy wallet is gone would open nothing, so it goes too (not from a decoy session)
    if (!this.decoy) {
      const rec = await this.readPinRecord().catch(() => null);
      if (rec?.duress?.wallet === id) await this.writePinRecord({ ...rec, duress: null });
    }
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
    const res = await this.vaultSeed(seedKey(id), prompt);
    return res.value ? JSON.parse(res.value) : null;
  }

  /**
   * Reads seed words from the Keychain. With the app PIN on, Face ID alone is tried first; if it doesn't confirm
   * it's you, the app PIN is asked for, and only then does iOS offer the passcode. Someone who only knows the
   * iPhone passcode can't get past the PIN.
   */
  private async vaultSeed(key: string, prompt: string): Promise<{ value: string | null }> {
    // B: a decoy session that "turned the PIN off" reads as one with no PIN would
    if (!this.pinOn) return ShrikeNative.vaultGet({ key, prompt });
    const session = this.session;
    try {
      return await ShrikeNative.vaultGet({ key, prompt, biometricsOnly: true, fallbackTitle: 'Use PIN' });
    } catch (e) {
      if (errorKind(e) !== 'needs-pin') throw e;
      // A request from a session that has since ended is never shown in the next one
      if (session !== this.session || !(await this.askPin(prompt)) || session !== this.session) throw new Error('Cancelled');
      return ShrikeNative.vaultGet({ key, prompt });
    }
  }

  outputDescriptor(w: WalletRuntime, chain: 0 | 1): string {
    return originDescriptor({ scriptType: w.config.scriptType, xpub: w.config.xpub, fingerprint: w.config.fingerprint, derivation: w.config.derivation }, chain);
  }

  // ------------------------------------------------------------------------------------------- addresses

  freshReceive(w: WalletRuntime): { address: string; index: number } {
    const index = (w.snapshot?.highestUsed[0] ?? -1) + 1;
    return { address: this.addressAt(w, 0, index), index };
  }

  /**
   * Addresses to compare a recipient with: saved contacts, addresses this phone's wallets have paid, and their
   * own used addresses. Payments from others aren't included, since a poisoning payment's addresses are the
   * scammer's.
   */
  knownAddresses(): KnownAddress[] {
    const out: KnownAddress[] = this.networkContacts().map((c) => ({ address: c.address, kind: 'contact' as const, name: c.name }));
    for (const w of this.networkWallets()) {
      for (const t of w.snapshot?.txs ?? []) {
        const sent = t.inputs.some((i) => i.mine);
        for (const o of t.outputs) {
          if (!o.address) continue;
          if (o.mine) out.push({ address: o.address, kind: 'own', name: w.config.name });
          else if (sent) out.push({ address: o.address, kind: 'paid', when: t.time });
        }
      }
    }
    return out;
  }

  /** What a recipient address matches, or looks like without matching. */
  recipientCheck(address: string): RecipientCheck {
    const c = checkRecipient(address, this.knownAddresses());
    if (!c.exact && address.trim() && this.isOwnAddress(address.trim())) c.exact = { address: address.trim(), kind: 'own' };
    return c;
  }

  /** A tiny payment from someone else: the usual way a look-alike address gets into a wallet's history. */
  isDust(t: WalletTx): boolean {
    return !t.coinbase && t.net > 0 && t.net < DUST_SATS && !t.inputs.some((i) => i.mine);
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
    if (signerOf(w.config) === 'krux') throw new Error(`${w.config.name} signs on your Krux, not on this iPhone.`);
    if (draft.unified !== this.replayOptIn()) throw new Error('Replay protection changed since this was built. Go back and review it again.');
    await this.checkSecondFactor(code);
    const rpc = await this.getRpc();
    await this.checkCoinsUnspent(draft, replaces);
    const { value } = await this.vaultSeed(seedKey(w.config.id), 'Sign and send this transaction');
    if (!value) {
      throw new Error('The seed words for this wallet are no longer in the Keychain, which happens if the iPhone passcode was turned off. Remove the wallet and add it again with your seed words.');
    }
    const secret = JSON.parse(value) as { mnemonic: string; passphrase: string };
    const signed = signDraft(draft, secret, w.config.scriptType, w.config.derivation, w.config.fingerprint, NETWORKS[w.config.network]);
    await broadcast(rpc, signed.hex);
    await this.afterBroadcast(w, draft, signed.txid, signed.hex, label, replaces);
    return signed;
  }

  /**
   * Every coin must still be unspent. A replacement's coins are spent by the transaction it replaces, so for those
   * only the confirmed UTXO set is asked; for a normal send the mempool counts too.
   */
  private async checkCoinsUnspent(draft: DraftTransaction, replaces?: string): Promise<void> {
    const rpc = await this.getRpc();
    const checks = await rpc.batch(draft.coins.map((c) => ({ method: 'gettxout', params: [c.txid, c.vout, !replaces] })));
    if (checks.some((r) => !r.ok || r.result == null)) {
      void this.refresh();
      throw new Error('One of these coins has already been spent. The wallet is refreshing; review the payment again.');
    }
  }

  /** After a send reaches the node: spent at once in this wallet's view, before the node's wallet catches up, and labelled. */
  private async afterBroadcast(w: WalletRuntime, draft: DraftTransaction, txid: string, hex: string, label?: string, replaces?: string): Promise<void> {
    addPendingTransaction(w.store, txid, hex, replaces);
    this.recompute(w);
    const txLabel = label ?? draft.outputs.map((o) => o.payment?.label).filter(Boolean).join(', ');
    if (txLabel) w.labels.set('tx', txid, txLabel);
    await this.saveWallet(w);
    await this.touchContacts(draft.outputs.map((o) => o.payment?.address).filter((a): a is string => !!a));
    this.emit();
    void this.refresh();
  }

  // ------------------------------------------------------------------------------------------- Krux hardware wallet
  //
  // A wallet can sign on Paperclip's Krux: the phone builds the transaction and shows it as a PSBT (BBQr codes, or a
  // file for microSD), the Krux shows what it pays and signs it, and the phone reads the signed PSBT back, checks
  // every signature against the wallet's own keys and sends it. The Krux's approval is the check, so no Face ID or
  // two-factor code is asked for these sends.

  /** Reads the key a Krux shows. Throws a HardwareKeyError saying what to change on the Krux. */
  readKruxKey(text: string): HardwareKey {
    return parseHardwareKey(text, this.net);
  }

  /** What a Krux's key is to this phone: a wallet already here, one waiting in a restored backup, or neither. */
  kruxKeyFor(key: HardwareKey): { wallet: WalletRuntime | null; waiting: BackupWallet | null } {
    const wallet = this.networkWallets().find((w) => w.config.xpub === key.xpub) ?? null;
    const waiting = wallet ? null : (this.waitingWallets().find((b) => b.config.xpub === key.xpub) ?? null);
    return { wallet, waiting };
  }

  /** Whether the node already watches this key's addresses, so adding it needs no scan. */
  async kruxOnNode(key: HardwareKey): Promise<boolean> {
    const rpc = await this.getRpc();
    await ensureCormorantWallet(rpc);
    const imported = await listImportedDescriptors(rpc);
    const src = { scriptType: key.scriptType, xpub: key.xpub, fingerprint: key.fingerprint, derivation: key.derivation };
    return imported.has(normalizeDescriptor(cormorantDescriptor(src, 0))) && imported.has(normalizeDescriptor(cormorantDescriptor(src, 1)));
  }

  /** Adds a wallet that signs on the Krux. The phone holds its public key only: no seed words. */
  async addKruxWallet(input: { name: string; key: HardwareKey; rescan: RescanChoice }): Promise<void> {
    const { key } = input;
    const already = this.wallets.find((w) => w.config.xpub === key.xpub && w.config.network === this.settings.network);
    if (already && this.decoy && !this.shows(already)) {
      // Whoever holds the Krux can spend from the wallet anyway; saying it's already here would say more
      this.decoy.wallets.add(already.config.id);
      this.activeId = already.config.id;
      this.emit();
      return;
    }
    if (already) {
      throw new Error(
        signerOf(already.config) === 'phone'
          ? `That’s ${already.config.name}, already on this phone with its seed words. To sign it on the Krux, link the two in Settings, Wallets, ${already.config.name}.`
          : `${already.config.name} is already on this phone, signed on the Krux.`,
      );
    }
    // None in a duress session: a backup restored in a real session stays out of it
    const restored = this.waitingWallets().find((b) => b.config.xpub === key.xpub);
    const config: WalletConfig = {
      id: restored && !this.wallets.some((w) => w.config.id === restored.config.id) ? restored.config.id : randomId(),
      name: input.name.trim() || 'Krux',
      network: this.settings.network,
      scriptType: key.scriptType,
      fingerprint: key.fingerprint,
      derivation: key.derivation,
      xpub: key.xpub,
      gapLimit: restored ? Math.max(DEFAULT_GAP_LIMIT, restored.config.gapLimit) : DEFAULT_GAP_LIMIT,
      createdAt: restored?.config.createdAt ?? Date.now(),
      hasPassphrase: false,
      signer: 'krux',
    };
    const w = this.runtimeFor(config, null);
    if (restored) w.labels = new LabelStore(restored.labels);
    await this.installWallet(w, input.rescan, restored);
  }

  /**
   * Links a wallet whose seed words are on this phone to a Krux holding the same ones, once the Krux's key proves
   * it. removeSeed takes the seed words off this iPhone, so the wallet signs only on the Krux.
   */
  async linkKrux(id: string, key: HardwareKey, removeSeed: boolean): Promise<void> {
    const w = this.walletById(id);
    if (!w) throw new Error('That wallet isn’t on this phone');
    if (signerOf(w.config) === 'krux') throw new Error(`${w.config.name} already signs on the Krux.`);
    const m = matchWallet(key, { ...w.config });
    if (!m.ok) throw new Error(m.reason);
    w.config.signer = removeSeed ? 'krux' : 'both';
    await this.saveWalletList();
    if (removeSeed) await ShrikeNative.vaultDelete({ key: seedKey(id) });
    this.emit();
  }

  /** Stops offering the Krux for a wallet whose seed words are still on this iPhone. */
  async unlinkKrux(id: string): Promise<void> {
    const w = this.walletById(id);
    if (!w || signerOf(w.config) !== 'both') return;
    w.config.signer = 'phone';
    await this.saveWalletList();
    this.emit();
  }

  /** A send waiting for the Krux, kept across a lock. Not shown in another session's place. */
  kruxSigning: KruxSigning | null = null;

  private psbtWallet(w: WalletRuntime, draft: DraftTransaction): PsbtWallet {
    return {
      scriptType: w.config.scriptType,
      fingerprint: w.config.fingerprint,
      derivation: w.config.derivation,
      pubKey: (c, i) => w.key.pubKey(c, i),
      prevTx: (id) => w.store.hex[id],
      ownOutput: (script) => {
        const hex = toHex(script);
        const found = w.index.find(hex);
        if (found) return found;
        if (draft.change && w.index.script(1, draft.change.index) === hex) return { chain: 1, index: draft.change.index };
        return null;
      },
    };
  }

  /** Builds the PSBT for the Krux to sign. Nothing is asked for here: approving it on the Krux is the check. */
  async startKruxSigning(w: WalletRuntime, draft: DraftTransaction, label?: string, replaces?: string): Promise<KruxSigning> {
    if (signerOf(w.config) === 'phone') throw new Error(`${w.config.name} isn’t linked to a Krux.`);
    if (draft.unified !== this.replayOptIn()) throw new Error('Replay protection changed since this was built. Go back and review it again.');
    if (!draft.unified) {
      throw new Error(`Your Krux only signs replay-protected transactions, and right now this one wouldn’t be. ${DECISION_TEXT[this.replayDecision()].reason ?? ''}`.trim());
    }
    await this.checkCoinsUnspent(draft, replaces);
    const psbt = buildPsbt(draft, this.psbtWallet(w, draft));
    this.kruxSigning = { walletId: w.config.id, draft, psbt, label, replaces, signed: null, createdAt: Date.now() };
    this.emit();
    return this.kruxSigning;
  }

  /** Takes the Krux's signed PSBT. Throws, saying what's wrong, unless every signature checks out. */
  acceptKruxSignature(data: Uint8Array): SignedFromDevice {
    const s = this.kruxSigning;
    if (!s) throw new Error('There’s no send waiting for the Krux.');
    const w = this.walletById(s.walletId);
    if (!w) throw new Error('That wallet isn’t on this phone.');
    const signed = finalizeFromDevice(s.draft, this.psbtWallet(w, s.draft), data);
    this.kruxSigning = { ...s, signed };
    this.emit();
    return signed;
  }

  /** Sends what the Krux signed. Returns the txid. */
  async sendKruxSigned(): Promise<string> {
    const s = this.kruxSigning;
    if (!s?.signed) throw new Error('Nothing signed to send yet.');
    const w = this.walletById(s.walletId);
    if (!w) throw new Error('That wallet isn’t on this phone.');
    const rpc = await this.getRpc();
    await this.checkCoinsUnspent(s.draft, s.replaces);
    await broadcast(rpc, s.signed.hex);
    this.kruxSigning = null;
    try {
      await this.afterBroadcast(w, s.draft, s.signed.txid, s.signed.hex, s.label, s.replaces);
    } catch {
      // It's sent: the wallet catches up at the next refresh
      this.emit();
    }
    return s.signed.txid;
  }

  cancelKruxSigning(): void {
    if (!this.kruxSigning) return;
    this.kruxSigning = null;
    this.emit();
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
      .filter((c) => c.network === this.settings.network && (!this.decoy || this.decoy.contacts.has(c.id)))
      .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || a.name.localeCompare(b.name));
  }

  contactFor(address: string): Contact | undefined {
    const a = address.trim();
    return this.networkContacts().find((c) => c.address === a);
  }

  contactById(id: string): Contact | undefined {
    return this.networkContacts().find((c) => c.id === id);
  }

  /** Adds or changes a saved address. The address must be valid on the current network. */
  async saveContact(input: { id?: string; name: string; address: string; note?: string }): Promise<Contact> {
    const name = input.name.trim();
    const address = input.address.trim();
    if (!name) throw new Error('Give it a name');
    decodeAddress(address, this.net);
    const same = this.networkContacts().find((c) => c.address === address && c.id !== input.id);
    if (same) throw new Error(`This address is already saved as ${same.name}`);
    const existing = input.id ? this.contacts.find((c) => c.id === input.id) : undefined;
    const contact: Contact = existing
      ? { ...existing, name, address, note: input.note?.trim() || undefined }
      : { id: randomId(), name, address, network: this.settings.network, note: input.note?.trim() || undefined, createdAt: Date.now() };
    this.contacts = existing ? this.contacts.map((c) => (c.id === contact.id ? contact : c)) : [...this.contacts, contact];
    this.decoy?.contacts.add(contact.id);
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
      note = !h.socks ? 'iOS had closed it while Crossbill was in the background. Reopened' : 'Reconnected';
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
          'iOS closed Tor’s connections while Crossbill was in the background, and this time the app couldn’t reopen them. Close Crossbill (swipe it away in the app switcher) and open it again. Your wallets aren’t affected.',
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

  /** What the widgets were last handed. In a decoy session, what this session would hand them; nothing is sent. */
  get widgetSnapshot(): WidgetSnapshot | null {
    return this.decoy ? buildWidgetSnapshot(this.widgetInput(), this.widgetLast) : this.widgetLast;
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
    // In a decoy session the widgets keep what they had: switching them to the decoy would show on the Home Screen
    if (!this.ready || this.widgetTimer || this.decoy) return;
    this.widgetTimer = setTimeout(() => {
      this.widgetTimer = null;
      void this.sendWidgets();
    }, 400);
  }

  /** Hands the widgets a new snapshot if anything on it changed. One at a time, in order. */
  sendWidgets(): Promise<void> {
    const run = this.widgetQueue.then(async () => {
      if (this.decoy) return;
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

  /** Asks iOS which Crossbill widgets are on screen. A price widget gets the price fetched for it. */
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

  /** A widget was tapped: crossbill://market or crossbill://wallet. Anything else is ignored. */
  openLink(url: string): void {
    const m = /^crossbill:\/\/(market|wallet)\/?$/i.exec(url.trim());
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

  // ------------------------------------------------------------------------------------------- backup
  //
  // One file with everything but secrets, sealed with a password. On a phone with nothing set up, restoring brings
  // back the settings and the node's address; anywhere, it adds contacts and labels. Wallets aren't on the phone
  // until their seed words are entered, so they wait, and get their labels back when they're added.

  /** What a backup of this session holds. In a decoy session, only what the session shows. */
  backupContents(): BackupContents {
    const settings: Partial<Settings> = {};
    for (const k of BACKUP_SETTINGS) (settings as Record<string, unknown>)[k] = this.settings[k];
    const shown = this.wallets.filter((w) => this.shows(w));
    if (settings.widgetWallet && !shown.some((w) => w.config.id === settings.widgetWallet)) settings.widgetWallet = null;
    return {
      kind: 'shrike-backup',
      v: 1,
      app: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
      createdAt: Date.now(),
      settings,
      wallets: shown.map((w) => ({ config: { ...w.config }, labels: w.labels.all(), importedRange: w.importedRange })),
      contacts: this.contacts.filter((c) => !this.decoy || this.decoy.contacts.has(c.id)),
    };
  }

  /** Seals a backup with `password`. Returns the file's text and a name for it. */
  async makeBackup(password: string): Promise<{ text: string; fileName: string }> {
    const text = await encryptBackup(this.backupContents(), password);
    await this.updateSettings({ lastBackupAt: Date.now() });
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { text, fileName: `crossbill-backup-${day}.json` };
  }

  /** When a backup file was made, read before asking for its password. Throws if it isn't one. */
  backupMadeAt(text: string): Date {
    return new Date(readBackupHeader(text).createdAt);
  }

  async openBackup(text: string, password: string): Promise<BackupContents> {
    return checkBackupContents(await decryptBackup(text, password));
  }

  /** Brings a backup's contents onto this phone. Nothing already here is overwritten. */
  async restoreBackup(b: BackupContents): Promise<RestoreSummary> {
    const summary: RestoreSummary = { settings: false, contacts: 0, labels: 0, waiting: [], kruxWaiting: [] };
    if (this.wallets.length === 0 && !this.settings.node && !this.decoy) {
      // Nothing set up yet: the backup's settings, and its node's address (the password is entered again)
      this.settings = { ...this.settings, ...b.settings, skinTier: Math.max(this.settings.skinTier, b.settings.skinTier ?? 0) };
      await writeJson(SETTINGS_FILE, this.settings);
      summary.settings = true;
    }
    const have = new Set(this.contacts.map((c) => `${c.network}:${c.address}`));
    const ids = new Set(this.contacts.map((c) => c.id));
    const shownContacts = new Set(this.networkContacts().map((c) => `${c.network}:${c.address}`));
    for (const c of b.contacts) {
      if (have.has(`${c.network}:${c.address}`)) {
        if (this.decoy && !shownContacts.has(`${c.network}:${c.address}`)) {
          // Whoever restored this file knows the contact; show it, as if it were just added
          const hidden = this.contacts.find((x) => x.network === c.network && x.address === c.address);
          if (hidden) this.decoy.contacts.add(hidden.id);
          summary.contacts++;
        }
        continue;
      }
      const contact = { ...c, id: ids.has(c.id) ? randomId() : c.id };
      this.contacts.push(contact);
      this.decoy?.contacts.add(contact.id);
      have.add(`${c.network}:${c.address}`);
      summary.contacts++;
    }
    if (summary.contacts) await writeJson(CONTACTS_FILE, this.contacts);
    for (const bw of b.wallets) {
      const same = (w: { config: WalletConfig }) => w.config.xpub === bw.config.xpub && w.config.network === bw.config.network;
      const here = this.wallets.find(same);
      if (here) {
        // A hidden wallet in a decoy session is left alone, and reported as if it were waiting
        if (!this.shows(here)) {
          if (signerOf(bw.config) === 'krux') summary.kruxWaiting.push(bw.config.name);
          else summary.waiting.push(bw.config.name);
          continue;
        }
        const known = new Set(here.labels.all().map((r) => `${r.type}:${r.ref}`));
        const fresh = bw.labels.filter((r) => !known.has(`${r.type}:${r.ref}`));
        if (fresh.length) {
          here.labels = new LabelStore([...here.labels.all(), ...fresh]);
          await this.saveWallet(here);
          summary.labels += fresh.length;
        }
      } else {
        if (!this.restoreWaiting.some(same)) this.restoreWaiting.push(bw);
        if (signerOf(bw.config) === 'krux') summary.kruxWaiting.push(bw.config.name);
        else summary.waiting.push(bw.config.name);
      }
    }
    await writeJson(RESTORE_FILE, this.restoreWaiting);
    this.emit();
    return summary;
  }

  /** Wallets from a restored backup on this network, waiting for their seed words. None in a decoy session. */
  waitingWallets(): BackupWallet[] {
    return this.decoy ? [] : this.restoreWaiting.filter((b) => b.config.network === this.settings.network);
  }

  /** The waiting wallet these seed words open, if any. */
  restoreMatch(mnemonic: string, passphrase: string): BackupWallet | null {
    for (const b of this.waitingWallets()) {
      try {
        if (deriveAccount(mnemonic, passphrase, b.config.scriptType, this.net).xpub === b.config.xpub) return b;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Stops waiting for a wallet's seed words. Its labels go with it. */
  async forgetWaiting(xpub: string): Promise<void> {
    this.restoreWaiting = this.restoreWaiting.filter((b) => !(b.config.xpub === xpub && b.config.network === this.settings.network));
    await writeJson(RESTORE_FILE, this.restoreWaiting);
    this.emit();
  }

  // ------------------------------------------------------------------------------------------- app PIN
  //
  // Six digits that stand in for the iPhone passcode when Face ID doesn't work. The Keychain item is the record of
  // whether it's on; settings.appPin mirrors it. Checks run one at a time, and wrong PINs make the next try wait,
  // as wrong two-factor codes do.

  /** The PIN record, or null. Throws if the Keychain can't be read, so checks fail closed. */
  private async readPinRecord(): Promise<PinRecord | null> {
    const { value } = await ShrikeNative.vaultGet({ key: PIN_KEY, prompt: 'Check the PIN' });
    return value ? (JSON.parse(value) as PinRecord) : null;
  }

  private async writePinRecord(r: PinRecord | null): Promise<void> {
    if (r) await ShrikeNative.vaultSet({ key: PIN_KEY, value: JSON.stringify(r), requireAuth: false });
    else await ShrikeNative.vaultDelete({ key: PIN_KEY });
    if (this.settings.appPin !== (r != null)) {
      this.settings = { ...this.settings, appPin: r != null };
      await writeJson(SETTINGS_FILE, this.settings);
    }
  }

  /** At launch, as for two-factor: the Keychain decides whether the PIN is on, and a fresh install drops an old one. */
  private async syncPinFlag(freshInstall: boolean): Promise<void> {
    let r: PinRecord | null;
    try {
      r = await this.readPinRecord();
    } catch {
      return;
    }
    if (freshInstall && r) {
      await ShrikeNative.vaultDelete({ key: PIN_KEY });
      r = null;
    }
    if ((r != null) !== this.settings.appPin) {
      this.settings = { ...this.settings, appPin: r != null };
      await writeJson(SETTINGS_FILE, this.settings);
    }
  }

  /** Seconds before another PIN can be tried, after too many wrong ones. */
  pinWait(): number {
    return Math.max(0, Math.ceil((this.pinDeadline - performance.now()) / 1000));
  }

  private savePinAttempts(): Promise<void> {
    return writeJson(PIN_ATTEMPTS_FILE, { failures: this.pinFailures, remaining: this.pinWait() } satisfies TwoFactorAttempts);
  }

  /** Whether this session was opened with the duress PIN. Only the PIN screens need to know. */
  get inDecoy(): boolean {
    return this.decoy != null;
  }

  /**
   * Checks a PIN, counting wrong ones. 'any' (the lock screen) takes the real or the duress PIN. 'session' takes
   * the one this session was opened with: the duress PIN in a decoy session, the real one otherwise.
   */
  private checkPin(pin: string, which: 'any' | 'session' | 'real'): Promise<'real' | 'duress'> {
    return this.serialPin(async () => {
      const wait = this.pinWait();
      if (wait > 0) throw new Error(`Too many wrong PINs. Try again in ${wait < 90 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.`);
      const rec = await this.readPinRecord();
      if (!rec) throw new Error('The app PIN is off');
      // Both hashes every time, so how long a check takes doesn't say whether a duress PIN exists or matched
      const realMatch = await pinMatches(pin, rec.pin);
      const duressMatch = await pinMatches(pin, rec.duress ?? { salt: rec.pin.salt, hash: '', rounds: rec.pin.rounds });
      let result: PinResult = null;
      if (realMatch) result = 'real';
      else if (rec.duress && duressMatch) result = 'duress';
      const want = which === 'session' ? (this.decoy ? 'duress' : 'real') : which;
      if (result == null || (want !== 'any' && result !== want)) {
        this.pinFailures++;
        this.pinDeadline = performance.now() + lockoutSeconds(this.pinFailures) * 1000;
        await this.savePinAttempts();
        this.emit();
        const left = this.pinWait();
        throw new Error(left > 0 ? `That PIN isn’t right. Try again in ${left < 90 ? `${left} seconds` : `${Math.ceil(left / 60)} minutes`}.` : 'That PIN isn’t right');
      }
      if (this.pinFailures) {
        this.pinFailures = 0;
        this.pinDeadline = 0;
        await this.savePinAttempts();
      }
      return result;
    });
  }

  private serialPin<T>(task: () => Promise<T>): Promise<T> {
    const run = this.pinQueue.then(task, task);
    this.pinQueue = run.catch(() => undefined);
    return run;
  }

  /** Whether the App PIN screen shows the PIN as on. In a decoy session, as that session left it. */
  get pinOn(): boolean {
    return this.decoy ? !this.decoy.pinOff : this.settings.appPin;
  }

  /** Turns the app PIN on. iOS confirms it's you first, with Face ID or the passcode. */
  async setPin(pin: string): Promise<void> {
    const problem = pinProblem(pin);
    if (problem) throw new Error(problem);
    if (this.decoy) {
      // After a pretend "turn off": the new PIN becomes the duress PIN, so it opens this same decoy next time
      if (!this.decoy.pinOff) throw new Error('The app PIN is already on');
      const ok = await ShrikeNative.authenticate({ reason: 'Turn on the app PIN' });
      if (!ok.ok) throw new Error('Cancelled');
      const rec = await this.readPinRecord();
      if (rec?.duress) await this.writePinRecord({ ...rec, duress: { ...(await hashPin(pin)), wallet: rec.duress.wallet } });
      this.decoy.pinOff = false;
      this.emit();
      return;
    }
    if (await this.readPinRecord()) throw new Error('The app PIN is already on');
    const ok = await ShrikeNative.authenticate({ reason: 'Turn on the app PIN' });
    if (!ok.ok) throw new Error('Cancelled');
    await this.writePinRecord({ pin: await hashPin(pin), duress: null, createdAt: Date.now() });
    await ShrikeNative.biometryTrust({ action: 'set' }).catch(() => undefined);
    this.faceIdChanged = false;
    this.emit();
  }

  /** Whether Face ID's faces changed since the PIN was set. Asked by the App PIN screen. */
  async checkFaceId(): Promise<boolean> {
    if (!this.settings.appPin) return false;
    const r = await ShrikeNative.biometryTrust({ action: 'check' }).catch(() => ({ changed: false }));
    if (r.changed !== this.faceIdChanged) {
      this.faceIdChanged = r.changed;
      this.emit();
    }
    return r.changed;
  }

  /** Trusts the faces Face ID accepts now, after a change. Needs the PIN. Pretends in a decoy session. */
  async trustFaceId(current: string): Promise<void> {
    await this.checkPin(current, 'session');
    if (!this.decoy) await ShrikeNative.biometryTrust({ action: 'set' });
    this.faceIdChanged = false;
    this.emit();
  }

  /**
   * Changes the PIN this session was opened with. In a decoy session that's the duress PIN, so the screen looks
   * the same and the real PIN is never touched.
   */
  async changePin(current: string, next: string): Promise<void> {
    const problem = pinProblem(next);
    if (problem) throw new Error(problem);
    const which = await this.checkPin(current, 'session');
    const rec = (await this.readPinRecord())!;
    if (which === 'real') {
      if (rec.duress && (await pinMatches(next, rec.duress))) throw new Error('That’s your duress PIN. Choose a different one.');
      await this.writePinRecord({ ...rec, pin: await hashPin(next) });
    } else if (rec.duress) {
      await this.writePinRecord({ ...rec, duress: { ...(await hashPin(next)), wallet: rec.duress.wallet } });
    }
    this.emit();
  }

  /**
   * Turns the app PIN off, and the duress PIN with it. Needs the PIN. In a decoy session it only looks that way: the
   * screen shows the PIN off until the app locks, and both PINs stay as they were.
   */
  async disablePin(current: string): Promise<void> {
    await this.checkPin(current, 'session');
    if (this.decoy) {
      this.decoy.pinOff = true;
      this.decoy.duressShown = null;
      this.emit();
      return;
    }
    await this.writePinRecord(null);
    await ShrikeNative.biometryTrust({ action: 'clear' }).catch(() => undefined);
    this.faceIdChanged = false;
    this.emit();
  }

  /**
   * The decoy wallet's ID, if a duress PIN is set. In a decoy session, only what that session pretended to set. A
   * duress PIN whose wallet has gone is cleared here.
   */
  async duressWallet(): Promise<string | null> {
    if (this.decoy) return this.decoy.duressShown;
    const rec = await this.readPinRecord().catch(() => null);
    if (rec?.duress && !this.wallets.some((w) => w.config.id === rec.duress!.wallet)) {
      await this.writePinRecord({ ...rec, duress: null });
      return null;
    }
    return rec?.duress?.wallet ?? null;
  }

  /** Sets the duress PIN and the wallet it opens. Needs the app PIN. In a decoy session, only on screen. */
  async setDuress(current: string, pin: string, walletId: string): Promise<void> {
    const problem = pinProblem(pin);
    if (problem) throw new Error(problem);
    if (!this.walletById(walletId)) throw new Error('Choose a wallet on this phone');
    if (this.decoy) {
      await this.checkPin(current, 'session');
      if (pin === current) throw new Error('The duress PIN has to differ from your app PIN');
      this.decoy.duressShown = walletId;
      this.emit();
      return;
    }
    await this.checkPin(current, 'real');
    const rec = (await this.readPinRecord())!;
    if (await pinMatches(pin, rec.pin)) throw new Error('The duress PIN has to differ from your app PIN');
    await this.writePinRecord({ ...rec, duress: { ...(await hashPin(pin)), wallet: walletId } });
    // The Home Screen shows before any PIN is typed: its Balance widget shows the decoy, as the session will
    if (this.settings.widgetBalance) await this.updateSettings({ widgetWallet: walletId === this.networkWallets()[0]?.config.id ? null : walletId });
    this.emit();
  }

  async clearDuress(current: string): Promise<void> {
    if (this.decoy) {
      await this.checkPin(current, 'session');
      this.decoy.duressShown = null;
      this.emit();
      return;
    }
    await this.checkPin(current, 'real');
    const rec = (await this.readPinRecord())!;
    await this.writePinRecord({ ...rec, duress: null });
    this.emit();
  }

  /** Asks the screens for the app PIN. Resolves true once the right one is typed, false if cancelled. */
  private askPin(reason: string): Promise<boolean> {
    this.pinAsk?.resolve(false);
    return new Promise((resolve) => {
      const ask: NonNullable<AppModel['pinAsk']> = {
        reason,
        resolve: (ok) => {
          // A newer request may have taken this one's place; only this one is answered
          if (this.pinAsk === ask) this.pinAsk = null;
          this.emit();
          resolve(ok);
        },
      };
      this.pinAsk = ask;
      this.emit();
    });
  }

  /**
   * That it's you, before money moves without a seed being read (a Lightning payment): Face ID, or the passcode.
   * With the app PIN on, Face ID alone, and the PIN when Face ID doesn't confirm it. Throws "Cancelled".
   */
  async confirmPresence(reason: string): Promise<void> {
    const session = this.session;
    if (this.pinOn) {
      const res = await ShrikeNative.authenticate({ reason, biometricsOnly: true, fallbackTitle: 'Use PIN' });
      if (res.changed && !this.faceIdChanged) {
        this.faceIdChanged = true;
        this.emit();
      }
      if (res.ok && session === this.session) return;
      if (session !== this.session || !(await this.askPin(reason)) || session !== this.session) throw new Error('Cancelled');
      return;
    }
    const res = await ShrikeNative.authenticate({ reason, requirePasscode: true });
    if (res.noPasscode) throw new Error('Set a passcode on this iPhone, or turn on the app PIN, to pay with Lightning.');
    if (!res.ok || session !== this.session) throw new Error('Cancelled');
  }

  /** The PIN typed for a pending request. Throws with a message if it's wrong. */
  async answerPin(pin: string): Promise<void> {
    const ask = this.pinAsk;
    if (!ask) return;
    await this.checkPin(pin, 'session');
    ask.resolve(true);
  }

  cancelPin(): void {
    this.pinAsk?.resolve(false);
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
        throw new Error('That code doesn’t match. Check the authenticator shows the Crossbill entry you just added, and that this iPhone sets its clock automatically.');
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
