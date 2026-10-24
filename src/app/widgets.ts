// What the iPhone widgets show. The app builds a snapshot of the XBT price and one wallet's balance, already
// worded and formatted, and the native plugin saves it in the App Group the app shares with its widget extension
// (ios/App/ShrikeWidgets). Widgets can't run Tor, so they never fetch anything: they show what the app last got,
// with the time it got it, and change when the app hands them something new.

import { formatPercent, formatPrice, formatUsd } from '../core/price';
import { formatAmount, SATS_PER_BTC, unitLabel, type Unit } from '../core/units';
import type { NetworkName } from '../core/network';
import type { Appearance, SkinId } from './look';

export const WIDGET_SNAPSHOT_VERSION = 1;

/** The widget kinds the extension declares. */
export const PRICE_WIDGET = 'ShrikePrice';
export const BALANCE_WIDGET = 'ShrikeBalance';

/** Most points in a widget's chart. The day's 96 fifteen-minute closes are thinned to this. */
export const WIDGET_CHART_POINTS = 48;
/** How old the day's chart can get before the app fetches it again for the widgets. */
export const WIDGET_CHART_MAX_AGE_MS = 15 * 60_000;
/** A chart this much older than the price no longer ends where the price is, so it's left out. */
const CHART_DROP_AFTER_MS = 2 * 60 * 60_000;
/**
 * When nothing shown has changed, the time on a widget moves forward at most this often. Otherwise every sync
 * with the node and every price refresh would rewrite the widgets while the app is open.
 */
export const WIDGET_TIME_STEP_MS = 5 * 60_000;

export interface WidgetPrice {
  /** "$570.25" */
  price: string;
  /** Fits a round Lock Screen widget: "$57.20", "$570", "$5,702", "$57.0K" */
  compact: string;
  /** "+1.50%" over 24 hours, or null if the exchange didn't say */
  change: string | null;
  direction: 'up' | 'down' | 'flat' | null;
  /** unix ms Crossbill got this price */
  at: number;
  /** Closing prices over the last day, oldest first, for the chart. null until fetched */
  points: number[] | null;
  /** unix ms the chart was fetched */
  pointsAt: number | null;
  /** The price itself, for the dollar balance */
  last: number;
}

export interface WidgetBalance {
  walletId: string;
  wallet: string;
  sats: number;
  /** "0.12 345 678" or "12,345,678", as on the Wallet tab */
  amount: string;
  /** "BTC" or "sats" */
  unit: string;
  /** Fits a round Lock Screen widget: "0.123" or "12.3M". Cut short, never rounded up */
  compact: string;
  /** "$70.41", on mainnet when there's a price */
  usd: string | null;
  /** "+0.01 000 000 BTC unconfirmed", or null */
  pending: string | null;
  /** null on mainnet, "Testnet4" or "Regtest" otherwise */
  network: string | null;
  /** unix ms the app last checked this balance with the node, or saw it change on the phone */
  at: number;
}

export interface WidgetSnapshot {
  v: number;
  look: { appearance: Appearance; skin: SkinId };
  /** False when prices are off in Settings, so the price widget can say so */
  prices: boolean;
  price: WidgetPrice | null;
  /** False when the balance is kept out of the widgets in Settings */
  showBalance: boolean;
  balance: WidgetBalance | null;
}

export interface WidgetInput {
  appearance: Appearance;
  skin: SkinId;
  unit: Unit;
  network: NetworkName;
  prices: boolean;
  showBalance: boolean;
  ticker: { last: number; changePercent: number | null } | null;
  /** unix ms of the ticker */
  priceAt: number;
  /** The day's closing prices and when they were fetched */
  chart: { closes: number[]; at: number } | null;
  /** The wallet the Balance widget shows, once it has synced at least once */
  wallet: { id: string; name: string; confirmed: number; unconfirmed: number } | null;
  /** unix ms the app last finished checking with the node, if it has since it started */
  syncedAt: number | null;
  now: number;
}

const NETWORK_LABEL: Record<NetworkName, string | null> = { mainnet: null, testnet4: 'Testnet4', regtest: 'Regtest' };

/**
 * The snapshot for the widgets. `previous` is the last one handed over: a price the app hasn't fetched again
 * since it started is kept from it, and so are times that would otherwise creep forward without anything on
 * the widget changing.
 */
export function buildWidgetSnapshot(input: WidgetInput, previous: WidgetSnapshot | null): WidgetSnapshot {
  const price = input.prices ? widgetPrice(input, previous?.price ?? null) : null;
  const balance = input.showBalance ? widgetBalance(input, price, previous?.balance ?? null) : null;
  return {
    v: WIDGET_SNAPSHOT_VERSION,
    look: { appearance: input.appearance, skin: input.skin },
    prices: input.prices,
    price,
    showBalance: input.showBalance,
    balance,
  };
}

function widgetPrice(input: WidgetInput, prev: WidgetPrice | null): WidgetPrice | null {
  const t = input.ticker;
  if (!t || !input.priceAt || !Number.isFinite(t.last)) return prev;
  const change = t.changePercent;
  let points: number[] | null = null;
  let pointsAt: number | null = null;
  // A number that isn't finite would be null in the JSON, which the widget can't read at all
  const closes = input.chart?.closes.filter(Number.isFinite) ?? [];
  if (input.chart && closes.length >= 2 && input.priceAt - input.chart.at < CHART_DROP_AFTER_MS) {
    points = thin(closes, WIDGET_CHART_POINTS);
    // The last candle is still open; end the line at the price the widget shows
    if (Math.abs(input.priceAt - input.chart.at) < WIDGET_CHART_MAX_AGE_MS) points[points.length - 1] = t.last;
    pointsAt = input.chart.at;
  }
  const next: WidgetPrice = {
    price: formatPrice(t.last),
    compact: compactPrice(t.last),
    change: change == null ? null : formatPercent(change),
    direction: change == null ? null : change >= 0.005 ? 'up' : change <= -0.005 ? 'down' : 'flat',
    at: input.priceAt,
    points,
    pointsAt,
    last: t.last,
  };
  if (prev && sameExceptTime(next, prev, ['at']) && input.priceAt - prev.at < WIDGET_TIME_STEP_MS) {
    return { ...next, at: prev.at };
  }
  return next;
}

function widgetBalance(input: WidgetInput, price: WidgetPrice | null, prev: WidgetBalance | null): WidgetBalance | null {
  const w = input.wallet;
  if (!w) return null;
  const unit = input.unit;
  const usd = input.network === 'mainnet' && price ? formatUsd(w.confirmed, price.last) : null;
  const same = prev != null && prev.walletId === w.id && prev.sats === w.confirmed;
  let at = input.syncedAt ?? (same ? prev.at : input.now);
  if (same && at - prev.at < WIDGET_TIME_STEP_MS) at = prev.at;
  return {
    walletId: w.id,
    wallet: w.name,
    sats: w.confirmed,
    amount: formatAmount(w.confirmed, unit),
    unit: unitLabel(unit),
    compact: compactAmount(w.confirmed, unit),
    usd,
    pending: w.unconfirmed ? `${formatAmount(w.unconfirmed, unit, { sign: true })} ${unitLabel(unit)} unconfirmed` : null,
    network: NETWORK_LABEL[input.network],
    at,
  };
}

function sameExceptTime<T extends object>(a: T, b: T, skip: (keyof T)[]): boolean {
  for (const k of Object.keys(a) as (keyof T)[]) {
    if (skip.includes(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

/** Up to `max` values spread evenly across `values`, always keeping the first and the last. */
export function thin(values: number[], max: number): number[] {
  if (values.length <= max) return values.slice();
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(values[Math.round((i * (values.length - 1)) / (max - 1))]);
  return out;
}

/** A price short enough for a round Lock Screen widget. */
export function compactPrice(p: number): string {
  if (!Number.isFinite(p) || p < 0) return '';
  if (p < 100) return formatPrice(p);
  if (p < 10_000) return `$${Math.round(p).toLocaleString('en-US')}`;
  if (p < 100_000) return `$${(p / 1000).toFixed(1)}K`;
  if (p < 1_000_000) return `$${Math.round(p / 1000)}K`;
  return `$${(p / 1_000_000).toFixed(1)}M`;
}

/**
 * An amount short enough for a round Lock Screen widget: BTC to two or three significant places, sats in
 * thousands or millions. Always cut short, never rounded up, so it never shows more than the wallet holds.
 */
export function compactAmount(sats: number, unit: Unit): string {
  const n = Math.max(0, Math.floor(sats));
  if (unit === 'sats') {
    if (n < 1000) return String(n);
    if (n < 10_000) return `${cut(n / 1000, 1)}K`;
    if (n < 1_000_000) return `${Math.floor(n / 1000)}K`;
    if (n < 10_000_000) return `${cut(n / 1_000_000, 1)}M`;
    if (n < 1_000_000_000) return `${Math.floor(n / 1_000_000)}M`;
    return `${cut(n / 1_000_000_000, 1)}B`;
  }
  if (n === 0) return '0';
  const decimals = n >= 100 * SATS_PER_BTC ? 0 : n >= 10 * SATS_PER_BTC ? 1 : n >= SATS_PER_BTC ? 2 : n >= 100_000 ? 3 : 8;
  const step = 10 ** (8 - decimals);
  const kept = Math.floor(n / step) * step;
  const whole = Math.floor(kept / SATS_PER_BTC);
  if (decimals === 0) return whole.toLocaleString('en-US');
  let frac = String(kept % SATS_PER_BTC)
    .padStart(8, '0')
    .slice(0, decimals);
  if (decimals === 8) frac = frac.replace(/0+$/, '');
  return `${whole}.${frac}`;
}

/** Cuts a number to `decimals` places without rounding up. */
function cut(v: number, decimals: number): string {
  const f = 10 ** decimals;
  return (Math.floor(v * f + 1e-9) / f).toFixed(decimals);
}

/** Widget sizes in words, for Settings. */
export const FAMILY_NAMES: Record<string, string> = {
  systemSmall: 'small, Home Screen',
  systemMedium: 'wide, Home Screen',
  systemLarge: 'large, Home Screen',
  systemExtraLarge: 'extra large, Home Screen',
  accessoryCircular: 'round, Lock Screen',
  accessoryRectangular: 'rectangular, Lock Screen',
  accessoryInline: 'one line, Lock Screen',
};

/** Sizes of the price widget that draw the day's chart. */
export const CHART_FAMILIES = new Set(['systemSmall', 'systemMedium']);
