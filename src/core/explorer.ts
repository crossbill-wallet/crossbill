// Block explorer links, built the way desktop Shrike builds them (AppServices.openBlockExplorer), so the same
// explorer setting means the same link on both.

import type { NetworkName } from './network';

/** Desktop Shrike's default: a mempool instance that follows the BLAKE2b chain. mempool.space does not. */
export const DEFAULT_EXPLORER = 'https://mempool.guide';

/** Checks and tidies an explorer address typed into settings. Returns null if it isn't an http(s) URL. */
export function normalizeExplorer(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = (/\.onion(?::\d+)?(?:[/?#{]|$)/i.test(s) ? 'http://' : 'https://') + s;
  let u: URL;
  try {
    u = new URL(s.replace('{0}', 'TXID'));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return s.replace(/\/+$/, '');
}

/**
 * The page for a transaction. {0} in the explorer address is replaced with the txid; otherwise /tx/<txid> is added,
 * after the network name on test networks, as desktop Shrike does.
 */
export function explorerTxUrl(base: string, txid: string, network: NetworkName): string {
  if (base.includes('{0}')) return base.replace('{0}', txid);
  const root = base.replace(/\/+$/, '');
  return `${root}${network === 'mainnet' ? '' : `/${network}`}/tx/${txid}`;
}

/**
 * What the phone actually opens. Safari can't reach .onion addresses, so those go to Onion Browser through its
 * onionhttp:// and onionhttps:// links, which keeps the lookup on Tor.
 */
export function explorerOpenUrl(url: string): string {
  const u = new URL(url);
  if (u.hostname.toLowerCase().endsWith('.onion')) return url.replace(/^http(s?):\/\//i, 'onionhttp$1://');
  return url;
}

/** A short name for the button: the host, unless it's too long to read (an onion address, say). */
export function explorerName(base: string): string {
  try {
    const host = new URL(base.replace('{0}', 'TXID')).hostname;
    return host.length <= 24 ? host : 'your block explorer';
  } catch {
    return 'your block explorer';
  }
}
