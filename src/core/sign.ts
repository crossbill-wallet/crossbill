// Signing for the four single-signature script types, with the hash type the replay decision chose.
// ECDSA nonces follow RFC 6979 with Bitcoin Core's low-R grinding (a little-endian counter as extra data),
// exactly as drongo's HMacDSANonceKCalculator does, so signatures match the desktop app byte for byte.
// Schnorr uses 32 zero bytes of auxiliary randomness, as drongo passes to libsecp256k1.

import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { concat, equal, u8, type Bytes } from './bytes';
import { hash160, taggedHash } from './hash';
import { bip143Sighash, bip341Sighash, isUnified, legacySighash, SIGHASH, unifiedSighash, UnifiedScriptType } from './sighash';
import { bytesToBigInt, nestedRedeemScript, outputScript, p2pkhScript, pushData, xOnly, type ScriptType } from './script';
import type { Tx, TxOut } from './tx';

const N = secp256k1.Point.Fn.ORDER;

function bigIntTo32(v: bigint): Bytes {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Minimal DER integer, as BIP66 requires. */
function derInt(b: Bytes): Bytes {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let v: Bytes = b.slice(i);
  if (v[0] & 0x80) v = concat(u8(0), v);
  return concat(u8(0x02), u8(v.length), v);
}

export function derEncode(compact: Bytes): Bytes {
  const body = concat(derInt(compact.slice(0, 32)), derInt(compact.slice(32, 64)));
  return concat(u8(0x30), u8(body.length), body);
}

/**
 * RFC 6979 ECDSA with low-S, grinding the nonce until the DER encoding is under 71 bytes. That is drongo's
 * test (ECDSASignature.hasLowR), which also accepts a high R paired with a short S; Bitcoin Core tests the
 * first byte of R alone. Following drongo keeps signatures identical to the desktop app's, and both rules
 * cap the encoding at 70 bytes, which is what fee estimation relies on.
 */
export function ecdsaSignLowR(digest: Bytes, privKey: Bytes): Bytes {
  let counter = 0;
  for (;;) {
    let extraEntropy: Bytes | undefined;
    if (counter > 0) {
      extraEntropy = new Uint8Array(32);
      new DataView(extraEntropy.buffer).setUint32(0, counter, true);
    }
    const sig = secp256k1.sign(digest, privKey, { prehash: false, lowS: true, extraEntropy });
    if (derEncode(sig).length < 71) {
      const pub = secp256k1.getPublicKey(privKey, true);
      if (!secp256k1.verify(sig, digest, pub, { prehash: false, lowS: true })) throw new Error('Generated signature failed verification');
      return sig;
    }
    counter++;
  }
}

/** BIP341 key path private key: negate for an odd-y internal key, then add the tap tweak. */
export function taprootTweakPrivKey(privKey: Bytes): Bytes {
  const P = secp256k1.Point.BASE.multiply(bytesToBigInt(privKey));
  const pub = P.toBytes(true);
  let d = bytesToBigInt(privKey);
  if (pub[0] === 0x03) d = N - d;
  const t = bytesToBigInt(taggedHash('TapTweak', xOnly(pub)));
  if (t >= N) throw new Error('Tweak out of range');
  const tweaked = (d + t) % N;
  if (tweaked === 0n) throw new Error('Tweaked key is zero');
  return bigIntTo32(tweaked);
}

export function schnorrSignBip340(digest: Bytes, tweakedPriv: Bytes): Bytes {
  const sig = schnorr.sign(digest, tweakedPriv, new Uint8Array(32));
  const pub = schnorr.getPublicKey(tweakedPriv);
  if (!schnorr.verify(sig, digest, pub)) throw new Error('Generated signature failed verification');
  return sig;
}

/** The hash type an input is signed with: the unified opt-in, or what the script type uses by default. */
export function hashTypeFor(type: ScriptType, unified: boolean): number {
  if (unified) return SIGHASH.UNIFIED_ALL;
  return type === 'P2TR' ? SIGHASH.DEFAULT : SIGHASH.ALL;
}

/** The digest for one of this wallet's inputs, by script type and hash type. */
export function inputDigest(tx: Tx, index: number, spent: TxOut[], type: ScriptType, pubKey: Bytes, hashType: number): Bytes {
  const scriptCode = p2pkhScript(hash160(pubKey));
  if (isUnified(hashType)) {
    if (type === 'P2TR') return unifiedSighash(tx, index, spent, { scriptType: UnifiedScriptType.TAPROOT, scriptCode: null, hashType });
    const st = type === 'P2PKH' ? UnifiedScriptType.BARE : UnifiedScriptType.WITNESS_V0;
    return unifiedSighash(tx, index, spent, { scriptType: st, scriptCode, hashType });
  }
  switch (type) {
    case 'P2PKH':
      return legacySighash(tx, index, spent[index].script, hashType);
    case 'P2SH_P2WPKH':
    case 'P2WPKH':
      return bip143Sighash(tx, index, scriptCode, spent[index].value, hashType);
    case 'P2TR':
      return bip341Sighash(tx, index, spent, hashType);
  }
}

export interface SigningKey {
  type: ScriptType;
  privKey: Bytes;
  pubKey: Bytes;
}

/**
 * Signs input `index` in place, writing its scriptSig and witness. `spent` lists every input's spent output,
 * which BIP341 and the unified message commit to.
 */
export function signInput(tx: Tx, index: number, spent: TxOut[], key: SigningKey, hashType: number): void {
  const { type, privKey, pubKey } = key;
  const expected = outputScript(type, pubKey);
  if (!equal(expected, spent[index].script)) throw new Error(`Input ${index} is not paying this key`);
  const digest = inputDigest(tx, index, spent, type, pubKey, hashType);
  const input = tx.inputs[index];
  if (type === 'P2TR') {
    const sig = schnorrSignBip340(digest, taprootTweakPrivKey(privKey));
    input.scriptSig = new Uint8Array(0);
    input.witness = [hashType === SIGHASH.DEFAULT ? sig : concat(sig, u8(hashType))];
    return;
  }
  const sig = concat(derEncode(ecdsaSignLowR(digest, privKey)), u8(hashType));
  switch (type) {
    case 'P2PKH':
      input.scriptSig = concat(pushData(sig), pushData(pubKey));
      input.witness = [];
      return;
    case 'P2SH_P2WPKH':
      input.scriptSig = pushData(nestedRedeemScript(pubKey));
      input.witness = [sig, pubKey];
      return;
    case 'P2WPKH':
      input.scriptSig = new Uint8Array(0);
      input.witness = [sig, pubKey];
      return;
  }
}

/**
 * Writes placeholder signatures of the largest size each input can carry, so a transaction's size can be
 * measured before signing. ECDSA: 71 bytes with the hash type, as drongo's dummy (r = s = n/2) encodes.
 * Schnorr: 64 bytes, or 65 when the hash type byte has to be carried, which an opted-in signature always does.
 */
export function writeDummySignature(tx: Tx, index: number, type: ScriptType, pubKey: Bytes, hashType: number): void {
  const input = tx.inputs[index];
  if (type === 'P2TR') {
    input.scriptSig = new Uint8Array(0);
    input.witness = [new Uint8Array(hashType === SIGHASH.DEFAULT ? 64 : 65)];
    return;
  }
  const half = bigIntTo32(N >> 1n);
  const sig = concat(derEncode(concat(half, half)), u8(hashType));
  switch (type) {
    case 'P2PKH':
      input.scriptSig = concat(pushData(sig), pushData(pubKey));
      input.witness = [];
      return;
    case 'P2SH_P2WPKH':
      input.scriptSig = pushData(nestedRedeemScript(pubKey));
      input.witness = [sig, pubKey];
      return;
    case 'P2WPKH':
      input.scriptSig = new Uint8Array(0);
      input.witness = [sig, pubKey];
      return;
  }
}

/** Reads the hash type byte off each signature of an input this wallet signed, for the replay status of a broadcast transaction. */
export function signatureHashTypes(tx: Tx, type: ScriptType): number[] {
  return tx.inputs.map((input) => {
    if (type === 'P2TR') {
      const sig = input.witness[0];
      if (!sig) return -1;
      return sig.length === 64 ? SIGHASH.DEFAULT : sig[64];
    }
    if (type === 'P2PKH') {
      const s = input.scriptSig;
      if (s.length < 2) return -1;
      const len = s[0];
      return s[len];
    }
    const sig = input.witness[0];
    return sig && sig.length > 0 ? sig[sig.length - 1] : -1;
  });
}

function derToCompact(der: Bytes): Bytes | null {
  // 0x30 len 0x02 rlen r 0x02 slen s
  if (der.length < 8 || der[0] !== 0x30 || der[2] !== 0x02) return null;
  const rlen = der[3];
  const r = der.slice(4, 4 + rlen);
  if (der[4 + rlen] !== 0x02) return null;
  const slen = der[5 + rlen];
  const s = der.slice(6 + rlen, 6 + rlen + slen);
  const pad = (x: Bytes) => {
    let v = x;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) return null;
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const R = pad(r);
  const S = pad(s);
  return R && S ? concat(R, S) : null;
}

export type ReplayReadback = 'protected' | 'unprotected' | 'unchecked';

/**
 * Reads whether a signed transaction of this wallet's is replay protected, by checking each of its own
 * signatures against its own keys, as the desktop app does: a hash type byte alone proves nothing, since any
 * 64 or 65 byte push decodes as a signature. One verified opted-in signature protects the whole transaction.
 * `spent` holds each input's spent output where known; `pubKeys` the wallet's key for its own inputs.
 */
export function replayReadback(tx: Tx, spent: (TxOut | null)[], type: ScriptType, pubKeys: (Bytes | null)[]): ReplayReadback {
  let verifiedLegacy = 0;
  let own = 0;
  const allSpent = spent.every((s) => s != null) ? (spent as TxOut[]) : null;
  for (let i = 0; i < tx.inputs.length; i++) {
    const pub = pubKeys[i];
    if (!pub) continue;
    own++;
    const input = tx.inputs[i];
    let sig: Bytes | undefined;
    if (type === 'P2PKH') {
      const len = input.scriptSig[0];
      sig = input.scriptSig.slice(1, 1 + len);
    } else {
      sig = input.witness[0];
    }
    if (!sig || sig.length === 0) continue;
    const hashType = type === 'P2TR' ? (sig.length === 64 ? SIGHASH.DEFAULT : sig[64]) : sig[sig.length - 1];
    const unified = isUnified(hashType);
    if ((unified || type === 'P2TR') && !allSpent) continue;
    let digest: Bytes;
    try {
      const s = allSpent ?? spent.map((x) => x ?? { value: 0, script: new Uint8Array(0) });
      if (!s[i] || s[i].script.length === 0) continue;
      digest = inputDigest(tx, i, s, type, pub, hashType);
    } catch {
      continue;
    }
    let ok = false;
    if (type === 'P2TR') {
      const outputKey = outputScript('P2TR', pub).slice(2);
      try {
        ok = schnorr.verify(sig.slice(0, 64), digest, outputKey);
      } catch {
        ok = false;
      }
    } else {
      const compact = derToCompact(sig.slice(0, -1));
      try {
        ok = !!compact && secp256k1.verify(compact, digest, pub, { prehash: false, lowS: false });
      } catch {
        ok = false;
      }
    }
    if (!ok) continue;
    if (unified) return 'protected';
    verifiedLegacy++;
  }
  return own > 0 && verifiedLegacy === own ? 'unprotected' : 'unchecked';
}
