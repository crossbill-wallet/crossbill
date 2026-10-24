// Partially signed transactions (BIP174, version 0) for an air-gapped signer such as Paperclip's Krux. The phone
// builds the transaction, hands it over with everything the signer needs to check it, and reads the signatures
// back. Every input asks for the unified signature (SIGHASH_UNIFIED | SIGHASH_ALL, 0x21): Paperclip's firmware
// refuses anything else, and a signature it returns is only taken once it verifies against this wallet's own
// key and the unified message for that input.

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { compactSize, concat, equal, fromHex, Reader, toHex, u32le, u8, varBytes, type Bytes } from './bytes';
import { SIGHASH } from './sighash';
import { derEncode, inputDigest } from './sign';
import { nestedRedeemScript, outputScript, pushData, xOnly, type ScriptType } from './script';
import { cloneTx, parseTx, serializeOutput, serializeTx, txid, type Tx, type TxOut } from './tx';
import type { DraftTransaction } from './txbuilder';

const MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff);

export const PSBT_GLOBAL = { UNSIGNED_TX: 0x00, XPUB: 0x01, VERSION: 0xfb } as const;
export const PSBT_IN = {
  NON_WITNESS_UTXO: 0x00,
  WITNESS_UTXO: 0x01,
  PARTIAL_SIG: 0x02,
  SIGHASH_TYPE: 0x03,
  REDEEM_SCRIPT: 0x04,
  WITNESS_SCRIPT: 0x05,
  BIP32_DERIVATION: 0x06,
  FINAL_SCRIPTSIG: 0x07,
  FINAL_SCRIPTWITNESS: 0x08,
  TAP_KEY_SIG: 0x13,
  TAP_BIP32_DERIVATION: 0x16,
  TAP_INTERNAL_KEY: 0x17,
} as const;
export const PSBT_OUT = { REDEEM_SCRIPT: 0x00, BIP32_DERIVATION: 0x02, TAP_INTERNAL_KEY: 0x05, TAP_BIP32_DERIVATION: 0x07 } as const;

export interface PsbtEntry {
  /** The whole key, its type byte first. */
  key: Bytes;
  value: Bytes;
}

export interface Psbt {
  tx: Tx;
  global: PsbtEntry[];
  inputs: PsbtEntry[][];
  outputs: PsbtEntry[][];
}

export class PsbtError extends Error {}

export function isPsbt(data: Bytes): boolean {
  return data.length > MAGIC.length && equal(data.slice(0, MAGIC.length), MAGIC);
}

function readMap(r: Reader, where: string): PsbtEntry[] {
  const out: PsbtEntry[] = [];
  const seen = new Set<string>();
  for (;;) {
    const keyLen = r.compactSize();
    if (keyLen === 0) return out;
    const key = r.bytes(keyLen);
    const value = r.varBytes();
    const id = toHex(key);
    if (seen.has(id)) throw new PsbtError(`The transaction repeats a field in ${where}`);
    seen.add(id);
    out.push({ key, value });
  }
}

export function parsePsbt(data: Bytes): Psbt {
  if (!isPsbt(data)) throw new PsbtError('This isn’t a partially signed transaction');
  const r = new Reader(data);
  r.bytes(MAGIC.length);
  let global: PsbtEntry[];
  try {
    global = readMap(r, 'its header');
  } catch (e) {
    if (e instanceof PsbtError) throw e;
    throw new PsbtError('The transaction is cut short or damaged');
  }
  const version = global.find((e) => e.key.length === 1 && e.key[0] === PSBT_GLOBAL.VERSION);
  if (version && version.value.length === 4 && new DataView(version.value.buffer, version.value.byteOffset, 4).getUint32(0, true) !== 0) {
    throw new PsbtError('This is a version 2 PSBT, which Crossbill doesn’t read. Export it as version 0.');
  }
  const unsigned = global.find((e) => e.key.length === 1 && e.key[0] === PSBT_GLOBAL.UNSIGNED_TX);
  if (!unsigned) throw new PsbtError('The PSBT has no transaction in it');
  let tx: Tx;
  try {
    tx = parseTx(unsigned.value);
  } catch {
    throw new PsbtError('The transaction inside the PSBT is damaged');
  }
  if (tx.inputs.some((i) => i.scriptSig.length > 0 || i.witness.length > 0)) throw new PsbtError('The PSBT’s transaction should be unsigned');
  try {
    const inputs = tx.inputs.map((_, i) => readMap(r, `input ${i + 1}`));
    const outputs = tx.outputs.map((_, i) => readMap(r, `output ${i + 1}`));
    if (r.remaining !== 0) throw new PsbtError('There is extra data after the PSBT');
    return { tx, global, inputs, outputs };
  } catch (e) {
    if (e instanceof PsbtError) throw e;
    throw new PsbtError('The transaction is cut short or damaged');
  }
}

function writeMap(entries: PsbtEntry[]): Bytes {
  return concat(...entries.map((e) => concat(varBytes(e.key), varBytes(e.value))), Uint8Array.of(0));
}

export function serializePsbt(p: Psbt): Bytes {
  return concat(MAGIC, writeMap(p.global), ...p.inputs.map(writeMap), ...p.outputs.map(writeMap));
}

const HARDENED = 0x80000000;

/** "m/84'/0'/0'" (or with h) as BIP32 path numbers. */
export function parsePath(path: string): number[] {
  const parts = path.trim().replace(/^m\/?/, '').split('/').filter(Boolean);
  return parts.map((p) => {
    const hard = /['hH]$/.test(p);
    const n = Number(hard ? p.slice(0, -1) : p);
    if (!Number.isInteger(n) || n < 0 || n >= HARDENED) throw new Error(`Bad derivation step ${p}`);
    return hard ? n + HARDENED : n;
  });
}

/** BIP174's key origin: the master fingerprint as written (4 bytes), then each step as a little-endian u32. */
function keyOrigin(fingerprint: string, path: number[]): Bytes {
  if (!/^[0-9a-f]{8}$/i.test(fingerprint)) throw new Error('Bad fingerprint');
  return concat(fromHex(fingerprint.toLowerCase()), ...path.map((n) => u32le(n)));
}

function entry(type: number, value: Bytes, keyData: Bytes = new Uint8Array(0)): PsbtEntry {
  return { key: concat(Uint8Array.of(type), keyData), value };
}

export interface PsbtWallet {
  scriptType: ScriptType;
  /** Master key fingerprint, 8 hex characters */
  fingerprint: string;
  /** Account path, e.g. m/84'/0'/0' */
  derivation: string;
  pubKey: (chain: 0 | 1, index: number) => Bytes;
  /** The raw transaction a coin came from, as hex. Legacy inputs can't be signed without it. */
  prevTx: (txid: string) => string | undefined;
  /** Which of this wallet's addresses an output pays, if any, so the signer shows it as change or a self-transfer. */
  ownOutput: (script: Bytes) => { chain: 0 | 1; index: number } | null;
}

/**
 * The PSBT for a draft. Every input carries what Paperclip's Krux checks before signing: the unified hash type,
 * the spent output (the whole previous transaction for legacy inputs), and this wallet's key origin. Outputs to
 * this wallet carry their key origin too, so the signer can show change as change.
 */
export function buildPsbt(draft: DraftTransaction, w: PsbtWallet): Bytes {
  if (!draft.unified) throw new PsbtError('The Krux only signs replay-protected transactions');
  const tx = cloneTx(draft.tx);
  for (const i of tx.inputs) {
    i.scriptSig = new Uint8Array(0);
    i.witness = [];
  }
  if (tx.inputs.length !== draft.coins.length) throw new Error('Draft inputs and coins disagree');
  const account = parsePath(w.derivation);
  const inputs = draft.coins.map((c, i) => {
    const prev = tx.inputs[i].prevout;
    if (prev.txid !== c.txid || prev.vout !== c.vout) throw new Error('Draft inputs and coins disagree');
    const pub = w.pubKey(c.chain, c.index);
    const script = fromHex(c.script);
    if (!equal(outputScript(w.scriptType, pub), script)) throw new Error(`Coin ${c.txid}:${c.vout} does not belong to this wallet`);
    const origin = keyOrigin(w.fingerprint, [...account, c.chain, c.index]);
    const out: PsbtEntry[] = [];
    if (w.scriptType === 'P2PKH') {
      const hex = w.prevTx(c.txid);
      if (!hex) throw new PsbtError(`The transaction that paid ${c.txid.slice(0, 8)}… isn’t on this phone yet. Refresh the wallet and try again.`);
      const prevTx = parseTx(hex);
      const spent = prevTx.outputs[c.vout];
      if (txid(prevTx) !== c.txid || !spent || spent.value !== c.value || !equal(spent.script, script)) throw new Error(`The saved copy of ${c.txid} doesn’t match`);
      // Without the witness copy: the Krux refuses a legacy input that carries one
      out.push(entry(PSBT_IN.NON_WITNESS_UTXO, serializeTx(prevTx, false)));
    } else {
      out.push(entry(PSBT_IN.WITNESS_UTXO, serializeOutput({ value: c.value, script })));
    }
    out.push(entry(PSBT_IN.SIGHASH_TYPE, u32le(SIGHASH.UNIFIED_ALL)));
    if (w.scriptType === 'P2SH_P2WPKH') out.push(entry(PSBT_IN.REDEEM_SCRIPT, nestedRedeemScript(pub)));
    if (w.scriptType === 'P2TR') {
      const x = xOnly(pub);
      out.push(entry(PSBT_IN.TAP_BIP32_DERIVATION, concat(compactSize(0), origin), x));
      out.push(entry(PSBT_IN.TAP_INTERNAL_KEY, x));
    } else {
      out.push(entry(PSBT_IN.BIP32_DERIVATION, origin, pub));
    }
    return out;
  });
  const outputs = tx.outputs.map((o) => {
    const own = w.ownOutput(o.script);
    if (!own) return [];
    const pub = w.pubKey(own.chain, own.index);
    if (!equal(outputScript(w.scriptType, pub), o.script)) throw new Error('An output to this wallet doesn’t match its key');
    const origin = keyOrigin(w.fingerprint, [...account, own.chain, own.index]);
    if (w.scriptType === 'P2TR') {
      const x = xOnly(pub);
      return [entry(PSBT_OUT.TAP_INTERNAL_KEY, x), entry(PSBT_OUT.TAP_BIP32_DERIVATION, concat(compactSize(0), origin), x)];
    }
    const out: PsbtEntry[] = [];
    if (w.scriptType === 'P2SH_P2WPKH') out.push(entry(PSBT_OUT.REDEEM_SCRIPT, nestedRedeemScript(pub)));
    out.push(entry(PSBT_OUT.BIP32_DERIVATION, origin, pub));
    return out;
  });
  return serializePsbt({ tx, global: [entry(PSBT_GLOBAL.UNSIGNED_TX, serializeTx(tx, false))], inputs, outputs });
}

function field(map: PsbtEntry[], type: number, keyData?: Bytes): PsbtEntry | undefined {
  return map.find((e) => e.key[0] === type && (keyData ? equal(e.key.slice(1), keyData) : e.key.length === 1));
}

function readWitness(v: Bytes): Bytes[] {
  const r = new Reader(v);
  const n = r.compactSize();
  const items: Bytes[] = [];
  for (let i = 0; i < n; i++) items.push(r.varBytes());
  return items;
}

/** The pushes of a push-only script, or null. */
function readPushes(script: Bytes): Bytes[] | null {
  const out: Bytes[] = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i++];
    let len: number;
    if (op >= 1 && op <= 75) len = op;
    else if (op === 0x4c) len = script[i++];
    else return null;
    if (i + len > script.length) return null;
    out.push(script.slice(i, i + len));
    i += len;
  }
  return out;
}

function derToCompact(der: Bytes): Bytes | null {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2 || der[2] !== 0x02) return null;
  const rlen = der[3];
  if (4 + rlen + 2 > der.length || der[4 + rlen] !== 0x02) return null;
  const slen = der[5 + rlen];
  if (6 + rlen + slen !== der.length) return null;
  const fit = (x: Bytes) => {
    let v = x;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) return null;
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const R = fit(der.slice(4, 4 + rlen));
  const S = fit(der.slice(6 + rlen));
  return R && S ? concat(R, S) : null;
}

export interface SignedFromDevice {
  tx: Tx;
  hex: string;
  txid: string;
}

/**
 * Takes the signatures out of what the signer returned and builds the final transaction. The returned PSBT
 * must hold the same transaction that was sent; only its signatures are used, and each one must be a unified
 * ALL signature (0x21) that verifies against this wallet's key for that input. Anything else is refused.
 */
export function finalizeFromDevice(draft: DraftTransaction, w: Pick<PsbtWallet, 'scriptType' | 'pubKey'>, returned: Bytes): SignedFromDevice {
  const p = parsePsbt(returned);
  const unsigned = cloneTx(draft.tx);
  for (const i of unsigned.inputs) {
    i.scriptSig = new Uint8Array(0);
    i.witness = [];
  }
  if (!equal(serializeTx(p.tx, false), serializeTx(unsigned, false))) {
    throw new PsbtError('This is a different transaction from the one you showed the Krux. Scan the Krux’s signed transaction for this payment.');
  }
  const spent: TxOut[] = draft.coins.map((c) => ({ value: c.value, script: fromHex(c.script) }));
  const tx = cloneTx(unsigned);
  draft.coins.forEach((c, i) => {
    const map = p.inputs[i];
    const pub = w.pubKey(c.chain, c.index);
    const digest = inputDigest(tx, i, spent, w.scriptType, pub, SIGHASH.UNIFIED_ALL);
    const which = `input ${i + 1} of ${draft.coins.length}`;
    if (w.scriptType === 'P2TR') {
      let sig = field(map, PSBT_IN.TAP_KEY_SIG)?.value;
      const final = field(map, PSBT_IN.FINAL_SCRIPTWITNESS)?.value;
      if (!sig && final) {
        const items = readWitness(final);
        if (items.length === 1) sig = items[0];
      }
      if (!sig) throw new PsbtError(`The Krux didn’t sign ${which}. Check it has this wallet’s seed words, passphrase and address type loaded.`);
      if (sig.length !== 65 || sig[64] !== SIGHASH.UNIFIED_ALL) throw new PsbtError(`The signature on ${which} isn’t a unified (replay-protected) signature, so it can’t be sent.`);
      let ok = false;
      try {
        ok = schnorr.verify(sig.slice(0, 64), digest, outputScript('P2TR', pub).slice(2));
      } catch {
        ok = false;
      }
      if (!ok) throw new PsbtError(`The signature on ${which} doesn’t check out against this wallet’s key.`);
      tx.inputs[i].witness = [sig];
      return;
    }
    let sig = field(map, PSBT_IN.PARTIAL_SIG, pub)?.value;
    if (!sig) {
      // A signer that finalizes: read the signature back out of its scriptSig or witness
      const fw = field(map, PSBT_IN.FINAL_SCRIPTWITNESS)?.value;
      const fs = field(map, PSBT_IN.FINAL_SCRIPTSIG)?.value;
      const items = w.scriptType === 'P2PKH' ? (fs ? readPushes(fs) : null) : fw ? readWitness(fw) : null;
      if (items && items.length === 2 && equal(items[1], pub)) sig = items[0];
    }
    if (!sig) throw new PsbtError(`The Krux didn’t sign ${which}. Check it has this wallet’s seed words, passphrase and address type loaded.`);
    if (sig[sig.length - 1] !== SIGHASH.UNIFIED_ALL) throw new PsbtError(`The signature on ${which} isn’t a unified (replay-protected) signature, so it can’t be sent.`);
    const compact = derToCompact(sig.slice(0, -1));
    let ok = false;
    try {
      ok = !!compact && secp256k1.verify(compact, digest, pub, { prehash: false, lowS: true });
    } catch {
      ok = false;
    }
    if (!ok) throw new PsbtError(`The signature on ${which} doesn’t check out against this wallet’s key.`);
    // Written out again in strict DER, as consensus requires, from the r and s that verified
    sig = concat(derEncode(compact!), u8(SIGHASH.UNIFIED_ALL));
    switch (w.scriptType) {
      case 'P2PKH':
        tx.inputs[i].scriptSig = concat(pushData(sig), pushData(pub));
        tx.inputs[i].witness = [];
        return;
      case 'P2SH_P2WPKH':
        tx.inputs[i].scriptSig = pushData(nestedRedeemScript(pub));
        tx.inputs[i].witness = [sig, pub];
        return;
      case 'P2WPKH':
        tx.inputs[i].scriptSig = new Uint8Array(0);
        tx.inputs[i].witness = [sig, pub];
        return;
    }
  });
  const hex = toHex(serializeTx(tx, true));
  return { tx, hex, txid: txid(tx) };
}

/** Whether the Krux will warn "Unverified input amounts": two or more non-taproot inputs without whole previous transactions. */
export function kruxWarnsUnverifiedAmounts(scriptType: ScriptType, inputs: number): boolean {
  return (scriptType === 'P2WPKH' || scriptType === 'P2SH_P2WPKH') && inputs >= 2;
}
