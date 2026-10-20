// Two-factor codes, price parsing, skin tiers and the donation address.

import { describe, expect, it } from 'vitest';
import {
  cleanCode,
  decodeSecret,
  encodeSecret,
  groupSecret,
  hashRecoveryCode,
  hotp,
  lockoutSeconds,
  looksLikeRecoveryCode,
  matchRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  timeStep,
  totp,
  verifyTotp,
} from '../src/core/totp';
import { candlesUrl, formatPercent, formatPrice, formatUsd, parseCandles, parseTicker, PriceError, tickerUrl, toMillis } from '../src/core/price';
import { SKINS, tierFor } from '../src/app/look';
import { DONATION_ADDRESS, LINK_GROUPS } from '../src/app/links';
import { decodeAddress } from '../src/core/script';
import { NETWORKS } from '../src/core/network';

// RFC 6238 appendix B, SHA-1, with the ASCII secret "12345678901234567890"
const RFC_SECRET = new TextEncoder().encode('12345678901234567890');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('time-based codes', () => {
  it('matches RFC 6238 for 8 digits', () => {
    for (const [t, code] of RFC_VECTORS) expect(totp(RFC_SECRET, t, 8)).toBe(code);
  });

  it('gives the last six of those for 6 digits', () => {
    for (const [t, code] of RFC_VECTORS) expect(totp(RFC_SECRET, t)).toBe(code.slice(2));
  });

  it('matches RFC 4226 HOTP values', () => {
    const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    want.forEach((code, i) => expect(hotp(RFC_SECRET, i)).toBe(code));
  });

  it('round-trips the secret through base32 as people type it', () => {
    const s = newTotpSecret();
    expect(s.length).toBe(20);
    const b32 = encodeSecret(s);
    expect(b32).toMatch(/^[A-Z2-7]{32}$/);
    expect(decodeSecret(groupSecret(b32).toLowerCase())).toEqual(s);
    expect(decodeSecret(b32.match(/.{4}/g)!.join('-'))).toEqual(s);
  });

  it('accepts one step either side, and refuses a step already used', () => {
    const t = 1_760_000_000;
    const now = timeStep(t);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, t), t)).toBe(now);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, t - 30), t)).toBe(now - 1);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, t + 30), t)).toBe(now + 1);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, t - 60), t)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, t), t, now)).toBeNull();
    // A later code still works after an earlier one was used
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, t + 30), t, now)).toBe(now + 1);
  });

  it('takes codes typed with a space, and refuses anything not six digits', () => {
    const t = 1_760_000_000;
    const c = totp(RFC_SECRET, t);
    expect(verifyTotp(RFC_SECRET, `${c.slice(0, 3)} ${c.slice(3)}`, t)).not.toBeNull();
    expect(cleanCode(' 123-456 ')).toBe('123456');
    expect(verifyTotp(RFC_SECRET, '12345', t)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', t)).toBeNull();
  });

  it('builds the link authenticator apps read', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'iPhone wallet', 'Shrike');
    expect(uri).toBe('otpauth://totp/Shrike:iPhone%20wallet?secret=JBSWY3DPEHPK3PXP&issuer=Shrike&algorithm=SHA1&digits=6&period=30');
  });
});

describe('recovery codes', () => {
  it('makes eight distinct codes without look-alike characters', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) {
      expect(c).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
      expect(looksLikeRecoveryCode(c)).toBe(true);
    }
  });

  it('matches a code however it is typed, and only against unused hashes', () => {
    const codes = newRecoveryCodes(3);
    const hashes = codes.map(hashRecoveryCode);
    expect(matchRecoveryCode(hashes, codes[1].toLowerCase().replace('-', ' '))).toBe(1);
    hashes[1] = '';
    expect(matchRecoveryCode(hashes, codes[1])).toBe(-1);
    expect(matchRecoveryCode(hashes, '123456')).toBe(-1);
    expect(looksLikeRecoveryCode('123456')).toBe(false);
  });

  it('makes a person wait longer the more wrong codes in a row', () => {
    expect(lockoutSeconds(4)).toBe(0);
    expect(lockoutSeconds(5)).toBe(30);
    expect(lockoutSeconds(10)).toBe(300);
    expect(lockoutSeconds(20)).toBe(3600);
  });
});

describe('XBT price', () => {
  it('reads the ticker, with numbers as strings or numbers', () => {
    const body = JSON.stringify({
      success: true,
      pair: 'BTCB2_USDC',
      ticker: { lastPrice: '540.50', change: -34.2, changePercent: '-5.95', high24h: '590', low24h: 530.1, volume24h: '12.5', quoteVolume24h: 6800, trades24h: 41, computedAt: '2026-10-18T12:00:00Z', bestBid: '539', bestAsk: '541', spread: '2' },
    });
    const t = parseTicker(body);
    expect(t.last).toBe(540.5);
    expect(t.changePercent).toBe(-5.95);
    expect(t.low24h).toBe(530.1);
    expect(t.volume24h).toBe(12.5);
    expect(t.bestAsk).toBe(541);
    expect(t.computedAt).toBe(Date.parse('2026-10-18T12:00:00Z'));
  });

  it('says what went wrong instead of showing a wrong price', () => {
    expect(() => parseTicker('<html>blocked</html>', 403)).toThrow(/HTTP 403/);
    expect(() => parseTicker(JSON.stringify({ success: false, error: 'Unknown pair' }))).toThrow(/Unknown pair/);
    expect(() => parseTicker(JSON.stringify({ success: true, ticker: { lastPrice: null } }))).toThrow(PriceError);
    expect(() => parseTicker(JSON.stringify({ success: true, ticker: { lastPrice: '0' } }))).toThrow(PriceError);
  });

  it('reads candles in either time format, oldest first, skipping broken ones', () => {
    const body = JSON.stringify({
      candles: [
        { time: '2026-10-18T02:00:00Z', open: '1', high: '3', low: '1', close: '2', volume: '5' },
        { time: 1760745600, open: 1, high: 2, low: 1, close: 1.5, volume: 1 },
        { time: 1760749200000, close: 2.5 },
        { time: 'never', close: 9 },
        { time: 1760752800, close: null },
      ],
    });
    const c = parseCandles(body);
    expect(c.map((x) => x.close)).toEqual([1.5, 2.5, 2]);
    expect(c[0].time).toBe(1760745600000);
    expect(c[1].open).toBe(2.5);
    expect(parseCandles(JSON.stringify({ candles: [[1760745600, 1, 2, 0.5, 1.2, 3]] }))[0].close).toBe(1.2);
  });

  it('asks Neoxa for the documented pair and endpoints', () => {
    expect(tickerUrl()).toBe('https://neoxa.exchange/api/exchange/ticker/BTCB2_USDC');
    expect(candlesUrl('1h', 168)).toBe('https://neoxa.exchange/api/exchange/candles/BTCB2_USDC?interval=1h&limit=168');
  });

  it('formats dollars, prices and changes', () => {
    expect(formatUsd(12_345_678, 540.5)).toBe('$66.73');
    expect(formatUsd(250_000_000, 540.5)).toBe('$1,351.25');
    expect(formatPrice(540.5)).toBe('$540.50');
    expect(formatPercent(-5.951)).toBe('-5.95%');
    expect(formatPercent(3)).toBe('+3.00%');
    expect(toMillis('soon')).toBeNull();
  });
});

describe('skins', () => {
  it('open at 0.1, 1 and 10 coins', () => {
    expect(SKINS.map((s) => s.minSats)).toEqual([0, 10_000_000, 100_000_000, 1_000_000_000]);
    expect(tierFor(0)).toBe(0);
    expect(tierFor(9_999_999)).toBe(0);
    expect(tierFor(10_000_000)).toBe(1);
    expect(tierFor(99_999_999)).toBe(1);
    expect(tierFor(100_000_000)).toBe(2);
    expect(tierFor(1_000_000_000)).toBe(3);
    expect(tierFor(21e14)).toBe(3);
  });
});

describe('links', () => {
  it('donation address, when set, is a valid mainnet address', () => {
    if (!DONATION_ADDRESS) return;
    expect(() => decodeAddress(DONATION_ADDRESS, NETWORKS.mainnet)).not.toThrow();
  });

  it('are all https', () => {
    for (const g of LINK_GROUPS) for (const l of g.links) expect(l.url).toMatch(/^https:\/\//);
  });
});
