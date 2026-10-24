// End to end with Paperclip's Krux signing code and a real Bitcoin Knots BLAKE2b regtest node: coins of each
// address type are paid to a wallet, Crossbill builds the PSBT and shows it as BBQr, the firmware's code signs it,
// Crossbill reads the reply back and the node accepts and mines the transaction.
//
// Runs only when KNOTS_BIN (bitcoind and bitcoin-cli) and KRUX_SRC and KRUX_UUR (see tools/krux-check) are set.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromHex, toHex } from '../src/core/bytes';
import { NETWORKS } from '../src/core/network';
import { AccountKey, deriveAccount } from '../src/core/keys';
import { decodeAddress, encodeAddress, outputScript, SCRIPT_TYPES } from '../src/core/script';
import { buildTransaction, type Coin } from '../src/core/txbuilder';
import { parseTx } from '../src/core/tx';
import { buildPsbt, finalizeFromDevice } from '../src/core/psbt';
import { bbqrEncode, QrAssembler } from '../src/core/qrtransfer';

const BIN = process.env.KNOTS_BIN;
if (process.env.KNOTS_REQUIRED && !BIN) throw new Error('KNOTS_REQUIRED is set, but KNOTS_BIN is missing');
if (process.env.KRUX_REQUIRED && !(process.env.KRUX_SRC && process.env.KRUX_UUR)) throw new Error('KRUX_REQUIRED is set, but KRUX_SRC or KRUX_UUR is missing');
const run = BIN && process.env.KRUX_SRC && process.env.KRUX_UUR ? describe : describe.skip;
const net = NETWORKS.regtest;
const PORT = 18553;
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function kruxSign(req: Record<string, unknown>): { ok: boolean; error?: string; qr?: string[] } {
  const r = spawnSync(process.env.KRUX_PYTHON ?? 'python3.12', [join(__dirname, '..', 'tools', 'krux-check', 'krux_sign.py')], { input: JSON.stringify(req), encoding: 'utf8', env: process.env });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

run('a Krux-signed send on a BLAKE2b regtest node', () => {
  let datadir: string;
  const cli = (...args: string[]): string =>
    execFileSync(join(BIN!, 'bitcoin-cli'), ['-regtest', `-datadir=${datadir}`, `-rpcport=${PORT}`, '-rpcuser=regtest', '-rpcpassword=regtest', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const miner = (...args: string[]) => cli('-rpcwallet=miner', ...args);

  beforeAll(async () => {
    datadir = mkdtempSync(join(tmpdir(), 'crossbill-krux-'));
    const p = spawn(
      join(BIN!, 'bitcoind'),
      ['-regtest', `-datadir=${datadir}`, `-rpcport=${PORT}`, '-port=18554', '-listen=0', '-blake2b_headline=BLAKE2b regtest', '-testactivationheight=blake2b@20', '-rpcuser=regtest', '-rpcpassword=regtest', '-fallbackfee=0.0001'],
      { stdio: 'ignore', detached: true },
    );
    p.unref();
    for (let i = 0; i < 60; i++) {
      try {
        cli('getblockchaininfo');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    cli('createwallet', 'miner');
    miner('generatetoaddress', '130', miner('getnewaddress'));
  }, 60_000);

  afterAll(() => {
    try {
      cli('stop');
    } catch {
      // already stopped
    }
    setTimeout(() => rmSync(datadir, { recursive: true, force: true }), 3000);
  });

  for (const type of SCRIPT_TYPES) {
    it(`spends ${type} coins`, () => {
      const acct = deriveAccount(MNEMONIC, '', type, net);
      const key = new AccountKey(acct.xpub, net);
      const scripts = [0, 1].map((i) => outputScript(type, key.pubKey(0, i)));
      const coins: Coin[] = [];
      const raw = new Map<string, string>();
      for (const [i, s] of scripts.entries()) {
        const id = miner('sendtoaddress', encodeAddress(s, net), '0.001');
        const hex = JSON.parse(miner('gettransaction', id)).hex as string;
        raw.set(id, hex);
        const vout = parseTx(hex).outputs.findIndex((o) => toHex(o.script) === toHex(s));
        coins.push({ txid: id, vout, value: 100_000, script: toHex(s), chain: 0, index: i, height: 131 });
      }
      miner('generatetoaddress', '1', miner('getnewaddress'));
      const dest = miner('getnewaddress');
      const draft = buildTransaction({
        scriptType: type,
        payments: [{ address: dest, scriptPubKey: decodeAddress(dest, net).scriptPubKey, amount: 120_000 }],
        feeRate: 2,
        available: coins,
        selected: coins,
        pubKeyFor: (c, i) => key.pubKey(c, i),
        changeIndex: 0,
        unified: true,
        tipHeight: Number(cli('getblockcount')),
      });
      const change = toHex(outputScript(type, key.pubKey(1, 0)));
      const wallet = {
        scriptType: type,
        fingerprint: acct.fingerprint,
        derivation: acct.derivation,
        pubKey: (c: 0 | 1, i: number) => key.pubKey(c, i),
        prevTx: (id: string) => raw.get(id),
        ownOutput: (s: Uint8Array) => (toHex(s) === change ? { chain: 1 as const, index: 0 } : null),
      };
      const answer = kruxSign({ mnemonic: MNEMONIC, network: 'test', scriptType: type, qr: bbqrEncode(buildPsbt(draft, wallet)) });
      expect(answer.error ?? '').toBe('');
      const a = new QrAssembler();
      let back = null;
      for (const p of answer.qr!) back = a.add(p) ?? back;
      expect(back?.kind).toBe('psbt');
      const signed = finalizeFromDevice(draft, wallet, back!.kind === 'psbt' ? back!.data : fromHex(''));
      const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify([signed.hex])))[0];
      expect(accept.allowed, accept['reject-reason']).toBe(true);
      expect(cli('sendrawtransaction', signed.hex)).toBe(signed.txid);
      miner('generatetoaddress', '1', miner('getnewaddress'));
      expect(JSON.parse(cli('getrawtransaction', signed.txid, 'true', cli('getbestblockhash'))).confirmations).toBe(1);
    });
  }
});
