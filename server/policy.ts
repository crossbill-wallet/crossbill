// What the Crossbill server lets the page ask of the node and the Lightning node. The page is signed in, but the
// server still holds the keys to both, so it passes on only what the app itself does: a page with a script
// slipped into it gets no further than the app would go.

/** The Knots RPC methods the app calls (src/core/sync.ts, rpc.ts and the model). Nothing that spends or exports keys. */
export const RPC_METHODS: ReadonlySet<string> = new Set([
  'createwallet',
  'estimatesmartfee',
  'getblockchaininfo',
  'getblockheader',
  'getdeploymentinfo',
  'getmempoolentry',
  'getmempoolinfo',
  'getnetworkinfo',
  'gettransaction',
  'gettxout',
  'getwalletinfo',
  'importdescriptors',
  'listdescriptors',
  'listsinceblock',
  'listwallets',
  'loadwallet',
  'sendrawtransaction',
  'testmempoolaccept',
]);

/** The only wallet the app opens on the node: the watch-only one desktop Shrike shares (src/core/sync.ts). */
export const RPC_WALLET = 'cormorant';

export class PolicyError extends Error {
  readonly code: string;
  constructor(message: string, code = 'not-allowed') {
    super(message);
    this.code = code;
  }
}

/** The RPC path the page asked for, checked: the node itself, or the cormorant wallet. */
export function rpcPath(pathname: string): string {
  if (pathname === '/' || pathname === '') return '/';
  if (pathname === `/wallet/${RPC_WALLET}`) return pathname;
  throw new PolicyError('Crossbill only uses the node and its cormorant wallet');
}

/** The methods in a JSON-RPC body (one call or a batch), each checked against the list. */
export function checkRpcBody(body: string, extra: readonly string[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PolicyError('Not a JSON-RPC request');
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0 || calls.length > 1000) throw new PolicyError('Not a JSON-RPC request');
  for (const c of calls) {
    const method = (c as { method?: unknown } | null)?.method;
    if (typeof method !== 'string') throw new PolicyError('Not a JSON-RPC request');
    if (!RPC_METHODS.has(method) && !extra.includes(method)) throw new PolicyError(`Crossbill doesn’t use the node’s ${method} call`);
    // The app makes and opens one wallet on the node, the watch-only cormorant, and no other
    if ((method === 'createwallet' || method === 'loadwallet') && !extra.includes(method)) {
      const params = (c as { params?: unknown }).params;
      const name = Array.isArray(params) ? params[0] : (params as { wallet_name?: unknown; filename?: unknown } | null)?.wallet_name ?? (params as { filename?: unknown } | null)?.filename;
      if (name !== RPC_WALLET) throw new PolicyError(`Crossbill only makes and opens the ${RPC_WALLET} wallet`);
    }
  }
}

/** Lightning Fork calls that move money. They go through only while Lightning payments are on for this server. */
export const LIGHTNING_SPENDING: ReadonlySet<string> = new Set(['/api/v1/lightning/pay', '/api/v1/pay/bitcoin-invoice', '/api/v1/onchain/send']);

export function lightningPath(pathname: string): string {
  if (!/^\/api\/v1\/[A-Za-z0-9/_.-]*$/.test(pathname) || pathname.includes('..')) throw new PolicyError('Not a call of Lightning Fork’s mobile API');
  return pathname;
}

/**
 * The answer the page gets for a payment while payments are off: a refusal in the node's own form (409), which the
 * app takes as "nothing was sent, and nothing will be" (isDefiniteRefusal in src/core/lfapi.ts), so it never asks
 * about the payment again as if its answer had been lost.
 */
export function paymentsOffAnswer(): { status: number; body: string } {
  return {
    status: 409,
    body: JSON.stringify({
      error: 'Paying is turned off for Crossbill on this server. Turn on Lightning payments in Crossbill’s actions on StartOS to pay from here.',
      code: 'payments_off',
    }),
  };
}

/** Headers passed on to Lightning Fork. Anything else from the page is dropped. */
export const LIGHTNING_HEADERS: ReadonlySet<string> = new Set(['accept', 'authorization', 'content-type', 'x-lf-capabilities']);

/** The price comes from this host only (src/core/price.ts), and only its public API. */
export const PRICE_HOST = 'neoxa.exchange';

export function pricePath(url: URL): string {
  if (url.protocol !== 'https:' || url.hostname !== PRICE_HOST || url.port) throw new PolicyError('Prices come from Neoxa Exchange only');
  if (!/^\/api\/[A-Za-z0-9/_.-]*$/.test(url.pathname) || url.pathname.includes('..')) throw new PolicyError('Not a call of Neoxa Exchange’s public API');
  return `${url.pathname}${url.search}`;
}
