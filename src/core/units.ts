export const SATS_PER_BTC = 100_000_000;

export type Unit = 'BTC' | 'sats';

/** Formats satoshis. BTC is shown with all eight decimals, grouped as Sparrow does. */
export function formatAmount(sats: number, unit: Unit, opts: { sign?: boolean } = {}): string {
  const neg = sats < 0;
  const abs = Math.abs(sats);
  let body: string;
  if (unit === 'sats') {
    body = abs.toLocaleString('en-US');
  } else {
    const whole = Math.floor(abs / SATS_PER_BTC);
    const frac = String(abs % SATS_PER_BTC).padStart(8, '0');
    body = `${whole.toLocaleString('en-US')}.${frac.slice(0, 2)} ${frac.slice(2, 5)} ${frac.slice(5)}`;
  }
  const sign = neg ? '-' : opts.sign && sats > 0 ? '+' : '';
  return `${sign}${body}`;
}

export function unitLabel(unit: Unit): string {
  return unit === 'BTC' ? 'BTC' : 'sats';
}

/**
 * Parses what a person typed as an amount. BTC accepts up to eight decimals; sats must be whole.
 * Returns null for anything that is not a clean positive amount.
 */
export function parseAmount(input: string, unit: Unit): number | null {
  const raw = input.replace(/[\s_]/g, '');
  if (!raw) return null;
  if (unit === 'sats') {
    // Whole sats. Separators are only accepted as thousands grouping (2,500 or 2.500), never as a decimal point
    if (!/^\d+$/.test(raw) && !/^\d{1,3}([,.]\d{3})+$/.test(raw)) return null;
    const s = raw.replace(/[,.]/g, '');
    const v = Number(s);
    return Number.isSafeInteger(v) && v > 0 ? v : null;
  }
  // A comma is the decimal point in many regions. One comma and no dot reads as a decimal point; any other mix
  // of commas is ambiguous for BTC and refused rather than guessed, since reading it wrong moves the decimal.
  const commas = (raw.match(/,/g) ?? []).length;
  if (commas > 1 || (commas === 1 && raw.includes('.'))) return null;
  const s = raw.replace(',', '.');
  const m = /^(\d*)(?:\.(\d{0,8}))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  const whole = Number(m[1] || '0');
  const frac = Number((m[2] ?? '').padEnd(8, '0'));
  const v = whole * SATS_PER_BTC + frac;
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** Fee rates are shown in sat/vB with up to two decimals. */
export function formatFeeRate(satPerVb: number): string {
  return `${Number(satPerVb.toFixed(2)).toString()} sat/vB`;
}
