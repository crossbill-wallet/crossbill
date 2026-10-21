// Address poisoning: a scammer makes an address whose start and end match one you've used, then sends you a tiny
// amount from it so it sits in your history, hoping you copy it next time instead of the real one. Wallets show the
// start and end of an address, and so do people's eyes. This compares a recipient with the addresses you know:
// saved contacts, addresses you've paid, and this phone's own.

export interface KnownAddress {
  address: string;
  kind: 'contact' | 'paid' | 'own';
  /** A contact's or wallet's name */
  name?: string;
  /** unix seconds, for an address paid */
  when?: number;
}

export interface RecipientCheck {
  /** The same address, already known */
  exact: KnownAddress | null;
  /** Known addresses this one looks like without being */
  lookalikes: KnownAddress[];
}

/** Characters every address of a kind starts with: "bc1q", "bc1p", "tb1q", "bcrt1q", or a base58 version digit. */
export function typePrefix(address: string): string {
  const a = address.toLowerCase();
  const sep = a.lastIndexOf('1');
  if (/^(bc|tb|bcrt)1/.test(a) && sep > 0) return a.slice(0, sep + 2);
  return a.slice(0, 1);
}

/**
 * How many characters match at the start, after each address's own kind prefix, and at the end. The prefixes
 * needn't be the same: a Taproot "bc1p" address made to match a SegWit "bc1q" one after those four characters
 * looks just as alike, and so does a "3" address against a "1" one.
 */
export function sharedEnds(a: string, b: string): { start: number; end: number } {
  const x = a.toLowerCase().slice(typePrefix(a).length);
  const y = b.toLowerCase().slice(typePrefix(b).length);
  let start = 0;
  while (start < Math.min(x.length, y.length) && x[start] === y[start]) start++;
  let end = 0;
  while (end < Math.min(x.length, y.length) - start && x[x.length - 1 - end] === y[y.length - 1 - end]) end++;
  return { start, end };
}

/**
 * Whether two different addresses look alike where people look: eight characters matching between the two ends
 * (at least three at each), or six at either end. By chance that's about one in a trillion, or a billion, for a
 * pair, so a match is almost certainly made on purpose.
 */
export function looksAlike(a: string, b: string): boolean {
  if (same(a, b)) return false;
  const { start, end } = sharedEnds(a, b);
  return (start >= 3 && end >= 3 && start + end >= 8) || start >= 6 || end >= 6;
}

/** The same address for comparing: bech32 ignores case, base58 doesn't. */
function same(a: string, b: string): boolean {
  const bech = (x: string) => /^(bc|tb|bcrt)1/i.test(x);
  return bech(a) && bech(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function checkRecipient(address: string, known: KnownAddress[]): RecipientCheck {
  const a = address.trim();
  if (!a) return { exact: null, lookalikes: [] };
  const rank = { contact: 0, own: 1, paid: 2 };
  const exact = known.filter((k) => same(k.address, a)).sort((x, y) => rank[x.kind] - rank[y.kind])[0] ?? null;
  const seen = new Set<string>();
  const lookalikes: KnownAddress[] = [];
  for (const k of [...known].sort((x, y) => rank[x.kind] - rank[y.kind])) {
    const key = k.address.toLowerCase();
    if (seen.has(key) || same(k.address, a) || !looksAlike(a, k.address)) continue;
    seen.add(key);
    lookalikes.push(k);
  }
  return { exact, lookalikes };
}

/** Under this, an incoming payment from someone else is treated as possible poisoning dust. */
export const DUST_SATS = 1000;
