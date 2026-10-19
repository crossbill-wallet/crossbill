// JSON-RPC client for Bitcoin Knots. The HTTP layer is injected: on the phone it is the native plugin, which
// routes through the embedded Tor client; in development and tests it is fetch.

export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /**
   * Whether repeating the request is harmless. Off for calls with effects worth not doubling: an import that
   * starts a rescan, and a broadcast.
   */
  retryable: boolean;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

export interface RpcServer {
  /** Host name: a .onion address, an IP, or a LAN name. */
  host: string;
  port: number;
  user: string;
  password: string;
  /** https is unusual for Knots RPC, but a reverse proxy in front of it may use it. */
  tls?: boolean;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly method: string,
  ) {
    super(message);
  }
}

export class TransportError extends Error {}

const NOT_RETRYABLE = new Set(['importdescriptors', 'sendrawtransaction', 'createwallet', 'loadwallet']);

/** Error codes from Bitcoin Core's rpc/protocol.h that the sync code reacts to. */
export const RPC_CODES = {
  MISC_ERROR: -1,
  INVALID_ADDRESS_OR_KEY: -5,
  WALLET_ERROR: -4,
  WALLET_NOT_FOUND: -18,
  WALLET_NOT_SPECIFIED: -19,
  IN_WARMUP: -28,
  METHOD_NOT_FOUND: -32601,
  VERIFY_REJECTED: -26,
  VERIFY_ALREADY_IN_CHAIN: -27,
  WALLET_ALREADY_LOADED: -35,
} as const;

function basicAuth(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

export interface CallOptions {
  wallet?: string;
  timeoutMs?: number;
}

export class KnotsRpc {
  private nextId = 1;

  constructor(
    private readonly server: RpcServer,
    private readonly transport: HttpTransport,
    private readonly defaultTimeoutMs = 90_000,
  ) {}

  private url(wallet?: string): string {
    const scheme = this.server.tls ? 'https' : 'http';
    const base = `${scheme}://${this.server.host}:${this.server.port}/`;
    return wallet ? `${base}wallet/${encodeURIComponent(wallet)}` : base;
  }

  private async post(payload: unknown, opts: CallOptions, methods: string[]): Promise<HttpResponse> {
    let res: HttpResponse;
    try {
      res = await this.transport({
        url: this.url(opts.wallet),
        headers: { 'Content-Type': 'application/json', Authorization: basicAuth(this.server.user, this.server.password) },
        body: JSON.stringify(payload),
        timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs,
        retryable: methods.every((m) => !NOT_RETRYABLE.has(m)),
      });
    } catch (e) {
      throw new TransportError(e instanceof Error ? e.message : String(e));
    }
    if (res.status === 401 || res.status === 403) throw new TransportError('The node refused the RPC user name or password');
    if (res.status === 404 && !res.body) throw new TransportError('The node answered 404. Check the port is the RPC port.');
    return res;
  }

  async call<T>(method: string, params: unknown[] = [], opts: CallOptions = {}): Promise<T> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '1.0', id, method, params }, opts, [method]);
    let parsed: { result?: T; error?: { code: number; message: string } | null };
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new TransportError(`Unexpected reply from the node (HTTP ${res.status})`);
    }
    if (parsed.error) throw new RpcError(parsed.error.message, parsed.error.code, method);
    return parsed.result as T;
  }

  /** Several calls in one round trip. Over Tor each round trip costs about a second, so this matters. */
  async batch<T = unknown>(calls: { method: string; params?: unknown[] }[], opts: CallOptions = {}): Promise<({ ok: true; result: T } | { ok: false; error: RpcError })[]> {
    if (calls.length === 0) return [];
    const base = this.nextId;
    this.nextId += calls.length;
    const payload = calls.map((c, i) => ({ jsonrpc: '1.0', id: base + i, method: c.method, params: c.params ?? [] }));
    const res = await this.post(payload, opts, calls.map((c) => c.method));
    let parsed: { id: number; result?: T; error?: { code: number; message: string } | null }[];
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new TransportError(`Unexpected reply from the node (HTTP ${res.status})`);
    }
    if (!Array.isArray(parsed)) {
      const err = (parsed as { error?: { code: number; message: string } }).error;
      throw new RpcError(err?.message ?? 'Batch request failed', err?.code ?? -1, 'batch');
    }
    const byId = new Map(parsed.map((r) => [r.id, r]));
    return calls.map((c, i) => {
      const r = byId.get(base + i);
      if (!r) return { ok: false as const, error: new RpcError('Missing reply in batch', -1, c.method) };
      if (r.error) return { ok: false as const, error: new RpcError(r.error.message, r.error.code, c.method) };
      return { ok: true as const, result: r.result as T };
    });
  }
}

/**
 * Splits a pasted node address such as `http://abc…xyz.onion:8332/` into host and port, the way node
 * dashboards like StartOS show it. Anything that isn't a URL or host:port comes back as the host, trimmed.
 */
export function splitNodeAddress(input: string): { host: string; port?: number; scheme?: string } {
  let s = input.trim();
  let scheme: string | undefined;
  const sm = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (sm) {
    scheme = sm[1].toLowerCase();
    s = s.slice(sm[0].length);
  }
  s = s.replace(/[/?#].*$/, '');
  if (sm) s = s.replace(/^[^@]*@/, '');
  const m = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(s);
  if (m) {
    const port = Number(m[2]);
    if (port > 0 && port < 65536) return { host: m[1], port, scheme };
  }
  return { host: s, scheme };
}

/**
 * What a pasted address means for the node form: the host, plus the port and HTTPS setting when a URL spells them
 * out. A URL without a port means the scheme's default (StartOS shows its HTTPS onion address with none, so 443).
 */
export function nodeAddressFields(input: string): { host: string; port?: number; tls?: boolean } {
  const a = splitNodeAddress(input);
  if (a.scheme === 'https') return { host: a.host, port: a.port ?? 443, tls: true };
  if (a.scheme === 'http') return { host: a.host, port: a.port ?? 80, tls: false };
  return a.port ? { host: a.host, port: a.port } : { host: a.host };
}

/** A fetch-based transport for development against a node the browser can reach (through the Vite proxy). */
export function fetchTransport(rewrite?: (url: string) => string): HttpTransport {
  return async (req) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
    try {
      const res = await fetch(rewrite ? rewrite(req.url) : req.url, { method: 'POST', headers: req.headers, body: req.body, signal: ctrl.signal });
      return { status: res.status, body: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  };
}
