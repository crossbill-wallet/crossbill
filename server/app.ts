// The Crossbill server: the StartOS build of the screens (dist-server), a sign-in page, and the API the page's
// stand-in for the native plugin calls (src/app/server-native.ts):
//
//   GET  /api/health                      for StartOS's health check, without signing in
//   GET  /api/info                        the network, where the node is, whether Tor and Lightning are set up
//   GET|PUT|DELETE /api/storage/<name>    the app's files
//   GET|PUT|DELETE /api/vault/<key>       what the iPhone keeps in the Keychain, never seed words
//   POST /api/http                        one request to the node, the Lightning node or the price API
//   POST /api/logout
//
// Everything but the health check and the sign-in page needs a session. API calls also need the X-Crossbill
// header, which a page on another site can't send, and the session cookie is SameSite=Strict.

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { Auth, ensurePassword, INITIAL_PASSWORD_FILE } from './auth.ts';
import type { ServerConfig } from './config.ts';
import { forward, ForwardError, isOnion } from './forward.ts';
import { loginPage, notBuiltPage } from './login-page.ts';
import { checkRpcBody, LIGHTNING_HEADERS, LIGHTNING_SPENDING, lightningPath, paymentsOffAnswer, PolicyError, pricePath, rpcPath } from './policy.ts';
import { DataStore, StoreError } from './store.ts';

const COOKIE = 'crossbill_session';
/** The app's wallet files hold transaction history, which can grow */
const STORAGE_LIMIT = 32 * 1024 * 1024;
const BODY_LIMIT = 4 * 1024 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), 'application/json');
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } });
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too-large', 'That’s more than the server takes in one request'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody<T>(req: IncomingMessage, limit = BODY_LIMIT): Promise<T> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'bad-request', 'Send JSON');
  const text = await readBody(req, limit);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'bad-request', 'That isn’t JSON');
  }
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function secureRequest(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto'];
  return (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') || (req.socket as { encrypted?: boolean }).encrypted === true;
}

function sessionCookie(req: IncomingMessage, token: string | null): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secureRequest(req)) attrs.push('Secure');
  return token ? `${COOKIE}=${token}; ${attrs.join('; ')}` : `${COOKIE}=; Max-Age=0; ${attrs.join('; ')}`;
}

/** What the page asks the server to send on its behalf (src/app/server-native.ts). */
interface HttpAsk {
  kind: 'rpc' | 'lightning' | 'price';
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  useTor: boolean;
  pinPem?: string;
  captureRootSha256?: string;
}

function checkAsk(v: unknown): HttpAsk {
  const a = v as Partial<HttpAsk> | null;
  if (!a || typeof a !== 'object') throw new HttpError(400, 'bad-request', 'Not a request');
  if (a.kind !== 'rpc' && a.kind !== 'lightning' && a.kind !== 'price') throw new HttpError(400, 'bad-request', 'Not a kind of request the server makes');
  if (typeof a.url !== 'string' || (a.method !== 'GET' && a.method !== 'POST')) throw new HttpError(400, 'bad-request', 'Not a request');
  const headers: Record<string, string> = {};
  for (const [k, val] of Object.entries(a.headers ?? {})) if (typeof val === 'string') headers[k.toLowerCase()] = val;
  return {
    kind: a.kind,
    url: a.url,
    method: a.method,
    headers,
    body: typeof a.body === 'string' ? a.body : '',
    timeoutMs: Math.min(300_000, Math.max(1_000, Number(a.timeoutMs) || 30_000)),
    useTor: a.useTor === true,
    pinPem: typeof a.pinPem === 'string' ? a.pinPem : undefined,
    captureRootSha256: typeof a.captureRootSha256 === 'string' ? a.captureRootSha256 : undefined,
  };
}

function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

/** The node's credentials: its cookie file as it is now, or the configured user and password. */
function rpcAuthorization(config: ServerConfig): string {
  const file = config.rpc.cookieFile;
  if (!file) return basicAuth(config.rpc.user, config.rpc.password);
  let cookie: string;
  try {
    cookie = readFileSync(file, 'utf8').trim();
  } catch {
    throw new ForwardError('Can’t read the node’s RPC cookie. Check the node is running.', 'network');
  }
  if (!cookie.includes(':')) throw new ForwardError('The node’s RPC cookie isn’t in the form user:password.', 'network');
  return `Basic ${Buffer.from(cookie, 'utf8').toString('base64')}`;
}

/** A path under a base address that may itself have a path (a dashboard behind a proxy at /lf, say). */
function under(base: URL, pathAndQuery: string): URL {
  const u = new URL(base.href);
  const q = pathAndQuery.indexOf('?');
  u.pathname = `${base.pathname.replace(/\/$/, '')}${q < 0 ? pathAndQuery : pathAndQuery.slice(0, q)}`;
  u.search = q < 0 ? '' : pathAndQuery.slice(q);
  return u;
}

export interface CrossbillServer {
  server: Server;
  store: DataStore;
  auth: Auth;
  port: number;
  /** The password the server made at its first start, if it made one just now */
  initialPassword: string | null;
  close(): Promise<void>;
}

export function paymentsOn(config: ServerConfig, store: DataStore): boolean {
  return config.lightning.paymentsOverride ?? store.settings().lightningPayments;
}

export function createHandler(config: ServerConfig, store: DataStore, auth: Auth): (req: IncomingMessage, res: ServerResponse) => void {
  const staticRoot = resolve(config.staticDir);

  async function relay(ask: HttpAsk): Promise<{ status: number; body: string }> {
    let url: URL;
    try {
      url = new URL(ask.url);
    } catch {
      throw new HttpError(400, 'bad-request', 'Not an address');
    }
    if (ask.kind === 'rpc') {
      if (ask.method !== 'POST') throw new PolicyError('The node’s RPC takes POST only');
      const path = rpcPath(url.pathname);
      checkRpcBody(ask.body, config.extraRpcMethods);
      const target = under(config.rpc.url, path);
      const r = await forward({
        url: target,
        method: 'POST',
        // The page's own Authorization (empty on StartOS) is dropped: the server holds the node's password
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: rpcAuthorization(config) },
        body: ask.body,
        timeoutMs: ask.timeoutMs,
        socks: isOnion(target.hostname) ? config.tor : null,
        ca: config.rpc.ca,
        maxBytes: 256 * 1024 * 1024,
      });
      return { status: r.status, body: r.body };
    }
    if (ask.kind === 'lightning') {
      // The home address is the iPhone's way in, pinned to the node's root. The server goes through StartOS
      if (ask.pinPem || ask.captureRootSha256) throw new ForwardError('Crossbill on StartOS reaches your Lightning node through StartOS, not its home address.', 'network');
      const path = lightningPath(url.pathname);
      if (ask.method === 'POST' && LIGHTNING_SPENDING.has(path) && !paymentsOn(config, store)) return paymentsOffAnswer();
      let target: URL;
      if (config.lightning.url) target = under(config.lightning.url, `${path}${url.search}`);
      else if (isOnion(url.hostname) && config.tor) target = url;
      else throw new ForwardError('Lightning Fork isn’t connected to Crossbill on this server.', 'network');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(ask.headers)) if (LIGHTNING_HEADERS.has(k)) headers[k] = v;
      const r = await forward({
        url: target,
        method: ask.method,
        headers,
        body: ask.method === 'POST' ? ask.body : '',
        timeoutMs: ask.timeoutMs,
        socks: isOnion(target.hostname) ? config.tor : null,
        ca: config.lightning.ca,
        maxBytes: 16 * 1024 * 1024,
      });
      return { status: r.status, body: r.body };
    }
    // The price
    if (ask.method !== 'GET') throw new PolicyError('The price is asked for with GET only');
    pricePath(url);
    if (ask.useTor && !config.tor) throw new ForwardError('This server has no Tor proxy set up, so the price can’t come through Tor.', 'network');
    const r = await forward({ url, method: 'GET', headers: { Accept: 'application/json' }, body: '', timeoutMs: ask.timeoutMs, socks: ask.useTor ? config.tor : null, ca: null, maxBytes: 4 * 1024 * 1024 });
    return { status: r.status, body: r.body };
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string, token: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (path === '/api/info' && method === 'GET') {
      const rpc = config.rpc.url;
      return json(res, 200, {
        version: config.version,
        network: config.network,
        node: { host: rpc.hostname, port: Number(rpc.port || (rpc.protocol === 'https:' ? 443 : 80)), tls: rpc.protocol === 'https:' },
        tor: config.tor != null,
        lightning: { reachable: config.lightning.url != null || config.tor != null, payments: paymentsOn(config, store) },
      });
    }
    if (path === '/api/logout' && method === 'POST') {
      auth.logout(token);
      return send(res, 200, '{}', 'application/json', { 'Set-Cookie': sessionCookie(req, null) });
    }
    const storage = /^\/api\/storage\/([^/]+)$/.exec(path);
    if (storage) {
      const name = decodeURIComponent(storage[1]);
      if (method === 'GET') return json(res, 200, { value: store.readApp(name) });
      if (method === 'PUT') {
        const b = await readJsonBody<{ value?: unknown }>(req, STORAGE_LIMIT);
        store.writeApp(name, b.value ?? null);
        return json(res, 200, {});
      }
      if (method === 'DELETE') {
        store.removeApp(name);
        return json(res, 200, {});
      }
    }
    const vault = /^\/api\/vault\/([^/]+)$/.exec(path);
    if (vault) {
      const key = decodeURIComponent(vault[1]);
      if (method === 'GET') return json(res, 200, { value: store.vaultGet(key) });
      if (method === 'PUT') {
        const b = await readJsonBody<{ value?: unknown }>(req);
        if (typeof b.value !== 'string') throw new HttpError(400, 'bad-request', 'A vault value is text');
        store.vaultSet(key, b.value);
        return json(res, 200, {});
      }
      if (method === 'DELETE') {
        store.vaultDelete(key);
        return json(res, 200, {});
      }
    }
    if (path === '/api/http' && method === 'POST') {
      const ask = checkAsk(await readJsonBody(req));
      return json(res, 200, await relay(ask));
    }
    throw new HttpError(404, 'not-found', 'No such call');
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (!existsSync(join(staticRoot, 'index.html'))) return send(res, 503, notBuiltPage(), 'text/html; charset=utf-8');
    let p: string;
    try {
      p = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, 'Bad address', 'text/plain');
    }
    if (p === '/' || p === '') p = '/index.html';
    const file = resolve(staticRoot, `.${p}`);
    if (!file.startsWith(staticRoot + sep)) return send(res, 404, 'Not found', 'text/plain');
    let size: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) return send(res, 404, 'Not found', 'text/plain');
      size = st.size;
    } catch {
      return send(res, 404, 'Not found', 'text/plain');
    }
    // Built assets carry a hash in their names, so they never change under the same name
    const cache = p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': String(size), 'Cache-Control': cache });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file).pipe(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://crossbill');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/api/health') return json(res, 200, { ok: true });

    if (path === '/login') {
      if (method === 'GET') {
        if (auth.check(cookie(req, COOKIE))) return send(res, 303, '', 'text/plain', { Location: '/' });
        return send(res, 200, loginPage({ firstStart: existsSync(store.path(INITIAL_PASSWORD_FILE)) }), 'text/html; charset=utf-8');
      }
      if (method === 'POST') {
        const form = new URLSearchParams(await readBody(req, 16 * 1024));
        const result = auth.login(form.get('password') ?? '');
        if (result === 'wait') {
          return send(res, 429, loginPage({ error: `Too many wrong passwords. Try again in ${auth.wait()} seconds.`, firstStart: false }), 'text/html; charset=utf-8');
        }
        if (!result) return send(res, 401, loginPage({ error: 'That password isn’t right.', firstStart: existsSync(store.path(INITIAL_PASSWORD_FILE)) }), 'text/html; charset=utf-8');
        return send(res, 303, '', 'text/plain', { Location: '/', 'Set-Cookie': sessionCookie(req, result) });
      }
      return send(res, 405, 'Method not allowed', 'text/plain');
    }

    const token = cookie(req, COOKIE);
    const signedIn = auth.check(token);

    if (path.startsWith('/api/')) {
      if (req.headers['x-crossbill'] !== '1') return fail(res, 403, 'forbidden', 'Calls come from Crossbill’s own page only');
      if (!signedIn) return fail(res, 401, 'signed-out', 'Sign in again');
      return api(req, res, path, token!);
    }

    if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    if (!signedIn) return send(res, 303, '', 'text/plain', { Location: '/login' });
    return serveStatic(req, res, path);
  }

  return (req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof HttpError) return fail(res, e.status, e.code, e.message);
      if (e instanceof StoreError) return fail(res, e.status, e.code, e.message);
      if (e instanceof PolicyError) return fail(res, 403, e.code, e.message);
      if (e instanceof ForwardError) return fail(res, 502, e.code, e.message);
      console.error('crossbill: request failed:', e instanceof Error ? e.message : e);
      fail(res, 500, 'server', 'Something went wrong in the Crossbill server');
    });
  };
}

export async function startServer(config: ServerConfig, opts: { log?: (line: string) => void } = {}): Promise<CrossbillServer> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const store = new DataStore(config.dataDir);
  const initialPassword = ensurePassword(store);
  if (initialPassword) log(`crossbill: first start. The password to sign in is ${initialPassword} (also in ${store.path(INITIAL_PASSWORD_FILE)}). Change it with set-password.`);
  const auth = new Auth(store);
  const server = createServer(createHandler(config, store, auth));
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  log(`crossbill: ${config.version} on http://${config.host}:${port}, ${config.network}, node at ${config.rpc.url.host}${config.lightning.url ? `, Lightning Fork at ${config.lightning.url.host}` : ''}${config.tor ? ', Tor proxy on' : ''}`);
  return {
    server,
    store,
    auth,
    port,
    initialPassword,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}
