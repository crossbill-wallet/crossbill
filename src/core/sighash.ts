// Signature hash messages: the legacy algorithm, BIP143 (segwit v0), BIP341 (taproot) and Shrike's unified
// opt-in message, ported line for line from drongo's Transaction.hashForUnifiedSignature.

import { compactSize, concat, i32le, u32le, u64le, u8, varBytes, type Bytes } from './bytes';
import { sha256, sha256d, taggedHash } from './hash';
import { outpointBytes, serializeOutput, serializeTx, type Tx, type TxOut } from './tx';

export const SIGHASH = {
  DEFAULT: 0x00,
  ALL: 0x01,
  NONE: 0x02,
  SINGLE: 0x03,
  ANYONECANPAY: 0x80,
  /** The opt-in bit selecting the unified signature hash. */
  UNIFIED_FLAG: 0x20,
  UNIFIED_ALL: 0x21,
} as const;

/** The script type byte the unified message is domain separated by (drongo's UnifiedScriptType). */
export const UnifiedScriptType = {
  BARE: 0,
  WITNESS_V0: 1,
  TAPROOT: 2,
  TAPSCRIPT: 3,
} as const;
export type UnifiedScriptTypeValue = (typeof UnifiedScriptType)[keyof typeof UnifiedScriptType];

export function isUnified(hashType: number): boolean {
  return (hashType & SIGHASH.UNIFIED_FLAG) !== 0;
}

const ZERO32: Bytes = new Uint8Array(32);

/** The original algorithm, for P2PKH and other pre-segwit inputs. OP_CODESEPARATOR is not handled, as no script this wallet signs carries one. */
export function legacySighash(tx: Tx, inputIndex: number, scriptCode: Bytes, hashType: number): Bytes {
  if (inputIndex >= tx.inputs.length) throw new Error('Input index out of range');
  const base = hashType & 0x1f;
  const acp = (hashType & SIGHASH.ANYONECANPAY) !== 0;
  if (base === SIGHASH.SINGLE && inputIndex >= tx.outputs.length) {
    // The historic "one" hash for SINGLE without a matching output
    const one = new Uint8Array(32);
    one[0] = 1;
    return one;
  }
  const inputs = tx.inputs.map((inp, i) => ({
    prevout: inp.prevout,
    scriptSig: i === inputIndex ? scriptCode : new Uint8Array(0),
    sequence: i !== inputIndex && (base === SIGHASH.NONE || base === SIGHASH.SINGLE) ? 0 : inp.sequence,
    witness: [] as Bytes[],
  }));
  const parts: Bytes[] = [i32le(tx.version)];
  const usedInputs = acp ? [inputs[inputIndex]] : inputs;
  parts.push(compactSize(usedInputs.length));
  for (const i of usedInputs) parts.push(outpointBytes(i.prevout), varBytes(i.scriptSig), u32le(i.sequence));
  if (base === SIGHASH.NONE) {
    parts.push(compactSize(0));
  } else if (base === SIGHASH.SINGLE) {
    parts.push(compactSize(inputIndex + 1));
    for (let i = 0; i < inputIndex; i++) parts.push(u64le(0xffffffffffffffffn), compactSize(0));
    parts.push(serializeOutput(tx.outputs[inputIndex]));
  } else {
    parts.push(compactSize(tx.outputs.length));
    for (const o of tx.outputs) parts.push(serializeOutput(o));
  }
  parts.push(u32le(tx.locktime), u32le(hashType >>> 0));
  return sha256d(concat(...parts));
}

/** BIP143, for segwit v0 inputs (P2WPKH and P2SH-P2WPKH here). */
export function bip143Sighash(tx: Tx, inputIndex: number, scriptCode: Bytes, value: number, hashType: number): Bytes {
  const base = hashType & 0x1f;
  const acp = (hashType & SIGHASH.ANYONECANPAY) !== 0;
  const hashPrevouts = acp ? ZERO32 : sha256d(concat(...tx.inputs.map((i) => outpointBytes(i.prevout))));
  const hashSequence = acp || base === SIGHASH.SINGLE || base === SIGHASH.NONE ? ZERO32 : sha256d(concat(...tx.inputs.map((i) => u32le(i.sequence))));
  let hashOutputs: Bytes = ZERO32;
  if (base !== SIGHASH.SINGLE && base !== SIGHASH.NONE) {
    hashOutputs = sha256d(concat(...tx.outputs.map(serializeOutput)));
  } else if (base === SIGHASH.SINGLE && inputIndex < tx.outputs.length) {
    hashOutputs = sha256d(serializeOutput(tx.outputs[inputIndex]));
  }
  const input = tx.inputs[inputIndex];
  return sha256d(
    concat(i32le(tx.version), hashPrevouts, hashSequence, outpointBytes(input.prevout), varBytes(scriptCode), u64le(value), u32le(input.sequence), hashOutputs, u32le(tx.locktime), u32le(hashType >>> 0)),
  );
}

const TAPROOT_HASH_TYPES = new Set([0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83]);

/** BIP341 signature message, key path (or script path when a leaf hash is given). */
export function bip341Sighash(tx: Tx, inputIndex: number, spent: TxOut[], hashType: number, leafHash: Bytes | null = null, annex: Bytes | null = null): Bytes {
  if (!TAPROOT_HASH_TYPES.has(hashType)) throw new Error(`Undefined taproot hash type ${hashType}`);
  if (spent.length !== tx.inputs.length) throw new Error('Every spent output is required');
  const base = hashType & 0x03;
  const acp = (hashType & SIGHASH.ANYONECANPAY) !== 0;
  const parts: Bytes[] = [u8(0x00), u8(hashType), i32le(tx.version), u32le(tx.locktime)];
  if (!acp) {
    parts.push(
      sha256(concat(...tx.inputs.map((i) => outpointBytes(i.prevout)))),
      sha256(concat(...spent.map((o) => u64le(o.value)))),
      sha256(concat(...spent.map((o) => varBytes(o.script)))),
      sha256(concat(...tx.inputs.map((i) => u32le(i.sequence)))),
    );
  }
  if (base !== SIGHASH.NONE && base !== SIGHASH.SINGLE) parts.push(sha256(concat(...tx.outputs.map(serializeOutput))));
  parts.push(u8((leafHash ? 2 : 0) + (annex ? 1 : 0)));
  if (acp) {
    const i = tx.inputs[inputIndex];
    parts.push(outpointBytes(i.prevout), u64le(spent[inputIndex].value), varBytes(spent[inputIndex].script), u32le(i.sequence));
  } else {
    parts.push(u32le(inputIndex));
  }
  if (annex) parts.push(sha256(varBytes(annex)));
  if (base === SIGHASH.SINGLE) {
    if (inputIndex >= tx.outputs.length) throw new Error('No output for SIGHASH_SINGLE');
    parts.push(sha256(serializeOutput(tx.outputs[inputIndex])));
  }
  if (leafHash) parts.push(leafHash, u8(0x00), u32le(0xffffffff));
  return taggedHash('TapSighash', concat(...parts));
}

export function tapLeafHash(leafScript: Bytes): Bytes {
  return taggedHash('TapLeaf', concat(u8(0xc0), varBytes(leafScript)));
}

export interface UnifiedParams {
  scriptType: UnifiedScriptTypeValue;
  /** For BARE and WITNESS_V0: the script the legacy rules already use. Ignored for taproot. */
  scriptCode: Bytes | null;
  hashType: number;
  annex?: Bytes | null;
  tapLeafHash?: Bytes | null;
  codeSeparatorPosition?: number | null;
}

/**
 * The unified opt-in signature hash: one BIP341-shaped message for every script type, selected per
 * signature by the 0x20 bit in the hash type byte. Commits to every spent amount and scriptPubKey.
 */
export function unifiedSighash(tx: Tx, inputIndex: number, spent: TxOut[], p: UnifiedParams): Bytes {
  const { scriptType, hashType } = p;
  const isTaproot = scriptType === UnifiedScriptType.TAPROOT || scriptType === UnifiedScriptType.TAPSCRIPT;
  if (spent.length !== tx.inputs.length) throw new Error('Provided spent UTXOs length does not equal the number of transaction inputs');
  if (inputIndex < 0 || inputIndex >= tx.inputs.length) throw new Error('Input index is greater than the number of transaction inputs');
  if (!isTaproot && !p.scriptCode) throw new Error(`A script code is required for script type ${scriptType}`);
  if (scriptType === UnifiedScriptType.TAPSCRIPT && !p.tapLeafHash) throw new Error('A tapleaf hash is required for a tapscript spend');
  if ((hashType & SIGHASH.UNIFIED_FLAG) === 0) throw new Error(`Hash type ${hashType.toString(16)} does not opt in`);

  const outType = hashType & 0x1f;
  const acp = (hashType & SIGHASH.ANYONECANPAY) !== 0;
  if (isTaproot) {
    if ((hashType & ~(0x1f | SIGHASH.ANYONECANPAY | SIGHASH.UNIFIED_FLAG) & 0xff) !== 0 || (outType !== SIGHASH.ALL && outType !== SIGHASH.NONE && outType !== SIGHASH.SINGLE)) {
      throw new Error(`Undefined hash type ${hashType.toString(16)} for script type ${scriptType}`);
    }
  }

  // Locktime is committed to as five bytes, the fifth zero until something sets it
  const parts: Bytes[] = [u8(0x00), u8(hashType & 0xff), u32le(tx.version >>> 0), u32le(tx.locktime), u8(0)];
  if (!acp) {
    parts.push(
      sha256(concat(...tx.inputs.map((i) => outpointBytes(i.prevout)))),
      sha256(concat(...spent.map((o) => u64le(o.value)))),
      sha256(concat(...spent.map((o) => varBytes(o.script)))),
      sha256(concat(...tx.inputs.map((i) => u32le(i.sequence)))),
    );
  }
  if (outType !== SIGHASH.NONE && outType !== SIGHASH.SINGLE) parts.push(sha256(concat(...tx.outputs.map(serializeOutput))));
  parts.push(u8(scriptType));
  if (acp) {
    const i = tx.inputs[inputIndex];
    parts.push(outpointBytes(i.prevout), u64le(spent[inputIndex].value), varBytes(spent[inputIndex].script), u32le(i.sequence));
  } else {
    parts.push(u32le(inputIndex));
  }
  if (!isTaproot) {
    parts.push(varBytes(p.scriptCode!));
  } else {
    parts.push(u8(p.annex ? 0x01 : 0x00));
    if (p.annex) parts.push(sha256(varBytes(p.annex)));
  }
  if (outType === SIGHASH.SINGLE) {
    if (inputIndex >= tx.outputs.length) throw new Error(`No output at index ${inputIndex} to sign with SIGHASH_SINGLE`);
    parts.push(sha256(serializeOutput(tx.outputs[inputIndex])));
  }
  if (scriptType === UnifiedScriptType.TAPSCRIPT) {
    const pos = p.codeSeparatorPosition == null ? 0xffffffff : p.codeSeparatorPosition >>> 0;
    parts.push(p.tapLeafHash!, u8(0x00), u32le(pos));
  }
  return taggedHash('UnifiedSighash', concat(...parts));
}

/** Kept for callers that need the non-witness serialization, e.g. size checks. */
export { serializeTx };
