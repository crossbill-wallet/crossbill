// Reading the public key a hardware wallet shows for a watch-only wallet. Paperclip's Krux shows it as
// "[fingerprint/purpose'/coin'/account']xpub…", with zpub for Native Segwit and ypub for Nested Segwit
// (SLIP-132), as text in a QR code or a .pub file on microSD. A single-key output descriptor is read as well.

import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { HDKey } from '@scure/bip32';
import { concat, u32be } from './bytes';
import type { NetworkParams } from './network';
import { SCRIPT_TYPE_INFO, type ScriptType } from './script';

const b58 = createBase58check(sha256);

const PURPOSE_TYPE: Record<number, ScriptType> = { 44: 'P2PKH', 49: 'P2SH_P2WPKH', 84: 'P2WPKH', 86: 'P2TR' };

/** SLIP-132 single-key versions: which networks and address types each header belongs to. */
const VERSIONS: Record<number, { name: string; mainnet: boolean; only?: ScriptType }> = {
  0x0488b21e: { name: 'xpub', mainnet: true },
  0x049d7cb2: { name: 'ypub', mainnet: true, only: 'P2SH_P2WPKH' },
  0x04b24746: { name: 'zpub', mainnet: true, only: 'P2WPKH' },
  0x043587cf: { name: 'tpub', mainnet: false },
  0x044a5262: { name: 'upub', mainnet: false, only: 'P2SH_P2WPKH' },
  0x045f1cf6: { name: 'vpub', mainnet: false, only: 'P2WPKH' },
};
const MULTISIG_VERSIONS = new Set([0x0295b43f, 0x02aa7ed3, 0x024289ef, 0x02575483]);

export interface HardwareKey {
  /** Master key fingerprint, 8 lowercase hex characters */
  fingerprint: string;
  /** Account path written as the app writes it: m/84'/0'/0' */
  derivation: string;
  /** The account key with this network's standard xpub/tpub header */
  xpub: string;
  scriptType: ScriptType;
  account: number;
}

export class HardwareKeyError extends Error {}

/**
 * Reads the key text from a hardware wallet for this network. Throws a HardwareKeyError that says what to change
 * on the device when the key isn't usable here.
 */
export function parseHardwareKey(text: string, net: NetworkParams): HardwareKey {
  let t = text.trim().replace(/#[a-z0-9]{8}$/, '');
  // Unwrap a single-key descriptor: wpkh(...), sh(wpkh(...)), pkh(...), tr(...)
  const wrapped = /^(wpkh|pkh|tr|sh\(wpkh)\((.*?)\)+$/.exec(t);
  const wrapper = wrapped?.[1];
  if (wrapped) t = wrapped[2];
  if (/^(wsh|sh\(wsh|sh\(multi|multi|sortedmulti)/.test(t)) throw new HardwareKeyError('That’s a multisig wallet. Crossbill holds single-signature wallets only.');
  const m = /^\[([0-9a-fA-F]{8})((?:\/\d+['hH]?)*)\]([1-9A-HJ-NP-Za-km-z]{100,120})((?:\/(?:\d+|<0;1>|\*))*)$/.exec(t);
  if (!m) {
    if (/^[xyztuv]pub[1-9A-HJ-NP-Za-km-z]{100,}$/.test(t)) {
      throw new HardwareKeyError('That key has no fingerprint or path, which the Krux needs to sign. On the Krux, show the key with its fingerprint: Extended Public Key, then the XPUB or ZPUB QR code.');
    }
    throw new HardwareKeyError('That isn’t a wallet key. On the Krux, open Extended Public Key and show the QR code for your address type.');
  }
  const fingerprint = m[1].toLowerCase();
  const steps = m[2].split('/').filter(Boolean);
  if (steps.length !== 3 || !steps.every((s) => /['hH]$/.test(s))) {
    throw new HardwareKeyError('That key’s path isn’t a standard account path (purpose, coin, account, all hardened). Use the Krux’s standard single-key wallet.');
  }
  const [purpose, coin, account] = steps.map((s) => Number(s.slice(0, -1)));
  const scriptType = PURPOSE_TYPE[purpose];
  if (!scriptType) throw new HardwareKeyError(`That key is for path ${purpose}', which isn’t one of Crossbill’s address types.`);
  if (wrapper) {
    const expect = { wpkh: 'P2WPKH', pkh: 'P2PKH', tr: 'P2TR', 'sh(wpkh': 'P2SH_P2WPKH' }[wrapper];
    if (expect !== scriptType) throw new HardwareKeyError('That descriptor’s address type and its path don’t agree.');
  }

  let payload: Uint8Array;
  try {
    payload = b58.decode(m[3]);
  } catch {
    throw new HardwareKeyError('That key is damaged: its checksum doesn’t match. Scan it again.');
  }
  if (payload.length !== 78) throw new HardwareKeyError('That key is damaged. Scan it again.');
  const version = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false);
  if (MULTISIG_VERSIONS.has(version)) throw new HardwareKeyError('That’s a multisig key. Crossbill holds single-signature wallets only.');
  const info = VERSIONS[version];
  if (!info) throw new HardwareKeyError('That key has a header Crossbill doesn’t know.');
  const mainnet = net.name === 'mainnet';
  if (info.mainnet !== mainnet) {
    throw new HardwareKeyError(
      mainnet
        ? 'That key is for testnet. On the Krux, set Network to Mainnet in Wallet, Customize, then show the key again.'
        : `That key is for mainnet, and Crossbill is on ${net.name}. On the Krux, set Network to Testnet in Wallet, Customize, then show the key again.`,
    );
  }
  if (info.only && info.only !== scriptType) throw new HardwareKeyError(`A ${info.name} is for ${SCRIPT_TYPE_INFO[info.only].label}, but its path says otherwise.`);
  if (coin !== net.coinType) {
    throw new HardwareKeyError(`That key uses coin type ${coin}', but ${net.name} uses ${net.coinType}'. Check the Krux’s network setting.`);
  }
  if (payload[4] !== 3) throw new HardwareKeyError('That key isn’t an account key (three steps from the seed).');
  const child = new DataView(payload.buffer, payload.byteOffset + 9, 4).getUint32(0, false);
  if (child !== account + 0x80000000) throw new HardwareKeyError('That key doesn’t match its own path.');

  const xpub = b58.encode(concat(u32be(net.bip32.public), payload.slice(4)));
  try {
    const k = HDKey.fromExtendedKey(xpub, net.bip32);
    if (k.privateKey) throw new Error('private');
  } catch {
    throw new HardwareKeyError('That key doesn’t decode. Scan it again.');
  }
  return { fingerprint, derivation: `m/${purpose}'/${coin}'/${account}'`, xpub, scriptType, account };
}

/** Writes a path the way the app stores it, so m/84h/0h/0h and m/84'/0'/0' compare equal. */
export function normalizePath(p: string): string {
  return p.trim().replace(/[hH]/g, "'");
}

export type KeyMatch = { ok: true } | { ok: false; reason: string };

/** Whether a hardware wallet's key is the same account as a wallet already on the phone, and if not, why. */
export function matchWallet(key: HardwareKey, wallet: { name: string; fingerprint: string; derivation: string; xpub: string; scriptType: ScriptType }): KeyMatch {
  if (key.fingerprint !== wallet.fingerprint.toLowerCase()) {
    return {
      ok: false,
      reason: `This Krux holds different seed words, or a different passphrase, from ${wallet.name}. On the Krux, load ${wallet.name}’s seed words and passphrase exactly, then show the key again.`,
    };
  }
  if (key.scriptType !== wallet.scriptType || normalizePath(key.derivation) !== normalizePath(wallet.derivation)) {
    return {
      ok: false,
      reason: `Same seed words, but the Krux shows ${SCRIPT_TYPE_INFO[key.scriptType].label} at ${key.derivation}, and ${wallet.name} is ${SCRIPT_TYPE_INFO[wallet.scriptType].label} at ${wallet.derivation}. On the Krux, change Script Type (and Account) in Wallet, Customize to match.`,
    };
  }
  if (key.xpub !== wallet.xpub) return { ok: false, reason: `The Krux’s key for this path isn’t ${wallet.name}’s.` };
  return { ok: true };
}
