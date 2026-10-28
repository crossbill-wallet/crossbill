// The XBT price from Neoxa Exchange's public market data API (https://neoxa.exchange/api-docs). Neoxa lists
// Bitcoin BLAKE2b as XBT on its site and as BTCB2 in the API. Read only: no account, no key, nothing about the
// wallet is sent. The app asks through Tor when the node is reached through Tor.

export const PRICE_HOST = 'https://neoxa.exchange';
export const PRICE_PAIR = 'BTCB2_USDC';
export const PRICE_PAGE = `${PRICE_HOST}/trade/${PRICE_PAIR}`;
/** A price older than this is fetched again before it's shown. */
export const PRICE_MAX_AGE_MS = 60_000;

export interface Ticker {
  /** USDC per XBT */
  last: number;
  /** Change over 24 hours in USDC, and as a percentage (-5.95 for -5.95%) */
  change: number | null;
  changePercent: number | null;
  high24h: number | null;
  low24h: number | null;
  /** Traded in 24 hours, in XBT and in USDC */
  volume24h: number | null;
  quoteVolume24h: number | null;
  trades24h: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  /** When the exchange computed these figures, unix ms, if it said */
  computedAt: number | null;
}

export interface Candle {
  /** unix ms at the candle's start */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export const CHART_RANGES: { id: string; label: string; interval: CandleInterval; limit: number }[] = [
  { id: '1h', label: '1H', interval: '1m', limit: 60 },
  { id: '1d', label: '1D', interval: '15m', limit: 96 },
  { id: '1w', label: '1W', interval: '1h', limit: 168 },
  { id: '1m', label: '1M', interval: '4h', limit: 180 },
  { id: '1y', label: '1Y', interval: '1d', limit: 365 },
];

export function tickerUrl(pair = PRICE_PAIR): string {
  return `${PRICE_HOST}/api/exchange/ticker/${pair}`;
}

export function candlesUrl(interval: CandleInterval, limit: number, pair = PRICE_PAIR): string {
  return `${PRICE_HOST}/api/exchange/candles/${pair}?interval=${interval}&limit=${limit}`;
}

export class PriceError extends Error {}

/** Numbers arrive as numbers or as decimal strings. Anything else is null. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

/** unix ms from seconds, milliseconds or an ISO date. */
export function toMillis(v: unknown): number | null {
  const n = num(v);
  if (n != null) return n > 1e12 ? n : n > 1e9 ? n * 1000 : null;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function parseBody(body: string, status: number): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    // A block page from a proxy in front of the exchange answers in HTML
    throw new PriceError(status && status !== 200 ? `Neoxa Exchange answered with HTTP ${status}` : 'Neoxa Exchange sent something other than prices');
  }
  if (!json || typeof json !== 'object') throw new PriceError('Neoxa Exchange sent something other than prices');
  const o = json as Record<string, unknown>;
  if (o.success === false || status >= 400) {
    const msg = typeof o.error === 'string' ? o.error : typeof o.message === 'string' ? o.message : `HTTP ${status}`;
    throw new PriceError(`Neoxa Exchange said: ${msg}`);
  }
  return o;
}

export function parseTicker(body: string, status = 200): Ticker {
  const o = parseBody(body, status);
  const t = (o.ticker && typeof o.ticker === 'object' ? o.ticker : o) as Record<string, unknown>;
  const last = num(t.lastPrice ?? t.last ?? t.price);
  if (last == null || last <= 0) throw new PriceError('Neoxa Exchange has no recent XBT/USDC trade');
  return {
    last,
    change: num(t.change),
    changePercent: num(t.changePercent),
    high24h: num(t.high24h),
    low24h: num(t.low24h),
    volume24h: num(t.volume24h),
    quoteVolume24h: num(t.quoteVolume24h),
    trades24h: num(t.trades24h),
    bestBid: num(t.bestBid),
    bestAsk: num(t.bestAsk),
    computedAt: toMillis(t.computedAt),
  };
}

export function parseCandles(body: string, status = 200): Candle[] {
  const o = parseBody(body, status);
  const list = Array.isArray(o.candles) ? o.candles : Array.isArray(o.data) ? o.data : null;
  if (!list) throw new PriceError('Neoxa Exchange sent no price history');
  const out: Candle[] = [];
  for (const raw of list) {
    // Objects, or arrays in the common [time, open, high, low, close, volume] order
    const c: Record<string, unknown> = Array.isArray(raw)
      ? { time: raw[0], open: raw[1], high: raw[2], low: raw[3], close: raw[4], volume: raw[5] }
      : (raw as Record<string, unknown>);
    const time = toMillis(c.time ?? c.timestamp ?? c.t);
    const close = num(c.close);
    if (time == null || close == null) continue;
    out.push({ time, open: num(c.open) ?? close, high: num(c.high) ?? close, low: num(c.low) ?? close, close, volume: num(c.volume) ?? 0 });
  }
  return out.sort((a, b) => a.time - b.time);
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * An amount in sats in US dollars, signed when asked, and as "<$0.01" when it's under a cent rather than a
 * misleading $0.00.
 */
export function formatUsdAmount(sats: number, pricePerCoin: number, opts: { sign?: boolean } = {}): string {
  const dollars = (Math.abs(sats) / 100_000_000) * pricePerCoin;
  const sign = sats < 0 ? '-' : opts.sign && sats > 0 ? '+' : '';
  if (dollars > 0 && dollars < 0.005) return `${sign}<$0.01`;
  return `${sign}${usd.format(dollars)}`;
}

/** A balance in sats at a price in USD per coin, as $1,234.56. */
export function formatUsd(sats: number, pricePerCoin: number): string {
  return usd.format((sats / 100_000_000) * pricePerCoin);
}

export function formatPrice(p: number): string {
  return usd.format(p);
}

export function formatPercent(p: number | null): string {
  if (p == null) return '';
  return `${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
}

/** 12,345.6 XBT or 1.2M, for volumes. */
export function formatCompact(n: number | null): string {
  if (n == null) return 'Not given';
  return new Intl.NumberFormat('en-US', { notation: n >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 2 }).format(n);
}
