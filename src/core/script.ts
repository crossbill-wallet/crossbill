import { bech32, bech32m, createBase58check } from '@scure/base';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { concat, equal, u8, type Bytes } from './bytes';
import { hash160, sha256, taggedHash } from './hash';
import type { NetworkParams } from './network';

const base58check = createBase58check(nobleSha256);

/** The single-signature script types the wallet can hold, named as drongo names them. */
export type ScriptType = 'P2PKH' | 'P2SH_P2WPKH' | 'P2WPKH' | 'P2TR';

export const SCRIPT_TYPES: ScriptType[] = ['P2WPKH', 'P2TR', 'P2SH_P2WPKH', 'P2PKH'];

export const SCRIPT_TYPE_INFO: Record<ScriptType, { label: string; purpose: number; descriptorWrap: (k: string) => string }> = {
  P2WPKH: { label: 'Native Segwit (P2WPKH)', purpose: 84, descriptorWrap: (k) => `wpkh(${k})` },
  P2TR: { label: 'Taproot (P2TR)', purpose: 86, descriptorWrap: (k) => `tr(${k})` },
  P2SH_P2WPKH: { label: 'Nested Segwit (P2SH-P2WPKH)', purpose: 49, descriptorWrap: (k) => `sh(wpkh(${k}))` },
  P2PKH: { label: 'Legacy (P2PKH)', purpose: 44, descriptorWrap: (k) => `pkh(${k})` },
};

export const OP = {
  OP_0: 0x00,
  OP_PUSHDATA1: 0x4c,
  OP_PUSHDATA2: 0x4d,
  OP_1: 0x51,
  OP_DUP: 0x76,
  OP_EQUAL: 0x87,
  OP_EQUALVERIFY: 0x88,
  OP_HASH160: 0xa9,
  OP_CHECKSIG: 0xac,
  OP_RETURN: 0x6a,
} as const;

/** Minimal push of a data element, as the standard scripts this wallet creates use. */
export function pushData(data: Bytes): Bytes {
  if (data.length < OP.OP_PUSHDATA1) return concat(u8(data.length), data);
  if (data.length <= 0xff) return concat(u8(OP.OP_PUSHDATA1), u8(data.length), data);
  if (data.length <= 0xffff) return concat(u8(OP.OP_PUSHDATA2), Uint8Array.of(data.length & 0xff, data.length >> 8), data);
  throw new Error('Push too large');
}

export function p2pkhScript(pubKeyHash: Bytes): Bytes {
  return concat(Uint8Array.of(OP.OP_DUP, OP.OP_HASH160, 0x14), pubKeyHash, Uint8Array.of(OP.OP_EQUALVERIFY, OP.OP_CHECKSIG));
}

export function p2shScript(scriptHash: Bytes): Bytes {
  return concat(Uint8Array.of(OP.OP_HASH160, 0x14), scriptHash, u8(OP.OP_EQUAL));
}

export function p2wpkhScript(pubKeyHash: Bytes): Bytes {
  return concat(Uint8Array.of(OP.OP_0, 0x14), pubKeyHash);
}

export function p2wshScript(scriptHash: Bytes): Bytes {
  return concat(Uint8Array.of(OP.OP_0, 0x20), scriptHash);
}

export function p2trScript(outputKey: Bytes): Bytes {
  return concat(Uint8Array.of(OP.OP_1, 0x20), outputKey);
}

/** x-only form of a compressed public key. */
export function xOnly(pubKey: Bytes): Bytes {
  if (pubKey.length === 32) return pubKey;
  if (pubKey.length !== 33) throw new Error('Expected a compressed public key');
  return pubKey.slice(1);
}

/** BIP86 key path only output key: Q = P + H_TapTweak(P)G, with no script tree. */
export function taprootOutputKey(internalPubKey: Bytes): Bytes {
  const internal = xOnly(internalPubKey);
  const t = bytesToScalar(taggedHash('TapTweak', internal));
  const P = schnorr.utils.lift_x(bytesToBigInt(internal));
  const Q = P.add(secp256k1.Point.BASE.multiply(t));
  return Q.toBytes(true).slice(1);
}

export function bytesToBigInt(b: Bytes): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

function bytesToScalar(b: Bytes): bigint {
  const v = bytesToBigInt(b);
  if (v >= secp256k1.Point.Fn.ORDER) throw new Error('Tweak out of range');
  return v;
}

/** The scriptPubKey this wallet uses for a key of the given type. */
export function outputScript(type: ScriptType, pubKey: Bytes): Bytes {
  switch (type) {
    case 'P2PKH':
      return p2pkhScript(hash160(pubKey));
    case 'P2SH_P2WPKH':
      return p2shScript(hash160(p2wpkhScript(hash160(pubKey))));
    case 'P2WPKH':
      return p2wpkhScript(hash160(pubKey));
    case 'P2TR':
      return p2trScript(taprootOutputKey(pubKey));
  }
}

/** The redeem script a P2SH-P2WPKH input reveals in its scriptSig. */
export function nestedRedeemScript(pubKey: Bytes): Bytes {
  return p2wpkhScript(hash160(pubKey));
}

export type AddressKind = 'P2PKH' | 'P2SH' | 'P2WPKH' | 'P2WSH' | 'P2TR';

export interface DecodedAddress {
  kind: AddressKind;
  scriptPubKey: Bytes;
}

export function encodeAddress(scriptPubKey: Bytes, net: NetworkParams): string {
  const s = scriptPubKey;
  if (s.length === 25 && s[0] === OP.OP_DUP && s[1] === OP.OP_HASH160 && s[2] === 0x14 && s[23] === OP.OP_EQUALVERIFY && s[24] === OP.OP_CHECKSIG) {
    return base58check.encode(concat(u8(net.p2pkhVersion), s.slice(3, 23)));
  }
  if (s.length === 23 && s[0] === OP.OP_HASH160 && s[1] === 0x14 && s[22] === OP.OP_EQUAL) {
    return base58check.encode(concat(u8(net.p2shVersion), s.slice(2, 22)));
  }
  if (s.length === 22 && s[0] === OP.OP_0 && s[1] === 0x14) {
    return bech32.encode(net.bech32, [0, ...bech32.toWords(s.slice(2))]);
  }
  if (s.length === 34 && s[0] === OP.OP_0 && s[1] === 0x20) {
    return bech32.encode(net.bech32, [0, ...bech32.toWords(s.slice(2))]);
  }
  if (s.length === 34 && s[0] === OP.OP_1 && s[1] === 0x20) {
    return bech32m.encode(net.bech32, [1, ...bech32m.toWords(s.slice(2))]);
  }
  throw new Error('Script has no standard address form');
}

/** Returns the address form of a script, or null when it has none (OP_RETURN, bare multisig and the like). */
export function tryEncodeAddress(scriptPubKey: Bytes, net: NetworkParams): string | null {
  try {
    return encodeAddress(scriptPubKey, net);
  } catch {
    return null;
  }
}

/**
 * Parses a destination address for this network. Only the address types this wallet knows how to size and
 * pay are accepted. Future witness versions are refused rather than paid, since coins sent to an undefined
 * version are spendable by anyone until a soft fork gives that version meaning.
 */
export function decodeAddress(address: string, net: NetworkParams): DecodedAddress {
  const a = address.trim();
  const lower = a.toLowerCase();
  if (lower.startsWith(net.bech32 + '1')) {
    if (a !== lower && a !== a.toUpperCase()) throw new Error('Address mixes upper and lower case');
    if (d0Prefix(lower) !== net.bech32) throw new Error('Address is for a different network');
    const decoded = decodeSegwit(lower);
    if (!decoded) throw new Error('Not a valid address for this network');
    const { version, program } = decoded;
    if (version === 0 && program.length === 20) return { kind: 'P2WPKH', scriptPubKey: p2wpkhScript(program) };
    if (version === 0 && program.length === 32) return { kind: 'P2WSH', scriptPubKey: p2wshScript(program) };
    if (version === 1 && program.length === 32) return { kind: 'P2TR', scriptPubKey: p2trScript(program) };
    throw new Error(`Witness version ${version} with a ${program.length} byte program is not supported`);
  }
  let payload: Bytes;
  try {
    payload = base58check.decode(a);
  } catch {
    throw new Error('Not a valid address for this network');
  }
  if (payload.length !== 21) throw new Error('Not a valid address for this network');
  if (payload[0] === net.p2pkhVersion) return { kind: 'P2PKH', scriptPubKey: p2pkhScript(payload.slice(1)) };
  if (payload[0] === net.p2shVersion) return { kind: 'P2SH', scriptPubKey: p2shScript(payload.slice(1)) };
  throw new Error('Address is for a different network');
}

function d0Prefix(lower: string): string {
  return lower.slice(0, lower.lastIndexOf('1'));
}

/** BIP173/BIP350: version 0 must use the bech32 checksum, every later version bech32m. */
function decodeSegwit(lower: string): { version: number; program: Bytes } | null {
  const s = lower as `${string}1${string}`;
  try {
    const d = bech32.decode(s, 90);
    if (d.words[0] === 0) {
      const program = bech32.fromWords(d.words.slice(1));
      if (program.length === 20 || program.length === 32) return { version: 0, program };
    }
    return null;
  } catch {
    // not a bech32 checksum, so try bech32m
  }
  try {
    const d = bech32m.decode(s, 90);
    const version = d.words[0];
    if (version < 1 || version > 16) return null;
    const program = bech32m.fromWords(d.words.slice(1));
    if (program.length < 2 || program.length > 40) return null;
    return { version, program };
  } catch {
    return null;
  }
}

/** Classifies a scriptPubKey, for sizing inputs and outputs. */
export function classifyScript(s: Bytes): AddressKind | 'OP_RETURN' | 'UNKNOWN' {
  if (s.length === 25 && s[0] === OP.OP_DUP && s[1] === OP.OP_HASH160 && s[2] === 0x14 && s[23] === OP.OP_EQUALVERIFY && s[24] === OP.OP_CHECKSIG) return 'P2PKH';
  if (s.length === 23 && s[0] === OP.OP_HASH160 && s[1] === 0x14 && s[22] === OP.OP_EQUAL) return 'P2SH';
  if (s.length === 22 && s[0] === OP.OP_0 && s[1] === 0x14) return 'P2WPKH';
  if (s.length === 34 && s[0] === OP.OP_0 && s[1] === 0x20) return 'P2WSH';
  if (s.length === 34 && s[0] === OP.OP_1 && s[1] === 0x20) return 'P2TR';
  if (s.length > 0 && s[0] === OP.OP_RETURN) return 'OP_RETURN';
  return 'UNKNOWN';
}

/**
 * Core's dust threshold at the default 3 sat/vB dust relay fee: the cost of spending an output, plus the
 * output itself, at that rate. Change below this is added to the fee instead.
 */
export function dustThreshold(scriptPubKey: Bytes): number {
  const outputSize = 8 + 1 + scriptPubKey.length;
  const kind = classifyScript(scriptPubKey);
  const isWitness = kind === 'P2WPKH' || kind === 'P2WSH' || kind === 'P2TR';
  // 107 / 4 is integer division in Core's GetDustThreshold
  const spendSize = isWitness ? 32 + 4 + 1 + Math.floor(107 / 4) + 4 : 32 + 4 + 1 + 107 + 4;
  return Math.floor((outputSize + spendSize) * 3);
}

export function scriptsEqual(a: Bytes, b: Bytes): boolean {
  return equal(a, b);
}

export { sha256 };
