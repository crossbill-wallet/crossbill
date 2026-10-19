import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { Bytes } from './bytes';
import type { NetworkParams } from './network';
import { SCRIPT_TYPE_INFO, type ScriptType } from './script';

export const BIP39_WORDS: readonly string[] = wordlist;

export function normalizeMnemonic(words: string): string {
  return words.trim().toLowerCase().split(/\s+/).join(' ');
}

export function isValidMnemonic(words: string): boolean {
  return validateMnemonic(normalizeMnemonic(words), wordlist);
}

/** A fresh mnemonic. 24 words (256 bits) by default, as Sparrow offers. */
export function newMnemonic(words: 12 | 24 = 24): string {
  return generateMnemonic(wordlist, words === 24 ? 256 : 128);
}

/** The standard account path for a script type: m/purpose'/coin'/account'. */
export function accountPath(type: ScriptType, net: NetworkParams, account = 0): string {
  return `m/${SCRIPT_TYPE_INFO[type].purpose}'/${net.coinType}'/${account}'`;
}

export function fingerprintHex(fp: number): string {
  return (fp >>> 0).toString(16).padStart(8, '0');
}

export interface AccountPublicInfo {
  /** Master key fingerprint, 8 hex characters. */
  fingerprint: string;
  /** Account derivation path, drongo style: m/84'/0'/0'. */
  derivation: string;
  /** Account extended public key with the network's standard xpub/tpub header. */
  xpub: string;
}

export function masterKey(mnemonic: string, passphrase: string, net: NetworkParams): HDKey {
  const seed = mnemonicToSeedSync(normalizeMnemonic(mnemonic), passphrase);
  return HDKey.fromMasterSeed(seed, net.bip32);
}

export function deriveAccount(mnemonic: string, passphrase: string, type: ScriptType, net: NetworkParams, account = 0): AccountPublicInfo {
  const root = masterKey(mnemonic, passphrase, net);
  const derivation = accountPath(type, net, account);
  const acct = root.derive(derivation);
  return { fingerprint: fingerprintHex(root.fingerprint), derivation, xpub: acct.publicExtendedKey };
}

/** Derives the account key with its private part, for one signing session. */
export function deriveAccountPrivate(mnemonic: string, passphrase: string, derivation: string, net: NetworkParams): { fingerprint: string; account: HDKey } {
  const root = masterKey(mnemonic, passphrase, net);
  return { fingerprint: fingerprintHex(root.fingerprint), account: root.derive(derivation) };
}

/** Public-only account key, for deriving addresses without the seed. */
export class AccountKey {
  private readonly key: HDKey;
  private readonly cache = new Map<string, Bytes>();

  constructor(xpub: string, net: NetworkParams) {
    this.key = HDKey.fromExtendedKey(xpub, net.bip32);
    if (this.key.privateKey) throw new Error('Expected a public key');
  }

  pubKey(chain: 0 | 1, index: number): Bytes {
    const id = `${chain}/${index}`;
    let pk = this.cache.get(id);
    if (!pk) {
      const k = this.key.deriveChild(chain).deriveChild(index).publicKey;
      if (!k) throw new Error('Derivation failed');
      pk = k;
      this.cache.set(id, pk);
    }
    return pk;
  }
}

export function childPrivateKey(account: HDKey, chain: 0 | 1, index: number): Bytes {
  const k = account.deriveChild(chain).deriveChild(index).privateKey;
  if (!k) throw new Error('No private key available for this account');
  return k;
}
