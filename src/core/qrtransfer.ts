// Moving a PSBT to and from an air-gapped signer by QR code. Crossbill shows BBQr (Coinkite's Better Bitcoin QR):
// the payload is deflated with a 1 KiB window, as BBQr's "Z" encoding specifies, then base32, then split into
// parts that each carry an 8 character header. Paperclip's Krux replies in the format it was shown, so a send
// comes back as BBQr too. A PSBT the Krux loaded from microSD comes back as Specter-style "pMofN" base64 parts,
// and a single plain base64 code is read as well.

import { deflateRaw, Inflate } from 'pako';
import { base32nopad, base64 } from '@scure/base';
import type { Bytes } from './bytes';

/** Alphanumeric capacity of a QR code at error correction L, by version (ISO/IEC 18004 table 7). */
export const QR_ALNUM_L: Record<number, number> = { 5: 154, 6: 195, 7: 224, 8: 279, 9: 335, 10: 395, 11: 468, 12: 535, 13: 619, 14: 667, 15: 758 };

export type QrDensity = 'easy' | 'standard' | 'dense';
/** The QR version each density setting tops out at. "easy" matches what the Krux shows on its own screen. */
export const DENSITY_VERSION: Record<QrDensity, number> = { easy: 7, standard: 10, dense: 13 };

const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const toB36 = (n: number) => B36[Math.floor(n / 36)] + B36[n % 36];
const fromB36 = (s: string) => {
  const a = B36.indexOf(s[0]);
  const b = B36.indexOf(s[1]);
  return a < 0 || b < 0 ? NaN : a * 36 + b;
};

export class QrTransferError extends Error {}

/** The most base32 a BBQr series may carry, as Paperclip's Krux allows (bbqr.py): 160 KiB. */
export const BBQR_MAX_CHARS = 160 * 1024;
/** The most parts a pMofN series may have, as the Krux allows (qr.py). */
export const PMOFN_MAX_PARTS = 99;
/** The most a deflated payload may inflate to. A PSBT this wallet signs is far smaller. */
export const INFLATE_MAX_BYTES = 1024 * 1024;

/** Inflates raw deflate with BBQr's 1 KiB window, stopping as soon as the output passes `max` bytes. */
export function boundedInflateRaw(data: Bytes, max = INFLATE_MAX_BYTES): Bytes {
  const inf = new Inflate({ raw: true, windowBits: 10 });
  const chunks: Bytes[] = [];
  let total = 0;
  inf.onData = (chunk: Bytes) => {
    total += chunk.length;
    if (total > max) throw new QrTransferError('Those codes hold far more than a transaction. Scan the Krux’s codes again.');
    chunks.push(chunk);
  };
  inf.push(data, true);
  if (inf.err) throw new QrTransferError('Those codes didn’t decode. Scan them again.');
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** BBQr parts for a PSBT ("P") or other file type, each fitting a QR code of at most `version` at level L. */
export function bbqrEncode(data: Bytes, opts: { version?: number; fileType?: 'P' | 'T' | 'U' | 'J' } = {}): string[] {
  const version = opts.version ?? DENSITY_VERSION.standard;
  const capacity = QR_ALNUM_L[version];
  if (!capacity) throw new Error(`No capacity known for QR version ${version}`);
  const deflated = deflateRaw(data, { windowBits: 10, level: 9 });
  const useZ = deflated.length < data.length;
  const body = base32nopad.encode(useZ ? deflated : data);
  if (body.length > BBQR_MAX_CHARS) throw new QrTransferError('This transaction is too large for the Krux to read as QR codes. Save it to microSD instead.');
  // Each part but the last holds a whole number of 8 character base32 groups, so it decodes on its own
  const perPart = Math.floor((capacity - 8) / 8) * 8;
  let count = Math.max(1, Math.ceil(body.length / perPart));
  if (count > 1295) throw new QrTransferError('This transaction is too large to show as QR codes. Save it to microSD instead.');
  // Even the parts out, so the last frame isn't a sliver
  const even = Math.ceil(Math.ceil(body.length / count) / 8) * 8;
  count = Math.ceil(body.length / even);
  const head = `B$${useZ ? 'Z' : '2'}${opts.fileType ?? 'P'}${toB36(count)}`;
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(head + toB36(i) + body.slice(i * even, (i + 1) * even));
  return parts;
}

export interface Progress {
  have: number;
  total: number;
}

export type ScanResult = { kind: 'psbt'; data: Bytes } | { kind: 'text'; text: string };

/**
 * Collects the parts of an animated code in any order. add() takes each code the camera reads and returns
 * the result once every part is in, or null while some are missing.
 */
export class QrAssembler {
  private kind: 'bbqr' | 'pmofn' | null = null;
  private total = 0;
  private encoding = '';
  private fileType = '';
  private parts = new Map<number, string>();
  private chars = 0;
  /** Goes up each time parts already read are dropped for another series, so the scanner can be told to pass them on again */
  restarts = 0;

  get progress(): Progress | null {
    return this.kind ? { have: this.parts.size, total: this.total } : null;
  }

  reset(): void {
    this.kind = null;
    this.total = 0;
    this.chars = 0;
    this.parts.clear();
  }

  add(raw: string): ScanResult | null {
    const text = raw.trim();
    if (/^B\$/.test(text)) return this.addBbqr(text);
    const pm = /^p(\d+)of(\d+) (.*)$/s.exec(text);
    if (pm) return this.addPmofn(Number(pm[1]), Number(pm[2]), pm[3]);
    if (/^ur:/i.test(text)) {
      throw new QrTransferError('That’s a UR code. Send the transaction from Crossbill so the Krux answers with the same kind of code Crossbill reads.');
    }
    const single = decodeSingle(text);
    if (single) return { kind: 'psbt', data: single };
    return { kind: 'text', text };
  }

  private start(kind: 'bbqr' | 'pmofn', total: number): void {
    if (this.kind !== kind || this.total !== total) {
      if (this.parts.size) this.restarts++;
      this.kind = kind;
      this.total = total;
      this.chars = 0;
      this.parts.clear();
    }
  }

  private keep(index: number, chunk: string, max: number): void {
    const before = this.parts.get(index);
    if (before === chunk) return;
    this.chars += chunk.length - (before?.length ?? 0);
    if (this.chars > max) {
      this.reset();
      throw new QrTransferError('Those codes hold more than a transaction can. Scan the Krux’s codes again.');
    }
    this.parts.set(index, chunk);
  }

  private addBbqr(text: string): ScanResult | null {
    if (text.length < 8) throw new QrTransferError('That code is cut short');
    const encoding = text[2];
    const fileType = text[3];
    const total = fromB36(text.slice(4, 6));
    const index = fromB36(text.slice(6, 8));
    if (!'Z2H'.includes(encoding)) throw new QrTransferError('That code uses a BBQr encoding Crossbill doesn’t read');
    if (!(total >= 1) || !(index >= 0) || index >= total) throw new QrTransferError('That code’s part numbers don’t make sense');
    if (this.kind === 'bbqr' && (this.encoding !== encoding || this.fileType !== fileType)) {
      if (this.parts.size) this.restarts++;
      this.reset();
    }
    this.start('bbqr', total);
    this.encoding = encoding;
    this.fileType = fileType;
    this.keep(index, text.slice(8), BBQR_MAX_CHARS);
    if (this.parts.size < total) return null;
    const ordered = [...Array(total).keys()].map((i) => this.parts.get(i)!);
    let data: Bytes;
    try {
      if (encoding === 'H') {
        const hex = ordered.join('');
        if (!/^[0-9A-F]*$/i.test(hex) || hex.length % 2) throw new Error('bad hex');
        data = Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
      } else {
        const bin = concatAll(ordered.map((p) => base32nopad.decode(p)));
        data = encoding === 'Z' ? boundedInflateRaw(bin) : bin;
      }
    } catch (e) {
      this.reset();
      if (e instanceof QrTransferError) throw e;
      throw new QrTransferError('Those codes didn’t decode. Scan them again.');
    }
    this.reset();
    if (fileType === 'P') return { kind: 'psbt', data };
    if (fileType === 'U' || fileType === 'J') return { kind: 'text', text: new TextDecoder().decode(data) };
    throw new QrTransferError('Those codes hold a kind of file Crossbill doesn’t use');
  }

  private addPmofn(m: number, n: number, chunk: string): ScanResult | null {
    if (!(n >= 1) || !(m >= 1) || m > n || n > PMOFN_MAX_PARTS) throw new QrTransferError('That code’s part numbers don’t make sense');
    this.start('pmofn', n);
    this.keep(m - 1, chunk, BBQR_MAX_CHARS);
    if (this.parts.size < n) return null;
    const joined = [...Array(n).keys()].map((i) => this.parts.get(i)!).join('');
    this.reset();
    const data = decodeSingle(joined);
    if (!data) throw new QrTransferError('Those codes didn’t decode. Scan them again.');
    return { kind: 'psbt', data };
  }
}

function concatAll(parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const PSBT_B64 = /^cHNidP8[A-Za-z0-9+/=\s]*$/;
const PSBT_HEX = /^70736274ff[0-9a-fA-F]*$/;

/** A whole PSBT in one string: base64 (starts "cHNidP8") or hex. */
export function decodeSingle(text: string): Bytes | null {
  const t = text.trim();
  try {
    if (PSBT_B64.test(t)) return base64.decode(t.replace(/\s+/g, ''));
    if (PSBT_HEX.test(t) && t.length % 2 === 0) return Uint8Array.from(t.match(/../g)!, (h) => parseInt(h, 16));
  } catch {
    return null;
  }
  return null;
}

/** A PSBT file from microSD or Files: binary, or base64 or hex text. */
export function readPsbtFile(data: Bytes): Bytes {
  if (data.length > 5 && data[0] === 0x70 && data[1] === 0x73 && data[2] === 0x62 && data[3] === 0x74 && data[4] === 0xff) return data;
  const text = new TextDecoder().decode(data);
  const single = decodeSingle(text);
  if (!single) throw new QrTransferError('That file isn’t a PSBT. Choose the signed file the Krux saved, ending in -signed.psbt.');
  return single;
}
