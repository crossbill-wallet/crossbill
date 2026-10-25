// One HTTP request from the Crossbill server to somewhere else: Bitcoin Knots, Lightning Fork or the price API.
// Directly, or through a Tor SOCKS proxy (SOCKS5, with the name resolved by Tor, so an onion works). Redirects
// are never followed: a request carrying a key goes to the address asked and no other.
//
// An onion's TLS certificate isn't checked, as on the iPhone: the onion address itself proves who answers. Any
// other https address is checked against the usual roots, or only against the one given (a StartOS server's root).

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { SocksProxy } from './config.ts';

export interface ForwardRequest {
  url: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /** Go through this Tor proxy */
  socks: SocksProxy | null;
  /** For https: trust this root certificate only, in place of the usual ones (a StartOS server's own root) */
  ca: string | null;
  /** The most of the answer to read */
  maxBytes: number;
}

export interface ForwardResponse {
  status: number;
  body: string;
  headers: IncomingMessage['headers'];
}

/** Why a request failed, in the codes the app's native plugin uses (src/app/native.ts). */
export class ForwardError extends Error {
  readonly code: 'timeout' | 'network';
  constructor(message: string, code: 'timeout' | 'network') {
    super(message);
    this.code = code;
  }
}

export function isOnion(host: string): boolean {
  return host.toLowerCase().endsWith('.onion');
}

const SOCKS_REPLIES: Record<number, string> = {
  1: 'general failure',
  2: 'not allowed',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

/** A TCP connection to host:port made by the SOCKS5 proxy, which resolves the name itself. */
export function socksConnect(proxy: SocksProxy, host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(proxy.port, proxy.host);
    let stage: 'hello' | 'connect' | 'done' = 'hello';
    let buf = Buffer.alloc(0);
    const fail = (msg: string) => {
      sock.destroy();
      reject(new ForwardError(msg, 'network'));
    };
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new ForwardError('Tor took too long to connect', 'timeout'));
    }, timeoutMs);
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(new ForwardError(`Can’t reach Tor: ${e.message}`, 'network'));
    });
    sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'hello') {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail('Tor’s proxy wants a login this server doesn’t have');
        buf = buf.subarray(2);
        const name = Buffer.from(host, 'utf8');
        if (name.length > 255) return fail('That address is too long');
        const p = Buffer.alloc(2);
        p.writeUInt16BE(port);
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, p]));
        stage = 'connect';
      }
      if (stage === 'connect') {
        if (buf.length < 5) return;
        if (buf[0] !== 5) return fail('Tor’s proxy answered in a way this server doesn’t understand');
        if (buf[1] !== 0) return fail(`Tor couldn’t connect: ${SOCKS_REPLIES[buf[1]] ?? `error ${buf[1]}`}`);
        const atyp = buf[3];
        const len = atyp === 1 ? 10 : atyp === 4 ? 22 : atyp === 3 ? 7 + buf[4] : -1;
        if (len < 0) return fail('Tor’s proxy answered in a way this server doesn’t understand');
        if (buf.length < len) return;
        stage = 'done';
        clearTimeout(timer);
        sock.off('data', onData);
        sock.removeAllListeners('error');
        const rest = buf.subarray(len);
        if (rest.length) sock.unshift(rest);
        resolve(sock);
      }
    };
    sock.on('data', onData);
  });
}

/** TLS over a connection Tor made. Resolves once the handshake is done, so a failed one is an answer, not a crash. */
function secure(raw: Socket, host: string, onion: boolean, ca: string | null, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const t = tlsConnect({ socket: raw, servername: isIP(host) ? undefined : host, rejectUnauthorized: !onion, ca: ca ?? undefined });
    const timer = setTimeout(() => {
      t.destroy();
      reject(new ForwardError('No answer in time', 'timeout'));
    }, timeoutMs);
    t.once('secureConnect', () => {
      clearTimeout(timer);
      t.removeAllListeners('error');
      resolve(t);
    });
    t.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      raw.destroy();
      reject(new ForwardError(e.code === 'ERR_SSL_WRONG_VERSION_NUMBER' ? 'That address doesn’t speak HTTPS' : friendly(e), 'network'));
    });
  });
}

export async function forward(req: ForwardRequest): Promise<ForwardResponse> {
  const tls = req.url.protocol === 'https:';
  const host = req.url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(req.url.port || (tls ? 443 : 80));
  const onion = isOnion(host);
  if (onion && !req.socks) throw new ForwardError('An onion address needs Tor, and this server has no Tor proxy set up', 'network');
  const started = Date.now();
  const left = () => Math.max(1, req.timeoutMs - (Date.now() - started));

  let socket: Socket | null = null;
  if (req.socks) {
    const raw = await socksConnect(req.socks, host, port, Math.min(left(), 120_000));
    socket = tls ? await secure(raw, host, onion, req.ca, left()) : raw;
  }

  return new Promise<ForwardResponse>((resolve, reject) => {
    const headers: Record<string, string | number> = { ...req.headers, Host: req.url.host };
    if (req.method === 'POST') headers['Content-Length'] = Buffer.byteLength(req.body);
    const options = {
      method: req.method,
      host,
      port,
      path: `${req.url.pathname}${req.url.search}`,
      headers,
      // A socket made through Tor goes in as is; otherwise a fresh connection each time, never kept alive
      ...(socket ? { createConnection: () => socket! } : { agent: false as const }),
      ...(tls && !socket ? { servername: isIP(host) ? undefined : host, ca: req.ca ?? undefined, rejectUnauthorized: true } : {}),
    };
    // Over Tor the TLS is already done on the socket, so the request itself is plain HTTP on top of it
    const r = tls && !socket ? httpsRequest(options) : httpRequest(options);
    const timer = setTimeout(() => {
      r.destroy(new ForwardError('No answer in time', 'timeout'));
    }, left());
    r.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > req.maxBytes) {
          r.destroy(new ForwardError('The answer was too large', 'network'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
      });
      res.on('error', (e) => {
        clearTimeout(timer);
        reject(e instanceof ForwardError ? e : new ForwardError(e.message, 'network'));
      });
    });
    r.on('error', (e) => {
      clearTimeout(timer);
      reject(e instanceof ForwardError ? e : new ForwardError(friendly(e as NodeJS.ErrnoException), 'network'));
    });
    if (req.method === 'POST') r.end(req.body);
    else r.end();
  });
}

function friendly(e: NodeJS.ErrnoException): string {
  switch (e.code) {
    case 'ECONNREFUSED':
      return 'The connection was refused';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'That address couldn’t be found';
    case 'ECONNRESET':
      return 'The connection was cut off';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'That address can’t be reached from this server';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `The server’s certificate isn’t trusted (${e.code})`;
    default:
      return e.message;
  }
}
