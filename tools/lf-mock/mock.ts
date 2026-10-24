// A pretend Lightning Fork dashboard: the mobile API (version 1) as docs/mobile-api.md of
// github.com/paulscode/umbrel-lightning-fork describes it, kept in memory, with no Lightning behind it. The tests
// call handle() directly; server.ts serves it to the browser version of the app. Nothing here is real money.
//
// Invoices are pretend too. A "SHA256" one carries "sha" after its amount (lnbc12500n1psha…), and this node treats
// any other lnbc… as one of its own chain. sample() makes them.

import { createHash, randomBytes } from 'node:crypto';

/** A throwaway root made for this pretend node. Its key was never kept. */
export const MOCK_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBpjCCAU2gAwIBAgIUdkkW6j67+sPXtYequeded3YQfgIwCgYIKoZIzj0EAwIw
KTEnMCUGA1UEAwweUHJldGVuZCBMaWdodG5pbmcgRm9yayBSb290IENBMB4XDTI2
MTAyNDE5MDgzN1oXDTQ2MTAxOTE5MDgzN1owKTEnMCUGA1UEAwweUHJldGVuZCBM
aWdodG5pbmcgRm9yayBSb290IENBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE
dskTqlNkimmAwUXHVEpGFX49wbzz5mFbqrd2jTwPEbm0wrB0xCd/QpnbobMZmAHy
712NgFMBbzhDl+ajaRrXvaNTMFEwHQYDVR0OBBYEFI0/J8nQwPq3FVkvoWuK2J0a
QsU8MB8GA1UdIwQYMBaAFI0/J8nQwPq3FVkvoWuK2J0aQsU8MA8GA1UdEwEB/wQF
MAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIgfMYYR/eL1f3kXdscIeU6J12/rGY3COHm
oQi6KlR9cFwCIALR294kQ1AtHJuW/rBacsT1Qr1ZeqQHCSngsyuMkfv6
-----END CERTIFICATE-----
`;

/** Another throwaway root, for a server that isn't the node. */
export const OTHER_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBkDCCATWgAwIBAgIUWTx/cZP2tTp/7gYg3aD+cGMbnuowCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSU29tZSBPdGhlciBSb290IENBMB4XDTI2MTAyNDE5MDgzN1oX
DTQ2MTAxOTE5MDgzN1owHTEbMBkGA1UEAwwSU29tZSBPdGhlciBSb290IENBMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEc/7TSOuAA5H7sR2A13/ZRtNJ5LxeGrRL
b+zq6crgPtZHC+V5b3j8I5WUeUYZXDDxGwlYf7vziPRwezmHD7wvtaNTMFEwHQYD
VR0OBBYEFBA58oI57JxTolm9tO3Rawa3jmsfMB8GA1UdIwQYMBaAFBA58oI57JxT
olm9tO3Rawa3jmsfMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIh
AJls3NJ6Gz1KPj2sTZFlC2WHCzpVxpKDc+i0ROygeHenAiEAuHIkCt1T8FNcLRqH
ynf6PTtejrO2/nQbf7oMzMzvSOw=
-----END CERTIFICATE-----
`;

export function pemSha256(pem: string): string {
  const b64 = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem)![1].replace(/\s+/g, '');
  const h = createHash('sha256').update(Buffer.from(b64, 'base64')).digest();
  return Array.from(h, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

export type PayMode = 'ok' | 'on_its_way' | 'price_changed' | 'not_paid' | 'cut_off';

export interface MockOptions {
  features?: string[];
  /** The node runs its own bridge: SHA256 invoices are paid from its SHA256 node */
  ownBridge?: { ready: boolean; availableSat: number } | null;
  /** A bridge service to pay SHA256 invoices through */
  service?: { label: string } | null;
  onion?: string | null;
  lan?: string | null;
  ip?: string | null;
  rootPem?: string;
  /** Settle invoices this node makes after this long, for the browser version. Never, unless set */
  autoSettleMs?: number | null;
  now?: () => number;
}

export interface MockRequest {
  method: string;
  /** /api/v1/... with any query */
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface MockResponse {
  status: number;
  body: string;
}

interface Sample {
  kind: 'xbt' | 'sha256' | 'offer';
  amountSat: number | null;
  description: string;
  createdAt: number;
  expiresAt: number | null;
  paymentHash: string;
  ours: boolean;
  settledAt: number | null;
  paid: boolean;
}

interface Activity {
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
  bitcoinInvoice?: Record<string, unknown> | null;
  preimage?: string | null;
}

const hex = (n: number) => randomBytes(n).toString('hex');
const json = (status: number, v: unknown): MockResponse => ({ status, body: JSON.stringify(v) });
const refuse = (status: number, error: string, code?: string, extra: Record<string, unknown> = {}): MockResponse => json(status, { error, ...(code ? { code } : {}), ...extra });

const SERVICE_RATE = 0.0049;
const SERVICE_SPREAD = 0.01;

export class MockNode {
  readonly rootPem: string;
  readonly rootSha256: string;
  readonly opts: Required<Omit<MockOptions, 'autoSettleMs' | 'now'>> & { autoSettleMs: number | null };
  private readonly now: () => number;

  codes = new Map<string, { exp: number; claimedAt: number | null; nonce: string | null; deviceId: string | null }>();
  keys = new Map<string, string>();
  devices = new Map<string, { label: string; revoked: boolean; lastUsed: number }>();
  samples = new Map<string, Sample>();
  activity: Activity[] = [];
  onchainSat = 30_000;
  outboundSat = 2_199_670;
  inboundSat = 3_000_000;
  /** What the next payment of each kind does */
  payMode: Record<'lightning' | 'bitcoin-invoice' | 'onchain', PayMode> = { lightning: 'ok', 'bitcoin-invoice': 'ok', onchain: 'ok' };
  /** Calls made, for the tests */
  calls: { method: string; path: string; body: unknown }[] = [];
  /** Request ids seen, kept in memory as the dashboard keeps them: restart() forgets them */
  private requests = new Map<string, { body: string; outcome: MockResponse | null; pendingUntilResume: boolean }>();
  /** On-chain sends by request id, as the wallet's labels keep them (lf-mobile:<id>): a restart keeps these */
  private sentByRequest = new Map<string, MockResponse>();

  constructor(o: MockOptions = {}) {
    this.rootPem = o.rootPem ?? MOCK_ROOT_PEM;
    this.rootSha256 = pemSha256(this.rootPem);
    this.now = o.now ?? (() => Date.now());
    this.opts = {
      features: o.features ?? ['bitcoin-invoice', 'bitcoin-invoice-quote'],
      ownBridge: o.ownBridge === undefined ? null : o.ownBridge,
      service: o.service === undefined ? { label: 'Pretend Bridge' } : o.service,
      onion: o.onion === undefined ? 'http://mocklightningforkmocklightningforkmocklightningfork42.onion' : o.onion,
      lan: o.lan === undefined ? 'https://lightning-fork.local:7157' : o.lan,
      ip: o.ip === undefined ? 'https://192.168.1.20:7157' : o.ip,
      rootPem: this.rootPem,
      autoSettleMs: o.autoSettleMs ?? null,
    };
    this.activity.push(
      { id: `chain-${hex(4)}`, kind: 'onchain', direction: 'in', amountSat: 30_000, feeSat: 0, timestamp: Math.floor(this.now() / 1000) - 86_400 * 2, status: 'confirmed', confirmations: 288, description: 'Deposit', reference: hex(32) },
      { id: `ln-${hex(4)}`, kind: 'lightning', direction: 'in', amountSat: 21_000, feeSat: 0, timestamp: Math.floor(this.now() / 1000) - 7_200, status: 'complete', description: 'Coffee money', reference: hex(32) },
    );
  }

  // ------------------------------------------------------------------------------------------- test controls

  /** A pairing code, as the dashboard's QR code shows it. */
  issueCode(over: Partial<{ exp: number; onion: string | null; lan: string | null; ip: string | null; ca: string | null }> = {}): { code: string; json: string; link: string } {
    const code = `e_${hex(12)}`;
    const exp = over.exp ?? this.now() + 5 * 60_000;
    this.codes.set(code, { exp, claimedAt: null, nonce: null, deviceId: null });
    const o: Record<string, unknown> = { lf: 1, code, exp };
    const lan = over.lan === undefined ? this.opts.lan : over.lan;
    const ip = over.ip === undefined ? this.opts.ip : over.ip;
    const onion = over.onion === undefined ? this.opts.onion : over.onion;
    const ca = over.ca === undefined ? this.rootSha256 : over.ca;
    if (lan) o.lan = lan;
    if (ip) o.ip = ip;
    if (onion) o.onion = onion;
    if (ca) o.ca = ca;
    const text = JSON.stringify(o);
    return { code, json: text, link: `lightningfork://pair?c=${Buffer.from(text).toString('base64url')}` };
  }

  /** A pretend invoice, offer or address to pay. */
  sample(kind: 'xbt' | 'sha256' | 'offer' | 'address', amountSat: number | null = 1250, description = 'Steak n Shake #241', expirySeconds = 600): string {
    if (kind === 'address') return `bc1qmock${hex(16)}`;
    const createdAt = Math.floor(this.now() / 1000);
    const s: Sample = { kind, amountSat, description, createdAt, expiresAt: expirySeconds ? createdAt + expirySeconds : null, paymentHash: hex(32), ours: false, settledAt: null, paid: false };
    let text: string;
    if (kind === 'offer') text = `lno1mock${hex(20)}`;
    else text = `lnbc${amountSat != null ? `${amountSat * 10}n` : ''}1p${kind === 'sha256' ? 'sha' : 'xbt'}${hex(24)}`;
    this.samples.set(text, s);
    return text;
  }

  settle(paymentHash: string): void {
    for (const s of this.samples.values()) {
      if (s.paymentHash === paymentHash && s.ours && !s.settledAt) {
        s.settledAt = Math.floor(this.now() / 1000);
        this.outboundSat += s.amountSat ?? 0;
        this.activity.unshift({ id: `ln-${hex(4)}`, kind: 'lightning', direction: 'in', amountSat: s.amountSat ?? 0, feeSat: 0, timestamp: s.settledAt, status: 'complete', description: s.description, reference: s.paymentHash });
      }
    }
  }

  /** The dashboard restarts: request ids in memory are forgotten; the wallet and its payments stay. */
  restart(): void {
    this.requests.clear();
  }

  revokeAll(): void {
    for (const d of this.devices.values()) d.revoked = true;
  }

  // ------------------------------------------------------------------------------------------- the API

  async handle(req: MockRequest): Promise<MockResponse> {
    const url = new URL(req.path, 'http://node');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    let body: Record<string, unknown> = {};
    if (req.method === 'POST' && req.body) {
      try {
        body = JSON.parse(req.body);
      } catch {
        return refuse(400, 'Not JSON');
      }
    }
    this.calls.push({ method: req.method, path, body });
    if (this.opts.autoSettleMs != null) this.autoSettle();

    if (req.method === 'POST' && path === '/pair') return this.pair(body);

    const auth = Object.entries(req.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? '';
    const key = /^Bearer (lf_\S+)$/.exec(auth)?.[1];
    const deviceId = key ? this.keys.get(key) : undefined;
    const device = deviceId ? this.devices.get(deviceId) : undefined;
    if (!device || device.revoked) return refuse(401, 'This phone is not paired with this node, or was removed.');
    device.lastUsed = this.now();

    const route = `${req.method} ${path}`;
    switch (route) {
      case 'GET /bootstrap':
        return json(200, { serverId: 'srv_mock', apiVersion: 1, deviceId, label: device.label, node: this.nodeInfo(), features: this.opts.features, bitcoinInvoices: this.opts.service ? { configured: true, label: this.opts.service.label, onion: true, premium: 0.05 } : { configured: false, label: '', onion: false, premium: 0.05 } });
      case 'GET /endpoints':
        return json(200, { onionUrl: this.opts.onion, lanUrl: this.opts.lan, lanIp: this.opts.ip, caPem: this.rootPem, caSha256: this.rootSha256 });
      case 'GET /wallet':
        return json(200, {
          onchain: { confirmedSat: this.onchainSat, unconfirmedSat: 0, lockedSat: 0, reservedSat: 0 },
          lightning: { outboundSat: this.outboundSat, inboundSat: this.inboundSat, pendingOutboundSat: 0 },
          syncedToChain: true,
          blockHeight: 962_400,
          updatedAt: this.now(),
        });
      case 'GET /fees':
        return json(200, { source: { kind: 'node', name: 'Your node' }, warning: null, minimumSatPerVbyte: 1, low: { satPerVbyte: 2, label: 'Low', eta: 'About a day' }, medium: { satPerVbyte: 5, label: 'Medium', eta: 'About an hour' }, high: { satPerVbyte: 12, label: 'High', eta: 'Next block' } });
      case 'GET /bitcoin-invoices': {
        const ownBridge = this.opts.ownBridge ? { ready: this.opts.ownBridge.ready, availableSat: this.opts.ownBridge.availableSat } : null;
        if (!this.opts.service) return json(200, { configured: false, label: '', onion: false, premium: 0.05, terms: null, ownBridge });
        return json(200, { configured: true, label: this.opts.service.label, onion: true, premium: 0.05, terms: { open: true, refusal: null, rate: SERVICE_RATE, spread: SERVICE_SPREAD, minSat: 100, maxSat: 500_000 }, error: null, reference: this.reference(), referenceError: null, ownBridge });
      }
      case 'GET /activity': {
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 50)));
        return json(200, { items: this.activity.slice(0, limit) });
      }
      case 'POST /decode':
        return json(200, this.decode(String(body.input ?? ''), /bitcoin-invoice/.test(Object.entries(req.headers).find(([k]) => k.toLowerCase() === 'x-lf-capabilities')?.[1] ?? '')));
      case 'POST /quote/bitcoin-invoice':
        return this.quote(String(body.request ?? ''));
      case 'POST /pay/bitcoin-invoice':
        return this.once(deviceId!, body, () => this.payBitcoinInvoice(body));
      case 'POST /lightning/pay':
        return this.once(deviceId!, body, () => this.payLightning(body));
      case 'POST /onchain/estimate':
        return this.estimate(body);
      case 'POST /onchain/send':
        return this.once(deviceId!, body, () => this.sendOnchain(body));
      case 'POST /receive/address': {
        const address = `bc1qmock${hex(16)}`;
        return json(200, { address, type: 'p2wkh', uri: `bitcoin:${address}` });
      }
      case 'POST /receive/invoice': {
        const amountSat = typeof body.amountSat === 'number' ? body.amountSat : null;
        const text = this.sample('xbt', amountSat, String(body.memo ?? ''), Number(body.expirySeconds ?? 3600));
        const s = this.samples.get(text)!;
        s.ours = true;
        return json(200, { paymentRequest: text, paymentHash: s.paymentHash, amountSat, memo: s.description, createdAt: s.createdAt, expiresAt: s.expiresAt, uri: `lightning:${text}` });
      }
      case 'POST /receive/offer': {
        const text = this.sample('offer', typeof body.amountSat === 'number' ? body.amountSat : null, String(body.description ?? ''));
        this.samples.get(text)!.ours = true;
        return json(200, { offer: text, offerId: hex(16), amountSat: body.amountSat ?? null, description: body.description ?? '', uri: `bitcoin:?lno=${text}` });
      }
      case 'POST /unpair':
        device.revoked = true;
        return json(200, { unpaired: true });
    }
    const inv = /^GET \/receive\/invoice\/([0-9a-f]{64})$/.exec(route);
    if (inv) {
      const s = Array.from(this.samples.values()).find((x) => x.ours && x.paymentHash === inv[1]);
      if (!s) return refuse(404, 'No such invoice');
      const expired = s.expiresAt != null && s.expiresAt < this.now() / 1000;
      return json(200, { state: s.settledAt ? 'settled' : expired ? 'expired' : 'open', amountSat: s.amountSat, amountPaidSat: s.settledAt ? (s.amountSat ?? 0) : 0, settledAt: s.settledAt, expiresAt: s.expiresAt });
    }
    return refuse(404, 'Unknown call');
  }

  private autoSettle(): void {
    const ms = this.opts.autoSettleMs!;
    for (const s of this.samples.values()) if (s.ours && !s.settledAt && s.kind === 'xbt' && this.now() - s.createdAt * 1000 >= ms) this.settle(s.paymentHash);
  }

  private nodeInfo() {
    return { alias: 'pretend-lightning-fork', pubkey: `02${hex(32)}`, color: '#3399ff', version: '0.21.4-beta.21.1', network: 'mainnet', syncedToChain: true, syncedToGraph: true, blockHeight: 962_400, activeChannels: 3, peers: 11 };
  }

  private pair(body: Record<string, unknown>): MockResponse {
    const code = String(body.enrollCode ?? '');
    const nonce = typeof body.claimNonce === 'string' ? body.claimNonce : null;
    const c = this.codes.get(code);
    if (!c || c.exp < this.now()) return refuse(401, 'That pairing code is used, expired or unknown.');
    if (c.claimedAt != null) {
      // Claimed again within two minutes with the same nonce: a new key that voids the first
      if (!nonce || nonce !== c.nonce || this.now() - c.claimedAt > 120_000) return refuse(401, 'That pairing code is used, expired or unknown.');
      for (const [k, d] of this.keys) if (d === c.deviceId) this.keys.delete(k);
    }
    const deviceId = c.deviceId ?? `dev_${hex(6)}`;
    const apiKey = `lf_${deviceId.slice(4)}_${hex(24)}`;
    c.claimedAt = c.claimedAt ?? this.now();
    c.nonce = nonce;
    c.deviceId = deviceId;
    this.keys.set(apiKey, deviceId);
    const label = String(body.label ?? 'Phone');
    this.devices.set(deviceId, { label, revoked: false, lastUsed: this.now() });
    return json(200, { apiKey, deviceId, label, serverId: 'srv_mock', apiVersion: 1, caPem: this.rootPem, caSha256: this.rootSha256, node: this.nodeInfo() });
  }

  private secondsLeft(s: Sample): number | null {
    return s.expiresAt == null ? null : Math.floor(s.expiresAt - this.now() / 1000);
  }

  /** What paying a SHA256 invoice would cost now, or why it can't be paid. */
  private sha256Estimate(amountSat: number): { estimate: Record<string, unknown> | null; message: string | null; messageCode: string | null } {
    const own = this.opts.ownBridge;
    const fees = Math.max(10, Math.ceil(amountSat * 0.01));
    if (own && own.ready && own.availableSat >= amountSat + fees) {
      return {
        estimate: { source: 'own_bridge', incomingSat: 0, feeSat: 0, maxIncomingSat: 0, routingFeeLimitSat: 0, sha256AmountSat: amountSat, sha256RoutingFeeLimitSat: fees, sha256AvailableSat: own.availableSat, rate: 0, spread: 0, serviceLabel: 'Your bridge', open: true },
        message: null,
        messageCode: null,
      };
    }
    if (!this.opts.service) {
      if (own && !own.ready) return { estimate: null, message: 'Your bridge’s SHA256 node is not ready to pay yet. It pays SHA256 invoices once it is running and synced.', messageCode: 'own_bridge_not_ready' };
      if (own) return { estimate: null, message: `Your bridge’s SHA256 node can send ${own.availableSat.toLocaleString('en-US')} sats; this needs ${(amountSat + fees).toLocaleString('en-US')} with routing.`, messageCode: 'own_bridge_no_liquidity' };
      return { estimate: null, message: 'No service is set up to pay SHA256 invoices. Add one in the dashboard, under Paying SHA256 invoices.', messageCode: 'no_service' };
    }
    const incomingSat = Math.ceil((amountSat / SERVICE_RATE) * (1 + SERVICE_SPREAD) / 1000) * 1;
    const feeSat = Math.ceil(incomingSat - incomingSat / (1 + SERVICE_SPREAD));
    return {
      estimate: { source: 'service', incomingSat, feeSat, maxIncomingSat: Math.ceil(incomingSat * 1.005), routingFeeLimitSat: Math.max(10, Math.ceil(incomingSat * 0.01)), rate: SERVICE_RATE, spread: SERVICE_SPREAD, minSat: 100, maxSat: 500_000, serviceLabel: this.opts.service.label, open: true },
      message: null,
      messageCode: null,
    };
  }

  private reference() {
    return { rate: 0.004875, premiumAllowed: 0.0638, premium: 0.0048, serviceWidening: 0, withinLimit: true, source: 'Neoxa' };
  }

  private decode(raw: string, sha256Capable: boolean): Record<string, unknown> {
    let input = raw.trim();
    if (/^lightning:/i.test(input)) input = input.slice(10);
    if (/^bitcoin:/i.test(input)) {
      const u = new URL(input.replace(/^bitcoin:/i, 'bitcoin://x/'));
      const ln = u.searchParams.get('lightning') ?? u.searchParams.get('lno');
      input = ln ?? u.pathname.replace(/^\//, '');
    }
    const s = this.samples.get(input);
    if (/^lno1/i.test(input)) {
      return { kind: 'offer', request: input, amountSat: s?.amountSat ?? null, amountEditable: s?.amountSat == null, description: s?.description ?? '', issuer: 'Pretend Shop', ours: s?.ours ?? false, expired: false, message: s?.ours ? 'That’s one of your own offers.' : null, messageCode: s?.ours ? 'ours' : null };
    }
    if (/^lnbc/i.test(input)) {
      const m = /^lnbc(\d+)([munp]?)1/i.exec(input);
      const amountSat = s?.amountSat ?? (m ? Math.ceil((Number(m[1]) * { m: 1e5, u: 100, n: 0.1, p: 0.0001, '': 1e8 }[m[2].toLowerCase() as 'm' | 'u' | 'n' | 'p' | '']) ) : null);
      const left = s ? this.secondsLeft(s) : 600;
      const expired = left != null && left <= 0;
      const base = { request: input, amountSat, amountEditable: amountSat == null, description: s?.description ?? '', destination: `03${hex(32)}`, paymentHash: s?.paymentHash ?? hex(32), createdAt: s?.createdAt ?? Math.floor(this.now() / 1000), expiresAt: s?.expiresAt ?? null, expired, ours: s?.ours ?? false };
      const sha = s ? s.kind === 'sha256' : /^lnbc\d*[munp]?1psha/i.test(input);
      if (!sha) return { kind: 'bolt11', ...base, message: expired ? 'This invoice has expired.' : s?.ours ? 'That’s one of your own invoices.' : null, messageCode: expired ? 'expired' : s?.ours ? 'ours' : null };
      if (!sha256Capable) return { kind: 'unsupported', request: input, amountSat, amountEditable: false, description: '', message: 'This invoice is for the SHA256 chain.', messageCode: 'bitcoin_invoice' };
      if (expired) return { kind: 'bitcoin-invoice', ...base, secondsLeft: left, payable: false, estimate: null, reference: null, message: 'This invoice has expired.', messageCode: 'expired' };
      if (amountSat == null) return { kind: 'bitcoin-invoice', ...base, secondsLeft: left, payable: false, estimate: null, reference: null, message: 'This invoice names no amount, so it can’t be paid through a bridge.', messageCode: 'no_amount' };
      const est = this.sha256Estimate(amountSat);
      const own = est.estimate?.source === 'own_bridge';
      return { kind: 'bitcoin-invoice', ...base, secondsLeft: left, payable: est.estimate != null, estimate: est.estimate, reference: est.estimate && !own ? this.reference() : null, message: est.message, messageCode: est.messageCode };
    }
    if (/^(bc1|tb1|bcrt1)[0-9a-z]{20,}$/i.test(input)) {
      return { kind: 'onchain', request: input, address: input, addressType: input.length > 50 ? 'p2tr' : 'p2wkh', amountSat: null, amountEditable: true, description: '', label: '', ours: false, message: null, messageCode: null };
    }
    return { kind: 'unsupported', request: input, amountSat: null, amountEditable: false, description: '', message: 'Crossbill’s node doesn’t know what this is.', messageCode: 'unknown' };
  }

  private quote(request: string): MockResponse {
    const s = this.samples.get(request);
    if (!s || s.kind !== 'sha256') return refuse(400, 'That invoice is this chain’s; pay it with /lightning/pay.', 'not_bitcoin_invoice');
    if (s.amountSat == null) return refuse(400, 'This invoice names no amount.', 'no_amount');
    const left = this.secondsLeft(s) ?? 600;
    const est = this.sha256Estimate(s.amountSat);
    if (!est.estimate) return refuse(400, est.message!, est.messageCode!);
    const nowS = Math.floor(this.now() / 1000);
    if (est.estimate.source === 'own_bridge') {
      return json(200, { source: 'own_bridge', incomingSat: 0, feeSat: 0, maxIncomingSat: 0, routingFeeLimitSat: 0, expiresAt: nowS + left, secondsLeft: left, minSecondsLeft: 10, invoiceExpiresAt: s.expiresAt, invoiceSecondsLeft: left, serviceLabel: 'Your bridge', reference: null, sha256AmountSat: s.amountSat, sha256RoutingFeeLimitSat: est.estimate.sha256RoutingFeeLimitSat, sha256AvailableSat: est.estimate.sha256AvailableSat });
    }
    const secondsLeft = Math.max(0, Math.min(60, left - 10));
    const incomingSat = est.estimate.incomingSat as number;
    return json(200, { source: 'service', incomingSat, feeSat: est.estimate.feeSat, maxIncomingSat: incomingSat, routingFeeLimitSat: est.estimate.routingFeeLimitSat, expiresAt: nowS + secondsLeft, secondsLeft, minSecondsLeft: 10, invoiceExpiresAt: s.expiresAt, invoiceSecondsLeft: left, serviceLabel: this.opts.service!.label, reference: this.reference() });
  }

  /** A call carrying a request id runs once; a repeat gets the first outcome, a different body with it is 422. */
  private async once(deviceId: string, body: Record<string, unknown>, run: () => MockResponse): Promise<MockResponse> {
    const id = typeof body.requestId === 'string' ? body.requestId : null;
    if (id && !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return refuse(400, 'Bad request id');
    if (!id) return run();
    const { requestId: _r, resume: _s, ...rest } = body;
    const key = `${deviceId}:${id}`;
    const shape = JSON.stringify(rest);
    const seen = this.requests.get(key);
    // Not remembered, but asked as a resume: found the way the dashboard finds it after a restart, by the
    // payment hash or the wallet label, before anything is paid
    if (!seen && body.resume === true) {
      const found = this.findEarlier(id, body);
      if (found) return found;
    }
    if (seen) {
      if (seen.body !== shape) return refuse(422, 'That request id was used for a different request.');
      if (seen.pendingUntilResume) {
        // Was "on its way" or cut off; asked again, it has finished
        seen.pendingUntilResume = false;
        seen.outcome = run();
      }
      return seen.outcome!;
    }
    const entry = { body: shape, outcome: null as MockResponse | null, pendingUntilResume: false };
    this.requests.set(key, entry);
    const kind = body.address ? 'onchain' : 'maxIncomingSat' in body ? 'bitcoin-invoice' : 'lightning';
    const mode = this.payMode[kind];
    if (mode === 'on_its_way' || mode === 'cut_off') {
      this.payMode[kind] = 'ok';
      entry.pendingUntilResume = true;
      return mode === 'on_its_way'
        ? kind === 'bitcoin-invoice' && this.opts.ownBridge?.ready
          ? refuse(504, 'Your bridge’s SHA256 node is still paying the invoice.', 'on_its_way', { uncertain: true })
          : refuse(504, 'Paid to the service, which is paying the invoice now.', 'on_its_way', { uncertain: true, details: { maxHoldHours: 24 } })
        : refuse(504, 'The connection to LND dropped. The payment may have gone through.', undefined, { uncertain: true });
    }
    entry.outcome = run();
    return entry.outcome;
  }

  private findEarlier(id: string, body: Record<string, unknown>): MockResponse | null {
    if (body.address) return this.sentByRequest.get(id) ?? null;
    const s = this.samples.get(String(body.request ?? ''));
    if (!s || !s.paid) return null;
    const a = this.activity.find((x) => x.reference === s.paymentHash && x.direction === 'out');
    if (!a) return null;
    const bi = a.bitcoinInvoice ? { amountSat: s.amountSat, description: s.description, paymentHash: s.paymentHash, ...(a.bitcoinInvoice.source ? { source: a.bitcoinInvoice.source, sha256FeeSat: a.bitcoinInvoice.sha256FeeSat } : {}) } : undefined;
    return json(200, { status: 'succeeded', paymentHash: s.paymentHash, preimage: a.preimage, amountSat: a.amountSat, feeSat: a.feeSat, ...(bi ? { bitcoinInvoice: bi } : {}) });
  }

  private payBitcoinInvoice(body: Record<string, unknown>): MockResponse {
    const request = String(body.request ?? '');
    const s = this.samples.get(request);
    if (!s || s.kind !== 'sha256') return refuse(400, 'That invoice is this chain’s; pay it with /lightning/pay.', 'not_bitcoin_invoice');
    if (s.paid) return refuse(409, 'This invoice has been paid.', 'already_paid');
    if (s.amountSat == null) return refuse(400, 'This invoice names no amount.', 'no_amount');
    const mode = this.payMode['bitcoin-invoice'];
    if (mode === 'not_paid') {
      this.payMode['bitcoin-invoice'] = 'ok';
      return refuse(400, 'Your node couldn’t get the payment to the service: no route. Nothing was paid; you can try again.', 'not_paid');
    }
    const est = this.sha256Estimate(s.amountSat);
    if (!est.estimate) return refuse(400, est.message!, est.messageCode!);
    const preimage = hex(32);
    const nowS = Math.floor(this.now() / 1000);
    if (est.estimate.source === 'own_bridge') {
      const fee = 2;
      this.opts.ownBridge!.availableSat -= s.amountSat + fee;
      s.paid = true;
      const bitcoinInvoice = { amountSat: s.amountSat, description: s.description, paymentHash: s.paymentHash, source: 'own_bridge', sha256FeeSat: fee };
      this.activity.unshift({ id: `bi-${hex(4)}`, kind: 'lightning', direction: 'out', amountSat: 0, feeSat: 0, timestamp: nowS, status: 'complete', description: s.description, reference: s.paymentHash, bitcoinInvoice: { ...bitcoinInvoice, serviceLabel: 'Your bridge', state: 'paid' }, preimage });
      return json(200, { status: 'succeeded', paymentHash: s.paymentHash, preimage, amountSat: 0, feeSat: 0, bitcoinInvoice });
    }
    const incoming = est.estimate.incomingSat as number;
    if (mode === 'price_changed' || Number(body.maxIncomingSat) < incoming) {
      this.payMode['bitcoin-invoice'] = 'ok';
      const newer = mode === 'price_changed' ? incoming + Math.ceil(incoming * 0.02) : incoming;
      return refuse(409, 'The service asks more than the price you agreed to. Check the new price.', 'price_changed', { details: { incomingSat: newer, maxIncomingSat: Number(body.maxIncomingSat) } });
    }
    const routing = 3;
    this.outboundSat -= incoming + routing;
    s.paid = true;
    const bitcoinInvoice = { amountSat: s.amountSat, description: s.description, paymentHash: s.paymentHash };
    this.activity.unshift({ id: `bi-${hex(4)}`, kind: 'lightning', direction: 'out', amountSat: incoming, feeSat: routing, timestamp: nowS, status: 'complete', description: s.description, reference: s.paymentHash, bitcoinInvoice: { ...bitcoinInvoice, serviceLabel: this.opts.service!.label, state: 'paid' }, preimage });
    return json(200, { status: 'succeeded', paymentHash: s.paymentHash, preimage, amountSat: incoming, feeSat: routing, bitcoinInvoice });
  }

  private payLightning(body: Record<string, unknown>): MockResponse {
    const request = String(body.request ?? '');
    const s = this.samples.get(request);
    if (s?.kind === 'sha256' || /^lnbc\d*[munp]?1psha/i.test(request)) return refuse(400, 'This invoice is for the SHA256 chain.', 'bitcoin_invoice');
    if (s?.paid) return refuse(409, 'This invoice has been paid.', 'already_paid');
    if (s && s.expiresAt != null && s.expiresAt < this.now() / 1000) return refuse(400, 'This invoice has expired.', 'expired');
    const amount = s?.amountSat ?? (typeof body.amountSat === 'number' ? body.amountSat : null);
    if (amount == null) return refuse(400, 'Enter an amount.', 'no_amount');
    if (this.payMode.lightning === 'not_paid') {
      this.payMode.lightning = 'ok';
      return refuse(400, 'No route to the recipient. Nothing was paid.', 'no_route');
    }
    if (amount + 1 > this.outboundSat) return refuse(400, 'Not enough in your channels to send this.', 'insufficient');
    const fee = 1;
    this.outboundSat -= amount + fee;
    if (s) s.paid = true;
    const paymentHash = s?.paymentHash ?? hex(32);
    const preimage = hex(32);
    this.activity.unshift({ id: `ln-${hex(4)}`, kind: 'lightning', direction: 'out', amountSat: amount, feeSat: fee, timestamp: Math.floor(this.now() / 1000), status: 'complete', description: s?.description ?? '', reference: paymentHash, preimage });
    return json(200, { status: 'succeeded', paymentHash, preimage, amountSat: amount, feeSat: fee });
  }

  private estimate(body: Record<string, unknown>): MockResponse {
    const rate = Number(body.satPerVbyte ?? 0);
    if (!(rate >= 1)) return refuse(400, 'The fee rate is below the minimum.', 'fee_rate');
    const fee = Math.ceil(rate * 141);
    const sendAll = body.sendAll === true;
    const amountSat = sendAll ? this.onchainSat - fee : Number(body.amountSat ?? 0);
    if (!(amountSat > 0) || amountSat + fee > this.onchainSat) return refuse(400, 'Not enough on chain for this amount and its fee.', 'insufficient');
    return json(200, { amountSat, feeSat: fee, satPerVbyte: rate, totalSat: amountSat + fee, sendAll });
  }

  private sendOnchain(body: Record<string, unknown>): MockResponse {
    const est = this.estimate(body);
    if (est.status !== 200) return est;
    const e = JSON.parse(est.body);
    this.onchainSat -= e.totalSat;
    const txid = hex(32);
    this.activity.unshift({ id: `chain-${hex(4)}`, kind: 'onchain', direction: 'out', amountSat: e.amountSat, feeSat: e.feeSat, timestamp: Math.floor(this.now() / 1000), status: 'pending', confirmations: 0, description: '', reference: txid });
    const out = json(200, { txid, satPerVbyte: e.satPerVbyte });
    if (typeof body.requestId === 'string') this.sentByRequest.set(body.requestId, out);
    return out;
  }
}
