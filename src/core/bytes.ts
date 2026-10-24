// Byte helpers shared by the wallet core. Everything here is synchronous and side-effect free.

export type Bytes = Uint8Array;

const HEX = '0123456789abcdef';

export function toHex(b: Bytes): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i] >> 4] + HEX[b[i] & 15];
  return s;
}

export function fromHex(hex: string): Bytes {
  if (hex.length % 2 !== 0) throw new Error('Hex string has an odd length');
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('Not a hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function concat(...parts: Bytes[]): Bytes {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equal(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function reversed(b: Bytes): Bytes {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i];
  return out;
}

export function u8(n: number): Bytes {
  return Uint8Array.of(n & 0xff);
}

export function u32le(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`uint32 out of range: ${n}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

export function u32be(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`uint32 out of range: ${n}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

export function i32le(n: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, n, true);
  return out;
}

/** Satoshi amounts and other 64 bit values. Amounts in this wallet are always safe integers. */
export function u64le(n: number | bigint): Bytes {
  const v = BigInt(n);
  if (v < 0n || v > 0xffffffffffffffffn) throw new Error(`uint64 out of range: ${n}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

export function compactSize(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0) throw new Error(`Bad compact size ${n}`);
  if (n < 0xfd) return u8(n);
  if (n <= 0xffff) {
    const out = new Uint8Array(3);
    out[0] = 0xfd;
    new DataView(out.buffer).setUint16(1, n, true);
    return out;
  }
  if (n <= 0xffffffff) return concat(u8(0xfe), u32le(n));
  return concat(u8(0xff), u64le(n));
}

/** Length-prefixed byte string, as transactions and the signature hash messages serialize scripts. */
export function varBytes(b: Bytes): Bytes {
  return concat(compactSize(b.length), b);
}

export class Reader {
  private pos = 0;
  constructor(private readonly buf: Bytes) {}

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  bytes(n: number): Bytes {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error('Unexpected end of data');
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u8(): number {
    return this.bytes(1)[0];
  }

  u32(): number {
    const b = this.bytes(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  }

  i32(): number {
    const b = this.bytes(4);
    return new DataView(b.buffer, b.byteOffset, 4).getInt32(0, true);
  }

  u64(): number {
    const b = this.bytes(8);
    const v = new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount too large');
    return Number(v);
  }

  compactSize(): number {
    const first = this.u8();
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const b = this.bytes(2);
      return new DataView(b.buffer, b.byteOffset, 2).getUint16(0, true);
    }
    if (first === 0xfe) return this.u32();
    return this.u64();
  }

  varBytes(): Bytes {
    return this.bytes(this.compactSize());
  }
}
