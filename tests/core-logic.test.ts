import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { toHex } from '../src/core/bytes';
import { NETWORKS } from '../src/core/network';
import { AccountKey, deriveAccount, isValidMnemonic } from '../src/core/keys';
import { chainDecision, decisionSummary, heightDecision, isOptedIn, parseHeader } from '../src/core/replay';
import { decodeAddress, dustThreshold, encodeAddress, outputScript } from '../src/core/script';
import { buildTransaction, BuildError, minimumReplacementFee, type Coin } from '../src/core/txbuilder';
import { signDraft } from '../src/core/signer';
import { signatureHashTypes } from '../src/core/sign';
import { LabelStore } from '../src/core/labels';
import { formatAmount, parseAmount } from '../src/core/units';
import { descriptorChecksum, normalizeDescriptor } from '../src/core/descriptor';
import { wantedRange, readActivationHeight } from '../src/core/sync';
import { nodeAddressFields, splitNodeAddress } from '../src/core/rpc';
import { seedWordsFeedback } from '../src/core/seedwords';
import { DEFAULT_EXPLORER, explorerName, explorerOpenUrl, explorerTxUrl, normalizeExplorer } from '../src/core/explorer';
import { newMnemonic } from '../src/core/keys';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const net = NETWORKS.regtest;

describe('replay decision follows Shrike', () => {
  const main = NETWORKS.mainnet;
  it('needs a tip before deciding', () => expect(chainDecision(main, { height: 970000, tipIsV2: null, nodeActivationHeight: 961640 })).toBe('CHAIN_UNSEEN'));
  it('opts in past activation when the node agrees', () => expect(chainDecision(main, { height: 970000, tipIsV2: true, nodeActivationHeight: 961640 })).toBe('OPTED_IN'));
  it('opts in uncorroborated when the node says nothing', () => expect(chainDecision(main, { height: 970000, tipIsV2: true, nodeActivationHeight: null })).toBe('OPTED_IN_UNCORROBORATED'));
  it('declines on a schedule mismatch', () => expect(chainDecision(main, { height: 970000, tipIsV2: true, nodeActivationHeight: 961641 })).toBe('SCHEDULE_MISMATCH'));
  it('names the server when a v1 tip claims a post-activation height', () =>
    expect(chainDecision(main, { height: 961640, tipIsV2: false, nodeActivationHeight: 961640 })).toBe('TIP_CONTRADICTS_SCHEDULE'));
  it('declines before activation', () => expect(chainDecision(main, { height: 900000, tipIsV2: false, nodeActivationHeight: 961640 })).toBe('CHAIN_NOT_ACTIVATED'));
  it('regtest opts in on a v2 tip alone', () => expect(chainDecision(net, { height: 25, tipIsV2: true, nodeActivationHeight: 20 })).toBe('OPTED_IN'));
  it('height decision edge', () => {
    expect(heightDecision(961640, 961640, 961639)).toBe('BEFORE_ACTIVATION_HEIGHT');
    expect(heightDecision(null, 961640, 970000)).toBe('BUILD_HAS_NO_SCHEDULE');
    expect(isOptedIn('OPTED_IN_UNCORROBORATED')).toBe(true);
    expect(decisionSummary('SCHEDULE_MISMATCH')).toBe('Not replay protected');
  });
  it('reads the activation height where Shrike reads it', () => {
    expect(readActivationHeight({ blake2b: { height: 20, active: true } })).toBe(20);
    expect(readActivationHeight({ deployments: {} })).toBe(null);
  });
});

describe('v2 headers', () => {
  it('parses the testnet4 v2 headers and their height field', () => {
    const lines = readFileSync(new URL('./vectors/testnet4_v2_headers.tsv', import.meta.url), 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      const [height, raw] = line.split('\t');
      const h = parseHeader(raw);
      expect(h.isV2).toBe(true);
      expect(h.height).toBe(Number(height));
    }
  });
  it('parses a v1 header', () => {
    const genesis = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
    const h = parseHeader(genesis);
    expect(h.isV2).toBe(false);
    expect(h.height).toBe(null);
  });
  it('matches the reference serialization', () => {
    const v = JSON.parse(readFileSync(new URL('./vectors/block_header_v2.json', import.meta.url), 'utf8'));
    for (const h of v.headers) {
      const p = parseHeader(h.serialized);
      expect(p.isV2).toBe(true);
      expect(p.height).toBe(h.fields.m_height);
    }
  });
});

function coin(key: AccountKey, chain: 0 | 1, index: number, value: number, height: number | null = 100, txidSeed = index): Coin {
  return { txid: (txidSeed + chain * 1000).toString(16).padStart(64, '0'), vout: 0, value, script: toHex(outputScript('P2WPKH', key.pubKey(chain, index))), chain, index, height };
}

describe('transaction builder', () => {
  const acct = deriveAccount(MNEMONIC, '', 'P2WPKH', net);
  const key = new AccountKey(acct.xpub, net);
  const pubKeyFor = (c: 0 | 1, i: number) => key.pubKey(c, i);
  const dest = decodeAddress('bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m', net);
  const base = { scriptType: 'P2WPKH' as const, pubKeyFor, changeIndex: 3, tipHeight: 200, random: () => 0 };

  it('pays with change at the requested rate or above', () => {
    const available = [coin(key, 0, 0, 50_000), coin(key, 0, 1, 80_000), coin(key, 0, 2, 20_000)];
    const d = buildTransaction({ ...base, payments: [{ address: 'x', scriptPubKey: dest.scriptPubKey, amount: 60_000 }], feeRate: 5, available, unified: true });
    expect(d.change).not.toBeNull();
    expect(d.feeRate).toBeGreaterThanOrEqual(5);
    expect(d.tx.locktime).toBe(200);
    expect(d.tx.inputs.every((i) => i.sequence === 0xfffffffd)).toBe(true);
    const total = d.coins.reduce((s, c) => s + c.value, 0);
    expect(total - d.outputs.reduce((s, o) => s + o.value, 0)).toBe(d.fee);
    // The smallest single coin that covers it
    expect(d.coins.map((c) => c.value)).toEqual([80_000]);
    // Signing produces exactly the size that was estimated or less
    const signed = signDraft(d, { mnemonic: MNEMONIC, passphrase: '' }, 'P2WPKH', acct.derivation, acct.fingerprint, net);
    expect(signed.vsize).toBeLessThanOrEqual(d.vsize);
    expect(signed.feeRate).toBeGreaterThanOrEqual(5);
    expect(signatureHashTypes(signed.tx, 'P2WPKH')).toEqual([0x21]);
  });

  it('sends the maximum with no change', () => {
    const available = [coin(key, 0, 0, 50_000), coin(key, 0, 1, 80_000)];
    const d = buildTransaction({ ...base, payments: [{ address: 'x', scriptPubKey: dest.scriptPubKey, amount: 0, sendMax: true }], feeRate: 2, available, unified: false });
    expect(d.change).toBeNull();
    expect(d.coins.length).toBe(2);
    expect(d.outputs[0].value).toBe(130_000 - d.fee);
    const signed = signDraft(d, { mnemonic: MNEMONIC, passphrase: '' }, 'P2WPKH', acct.derivation, acct.fingerprint, net);
    expect(signatureHashTypes(signed.tx, 'P2WPKH')).toEqual([0x01, 0x01]);
  });

  it('spends exactly the coins picked', () => {
    const picked = [coin(key, 0, 2, 20_000), coin(key, 1, 0, 30_000)];
    const d = buildTransaction({ ...base, payments: [{ address: 'x', scriptPubKey: dest.scriptPubKey, amount: 40_000 }], feeRate: 3, available: picked, selected: picked, unified: true });
    expect(d.coins.map((c) => c.value).sort()).toEqual([20_000, 30_000]);
  });

  it('refuses when the picked coins cannot pay', () => {
    const picked = [coin(key, 0, 2, 20_000)];
    expect(() => buildTransaction({ ...base, payments: [{ address: 'x', scriptPubKey: dest.scriptPubKey, amount: 40_000 }], feeRate: 3, available: picked, selected: picked, unified: true })).toThrow(BuildError);
  });

  it('prefers confirmed coins', () => {
    const available = [coin(key, 0, 0, 500_000, null), coin(key, 0, 1, 90_000, 100)];
    const d = buildTransaction({ ...base, payments: [{ address: 'x', scriptPubKey: dest.scriptPubKey, amount: 50_000 }], feeRate: 2, available, unified: true });
    expect(d.coins.map((c) => c.value)).toEqual([90_000]);
  });

  it('keeps an address whole', () => {
    const a = coin(key, 0, 4, 30_000, 100, 1);
    const b = { ...coin(key, 0, 4, 40_000, 100, 2) };
    const d = buildTransaction({ ...base, payments: [{ address: 'x', scriptPubKey: dest.scriptPubKey, amount: 25_000 }], feeRate: 2, available: [a, b], unified: true });
    expect(d.coins.length).toBe(2);
  });

  it('drops dust change into the fee', () => {
    const available = [coin(key, 0, 0, 50_000)];
    const d = buildTransaction({ ...base, payments: [{ address: 'x', scriptPubKey: dest.scriptPubKey, amount: 49_700 }], feeRate: 1, available, unified: true });
    expect(d.change).toBeNull();
    expect(d.fee).toBe(300);
  });

  it('a replacement pays BIP125 rule 4', () => {
    const c = coin(key, 0, 0, 100_000);
    const d = buildTransaction({ ...base, payments: [{ address: 'x', scriptPubKey: dest.scriptPubKey, amount: 50_000 }], feeRate: 1, available: [], replacing: { mustSpend: [c], originalFee: 5000 }, unified: true });
    expect(d.fee).toBeGreaterThanOrEqual(minimumReplacementFee(5000, d.vsize));
  });

  it('taproot opt-in signatures carry the hash type byte', () => {
    const tAcct = deriveAccount(MNEMONIC, '', 'P2TR', net);
    const tKey = new AccountKey(tAcct.xpub, net);
    const c: Coin = { txid: 'ab'.repeat(32), vout: 1, value: 100_000, script: toHex(outputScript('P2TR', tKey.pubKey(0, 0))), chain: 0, index: 0, height: 100 };
    for (const unified of [true, false]) {
      const d = buildTransaction({ scriptType: 'P2TR', pubKeyFor: (ch, i) => tKey.pubKey(ch, i), changeIndex: 0, tipHeight: 300, random: () => 0, payments: [{ address: 'x', scriptPubKey: dest.scriptPubKey, amount: 30_000 }], feeRate: 2, available: [c], unified });
      const s = signDraft(d, { mnemonic: MNEMONIC, passphrase: '' }, 'P2TR', tAcct.derivation, tAcct.fingerprint, net);
      expect(s.tx.inputs[0].witness[0].length).toBe(unified ? 65 : 64);
      expect(signatureHashTypes(s.tx, 'P2TR')).toEqual([unified ? 0x21 : 0x00]);
      expect(s.vsize).toBeLessThanOrEqual(d.vsize);
    }
  });

  it('refuses a seed whose passphrase does not match', () => {
    const d = buildTransaction({ ...base, payments: [{ address: 'x', scriptPubKey: dest.scriptPubKey, amount: 30_000 }], feeRate: 2, available: [coin(key, 0, 0, 50_000)], unified: true });
    expect(() => signDraft(d, { mnemonic: MNEMONIC, passphrase: 'wrong' }, 'P2WPKH', acct.derivation, acct.fingerprint, net)).toThrow(/passphrase/);
  });
});

describe('addresses', () => {
  it('rejects addresses for another network', () => {
    expect(() => decodeAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', NETWORKS.regtest)).toThrow();
    expect(decodeAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', NETWORKS.mainnet).kind).toBe('P2WPKH');
  });
  it('round trips every kind', () => {
    for (const a of ['bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA', '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf', 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3']) {
      const d = decodeAddress(a, NETWORKS.mainnet);
      expect(encodeAddress(d.scriptPubKey, NETWORKS.mainnet)).toBe(a);
    }
  });
  it('rejects future witness versions', () => {
    expect(() => decodeAddress('bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', NETWORKS.mainnet)).toThrow();
  });
  it('dust thresholds match Core', () => {
    expect(dustThreshold(decodeAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', NETWORKS.mainnet).scriptPubKey)).toBe(294);
    expect(dustThreshold(decodeAddress('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA', NETWORKS.mainnet).scriptPubKey)).toBe(546);
    expect(dustThreshold(decodeAddress('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', NETWORKS.mainnet).scriptPubKey)).toBe(330);
  });
});

describe('block explorer links', () => {
  const txid = '7033e5d44c8af34652bb9f646e9cd3a70ac7a994a995f48e01b8db9e9cbc9df1';
  it('builds the page the way desktop Shrike does', () => {
    expect(explorerTxUrl(DEFAULT_EXPLORER, txid, 'mainnet')).toBe(`https://mempool.guide/tx/${txid}`);
    expect(explorerTxUrl(DEFAULT_EXPLORER + '/', txid, 'mainnet')).toBe(`https://mempool.guide/tx/${txid}`);
    expect(explorerTxUrl(DEFAULT_EXPLORER, txid, 'testnet4')).toBe(`https://mempool.guide/testnet4/tx/${txid}`);
    expect(explorerTxUrl('http://192.168.1.50:4080/transaction/{0}', txid, 'mainnet')).toBe(`http://192.168.1.50:4080/transaction/${txid}`);
  });
  it('sends onion addresses to Onion Browser and leaves the rest for Safari', () => {
    const onion = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion';
    expect(explorerOpenUrl(`http://${onion}/tx/${txid}`)).toBe(`onionhttp://${onion}/tx/${txid}`);
    expect(explorerOpenUrl(`https://${onion}/tx/${txid}`)).toBe(`onionhttps://${onion}/tx/${txid}`);
    expect(explorerOpenUrl(`https://mempool.guide/tx/${txid}`)).toBe(`https://mempool.guide/tx/${txid}`);
    expect(explorerName(`http://${onion}`)).toBe('your block explorer');
    expect(explorerName(DEFAULT_EXPLORER)).toBe('mempool.guide');
  });
  it('tidies what is typed into settings', () => {
    expect(normalizeExplorer('mempool.guide/')).toBe('https://mempool.guide');
    expect(normalizeExplorer('abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion')).toBe('http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion');
    expect(normalizeExplorer('https://x.example/tx/{0}')).toBe('https://x.example/tx/{0}');
    expect(normalizeExplorer('javascript:alert(1)')).toBeNull();
    expect(normalizeExplorer('ftp://x.example')).toBeNull();
    expect(normalizeExplorer('   ')).toBeNull();
  });
});

describe('seed words feedback', () => {
  const seed24 = newMnemonic(24);
  const w24 = seed24.split(' ');
  it('never calls a 24-word seed invalid while it is still being typed', () => {
    for (let n = 1; n < 24; n++) {
      for (const settled of [false, true]) {
        const f = seedWordsFeedback(w24.slice(0, n).join(' ') + ' ', 24, settled);
        expect(f.error).toBeNull();
        expect(f.valid).toBe(false);
        expect(f.hint).toContain(`${n} of 24 words`);
      }
    }
  });
  it('accepts the full seed, typed or pasted', () => {
    expect(seedWordsFeedback(seed24, 24, false).valid).toBe(true);
    expect(seedWordsFeedback(`  ${seed24.toUpperCase()}\n`, 24, false).valid).toBe(true);
  });
  it('flags a bad checksum only once all words are in and the last one is finished', () => {
    const bad = ['abandon', 'ability', 'able', 'about', 'above'].map((x) => [...w24.slice(0, 23), x].join(' ')).find((x) => !isValidMnemonic(x))!;
    expect(seedWordsFeedback(bad, 24, false).error).toBeNull();
    expect(seedWordsFeedback(bad, 24, true).error).toMatch(/All 24 words are in/);
    expect(seedWordsFeedback(bad + ' ', 24, false).error).toMatch(/All 24 words are in/);
  });
  it('names words that are not on the list, but not the one being typed', () => {
    expect(seedWordsFeedback('abandon abandon zzz abandon ab', 24, false).error).toBe('Not a seed word: zzz');
    expect(seedWordsFeedback('abandon ab', 24, false).error).toBeNull();
    expect(seedWordsFeedback('abandon ab', 24, true).error).toBe('Not a seed word: ab');
  });
  it('says so when there are more words than picked', () => {
    expect(seedWordsFeedback(seed24, 12, true).error).toMatch(/24 words, more than the 12/);
  });
  it('works for 12 words', () => {
    expect(seedWordsFeedback(MNEMONIC, 12, true).valid).toBe(true);
    expect(seedWordsFeedback(MNEMONIC, 24, true)).toMatchObject({ error: null, valid: false });
  });
});

describe('misc', () => {
  it('splits a pasted node address into host and port', () => {
    const onion = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion';
    expect(splitNodeAddress(`http://${onion}:8332`)).toEqual({ host: onion, port: 8332, scheme: 'http' });
    expect(splitNodeAddress(` http://${onion}:8332/ `)).toEqual({ host: onion, port: 8332, scheme: 'http' });
    expect(splitNodeAddress(`https://${onion}`)).toEqual({ host: onion, scheme: 'https' });
    expect(splitNodeAddress(`${onion}:48332`)).toEqual({ host: onion, port: 48332, scheme: undefined });
    expect(splitNodeAddress(onion)).toEqual({ host: onion, scheme: undefined });
    expect(splitNodeAddress('http://user:pw@192.168.1.50:8332')).toEqual({ host: '192.168.1.50', port: 8332, scheme: 'http' });
    expect(splitNodeAddress('[fd04::1]:8332')).toEqual({ host: '[fd04::1]', port: 8332, scheme: undefined });
    expect(splitNodeAddress('node.local:99999')).toEqual({ host: 'node.local:99999', scheme: undefined });
  });
  it('reads port and HTTPS from a pasted StartOS address', () => {
    const onion = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion';
    expect(nodeAddressFields(`https://${onion}`)).toEqual({ host: onion, port: 443, tls: true });
    expect(nodeAddressFields(`https://192.168.1.50:52478`)).toEqual({ host: '192.168.1.50', port: 52478, tls: true });
    expect(nodeAddressFields(`http://${onion}:8332`)).toEqual({ host: onion, port: 8332, tls: false });
    expect(nodeAddressFields(`${onion}:8332`)).toEqual({ host: onion, port: 8332 });
    expect(nodeAddressFields(onion)).toEqual({ host: onion });
  });
  it('validates mnemonics', () => {
    expect(isValidMnemonic(MNEMONIC)).toBe(true);
    expect(isValidMnemonic(MNEMONIC.replace('about', 'abandon'))).toBe(false);
  });
  it('descriptor checksum matches BIP380 example', () => {
    expect(descriptorChecksum('raw(deadbeef)')).toBe('89f8spxm');
    expect(descriptorChecksum("pkh([d34db33f/44'/0'/0']xpub6ERApfZwUNrhLCkDtcHTcxd75RbzS1ed54G1LkBUHQVHQKqhMkhgbmJbZRkrgZw4koxb5JaHWkY4ALHY2grBGRjaDMzQLcgJvLJuZZvRcEL/1/*)")).toBe('ml40v0wf');
    expect(normalizeDescriptor("pkh([d34db33f/44'/0'/0']xpub6ERApfZwUNrhLCkDtcHTcxd75RbzS1ed54G1LkBUHQVHQKqhMkhgbmJbZRkrgZw4koxb5JaHWkY4ALHY2grBGRjaDMzQLcgJvLJuZZvRcEL/1/*)#ml40v0wf")).toMatch(/^pkh\(\[d34db33f\/44h\/0h\/0h\]/);
  });
  it('import range follows Cormorant', () => {
    expect(wantedRange(-1, 20)).toBe(1000);
    expect(wantedRange(990, 20)).toBe(1500);
  });
  it('amounts', () => {
    expect(formatAmount(123456789, 'BTC')).toBe('1.23 456 789');
    expect(parseAmount('0.001', 'BTC')).toBe(100000);
    expect(parseAmount('1.000000001', 'BTC')).toBe(null);
    expect(parseAmount('2,500', 'sats')).toBe(2500);
    expect(parseAmount('2.500', 'sats')).toBe(2500);
    expect(parseAmount('1.5', 'sats')).toBe(null);
    // A decimal comma, as many iPhone keyboards type it, must not move the decimal point
    expect(parseAmount('0,5', 'BTC')).toBe(50_000_000);
    expect(parseAmount('0,001', 'BTC')).toBe(100_000);
    expect(parseAmount('1,000.5', 'BTC')).toBe(null);
    expect(parseAmount('1,000,000', 'BTC')).toBe(null);
  });
  it('labels round trip BIP329 and freeze coins', () => {
    const s = new LabelStore();
    s.set('tx', 'aa', 'Rent');
    s.setFrozen('bb', 1, true);
    s.set('output', 'bb:1', 'Cold');
    const t = new LabelStore();
    expect(t.importJsonl(s.exportJsonl())).toBe(2);
    expect(t.get('tx', 'aa')).toBe('Rent');
    expect(t.isFrozen('bb', 1)).toBe(true);
    t.setFrozen('bb', 1, false);
    expect(t.isFrozen('bb', 1)).toBe(false);
    expect(t.get('output', 'bb:1')).toBe('Cold');
  });
});

describe('replay readback', () => {
  it('reads protection off verified signatures only', async () => {
    const { replayReadback } = await import('../src/core/sign');
    const { parseTx: p } = await import('../src/core/tx');
    const acct = deriveAccount(MNEMONIC, '', 'P2WPKH', net);
    const key = new AccountKey(acct.xpub, net);
    const dest = decodeAddress('bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m', net);
    const c: Coin = { txid: '11'.repeat(32), vout: 0, value: 90_000, script: toHex(outputScript('P2WPKH', key.pubKey(0, 0))), chain: 0, index: 0, height: 10 };
    for (const unified of [true, false]) {
      const d = buildTransaction({ scriptType: 'P2WPKH', pubKeyFor: (ch, i) => key.pubKey(ch, i), changeIndex: 0, tipHeight: 30, random: () => 0, payments: [{ address: 'x', scriptPubKey: dest.scriptPubKey, amount: 30_000 }], feeRate: 2, available: [c], unified });
      const s = signDraft(d, { mnemonic: MNEMONIC, passphrase: '' }, 'P2WPKH', acct.derivation, acct.fingerprint, net);
      const spent = [{ value: c.value, script: outputScript('P2WPKH', key.pubKey(0, 0)) }];
      expect(replayReadback(s.tx, spent, 'P2WPKH', [key.pubKey(0, 0)])).toBe(unified ? 'protected' : 'unprotected');
      // A stamped byte with no valid signature behind it proves nothing
      const forged = p(s.hex);
      const w0 = forged.inputs[0].witness[0];
      w0[w0.length - 1] = unified ? 0x01 : 0x21;
      expect(replayReadback(forged, spent, 'P2WPKH', [key.pubKey(0, 0)])).toBe('unchecked');
    }
  });
});
