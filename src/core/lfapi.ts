// A client for the mobile API of a Lightning Fork node's dashboard (version 1), as Paul Lamb documents it in
// docs/mobile-api.md of github.com/paulscode/umbrel-lightning-fork. The node holds the keys and the funds; this
// phone holds a key to the dashboard that the dashboard can revoke at any time.
//
// Nothing here talks to the network itself: requests go through an LfHttp, which the app backs with the iPhone's
// own HTTP (its LAN, with HTTPS pinned to the node's root certificate) and the embedded Tor (the node's onion).
// Tests back it with a pretend dashboard.

import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';

export const LF_API_VERSION = 1;
/** What this app can show beyond version 1's kinds, sent on /decode: a SHA256 invoice, paid through a service. */
export const LF_CAPABILITIES = 'bitcoin-invoice';
export const LF_FEATURE_QUOTE = 'bitcoin-invoice-quote';
export const LF_FEATURE_SHA256 = 'bitcoin-invoice';

// ------------------------------------------------------------------------------------------- pairing codes

/** The dashboard's pairing QR code: where the node is, the root certificate's SHA-256, and a one-time code. */
export interface PairingCode {
  code: string;
  /** epoch ms the code stops working, by the dashboard's clock */
  exp: number | null;
  onion: string | null;
  lan: string | null;
  ip: string | null;
  /** SHA-256 of the root certificate, colon hex in capitals, as openssl prints it */
  ca: string | null;
}

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

function cleanUrl(v: unknown, onion: boolean): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (onion !== u.hostname.toLowerCase().endsWith('.onion')) return null;
  // Only a host and a port: the API's paths are added here
  return `${u.protocol}//${u.host}`;
}

/** Reads a pairing code as the dashboard shows it: its JSON, or its lightningfork://pair?c= link. Null if it isn't one. */
export function parsePairingCode(text: string): PairingCode | null {
  let s = text.trim();
  const link = /^lightningfork:\/\/pair\?(?:.*&)?c=([A-Za-z0-9_-]+)/i.exec(s);
  if (link) {
    try {
      const b64 = link[1].replace(/-/g, '+').replace(/_/g, '/');
      s = new TextDecoder().decode(base64.decode(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    } catch {
      return null;
    }
  }
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(s);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.lf !== 1) return null;
  const code = typeof o.code === 'string' ? o.code : '';
  if (!code.startsWith('e_') || code.length < 10 || code.length > 80) return null;
  const ca = typeof o.ca === 'string' ? o.ca.trim().toUpperCase() : null;
  const out: PairingCode = {
    code,
    exp: typeof o.exp === 'number' && Number.isFinite(o.exp) ? o.exp : null,
    onion: cleanUrl(o.onion, true),
    lan: cleanUrl(o.lan, false),
    ip: cleanUrl(o.ip, false),
    ca: ca && FINGERPRINT.test(ca) ? ca : null,
  };
  if (!out.onion && !out.lan && !out.ip) return null;
  return out;
}

export function pairingExpired(p: PairingCode, nowMs: number): boolean {
  return p.exp != null && p.exp < nowMs;
}

// ------------------------------------------------------------------------------------------- certificates

/** The DER bytes of the first certificate in a PEM. */
export function pemToDer(pem: string): Uint8Array {
  const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem);
  if (!m) throw new Error('Not a certificate');
  return base64.decode(m[1].replace(/\s+/g, ''));
}

/** A certificate's SHA-256, colon hex in capitals, as the pairing code carries it. */
export function certFingerprint(pem: string): string {
  return Array.from(sha256(pemToDer(pem)), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

export function sameFingerprint(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();
}

// ------------------------------------------------------------------------------------------- routes

export interface LfEndpoints {
  onionUrl: string | null;
  lanUrl: string | null;
  lanIp: string | null;
  /** The root certificate the LAN addresses are pinned to, captured at pairing */
  caPem: string | null;
  /** Its SHA-256, from the pairing code: until the root itself is in hand, a LAN answer is taken only from a
   * server whose chain ends in a certificate with this hash, and that certificate is kept */
  caSha256: string | null;
}

export type LfRoute = 'lan' | 'tor';

export interface LfAttempt {
  route: LfRoute;
  base: string;
}

/**
 * The ways to the node, in the order to try them: the home addresses (only over HTTPS, pinned to the root or, while
 * pairing, to its hash) and the onion. A StartOS onion may serve only HTTPS, so an http one is tried as https too.
 * At home the home addresses go first; away (`lanLikely` false) the onion does, with the home addresses as a
 * fallback for a VPN. Within each, the address that last worked goes first.
 */
export function lfAttempts(e: LfEndpoints, opts: { lanLikely: boolean; last?: string | null }): LfAttempt[] {
  const list: LfAttempt[] = [];
  if (e.caPem || e.caSha256) {
    for (const u of [e.lanUrl, e.lanIp]) if (u && u.startsWith('https://')) list.push({ route: 'lan', base: u });
  }
  if (e.onionUrl) {
    list.push({ route: 'tor', base: e.onionUrl });
    if (e.onionUrl.startsWith('http://')) list.push({ route: 'tor', base: e.onionUrl.replace('http://', 'https://') });
  }
  const preferred: LfRoute = opts.lanLikely ? 'lan' : 'tor';
  const rank = (a: LfAttempt) => (a.route === preferred ? 2 : 0) + (a.base === opts.last ? 1 : 0);
  return list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(y.a) - rank(x.a) || x.i - y.i)
    .map((x) => x.a);
}

// ------------------------------------------------------------------------------------------- transport

export interface LfHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  route: LfRoute;
  /** For a LAN request: the root certificate the server's chain must end in */
  pinPem?: string;
  /** For a LAN request before the root is known: the SHA-256 the last certificate of the server's chain must have.
   * That certificate comes back as `rootPem`. */
  captureRootSha256?: string;
}

export interface LfHttpResponse {
  status: number;
  body: string;
  /** The root captured by `captureRootSha256` */
  rootPem?: string;
}

/** Throws when nothing came back: no connection, a timeout, or a certificate that isn't the pinned one. */
export type LfHttp = (req: LfHttpRequest) => Promise<LfHttpResponse>;

/** An LfHttp failure that says the server's certificate didn't chain to the pinned root. */
export class LfCertificateError extends Error {
  constructor(message = 'The node’s certificate doesn’t match the one this iPhone paired with.') {
    super(message);
  }
}

/** The node answered, but not with success. `message` is the node's own sentence when it gave one. */
export class LfError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
    /** The node's word that money may have moved: ask again with the same request id and resume */
    readonly uncertain = false,
    readonly details: Record<string, unknown> | null = null,
    /** The answer was the node's own ({error, …} in JSON), not a proxy's page in front of it or the app's guess */
    readonly fromNode = false,
  ) {
    super(message);
  }
}

/**
 * Whether an answer to a payment says for sure that this attempt moved no money and never will: a refusal in
 * the node's own words (400, 409, 422), or its 503, which the API gives only when nothing was sent. Anything
 * else, a 502 page from a proxy, a timeout, a 401, an answer that can't be read, says nothing about the
 * payment, which is then asked about again with the same request id.
 */
export function isDefiniteRefusal(e: unknown): boolean {
  return e instanceof LfError && e.fromNode && !e.uncertain && e.code !== 'on_its_way' && [400, 409, 422, 503].includes(e.status);
}

/** No way to the node worked. Nothing came back, so for a call that moves money, it may or may not have arrived. */
export class LfUnreachable extends Error {
  constructor(
    message = 'Can’t reach your Lightning node right now.',
    readonly certificate = false,
  ) {
    super(message);
  }
}

function errorFrom(status: number, body: string): LfError {
  let parsed: { error?: unknown; code?: unknown; uncertain?: unknown; details?: unknown } | null = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const fromNode = typeof parsed?.error === 'string' && parsed.error.trim() ? parsed.error.trim() : null;
  const fallback =
    status === 401
      ? 'Your node no longer accepts this iPhone. Pair it again.'
      : status === 429
        ? 'Too many attempts. Try again in a few minutes.'
        : status === 502 || status === 503 || status === 504
          ? 'Your Lightning node isn’t answering. It may be starting up, or its wallet may be locked.'
          : `Your Lightning node answered with an error (${status}).`;
  return new LfError(
    status,
    fromNode ?? fallback,
    typeof parsed?.code === 'string' && parsed.code ? parsed.code : null,
    parsed?.uncertain === true,
    parsed?.details && typeof parsed.details === 'object' ? (parsed.details as Record<string, unknown>) : null,
    fromNode != null,
  );
}

/** A fresh id for one attempt at moving money: 32 hex digits, within the API's 8 to 64 letters, digits, - and _. */
export function newRequestId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------------------------------- what the API says

export interface LfNodeInfo {
  alias: string;
  pubkey: string;
  color: string;
  version: string;
  network: string;
  syncedToChain: boolean;
  syncedToGraph: boolean;
  blockHeight: number;
  activeChannels: number;
  peers: number;
}

export interface LfPairResponse {
  apiKey: string;
  deviceId: string;
  label: string;
  serverId: string;
  apiVersion: number;
  caPem: string | null;
  caSha256: string | null;
  node: LfNodeInfo | null;
}

export interface LfBitcoinInvoicesSummary {
  configured: boolean;
  label: string;
  onion: boolean;
  premium: number;
}

export interface LfBootstrap {
  serverId: string;
  apiVersion: number;
  deviceId: string;
  label: string;
  node: LfNodeInfo;
  features: string[] | null;
  bitcoinInvoices: LfBitcoinInvoicesSummary | null;
}

export interface LfWallet {
  onchain: { confirmedSat: number; unconfirmedSat: number; lockedSat: number; reservedSat: number; fromChannelsSat?: number };
  lightning: { outboundSat: number; inboundSat: number; pendingOutboundSat: number; inMotionSat?: number };
  syncedToChain: boolean;
  blockHeight: number;
  updatedAt: number;
}

export interface LfFeeRate {
  satPerVbyte: number;
  label: string;
  eta: string;
}

export interface LfFees {
  source: { kind: string; name: string } | null;
  warning: string | null;
  minimumSatPerVbyte: number;
  low: LfFeeRate;
  medium: LfFeeRate;
  high: LfFeeRate;
}

export interface LfReference {
  rate: number;
  premiumAllowed: number;
  premium: number;
  serviceWidening?: number;
  withinLimit: boolean;
  source: string;
}

export interface LfEstimate {
  incomingSat: number;
  feeSat: number;
  maxIncomingSat: number;
  routingFeeLimitSat: number;
  rate: number;
  spread: number;
  minSat?: number | null;
  maxSat?: number | null;
  serviceLabel: string;
  open: boolean;
  refusal?: string | null;
  refusalCode?: string | null;
  /** "own_bridge" when this node pays from its own bridge's SHA256 node */
  source?: string;
  sha256AmountSat?: number;
  sha256RoutingFeeLimitSat?: number;
  sha256AvailableSat?: number;
}

export const OWN_BRIDGE = 'own_bridge';

/** What /decode made of something pasted or scanned. */
export interface LfTarget {
  kind: 'onchain' | 'bolt11' | 'offer' | 'bolt12-invoice' | 'bitcoin-invoice' | 'unsupported';
  request: string;
  amountSat: number | null;
  amountEditable: boolean;
  description: string;
  address?: string;
  addressType?: string;
  label?: string;
  issuer?: string;
  destination?: string;
  paymentHash?: string;
  createdAt?: number;
  expiresAt?: number | null;
  expired?: boolean;
  ours?: boolean;
  message?: string | null;
  messageCode?: string | null;
  fallback?: LfTarget | null;
  /** bitcoin-invoice: the time it has left by the node's clock */
  secondsLeft?: number;
  payable?: boolean;
  estimate?: LfEstimate | null;
  reference?: LfReference | null;
  referenceError?: string | null;
}

export interface LfQuote {
  source: string;
  incomingSat: number;
  feeSat: number | null;
  maxIncomingSat: number;
  routingFeeLimitSat: number;
  expiresAt: number;
  secondsLeft: number;
  minSecondsLeft: number;
  invoiceExpiresAt: number | null;
  invoiceSecondsLeft: number | null;
  serviceLabel: string;
  reference: LfReference | null;
}

export interface LfPayResult {
  status: string;
  paymentHash: string;
  preimage: string;
  amountSat: number;
  feeSat: number;
  bitcoinInvoice?: { amountSat: number; description: string; paymentHash: string; source?: string; sha256FeeSat?: number } | null;
}

export interface LfOnchainEstimate {
  amountSat: number;
  feeSat: number;
  satPerVbyte: number;
  totalSat: number;
  sendAll: boolean;
  reservedSat?: number;
}

export interface LfInvoice {
  paymentRequest: string;
  paymentHash: string;
  amountSat: number | null;
  memo: string;
  createdAt: number;
  expiresAt: number;
  uri: string;
}

export interface LfInvoiceStatus {
  state: 'open' | 'settled' | 'canceled' | 'accepted' | 'expired';
  amountSat: number | null;
  amountPaidSat: number;
  settledAt: number | null;
  expiresAt: number;
}

export interface LfActivityItem {
  id: string;
  kind: 'onchain' | 'lightning';
  direction: 'in' | 'out';
  amountSat: number;
  feeSat: number;
  timestamp: number;
  status: string;
  confirmations?: number;
  description: string;
  reference: string;
  bitcoinInvoice?: { amountSat: number; description: string; serviceLabel: string; state: string; source?: string; sha256FeeSat?: number } | null;
  preimage?: string | null;
}

/** GET /bitcoin-invoices: the service set up for SHA256 invoices (asked for its terms), and the node's own bridge. */
export interface LfSha256Payers extends LfBitcoinInvoicesSummary {
  terms?: { open: boolean; refusal?: string | null; rate?: number; spread?: number; minSat?: number; maxSat?: number } | null;
  error?: string | null;
  ownBridge: { ready: boolean; availableSat: number } | null;
}

// ------------------------------------------------------------------------------------------- the client

export interface LfClientOptions {
  /** Whether the home addresses are worth trying first: the iPhone is on Wi-Fi */
  lanLikely: () => boolean;
  /** Called once a request went through, with the way it went */
  onRoute?: (route: LfRoute, base: string) => void;
  /** Called when the root certificate was captured on the LAN while pairing, to be kept with the endpoints */
  onRoot?: (pem: string) => void;
}

export interface LfCallOptions {
  body?: unknown;
  timeoutMs?: number;
  headers?: Record<string, string>;
  auth?: boolean;
  /** A key other than the paired one, as for unpairing a key the phone just got */
  key?: string;
}

/** Time a call is given beyond the node's own wait, for Tor's extra hops. */
const TOR_SLACK_MS = 30_000;

export class LfClient {
  /** The base URL of the way that last worked */
  last: string | null = null;

  constructor(
    public endpoints: LfEndpoints,
    private readonly http: LfHttp,
    private key: string | null,
    private readonly opts: LfClientOptions,
  ) {}

  setKey(key: string | null): void {
    this.key = key;
  }

  /**
   * One call, over the first way to the node that connects. Any HTTP answer is the node's verdict and is not
   * tried elsewhere; only a failure to connect moves on. A call that moves money carries a request id, so if it
   * reached the node and only its answer was lost, sending it again by another way gets the first outcome.
   */
  async call<T>(method: 'GET' | 'POST', path: string, o: LfCallOptions = {}): Promise<T> {
    const attempts = lfAttempts(this.endpoints, { lanLikely: this.opts.lanLikely(), last: this.last });
    if (attempts.length === 0) throw new LfUnreachable('This iPhone doesn’t know an address for your Lightning node. Pair it again.');
    const auth = o.auth ?? true;
    const key = o.key ?? this.key;
    if (auth && !key) throw new LfError(401, 'This iPhone isn’t paired with a Lightning node.');
    const headers: Record<string, string> = { Accept: 'application/json', ...(o.headers ?? {}) };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = `Bearer ${key}`;
    const money = method === 'POST' && o.body != null && typeof o.body === 'object' && 'requestId' in (o.body as object);
    let body = method === 'POST' ? JSON.stringify(o.body ?? {}) : '';
    let certificate = false;
    let last: unknown = null;
    for (const a of attempts) {
      let res: LfHttpResponse;
      try {
        res = await this.http({
          url: `${a.base}/api/v1${path}`,
          method,
          headers,
          body,
          timeoutMs: (o.timeoutMs ?? 30_000) + (a.route === 'tor' ? TOR_SLACK_MS : 0),
          route: a.route,
          pinPem: a.route === 'lan' ? (this.endpoints.caPem ?? undefined) : undefined,
          captureRootSha256: a.route === 'lan' && !this.endpoints.caPem ? (this.endpoints.caSha256 ?? undefined) : undefined,
        });
      } catch (e) {
        // Only the onion vouches for the far end by itself: a LAN address answering with another certificate
        // may be some other device on another network, so only an onion's mismatch is the node's certificate
        if (e instanceof LfCertificateError && a.route === 'tor') certificate = true;
        last = e;
        // The request may have reached the node before the answer was lost. Sent again by another way, it's a
        // resume, so a node that restarted in between checks for it before paying (a resume with no earlier
        // attempt simply sends)
        if (money && !(e instanceof LfCertificateError)) body = JSON.stringify({ ...(o.body as object), resume: true });
        continue;
      }
      this.last = a.base;
      this.opts.onRoute?.(a.route, a.base);
      // The transport checked the hash already; checking again here costs nothing and keeps a stand-in honest
      if (a.route === 'lan' && !this.endpoints.caPem && res.rootPem && this.endpoints.caSha256) {
        let fp = '';
        try {
          fp = certFingerprint(res.rootPem);
        } catch {
          fp = '';
        }
        if (!sameFingerprint(fp, this.endpoints.caSha256)) throw new LfUnreachable('Your node’s certificate doesn’t match the pairing code. Make a new code in the dashboard.', true);
        this.endpoints = { ...this.endpoints, caPem: res.rootPem };
        this.opts.onRoot?.(res.rootPem);
      }
      if (res.status < 200 || res.status >= 300) throw errorFrom(res.status, res.body);
      try {
        return (res.body ? JSON.parse(res.body) : {}) as T;
      } catch {
        throw new LfError(res.status, 'Your Lightning node sent an answer this app can’t read.');
      }
    }
    if (certificate) throw new LfUnreachable('Your node’s certificate doesn’t match the one this iPhone paired with. Pair it again from the dashboard.', true);
    throw new LfUnreachable(last instanceof Error && /Tor/.test(last.message) ? last.message : undefined);
  }

  pair(code: string, label: string, claimNonce: string): Promise<LfPairResponse> {
    return this.call('POST', '/pair', { body: { enrollCode: code, label, claimNonce }, auth: false, timeoutMs: 30_000 });
  }

  unpair(key?: string): Promise<{ unpaired: boolean }> {
    return this.call('POST', '/unpair', { key, timeoutMs: 20_000 });
  }

  bootstrap(): Promise<LfBootstrap> {
    return this.call('GET', '/bootstrap');
  }

  freshEndpoints(): Promise<{ onionUrl?: string | null; lanUrl?: string | null; lanIp?: string | null; caPem?: string | null; caSha256?: string | null }> {
    return this.call('GET', '/endpoints');
  }

  wallet(): Promise<LfWallet> {
    return this.call('GET', '/wallet');
  }

  fees(): Promise<LfFees> {
    return this.call('GET', '/fees');
  }

  /** A SHA256 invoice's price is asked of the service, over Tor when it's an onion: give it a minute. */
  decode(input: string): Promise<LfTarget> {
    return this.call('POST', '/decode', { body: { input }, headers: { 'X-LF-Capabilities': LF_CAPABILITIES }, timeoutMs: 60_000 });
  }

  quoteBitcoinInvoice(request: string): Promise<LfQuote> {
    return this.call('POST', '/quote/bitcoin-invoice', { body: { request }, timeoutMs: 90_000 });
  }

  /** The service holds the payment until it has paid; after 90 seconds the node answers "on its way" (504). */
  payBitcoinInvoice(b: { request: string; maxIncomingSat: number; requestId: string; resume?: boolean }): Promise<LfPayResult> {
    return this.call('POST', '/pay/bitcoin-invoice', { body: b, timeoutMs: 200_000 });
  }

  /** A route can take a while to find: up to two minutes. */
  pay(b: { request: string; amountSat?: number; payerNote?: string; requestId: string; resume?: boolean }): Promise<LfPayResult> {
    return this.call('POST', '/lightning/pay', { body: b, timeoutMs: 120_000 });
  }

  estimateOnchain(b: { address: string; amountSat?: number; sendAll?: boolean; satPerVbyte: number }): Promise<LfOnchainEstimate> {
    return this.call('POST', '/onchain/estimate', { body: b });
  }

  sendOnchain(b: { address: string; amountSat?: number; sendAll?: boolean; satPerVbyte: number; requestId: string; resume?: boolean }): Promise<{ txid: string; satPerVbyte: number }> {
    return this.call('POST', '/onchain/send', { body: b, timeoutMs: 60_000 });
  }

  receiveAddress(fresh = false): Promise<{ address: string; type: string; uri: string }> {
    return this.call('POST', '/receive/address', { body: { fresh } });
  }

  createInvoice(b: { amountSat?: number; memo?: string; expirySeconds?: number }): Promise<LfInvoice> {
    return this.call('POST', '/receive/invoice', { body: b });
  }

  invoiceStatus(paymentHash: string): Promise<LfInvoiceStatus> {
    return this.call('GET', `/receive/invoice/${encodeURIComponent(paymentHash)}`);
  }

  createOffer(b: { description?: string; amountSat?: number }): Promise<{ offer: string; offerId: string; amountSat: number | null; description: string; uri: string }> {
    return this.call('POST', '/receive/offer', { body: b });
  }

  /** How SHA256 invoices are paid: the node's own bridge and the service, whose terms the node asks for (slow). */
  sha256Payers(): Promise<LfSha256Payers> {
    return this.call('GET', '/bitcoin-invoices', { timeoutMs: 60_000 });
  }

  activity(limit = 50): Promise<{ items: LfActivityItem[] }> {
    return this.call('GET', `/activity?limit=${Math.max(1, Math.min(100, Math.floor(limit)))}`);
  }
}

// ------------------------------------------------------------------------------------------- reading answers

/** Codes after which the money may have moved, so the same request is asked about again rather than retried. */
export function isUncertain(e: unknown): boolean {
  return (e instanceof LfError && (e.uncertain || e.code === 'on_its_way')) || e instanceof LfUnreachable;
}

/**
 * A SHA256 quote's price holds while it has at least minSecondsLeft of secondsLeft, both counted from when the
 * call was sent (the node's clock may not be the phone's). Seconds it can still be paid in, at `nowMs`.
 */
export function quoteSecondsLeft(q: Pick<LfQuote, 'secondsLeft' | 'minSecondsLeft'>, sentAtMs: number, nowMs: number): number {
  return Math.max(0, Math.floor(q.secondsLeft - q.minSecondsLeft - (nowMs - sentAtMs) / 1000));
}
