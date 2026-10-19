import { compactSize, concat, fromHex, i32le, Reader, reversed, toHex, u32le, u64le, u8, varBytes, type Bytes } from './bytes';
import { sha256d } from './hash';

export interface OutPoint {
  /** Transaction id in display (RPC) byte order. */
  txid: string;
  vout: number;
}

export interface TxIn {
  prevout: OutPoint;
  scriptSig: Bytes;
  sequence: number;
  witness: Bytes[];
}

export interface TxOut {
  /** Satoshis. Always a safe integer. */
  value: number;
  script: Bytes;
}

export interface Tx {
  version: number;
  locktime: number;
  inputs: TxIn[];
  outputs: TxOut[];
}

export const SEQUENCE_FINAL = 0xffffffff;
/** Signals BIP125 replaceability and enables nLockTime, as Sparrow sets on every input it creates. */
export const SEQUENCE_RBF = 0xfffffffd;

export function outpointBytes(o: OutPoint): Bytes {
  return concat(reversed(fromHex(o.txid)), u32le(o.vout));
}

export function serializeOutput(o: TxOut): Bytes {
  return concat(u64le(o.value), varBytes(o.script));
}

export function hasWitness(tx: Tx): boolean {
  return tx.inputs.some((i) => i.witness.length > 0);
}

export function serializeTx(tx: Tx, withWitness = true): Bytes {
  const segwit = withWitness && hasWitness(tx);
  const parts: Bytes[] = [i32le(tx.version)];
  if (segwit) parts.push(Uint8Array.of(0x00, 0x01));
  parts.push(compactSize(tx.inputs.length));
  for (const i of tx.inputs) parts.push(outpointBytes(i.prevout), varBytes(i.scriptSig), u32le(i.sequence));
  parts.push(compactSize(tx.outputs.length));
  for (const o of tx.outputs) parts.push(serializeOutput(o));
  if (segwit) {
    for (const i of tx.inputs) {
      parts.push(compactSize(i.witness.length));
      for (const w of i.witness) parts.push(varBytes(w));
    }
  }
  parts.push(u32le(tx.locktime));
  return concat(...parts);
}

export function parseTx(data: Bytes | string): Tx {
  const r = new Reader(typeof data === 'string' ? fromHex(data) : data);
  const version = r.i32();
  let segwit = false;
  let nIn = r.compactSize();
  if (nIn === 0) {
    const flag = r.u8();
    if (flag !== 1) throw new Error('Unsupported transaction serialization');
    segwit = true;
    nIn = r.compactSize();
  }
  const inputs: TxIn[] = [];
  for (let i = 0; i < nIn; i++) {
    const txid = toHex(reversed(r.bytes(32)));
    const vout = r.u32();
    const scriptSig = r.varBytes();
    const sequence = r.u32();
    inputs.push({ prevout: { txid, vout }, scriptSig, sequence, witness: [] });
  }
  const nOut = r.compactSize();
  const outputs: TxOut[] = [];
  for (let i = 0; i < nOut; i++) {
    const value = r.u64();
    outputs.push({ value, script: r.varBytes() });
  }
  if (segwit) {
    for (const input of inputs) {
      const n = r.compactSize();
      for (let j = 0; j < n; j++) input.witness.push(r.varBytes());
    }
  }
  const locktime = r.u32();
  if (r.remaining !== 0) throw new Error('Trailing data after transaction');
  return { version, locktime, inputs, outputs };
}

export function txid(tx: Tx): string {
  return toHex(reversed(sha256d(serializeTx(tx, false))));
}

export function wtxid(tx: Tx): string {
  return toHex(reversed(sha256d(serializeTx(tx, true))));
}

export function weight(tx: Tx): number {
  const base = serializeTx(tx, false).length;
  const total = serializeTx(tx, true).length;
  return base * 3 + total;
}

export function vsize(tx: Tx): number {
  return Math.ceil(weight(tx) / 4);
}

export function isCoinbase(tx: Tx): boolean {
  return tx.inputs.length === 1 && /^0{64}$/.test(tx.inputs[0].prevout.txid) && tx.inputs[0].prevout.vout === 0xffffffff;
}

export function cloneTx(tx: Tx): Tx {
  return {
    version: tx.version,
    locktime: tx.locktime,
    inputs: tx.inputs.map((i) => ({ prevout: { ...i.prevout }, scriptSig: i.scriptSig.slice(), sequence: i.sequence, witness: i.witness.map((w) => w.slice()) })),
    outputs: tx.outputs.map((o) => ({ value: o.value, script: o.script.slice() })),
  };
}

export function txToHex(tx: Tx): string {
  return toHex(serializeTx(tx, true));
}

export { u8 };
