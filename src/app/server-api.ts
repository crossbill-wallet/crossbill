// The browser side of the Crossbill server's API (server/main.ts), used only by the StartOS build. Every call
// carries the X-Crossbill header, which a form or image on another site can't add, and the session cookie the
// login page set. A 401 means the session ended: the page goes back to the login page.

export interface ServerInfo {
  version: string;
  network: 'mainnet' | 'testnet4' | 'regtest';
  /** Where the server reaches Bitcoin Knots, for Settings to show. The password stays on the server */
  node: { host: string; port: number; tls: boolean };
  /** The server has a Tor SOCKS proxy: the price can be asked for through Tor, and onion addresses reached */
  tor: boolean;
  lightning: {
    /** The server knows how to reach a Lightning Fork node: through StartOS, or an onion through Tor */
    reachable: boolean;
    /** Paying is turned on for this server. Off, only balances, invoices and receiving work */
    payments: boolean;
  };
}

export class ServerError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function serverApi<T>(path: string, init: { method?: 'GET' | 'PUT' | 'POST' | 'DELETE'; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Crossbill': '1', Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api/${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status === 401) {
    location.assign('/login');
    throw new ServerError('Signed out. Sign in again.', 'signed-out', 401);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const err = (parsed as { error?: { message?: string; code?: string } } | null)?.error;
    throw new ServerError(err?.message ?? `The Crossbill server answered with an error (${res.status}).`, err?.code ?? null, res.status);
  }
  return parsed as T;
}

let info: Promise<ServerInfo> | null = null;

/** What the server says about itself, asked once per page load. */
export function serverInfo(): Promise<ServerInfo> {
  info ??= serverApi<ServerInfo>('info').catch((e) => {
    info = null;
    throw e;
  });
  return info;
}
