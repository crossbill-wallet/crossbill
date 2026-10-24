// 0.4.0's hardware wallet pieces: the PSBT Crossbill hands Paperclip's Krux, the BBQr codes it shows, reading the
// Krux's public key, and taking the signed transaction back.
//
// The "Paperclip's firmware" tests run the firmware's own signing code on this computer, through
// tools/krux-check/krux_sign.py. They run only when KRUX_SRC (a checkout of connorslab/krux-blake2b with its embit
// submodule) and KRUX_UUR (a folder holding the built uUR module) are set; see tools/krux-check/README.md.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { createBase58check, base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, fromHex, toHex, u32be, u8, type Bytes } from '../src/core/bytes';
import { NETWORKS, type NetworkParams } from '../src/core/network';
import { AccountKey, deriveAccount } from '../src/core/keys';
import { encodeAddress, outputScript, SCRIPT_TYPES, type ScriptType } from '../src/core/script';
import { buildTransaction, type Coin, type DraftTransaction } from '../src/core/txbuilder';
import { signDraft } from '../src/core/signer';
import { replayReadback, signatureHashTypes } from '../src/core/sign';
import { parseTx, serializeTx, txid, type Tx } from '../src/core/tx';
import { buildPsbt, finalizeFromDevice, kruxWarnsUnverifiedAmounts, parsePsbt, PSBT_IN, PSBT_OUT, PsbtError, serializePsbt, type PsbtWallet } from '../src/core/psbt';
import { bbqrEncode, BBQR_MAX_CHARS, DENSITY_VERSION, QR_ALNUM_L, QrAssembler, QrTransferError, readPsbtFile } from '../src/core/qrtransfer';
import { deflateRaw } from 'pako';
import { base32nopad } from '@scure/base';
import { HardwareKeyError, matchWallet, parseHardwareKey } from '../src/core/hwkey';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const b58 = createBase58check(sha256);

/** The key text a Krux shows: [fp/purpose'/coin'/account']zpub (or ypub, or xpub), as SLIP-132 writes it. */
function kruxKeyText(type: ScriptType, net: NetworkParams, passphrase = '', account = 0): string {
  const a = deriveAccount(MNEMONIC, passphrase, type, net, account);
  const main = net.name === 'mainnet';
  const version = type === 'P2WPKH' ? (main ? 0x04b24746 : 0x045f1cf6) : type === 'P2SH_P2WPKH' ? (main ? 0x049d7cb2 : 0x044a5262) : main ? 0x0488b21e : 0x043587cf;
  const payload = b58.decode(a.xpub);
  const path = a.derivation.replace(/^m\//, '').replace(/'/g, 'h');
  return `[${a.fingerprint}/${path}]${b58.encode(concat(u32be(version), payload.slice(4)))}`;
}

interface Fixture {
  type: ScriptType;
  net: NetworkParams;
  acct: ReturnType<typeof deriveAccount>;
  key: AccountKey;
  fund: Tx;
  coins: Coin[];
  wallet: PsbtWallet;
}

/** A wallet of the given type with `inputs` coins of 100,000 sats each, paid by one funding transaction. */
function fixture(type: ScriptType, net: NetworkParams, inputs = 1, passphrase = ''): Fixture {
  const acct = deriveAccount(MNEMONIC, passphrase, type, net);
  const key = new AccountKey(acct.xpub, net);
  const scripts = [...Array(inputs).keys()].map((i) => outputScript(type, key.pubKey(0, i)));
  // A funding transaction with a witness, as most are, to check legacy inputs carry it without one
  const fund: Tx = {
    version: 2,
    locktime: 0,
    inputs: [{ prevout: { txid: '11'.repeat(32), vout: 0 }, scriptSig: new Uint8Array(0), sequence: 0xfffffffd, witness: [new Uint8Array(71), new Uint8Array(33)] }],
    outputs: scripts.map((script) => ({ value: 100_000, script })),
  };
  const fundId = txid(fund);
  const coins: Coin[] = scripts.map((s, i) => ({ txid: fundId, vout: i, value: 100_000, script: toHex(s), chain: 0, index: i, height: 100 }));
  const own = new Map<string, { chain: 0 | 1; index: number }>();
  for (let i = 0; i < 25; i++) {
    own.set(toHex(outputScript(type, key.pubKey(0, i))), { chain: 0, index: i });
    own.set(toHex(outputScript(type, key.pubKey(1, i))), { chain: 1, index: i });
  }
  const wallet: PsbtWallet = {
    scriptType: type,
    fingerprint: acct.fingerprint,
    derivation: acct.derivation,
    pubKey: (c, i) => key.pubKey(c, i),
    prevTx: (id) => (id === fundId ? toHex(serializeTx(fund, true)) : undefined),
    ownOutput: (s) => own.get(toHex(s)) ?? null,
  };
  return { type, net, acct, key, fund, coins, wallet };
}

const STRANGER = fromHex('0014' + '42'.repeat(20));

function draftFor(f: Fixture, opts: { amount?: number; selfPay?: boolean; unified?: boolean } = {}): DraftTransaction {
  const to = opts.selfPay ? outputScript(f.type, f.key.pubKey(0, 20)) : STRANGER;
  return buildTransaction({
    scriptType: f.type,
    payments: [{ address: encodeAddress(to, f.net), scriptPubKey: to, amount: opts.amount ?? 50_000 }],
    feeRate: 2,
    available: f.coins,
    selected: f.coins,
    pubKeyFor: (c, i) => f.key.pubKey(c, i),
    changeIndex: 3,
    unified: opts.unified ?? true,
    tipHeight: 1000,
    random: () => 0,
  });
}

const field = (map: { key: Bytes; value: Bytes }[], type: number) => map.filter((e) => e.key[0] === type);

describe('the PSBT Crossbill hands the Krux', () => {
  for (const type of SCRIPT_TYPES) {
    it(`carries what the Krux checks, for ${type}`, () => {
      const f = fixture(type, NETWORKS.mainnet, 2);
      const draft = draftFor(f);
      const p = parsePsbt(buildPsbt(draft, f.wallet));
      expect(toHex(serializeTx(p.tx, false))).toBe(toHex(serializeTx(draft.tx, false)));
      p.inputs.forEach((map, i) => {
        // Unified ALL, written as a u32, on every input
        expect(toHex(field(map, PSBT_IN.SIGHASH_TYPE)[0].value)).toBe('21000000');
        const coin = draft.coins[i];
        if (type === 'P2PKH') {
          expect(field(map, PSBT_IN.WITNESS_UTXO)).toHaveLength(0);
          const prev = parseTx(field(map, PSBT_IN.NON_WITNESS_UTXO)[0].value);
          expect(txid(prev)).toBe(coin.txid);
          expect(prev.inputs[0].witness).toHaveLength(0);
        } else {
          expect(field(map, PSBT_IN.NON_WITNESS_UTXO)).toHaveLength(0);
          expect(field(map, PSBT_IN.WITNESS_UTXO)).toHaveLength(1);
        }
        const pub = f.key.pubKey(coin.chain, coin.index);
        if (type === 'P2TR') {
          const d = field(map, PSBT_IN.TAP_BIP32_DERIVATION)[0];
          expect(toHex(d.key.slice(1))).toBe(toHex(pub.slice(1)));
          expect(d.value[0]).toBe(0);
          expect(toHex(d.value.slice(1, 5))).toBe(f.acct.fingerprint);
          expect(toHex(field(map, PSBT_IN.TAP_INTERNAL_KEY)[0].value)).toBe(toHex(pub.slice(1)));
        } else {
          const d = field(map, PSBT_IN.BIP32_DERIVATION)[0];
          expect(toHex(d.key.slice(1))).toBe(toHex(pub));
          expect(toHex(d.value.slice(0, 4))).toBe(f.acct.fingerprint);
          expect(d.value.length).toBe(4 + 5 * 4);
        }
        expect(field(map, PSBT_IN.REDEEM_SCRIPT)).toHaveLength(type === 'P2SH_P2WPKH' ? 1 : 0);
      });
      // Change carries its key origin; the stranger's output carries nothing
      const changeAt = draft.outputs.findIndex((o) => o.isChange);
      expect(changeAt).toBeGreaterThanOrEqual(0);
      p.outputs.forEach((map, i) => {
        if (i !== changeAt) return expect(map).toHaveLength(0);
        expect(field(map, type === 'P2TR' ? PSBT_OUT.TAP_BIP32_DERIVATION : PSBT_OUT.BIP32_DERIVATION)).toHaveLength(1);
        expect(field(map, PSBT_OUT.REDEEM_SCRIPT)).toHaveLength(type === 'P2SH_P2WPKH' ? 1 : 0);
      });
      // It reads back byte for byte
      expect(toHex(serializePsbt(p))).toBe(toHex(buildPsbt(draft, f.wallet)));
    });
  }

  it('marks a payment to one of the wallet’s own addresses, so the Krux shows a self-transfer', () => {
    const f = fixture('P2WPKH', NETWORKS.mainnet);
    const draft = draftFor(f, { selfPay: true });
    const p = parsePsbt(buildPsbt(draft, f.wallet));
    expect(p.outputs.every((m) => field(m, PSBT_OUT.BIP32_DERIVATION).length === 1)).toBe(true);
  });

  it('refuses a draft that isn’t replay protected, and a legacy coin whose transaction isn’t on the phone', () => {
    const f = fixture('P2WPKH', NETWORKS.mainnet);
    expect(() => buildPsbt(draftFor(f, { unified: false }), f.wallet)).toThrow(/replay-protected/);
    const g = fixture('P2PKH', NETWORKS.mainnet);
    expect(() => buildPsbt(draftFor(g), { ...g.wallet, prevTx: () => undefined })).toThrow(/isn’t on this phone/);
  });

  it('says when the Krux will warn about unverified input amounts', () => {
    expect(kruxWarnsUnverifiedAmounts('P2WPKH', 1)).toBe(false);
    expect(kruxWarnsUnverifiedAmounts('P2WPKH', 2)).toBe(true);
    expect(kruxWarnsUnverifiedAmounts('P2SH_P2WPKH', 3)).toBe(true);
    expect(kruxWarnsUnverifiedAmounts('P2TR', 5)).toBe(false);
    expect(kruxWarnsUnverifiedAmounts('P2PKH', 5)).toBe(false);
  });

  it('refuses a version 2 PSBT and damaged ones', () => {
    const f = fixture('P2WPKH', NETWORKS.mainnet);
    const p = parsePsbt(buildPsbt(draftFor(f), f.wallet));
    const v2 = serializePsbt({ ...p, global: [...p.global, { key: u8(0xfb), value: fromHex('02000000') }] });
    expect(() => parsePsbt(v2)).toThrow(/version 2/);
    const raw = buildPsbt(draftFor(f), f.wallet);
    expect(() => parsePsbt(raw.slice(0, raw.length - 10))).toThrow(PsbtError);
    expect(() => parsePsbt(fromHex('00'))).toThrow(PsbtError);
  });
});

/** Puts this phone's own signatures into the PSBT the way a signer returns them: partial sigs, or tap key sigs. */
function signLikeADevice(f: Fixture, draft: DraftTransaction, mutate?: (sig: Bytes, i: number) => Bytes): Bytes {
  const signed = signDraft(draft, { mnemonic: MNEMONIC, passphrase: '' }, f.type, f.acct.derivation, f.acct.fingerprint, f.net);
  const p = parsePsbt(buildPsbt(draft, f.wallet));
  draft.coins.forEach((c, i) => {
    const pub = f.key.pubKey(c.chain, c.index);
    const input = signed.tx.inputs[i];
    let sig: Bytes;
    if (f.type === 'P2PKH') {
      sig = input.scriptSig.slice(1, 1 + input.scriptSig[0]);
    } else sig = input.witness[0];
    if (mutate) sig = mutate(sig, i);
    if (f.type === 'P2TR') p.inputs[i].push({ key: u8(PSBT_IN.TAP_KEY_SIG), value: sig });
    else p.inputs[i].push({ key: concat(u8(PSBT_IN.PARTIAL_SIG), pub), value: sig });
  });
  return serializePsbt(p);
}

describe('taking the signed transaction back', () => {
  for (const type of SCRIPT_TYPES) {
    it(`builds the same transaction the phone would have signed, for ${type}`, () => {
      const f = fixture(type, NETWORKS.mainnet, 2);
      const draft = draftFor(f);
      const own = signDraft(draft, { mnemonic: MNEMONIC, passphrase: '' }, type, f.acct.derivation, f.acct.fingerprint, f.net);
      const back = finalizeFromDevice(draft, f.wallet, signLikeADevice(f, draft));
      expect(back.hex).toBe(own.hex);
      expect(signatureHashTypes(back.tx, type).every((h) => h === 0x21)).toBe(true);
    });
  }

  it('refuses a different transaction', () => {
    const f = fixture('P2WPKH', NETWORKS.mainnet);
    const signed = signLikeADevice(f, draftFor(f, { amount: 40_000 }));
    expect(() => finalizeFromDevice(draftFor(f), f.wallet, signed)).toThrow(/different transaction/);
  });

  it('refuses a signature that isn’t unified ALL, or doesn’t verify, or is missing', () => {
    for (const type of ['P2WPKH', 'P2TR'] as ScriptType[]) {
      const f = fixture(type, NETWORKS.mainnet);
      const draft = draftFor(f);
      const legacyByte = signLikeADevice(f, draft, (s) => concat(s.slice(0, -1), u8(0x01)));
      expect(() => finalizeFromDevice(draft, f.wallet, legacyByte)).toThrow(/isn’t a unified/);
      const flipped = signLikeADevice(f, draft, (s) => {
        const c = s.slice();
        c[10] ^= 1;
        return c;
      });
      expect(() => finalizeFromDevice(draft, f.wallet, flipped)).toThrow(/doesn’t check out|isn’t a unified/);
      expect(() => finalizeFromDevice(draft, f.wallet, buildPsbt(draft, f.wallet))).toThrow(/didn’t sign input 1 of 1/);
    }
  });

  it('writes a signature with padded DER out again in strict DER, which the node requires', () => {
    const f = fixture('P2WPKH', NETWORKS.mainnet);
    const draft = draftFor(f);
    const own = signDraft(draft, { mnemonic: MNEMONIC, passphrase: '' }, 'P2WPKH', f.acct.derivation, f.acct.fingerprint, f.net);
    // 30 len 02 rlen r 02 slen s 21: give r an extra leading zero
    const padded = signLikeADevice(f, draft, (sig) => {
      const rlen = sig[3];
      const r = sig.slice(4, 4 + rlen);
      const rest = sig.slice(4 + rlen, -1);
      const body = concat(u8(0x02), u8(rlen + 1), u8(0), r, rest);
      return concat(u8(0x30), u8(body.length), body, u8(0x21));
    });
    expect(finalizeFromDevice(draft, f.wallet, padded).hex).toBe(own.hex);
  });

  it('reads a signature out of a finalized input too', () => {
    const f = fixture('P2WPKH', NETWORKS.mainnet);
    const draft = draftFor(f);
    const own = signDraft(draft, { mnemonic: MNEMONIC, passphrase: '' }, 'P2WPKH', f.acct.derivation, f.acct.fingerprint, f.net);
    const p = parsePsbt(buildPsbt(draft, f.wallet));
    const w = own.tx.inputs[0].witness;
    p.inputs[0].push({ key: u8(PSBT_IN.FINAL_SCRIPTWITNESS), value: concat(u8(2), u8(w[0].length), w[0], u8(w[1].length), w[1]) });
    expect(finalizeFromDevice(draft, f.wallet, serializePsbt(p)).hex).toBe(own.hex);
  });
});

describe('BBQr codes', () => {
  it('has the right capacity for each QR version', () => {
    for (const [v, cap] of Object.entries(QR_ALNUM_L)) {
      expect(QRCode.create('A'.repeat(cap), { version: Number(v), errorCorrectionLevel: 'L' }).version).toBe(Number(v));
      expect(() => QRCode.create('A'.repeat(cap + 1), { version: Number(v), errorCorrectionLevel: 'L' })).toThrow();
    }
  });

  it('splits into parts that fit, and reads back in any order', () => {
    const f = fixture('P2WPKH', NETWORKS.mainnet, 6);
    const psbt = buildPsbt(draftFor(f), f.wallet);
    for (const [density, version] of Object.entries(DENSITY_VERSION)) {
      const parts = bbqrEncode(psbt, { version });
      for (const p of parts) {
        expect(p).toMatch(/^B\$[Z2]P[0-9A-Z]{4}[A-Z2-7]+$/);
        expect(QRCode.create(p, { errorCorrectionLevel: 'L' }).version).toBeLessThanOrEqual(version);
      }
      const a = new QrAssembler();
      const order = [...parts.keys()].reverse();
      let out = null;
      for (const i of order) {
        expect(out).toBeNull();
        out = a.add(parts[i]);
        if (!out) expect(a.progress?.total).toBe(parts.length);
      }
      expect(out, density).toEqual({ kind: 'psbt', data: psbt });
    }
  });

  it('compresses when that’s smaller, and leaves it plain when not', () => {
    expect(bbqrEncode(new Uint8Array(400))[0].slice(0, 4)).toBe('B$ZP');
    const random = crypto.getRandomValues(new Uint8Array(400));
    expect(bbqrEncode(random)[0].slice(0, 4)).toBe('B$2P');
  });

  it('reads the Krux’s other replies: pMofN parts, one base64 code, a file', () => {
    const f = fixture('P2TR', NETWORKS.mainnet);
    const psbt = buildPsbt(draftFor(f), f.wallet);
    const b64 = base64.encode(psbt);
    const chunks = [b64.slice(0, 100), b64.slice(100, 200), b64.slice(200)];
    const a = new QrAssembler();
    expect(a.add(`p3of3 ${chunks[2]}`)).toBeNull();
    expect(a.add(`p1of3 ${chunks[0]}`)).toBeNull();
    expect(a.progress).toEqual({ have: 2, total: 3 });
    expect(a.add(`p2of3 ${chunks[1]}`)).toEqual({ kind: 'psbt', data: psbt });
    expect(new QrAssembler().add(b64)).toEqual({ kind: 'psbt', data: psbt });
    expect(readPsbtFile(psbt)).toEqual(psbt);
    expect(readPsbtFile(new TextEncoder().encode(b64 + '\n'))).toEqual(psbt);
    expect(() => readPsbtFile(new TextEncoder().encode('hello'))).toThrow(QrTransferError);
    expect(() => new QrAssembler().add('ur:crypto-psbt/abc')).toThrow(/UR code/);
    expect(new QrAssembler().add('[73c5da0a/84h/0h/0h]zpub')).toEqual({ kind: 'text', text: '[73c5da0a/84h/0h/0h]zpub' });
  });

  it('refuses codes that would inflate to far more than a transaction, or claim too many parts', () => {
    // 3 MB of zeros deflates to a few kilobytes: one series of BBQr codes
    const bomb = base32nopad.encode(deflateRaw(new Uint8Array(3_000_000), { windowBits: 10, level: 9 }));
    const per = 400;
    const n = Math.ceil(bomb.length / per);
    const b36 = (x: number) => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(x / 36)] + '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[x % 36];
    const a = new QrAssembler();
    let thrown: unknown = null;
    try {
      for (let i = 0; i < n; i++) a.add(`B$ZP${b36(n)}${b36(i)}${bomb.slice(i * per, (i + 1) * per)}`);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(QrTransferError);
    expect(String(thrown)).toMatch(/far more than a transaction/);
    expect(() => new QrAssembler().add('p1of100000 abc')).toThrow(/don’t make sense/);
    // A series longer than the Krux reads, refused part by part
    const big = new QrAssembler();
    expect(() => {
      for (let i = 0; i < 1295; i++) big.add(`B$2P${b36(1295)}${b36(i)}${'A'.repeat(200)}`);
    }).toThrow(/more than a transaction can/);
    const noise = new Uint8Array(Math.ceil(BBQR_MAX_CHARS * 0.7));
    for (let i = 0; i < noise.length; i += 65536) crypto.getRandomValues(noise.subarray(i, i + 65536));
    expect(() => bbqrEncode(noise)).toThrow(/microSD/);
  });

  it('counts each time a different series drops the codes read so far', () => {
    const one = bbqrEncode(crypto.getRandomValues(new Uint8Array(500)), { version: 7 });
    const two = bbqrEncode(crypto.getRandomValues(new Uint8Array(700)), { version: 7 });
    const a = new QrAssembler();
    a.add(one[0]);
    expect(a.restarts).toBe(0);
    a.add(two[0]);
    expect(a.restarts).toBe(1);
  });

  it('starts over when a different set of codes comes along', () => {
    const one = bbqrEncode(crypto.getRandomValues(new Uint8Array(500)), { version: 7 });
    const two = bbqrEncode(crypto.getRandomValues(new Uint8Array(700)), { version: 7 });
    const a = new QrAssembler();
    a.add(one[0]);
    a.add(two[1]);
    expect(a.progress).toEqual({ have: 1, total: two.length });
  });
});

describe('the Krux’s public key', () => {
  const ZPUB = '[73c5da0a/84h/0h/0h]zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

  it('reads the BIP84 test key as the Krux shows it', () => {
    const k = parseHardwareKey(ZPUB, NETWORKS.mainnet);
    expect(k).toMatchObject({ fingerprint: '73c5da0a', derivation: "m/84'/0'/0'", scriptType: 'P2WPKH', account: 0 });
    expect(k.xpub).toBe(deriveAccount(MNEMONIC, '', 'P2WPKH', NETWORKS.mainnet).xpub);
  });

  for (const type of SCRIPT_TYPES) {
    for (const net of [NETWORKS.mainnet, NETWORKS.regtest]) {
      it(`reads ${type} on ${net.name}`, () => {
        const a = deriveAccount(MNEMONIC, '', type, net);
        const k = parseHardwareKey(kruxKeyText(type, net), net);
        expect(k).toMatchObject({ fingerprint: a.fingerprint, derivation: a.derivation, xpub: a.xpub, scriptType: type });
        expect(matchWallet(k, { name: 'Spending', ...a, scriptType: type })).toEqual({ ok: true });
      });
    }
  }

  it('reads an output descriptor, and an account other than 0', () => {
    const net = NETWORKS.mainnet;
    expect(parseHardwareKey(`wpkh(${ZPUB}/<0;1>/*)`, net).scriptType).toBe('P2WPKH');
    const tr = kruxKeyText('P2TR', net);
    expect(parseHardwareKey(`tr(${tr}/0/*)#abcdefgh`, net).scriptType).toBe('P2TR');
    expect(() => parseHardwareKey(`pkh(${tr})`, net)).toThrow(/don’t agree/);
    const acct1 = parseHardwareKey(kruxKeyText('P2WPKH', net, '', 1), net);
    expect(acct1).toMatchObject({ derivation: "m/84'/0'/1'", account: 1 });
  });

  it('says what to change on the Krux when the key won’t do', () => {
    const main = NETWORKS.mainnet;
    expect(() => parseHardwareKey(kruxKeyText('P2WPKH', NETWORKS.regtest), main)).toThrow(/set Network to Mainnet/);
    expect(() => parseHardwareKey(ZPUB, NETWORKS.regtest)).toThrow(/set Network to Testnet/);
    expect(() => parseHardwareKey(ZPUB.slice(ZPUB.indexOf(']') + 1), main)).toThrow(/no fingerprint/);
    expect(() => parseHardwareKey('hello', main)).toThrow(HardwareKeyError);
    expect(() => parseHardwareKey(ZPUB.slice(0, -1) + 'x', main)).toThrow(/checksum|damaged/);
    expect(() => parseHardwareKey(ZPUB.replace('/84h', '/49h'), main)).toThrow(/zpub is for Native Segwit/);
    expect(() => parseHardwareKey(ZPUB.replace('/0h]', '/0h/0]'), main)).toThrow(/standard account path/);
    expect(() => parseHardwareKey('wsh(sortedmulti(2,...))', main)).toThrow(/multisig/);
  });

  it('says why a key isn’t a wallet’s', () => {
    const net = NETWORKS.mainnet;
    const k = parseHardwareKey(ZPUB, net);
    const other = deriveAccount(MNEMONIC, 'secret', 'P2WPKH', net);
    expect(matchWallet(k, { name: 'Savings', ...other, scriptType: 'P2WPKH' })).toMatchObject({ ok: false, reason: expect.stringMatching(/different seed words, or a different passphrase/) });
    const tr = deriveAccount(MNEMONIC, '', 'P2TR', net);
    expect(matchWallet(k, { name: 'Savings', ...tr, scriptType: 'P2TR' })).toMatchObject({ ok: false, reason: expect.stringMatching(/change Script Type/) });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Against Paperclip's firmware code

if (process.env.KRUX_REQUIRED && !(process.env.KRUX_SRC && process.env.KRUX_UUR)) throw new Error('KRUX_REQUIRED is set, but KRUX_SRC or KRUX_UUR is missing');
const KRUX = process.env.KRUX_SRC && process.env.KRUX_UUR ? describe : describe.skip;

interface DeviceAnswer {
  ok: boolean;
  stage?: string;
  error?: string;
  warnings?: { pathMismatch: boolean; unverifiedAmounts: boolean };
  review?: string[];
  qr?: string[];
  sd?: string;
}

function kruxSign(req: Record<string, unknown>): DeviceAnswer {
  const r = spawnSync(process.env.KRUX_PYTHON ?? 'python3.12', [join(__dirname, '..', 'tools', 'krux-check', 'krux_sign.py')], {
    input: JSON.stringify(req),
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`krux_sign.py failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as DeviceAnswer;
}

function readBack(parts: string[]): Bytes {
  const a = new QrAssembler();
  let out = null;
  // The Krux loops its codes; the phone may start reading partway through
  for (const p of [...parts.slice(1), parts[0]]) out = a.add(p) ?? out;
  if (!out || out.kind !== 'psbt') throw new Error('no PSBT came back');
  return out.data;
}

KRUX('Paperclip’s firmware signs what Crossbill sends', () => {
  for (const type of SCRIPT_TYPES) {
    it(`by QR code, for ${type}`, () => {
      const f = fixture(type, NETWORKS.mainnet, 2);
      const draft = draftFor(f);
      const psbt = buildPsbt(draft, f.wallet);
      for (const version of Object.values(DENSITY_VERSION)) {
        const parts = bbqrEncode(psbt, { version });
        const answer = kruxSign({ mnemonic: MNEMONIC, network: 'main', scriptType: type, qr: [...parts].reverse() });
        expect(answer.error ?? '').toBe('');
        expect(answer.warnings!.pathMismatch).toBe(false);
        expect(answer.warnings!.unverifiedAmounts).toBe(kruxWarnsUnverifiedAmounts(type, draft.coins.length));
        // The Krux recognises the change as change, so it reviews one payment
        expect(answer.review!.join('\n')).toMatch(/Change/);
        // It answers in BBQr, as it was asked
        expect(answer.qr![0]).toMatch(/^B\$[Z2]P/);
        const back = finalizeFromDevice(draft, f.wallet, readBack(answer.qr!));
        const spent = draft.coins.map((c) => ({ value: c.value, script: fromHex(c.script) }));
        expect(replayReadback(back.tx, spent, type, draft.coins.map((c) => f.key.pubKey(c.chain, c.index)))).toBe('protected');
      }
    });

    it(`by microSD, for ${type}`, () => {
      const f = fixture(type, NETWORKS.mainnet);
      const draft = draftFor(f);
      const answer = kruxSign({ mnemonic: MNEMONIC, network: 'main', scriptType: type, sd: base64.encode(buildPsbt(draft, f.wallet)) });
      expect(answer.error ?? '').toBe('');
      const back = finalizeFromDevice(draft, f.wallet, readPsbtFile(base64.decode(answer.sd!)));
      expect(signatureHashTypes(back.tx, type).every((h) => h === 0x21)).toBe(true);
    });
  }

  it('shows a payment to the wallet itself as a self-transfer', () => {
    const f = fixture('P2WPKH', NETWORKS.mainnet);
    const answer = kruxSign({ mnemonic: MNEMONIC, network: 'main', scriptType: 'P2WPKH', qr: bbqrEncode(buildPsbt(draftFor(f, { selfPay: true }), f.wallet)) });
    expect(answer.review!.join('\n')).toMatch(/Self-transfer/);
  });

  it('signs on testnet and regtest, and with a passphrase', () => {
    const f = fixture('P2WPKH', NETWORKS.regtest, 1, 'secret');
    const draft = draftFor(f);
    const answer = kruxSign({ mnemonic: MNEMONIC, passphrase: 'secret', network: 'test', scriptType: 'P2WPKH', qr: bbqrEncode(buildPsbt(draft, f.wallet)) });
    expect(answer.error ?? '').toBe('');
    expect(finalizeFromDevice(draft, f.wallet, readBack(answer.qr!)).txid).toBe(txid(draft.tx));
  });

  it('can’t sign with the wrong seed or passphrase, and Crossbill says so', () => {
    const f = fixture('P2WPKH', NETWORKS.mainnet);
    const draft = draftFor(f);
    const answer = kruxSign({ mnemonic: MNEMONIC, passphrase: 'wrong', network: 'main', scriptType: 'P2WPKH', qr: bbqrEncode(buildPsbt(draft, f.wallet)) });
    // The firmware stops at its Sign step ("cannot sign"), so nothing comes back to the phone
    expect(answer.ok).toBe(false);
    expect(answer.stage).toBe('sign');
  });
});
