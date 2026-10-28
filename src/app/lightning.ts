// Lightning, through the person's own Lightning Fork node: Crossbill pairs with the node's dashboard and uses its
// mobile API (src/core/lfapi.ts). The node holds the keys and the money; this iPhone holds a key to the dashboard,
// which the dashboard can revoke at any time, in the Keychain.
//
// Every payment needs Face ID (or the app PIN) and, with two-factor on, a code. A payment whose outcome the node
// couldn't report yet is written down before it is sent and asked about again with the same request id, never
// sent as a new one.

import {
  certFingerprint,
  isDefiniteRefusal,
  LF_FEATURE_QUOTE,
  LfCertificateError,
  LfClient,
  LfError,
  LfUnreachable,
  newRequestId,
  OWN_BRIDGE,
  pairingExpired,
  parsePairingCode,
  sameFingerprint,
  type LfActivityItem,
  type LfBootstrap,
  type LfEndpoints,
  type LfFees,
  type LfHttp,
  type LfInvoice,
  type LfInvoiceStatus,
  type LfOnchainEstimate,
  type LfPayResult,
  type LfQuote,
  type LfRoute,
  type LfSha256Payers,
  type LfTarget,
  type LfWallet,
  type PairingCode,
} from '../core/lfapi';
import { errorKind, ShrikeNative, type NetworkPath } from './native';
import { readJson, removeJson, writeJson } from './storage';
import { isServer } from './target';

export const LIGHTNING_FILE = 'lightning.json';
export const LIGHTNING_PENDING_FILE = 'lightning-pending.json';
/** The dashboard's key for this iPhone, in the Keychain. Read without Face ID: every payment asks for it anyway */
export const LIGHTNING_KEY = 'lightning.apiKey';

/** What the app keeps about the paired node. No secret: the key is in the Keychain. */
export interface LightningLink {
  serverId: string;
  deviceId: string;
  /** What the dashboard lists this iPhone as */
  label: string;
  alias: string;
  endpoints: LfEndpoints;
  pairedAt: number;
  features: string[];
  /** The address that last answered */
  last: string | null;
}

export type PendingKind = 'lightning' | 'bitcoin-invoice' | 'onchain';

/** A payment sent without a final answer yet. Kept on disk until the node gives one. */
export interface PendingPayment {
  kind: PendingKind;
  requestId: string;
  body: Record<string, unknown>;
  startedAt: number;
  /** In words, for the banner: "1,250 sats to Steak n Shake" */
  summary: string;
  /** The node's own words about it, the last time it was asked */
  note: string | null;
  /** The pairing it was sent under. Request ids belong to one device's key, so it's only asked about under it */
  serverId: string;
  deviceId: string;
  /**
   * The node said it has this payment ("on its way", or not sure how it went): asking again only checks on it,
   * and Crossbill does that by itself. Otherwise the node may never have received it, and asking again would
   * pay it then, so Crossbill waits to be asked.
   */
  known: boolean;
}

/** What asking about a pending payment again would do. */
export type PendingCheck =
  /** Only check: the node has it */
  | 'check'
  /** Check, and pay it now if the node never got it */
  | 'check-or-pay'
  /** It was sent under an earlier pairing, so this iPhone can no longer ask about it */
  | 'other-pairing';

export type PaymentOutcome =
  | { kind: 'paid'; result: LfPayResult }
  | { kind: 'sent'; txid: string }
  /** It may still go through: the node is finishing it, or it couldn't be asked. Kept as pending */
  | { kind: 'waiting'; note: string };

export interface LightningState {
  link: LightningLink | null;
  bootstrap: LfBootstrap | null;
  wallet: LfWallet | null;
  activity: LfActivityItem[] | null;
  loading: boolean;
  /** Why the last refresh failed, in words */
  error: string | null;
  /** The node no longer accepts this iPhone's key, or its certificate changed: pairing again is the way out */
  needsPairing: string | null;
  route: LfRoute | null;
  updatedAt: number;
  pending: PendingPayment | null;
  /** How the node pays SHA256 invoices */
  sha256: LfSha256Payers | null;
}

/** What the controller needs from the rest of the app. */
export interface LightningHost {
  /** The embedded Tor exists here: the iPhone app */
  torAvailable(): boolean;
  /** Starts Tor, or reopens what iOS took back while the app was suspended */
  ensureTor(): Promise<void>;
  /** The duress PIN opened the app: Lightning doesn't exist in this session */
  inDecoy(): boolean;
  /** Face ID, or the app PIN when Face ID doesn't confirm it's you. Throws "Cancelled" */
  confirmPresence(reason: string): Promise<void>;
  /** Uses up a two-factor code when two-factor is on; nothing otherwise */
  checkSecondFactor(code: string | undefined): Promise<void>;
  changed(): void;
  /** The activity was just read, for notifications */
  sawActivity?(items: LfActivityItem[]): Promise<void>;
  /** Background checks are on: the key must be readable while the iPhone is locked */
  readableInBackground?(): boolean;
}

/** How long a check that the home address answers is believed. */
const LAN_CHECK_MS = 60_000;
/** How long the home address gets to answer that check. */
const LAN_PROBE_MS = 4_000;
/** How the dashboard lists this pairing */
const DEVICE_LABEL = isServer ? 'Crossbill on StartOS' : 'Crossbill on iPhone';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function randomNonce(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** A Lightning error in words for the screens. */
export function lightningError(e: unknown): string {
  if (e instanceof LfError || e instanceof LfUnreachable) return e.message;
  if (e instanceof Error) {
    if (/Tor is not connected/i.test(e.message)) return 'Tor isn’t connected yet. Try again in a moment.';
    return e.message;
  }
  return String(e);
}

export class LightningController {
  state: LightningState = { link: null, bootstrap: null, wallet: null, activity: null, loading: false, error: null, needsPairing: null, route: null, updatedAt: 0, pending: null, sha256: null };
  private key: string | null = null;
  private client: LfClient | null = null;
  private lan: { ok: boolean; at: number; path: string } | null = null;
  private path: NetworkPath | null = null;
  private refreshing: Promise<void> | null = null;
  private pendingQueue: Promise<unknown> = Promise.resolve();
  /** A payment is being approved or sent: no second one starts meanwhile */
  private sending = false;
  /** When the payer info and the node's addresses were last read */
  private slowAt = 0;

  constructor(private readonly host: LightningHost) {}

  // ------------------------------------------------------------------------------------------- state

  get paired(): boolean {
    return this.state.link != null && !this.host.inDecoy();
  }

  /** Whether the node can price and pay SHA256 invoices with a firm quote first. */
  get quotes(): boolean {
    return (this.state.bootstrap?.features ?? this.state.link?.features ?? []).includes(LF_FEATURE_QUOTE);
  }

  private set(patch: Partial<LightningState>): void {
    this.state = { ...this.state, ...patch };
    this.host.changed();
  }

  /**
   * The key is readable without asking, and only while the iPhone has a passcode. With background checks on it can
   * also be read while the iPhone is locked, which iOS can't combine with the passcode condition.
   */
  private async storeKey(key: string, background: boolean): Promise<void> {
    // Both: the plugin refuses unless the iPhone has a passcode, then stores it readable after the first unlock
    await ShrikeNative.vaultSet({ key: LIGHTNING_KEY, value: key, requireAuth: false, whenPasscodeSet: true, afterFirstUnlock: background });
  }

  /** Stores the key again for background checks being turned on or off. Nothing to do when not paired. */
  async storeKeyAgain(background: boolean): Promise<void> {
    if (!this.state.link) return;
    const key = await this.keyOrNull();
    if (!key) return;
    try {
      await this.storeKey(key, background);
    } catch (e) {
      // Turning off with the passcode removed since: the key can't be kept without one, as when it was stored
      // that way to begin with and iOS removed it with the passcode
      if (background || (e as { code?: string }).code !== 'no-passcode') throw e;
      await ShrikeNative.vaultDelete({ key: LIGHTNING_KEY }).catch(() => undefined);
      this.key = null;
      this.client = null;
      this.set({ needsPairing: 'This iPhone has no passcode now, so its key for your Lightning node was removed. Set a passcode and pair again.' });
    }
  }

  async init(): Promise<void> {
    const link = await readJson<LightningLink>(LIGHTNING_FILE);
    const pending = await readJson<PendingPayment>(LIGHTNING_PENDING_FILE);
    this.state = { ...this.state, link, pending };
  }

  /** The key, or null when there's none. Throws when it's there but can't be read now, as while the iPhone is locked. */
  private async keyOrNull(): Promise<string | null> {
    if (this.key) return this.key;
    let r: { value: string | null };
    try {
      r = await ShrikeNative.vaultGet({ key: LIGHTNING_KEY, prompt: 'Use your Lightning node' });
    } catch {
      throw new Error('Crossbill couldn’t read its key for your Lightning node just now. Try again in a moment.');
    }
    this.key = r.value;
    return this.key;
  }

  private async api(): Promise<LfClient> {
    const link = this.state.link;
    if (!link || this.host.inDecoy()) throw new Error('Crossbill isn’t paired with a Lightning node.');
    const key = await this.keyOrNull();
    if (!key) throw new LfError(401, 'This iPhone’s key for your Lightning node is missing. Pair it again.');
    if (!this.client) {
      this.client = new LfClient(link.endpoints, this.http, key, {
        lanLikely: () => this.lan?.ok ?? false,
        onRoute: (route, base) => this.noteRoute(route, base),
      });
      this.client.last = link.last;
    } else {
      this.client.setKey(key);
    }
    await this.checkLan(this.client);
    return this.client;
  }

  private noteRoute(route: LfRoute, base: string): void {
    if (route === 'lan') this.lan = { ok: true, at: Date.now(), path: this.pathKey() };
    if (this.state.route !== route) this.set({ route });
    const link = this.state.link;
    if (link && link.last !== base) {
      const next = { ...link, last: base };
      this.state = { ...this.state, link: next };
      void writeJson(LIGHTNING_FILE, next);
    }
  }

  // ------------------------------------------------------------------------------------------- transport

  /** The iPhone's own HTTP: the home address over HTTPS pinned to the node's root, the onion through Tor. */
  private http: LfHttp = async (req) => {
    const tor = req.route === 'tor';
    if (tor) {
      if (!this.host.torAvailable()) throw new Error('Tor runs in the iPhone app only');
      await this.host.ensureTor();
    }
    const send = () =>
      ShrikeNative.httpRequest({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        timeoutMs: req.timeoutMs,
        useTor: tor,
        pinPem: req.pinPem,
        captureRootSha256: req.captureRootSha256,
        noRedirect: true,
      });
    try {
      return await send();
    } catch (e) {
      if (errorKind(e) === 'certificate') throw new LfCertificateError();
      // Tor's port on this iPhone refused the connection, so the request never left it: reopen and send again
      if (tor && errorKind(e) === 'refused') {
        await ShrikeNative.torRepair({ newCircuit: false }).catch(() => undefined);
        await this.host.ensureTor();
        return send();
      }
      throw e;
    }
  };

  private pathKey(): string {
    const p = this.path;
    if (!p) return 'unknown';
    return p.wifi ? 'wifi' : p.wired ? 'wired' : p.cellular ? 'cellular' : 'other';
  }

  /**
   * Whether the home address answers, checked at most once a minute and again whenever the iPhone changes
   * networks. Away from Wi-Fi it isn't tried first. A quick answer here keeps a payment from waiting out a long
   * timeout on a café's Wi-Fi before going through Tor.
   */
  private async checkLan(client: LfClient): Promise<void> {
    try {
      this.path = await ShrikeNative.networkPath();
    } catch {
      this.path = null;
    }
    const key = this.pathKey();
    const p = this.path;
    const homeish = !p || !p.known || p.wifi || p.wired;
    const e = client.endpoints;
    const lanUrls = [e.lanUrl, e.lanIp].filter((u): u is string => !!u && u.startsWith('https://'));
    if (!homeish || !e.caPem || lanUrls.length === 0) {
      this.lan = { ok: false, at: Date.now(), path: key };
      return;
    }
    if (this.lan && this.lan.path === key && Date.now() - this.lan.at < LAN_CHECK_MS) return;
    let ok = false;
    for (const base of lanUrls) {
      try {
        await this.http({ url: `${base}/api/v1/bootstrap`, method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${this.key}` }, body: '', timeoutMs: LAN_PROBE_MS, route: 'lan', pinPem: e.caPem });
        ok = true;
        break;
      } catch {
        // not at home, or the node is down: the onion goes first
      }
    }
    this.lan = { ok, at: Date.now(), path: key };
  }

  // ------------------------------------------------------------------------------------------- pairing

  /** Reads a pairing code. Throws with words when it isn't one, or has run out. */
  readPairingCode(text: string): PairingCode {
    const code = parsePairingCode(text);
    if (!code) throw new Error('That isn’t a Lightning Fork pairing code. In the dashboard, open Mobile app, then Pair a phone.');
    if (pairingExpired(code, Date.now())) throw new Error('That pairing code has run out. Make a new one in the dashboard: each works for five minutes.');
    if (!code.ca && !code.onion) throw new Error('That pairing code has no certificate and no onion address, so there’s no safe way to reach the node.');
    return code;
  }

  /**
   * Pairs with the node a code points to. At home it pins the root certificate whose hash the code carries; away,
   * it goes through the onion. A lost answer is claimed again with the same nonce, which voids the first key.
   */
  async pair(text: string): Promise<LightningLink> {
    // A duress session never pairs; it fails the way an unreachable node would
    if (this.host.inDecoy()) {
      await sleep(2500);
      throw new LfUnreachable();
    }
    const code = this.readPairingCode(text);
    try {
      this.path = await ShrikeNative.networkPath();
    } catch {
      this.path = null;
    }
    // At home, a quick look at the home address takes the root certificate whose hash the code carries; that root
    // is pinned from then on. Anywhere else, or if it doesn't answer, the onion carries the pairing
    let caPem: string | null = null;
    const p = this.path;
    if (code.ca && (!p || !p.known || p.wifi || p.wired)) {
      // The first look at the home network brings up iOS's Local Network question, and fails until it's answered.
      // With no onion to fall back on, look again for a while
      const tries = code.onion ? 1 : 6;
      for (let i = 0; i < tries && !caPem; i++) {
        if (i > 0) await sleep(3000);
        for (const base of [code.lan, code.ip]) {
          if (!base || !base.startsWith('https://')) continue;
          try {
            const r = await this.http({ url: `${base}/api/v1/bootstrap`, method: 'GET', headers: { Accept: 'application/json' }, body: '', timeoutMs: LAN_PROBE_MS, route: 'lan', captureRootSha256: code.ca });
            if (r.rootPem && sameFingerprint(certFingerprint(r.rootPem), code.ca)) {
              caPem = r.rootPem;
              break;
            }
          } catch {
            // another network, the node is down, or iOS hasn't been allowed to look yet
          }
        }
      }
    }
    const endpoints: LfEndpoints = { onionUrl: code.onion, lanUrl: code.lan, lanIp: code.ip, caPem, caSha256: code.ca };
    let captured: string | null = null;
    const client = new LfClient(endpoints, this.http, null, {
      lanLikely: () => caPem != null,
      onRoot: (pem) => (captured = pem),
    });
    this.lan = caPem ? { ok: true, at: Date.now(), path: this.pathKey() } : null;
    const nonce = randomNonce();
    let res;
    try {
      res = await client.pair(code.code, DEVICE_LABEL, nonce);
    } catch (e) {
      if (e instanceof LfError && e.status === 401) throw new LfError(401, 'The node didn’t accept that code. It may have been used or run out: make a new one in the dashboard.');
      if (e instanceof LfUnreachable && !e.certificate) {
        // The answer may have been lost on its way back: the same code and nonce can be claimed again for two minutes
        await sleep(1500);
        res = await client.pair(code.code, DEVICE_LABEL, nonce);
      } else {
        throw e;
      }
    }
    // The root the node names must be the one the code vouches for, whichever way the answer came
    caPem = captured ?? client.endpoints.caPem;
    if (res.caPem) {
      let fp = '';
      try {
        fp = certFingerprint(res.caPem);
      } catch {
        fp = '';
      }
      if (code.ca && !sameFingerprint(fp, code.ca)) {
        await client.unpair(res.apiKey).catch(() => undefined);
        throw new Error('The node’s certificate doesn’t match the pairing code, so Crossbill didn’t pair. Make a new code in the dashboard and try again.');
      }
      if (!caPem && (!code.ca || sameFingerprint(fp, code.ca))) caPem = res.caPem;
    }
    if (code.ca && caPem && !sameFingerprint(certFingerprint(caPem), code.ca)) caPem = null;
    const link: LightningLink = {
      serverId: res.serverId,
      deviceId: res.deviceId,
      label: res.label,
      alias: res.node?.alias ?? '',
      endpoints: { ...client.endpoints, caPem, caSha256: code.ca ?? res.caSha256 ?? null },
      pairedAt: Date.now(),
      features: [],
      last: client.last,
    };
    try {
      await this.storeKey(res.apiKey, this.host.readableInBackground?.() ?? false);
    } catch (e) {
      await client.unpair(res.apiKey).catch(() => undefined);
      throw e;
    }
    this.key = res.apiKey;
    this.client = null;
    await writeJson(LIGHTNING_FILE, link);
    this.set({ link, bootstrap: null, wallet: null, activity: null, error: null, needsPairing: null });
    // Addresses the code left out (an onion added since), and what the node can do
    try {
      const api = await this.api();
      const fresh = await api.freshEndpoints().catch(() => null);
      if (fresh) await this.adoptEndpoints(fresh);
      const boot = await api.bootstrap();
      await this.saveLink({ ...this.state.link!, features: boot.features ?? [], alias: boot.node?.alias ?? link.alias });
      this.set({ bootstrap: boot });
    } catch {
      // Paired all the same; the Lightning tab tries again
    }
    void this.refresh();
    return this.state.link!;
  }

  private async saveLink(link: LightningLink): Promise<void> {
    await writeJson(LIGHTNING_FILE, link);
    this.set({ link });
  }

  /** The node's current addresses. A certificate is only ever taken when it is the root already pinned. */
  private async adoptEndpoints(fresh: { onionUrl?: string | null; lanUrl?: string | null; lanIp?: string | null; caSha256?: string | null }): Promise<void> {
    const link = this.state.link;
    if (!link) return;
    const e = link.endpoints;
    if (fresh.caSha256 && e.caSha256 && !sameFingerprint(fresh.caSha256, e.caSha256)) return;
    const clean = (v: string | null | undefined, onion: boolean) => {
      if (!v) return null;
      try {
        const u = new URL(v);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        if (onion !== u.hostname.endsWith('.onion')) return null;
        return `${u.protocol}//${u.host}`;
      } catch {
        return null;
      }
    };
    const next: LfEndpoints = {
      ...e,
      onionUrl: clean(fresh.onionUrl, true) ?? e.onionUrl,
      lanUrl: clean(fresh.lanUrl, false) ?? e.lanUrl,
      lanIp: clean(fresh.lanIp, false) ?? e.lanIp,
    };
    if (JSON.stringify(next) === JSON.stringify(e)) return;
    this.client = null;
    await this.saveLink({ ...link, endpoints: next });
  }

  /** Removes this iPhone from the node (when it can be asked) and forgets the node here either way. */
  async unpair(): Promise<{ removedThere: boolean }> {
    let removedThere = false;
    try {
      const api = await this.api();
      await api.unpair();
      removedThere = true;
    } catch {
      removedThere = false;
    }
    await this.forget();
    return { removedThere };
  }

  async forget(): Promise<void> {
    await ShrikeNative.vaultDelete({ key: LIGHTNING_KEY }).catch(() => undefined);
    await removeJson(LIGHTNING_FILE);
    await removeJson(LIGHTNING_PENDING_FILE);
    this.slowAt = 0;
    this.key = null;
    this.client = null;
    this.lan = null;
    this.state = { link: null, bootstrap: null, wallet: null, activity: null, loading: false, error: null, needsPairing: null, route: null, updatedAt: 0, pending: null, sha256: null };
    this.host.changed();
  }

  // ------------------------------------------------------------------------------------------- reading

  /** Balances, activity, and once in a while what the node can do. One at a time. */
  /** With resume false (a background check), a payment waiting for an answer is left for when the app is open. */
  refresh(opts: { resume?: boolean } = {}): Promise<void> {
    if (!this.paired) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      this.set({ loading: true });
      try {
        const api = await this.api();
        const [wallet, activity] = await Promise.all([api.wallet(), api.activity(40)]);
        let bootstrap = this.state.bootstrap;
        let sha256 = this.state.sha256;
        if (!bootstrap || !sha256 || Date.now() - this.slowAt > 10 * 60_000) {
          this.slowAt = Date.now();
          // Asks the service for its terms, over Tor when it's an onion: not on every refresh
          sha256 = await api.sha256Payers().catch(() => sha256);
          bootstrap = await api.bootstrap().catch(() => bootstrap);
          if (bootstrap && this.state.link) {
            const features = bootstrap.features ?? [];
            if (JSON.stringify(features) !== JSON.stringify(this.state.link.features)) await this.saveLink({ ...this.state.link, features });
          }
          const fresh = await api.freshEndpoints().catch(() => null);
          if (fresh) await this.adoptEndpoints(fresh);
        }
        this.set({ wallet, activity: activity.items, bootstrap, sha256, error: null, needsPairing: null, updatedAt: Date.now() });
        await this.host.sawActivity?.(activity.items).catch(() => undefined);
      } catch (e) {
        this.set({ error: lightningError(e), needsPairing: this.pairingProblem(e) });
      } finally {
        this.refreshing = null;
        this.set({ loading: false });
      }
      const p = this.state.pending;
      if (p && opts.resume !== false && !this.state.error && this.pendingCheck(p) === 'check') void this.resumePending();
    })();
    return this.refreshing;
  }

  /** How SHA256 invoices are paid, asked now: the node asks its service for its terms. */
  async readSha256Payers(): Promise<void> {
    try {
      const sha256 = await (await this.api()).sha256Payers();
      this.set({ sha256 });
    } catch {
      // the last reading stays
    }
  }

  private pairingProblem(e: unknown): string | null {
    if (e instanceof LfError && e.status === 401) return e.message;
    if (e instanceof LfUnreachable && e.certificate) return e.message;
    return null;
  }

  async decode(input: string): Promise<LfTarget> {
    const api = await this.api();
    return api.decode(input.trim());
  }

  async quote(request: string): Promise<LfQuote> {
    const api = await this.api();
    return api.quoteBitcoinInvoice(request);
  }

  async fees(): Promise<LfFees> {
    return (await this.api()).fees();
  }

  async estimateOnchain(b: { address: string; amountSat?: number; sendAll?: boolean; satPerVbyte: number }): Promise<LfOnchainEstimate> {
    return (await this.api()).estimateOnchain(b);
  }

  // ------------------------------------------------------------------------------------------- receiving

  async createInvoice(b: { amountSat?: number; memo?: string }): Promise<LfInvoice> {
    return (await this.api()).createInvoice({ ...b, expirySeconds: 3600 });
  }

  async invoiceStatus(paymentHash: string): Promise<LfInvoiceStatus> {
    return (await this.api()).invoiceStatus(paymentHash);
  }

  async receiveAddress(fresh = false): Promise<{ address: string; type: string; uri: string }> {
    return (await this.api()).receiveAddress(fresh);
  }

  async createOffer(b: { description?: string; amountSat?: number }) {
    return (await this.api()).createOffer(b);
  }

  // ------------------------------------------------------------------------------------------- paying

  /** The two-factor code when it's on, then Face ID (or the app PIN), as a send from the wallet asks. Nothing is paid without both. */
  async approve(reason: string, code?: string): Promise<void> {
    if (this.host.inDecoy()) throw new LfUnreachable();
    await this.host.checkSecondFactor(code);
    await this.host.confirmPresence(reason);
  }

  /** A Lightning invoice or offer of this chain. */
  payLightning(p: { request: string; amountSat?: number; payerNote?: string; summary: string; code?: string }): Promise<PaymentOutcome> {
    const body: Record<string, unknown> = { request: p.request };
    if (p.amountSat != null) body.amountSat = p.amountSat;
    if (p.payerNote) body.payerNote = p.payerNote;
    return this.send('lightning', body, p.summary, `Pay ${p.summary}`, p.code);
  }

  /**
   * A Lightning invoice on the SHA256 chain. Paid from the node's own bridge when it runs one (maxIncomingSat 0),
   * otherwise through its service, at no more than the price the person agreed to.
   */
  payBitcoinInvoice(p: { request: string; maxIncomingSat: number; summary: string; code?: string; stillValid?: () => boolean }): Promise<PaymentOutcome> {
    return this.send('bitcoin-invoice', { request: p.request, maxIncomingSat: p.maxIncomingSat }, p.summary, `Pay ${p.summary}`, p.code, p.stillValid);
  }

  sendOnchain(p: { address: string; amountSat?: number; sendAll?: boolean; satPerVbyte: number; summary: string; code?: string }): Promise<PaymentOutcome> {
    const body: Record<string, unknown> = { address: p.address, satPerVbyte: p.satPerVbyte };
    if (p.sendAll) body.sendAll = true;
    else body.amountSat = p.amountSat;
    return this.send('onchain', body, p.summary, `Send ${p.summary}`, p.code);
  }

  private async send(kind: PendingKind, body: Record<string, unknown>, summary: string, reason: string, code?: string, stillValid?: () => boolean): Promise<PaymentOutcome> {
    if (this.state.pending || this.sending) throw new Error('An earlier payment hasn’t finished yet. Check on it first, at the top of the Lightning tab.');
    this.sending = true;
    try {
      await this.approve(reason, code);
      if (stillValid && !stillValid()) throw new Error('The price ran out while you confirmed. Get a new price, then pay.');
      const link = this.state.link;
      if (!link || this.host.inDecoy()) throw new LfUnreachable();
      const pending: PendingPayment = { kind, requestId: newRequestId(), body, startedAt: Date.now(), summary, note: null, serverId: link.serverId, deviceId: link.deviceId, known: false };
      // Written down before it's sent: if the app ends before the answer, it's asked about, never sent again as new
      await writeJson(LIGHTNING_PENDING_FILE, pending);
      this.set({ pending });
      return await this.enqueue(() => this.attempt(pending, false));
    } finally {
      this.sending = false;
    }
  }

  /** What asking about a pending payment again would do, under the current pairing. */
  pendingCheck(p: PendingPayment): PendingCheck {
    const l = this.state.link;
    if (!l || l.serverId !== p.serverId || l.deviceId !== p.deviceId) return 'other-pairing';
    return p.known ? 'check' : 'check-or-pay';
  }

  /**
   * Asks the node about the payment written down as pending, with its request id. When the node may never have
   * received it, this pays it now, so it's only done when the person asks.
   */
  resumePending(): Promise<PaymentOutcome | null> {
    return this.enqueue(async () => {
      const p = this.state.pending;
      if (!p || !this.paired || this.pendingCheck(p) === 'other-pairing') return null;
      return this.attempt(p, true);
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.pendingQueue.then(task);
    this.pendingQueue = run.catch(() => undefined);
    return run;
  }

  private async attempt(p: PendingPayment, resume: boolean): Promise<PaymentOutcome> {
    const body = { ...p.body, requestId: p.requestId, ...(resume ? { resume: true } : {}) };
    try {
      const api = await this.api();
      let outcome: PaymentOutcome;
      if (p.kind === 'onchain') {
        const r = await api.sendOnchain(body as Parameters<LfClient['sendOnchain']>[0]);
        outcome = { kind: 'sent', txid: r.txid };
      } else if (p.kind === 'bitcoin-invoice') {
        outcome = { kind: 'paid', result: await api.payBitcoinInvoice(body as Parameters<LfClient['payBitcoinInvoice']>[0]) };
      } else {
        outcome = { kind: 'paid', result: await api.pay(body as Parameters<LfClient['pay']>[0]) };
      }
      await this.clearPending(p.requestId);
      void this.refresh();
      return outcome;
    } catch (e) {
      // A refusal in the node's own words: nothing more will come of this attempt
      if (isDefiniteRefusal(e)) {
        await this.clearPending(p.requestId);
        throw e;
      }
      // Anything else says nothing about the money: it's kept, and asked about with the same id
      const known = p.known || (e instanceof LfError && e.fromNode && (e.uncertain || e.code === 'on_its_way'));
      const note = waitingNote(e, p.kind, known);
      if (this.state.pending?.requestId === p.requestId) {
        const next = { ...p, note, known };
        await writeJson(LIGHTNING_PENDING_FILE, next);
        this.set({ pending: next });
      }
      return { kind: 'waiting', note };
    }
  }

  /** Clears the pending record, if it is still the one for this request. */
  private async clearPending(requestId?: string): Promise<void> {
    if (requestId && this.state.pending?.requestId !== requestId) return;
    await removeJson(LIGHTNING_PENDING_FILE);
    this.set({ pending: null });
  }

  /**
   * Gives up asking about a pending payment, after the person checked the activity. The node still decides what
   * happened to it; this only stops Crossbill asking.
   */
  async dismissPending(): Promise<void> {
    await this.clearPending();
  }
}

/** What to say while a payment's outcome isn't known yet. */
function waitingNote(e: unknown, kind: PendingKind, known: boolean): string {
  if (e instanceof LfError && e.code === 'on_its_way') {
    const hours = Number(e.details?.maxHoldHours);
    return kind === 'bitcoin-invoice' && Number.isFinite(hours) && hours > 0
      ? `On its way. The service is paying the invoice. If it never does, the payment comes back to your node within about ${Math.ceil(hours)} hours.`
      : 'On its way. Your node is still finishing it.';
  }
  if (known && e instanceof LfError && e.fromNode) return e.message;
  return 'Crossbill couldn’t hear back from your node, so it can’t tell whether this was paid. Check your node’s activity before paying again.';
}

/** Whether a SHA256 invoice is paid from the node's own bridge: BTC from its SHA256 node, nothing of this chain. */
export function fromOwnBridge(x: { source?: string | null } | null | undefined): boolean {
  return x?.source === OWN_BRIDGE;
}
