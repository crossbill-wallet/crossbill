// Turns a draft into a signed transaction. The seed is only read for this, and nothing derived from it is
// kept once signing is done.

import { fromHex, toHex } from './bytes';
import { childPrivateKey, deriveAccountPrivate } from './keys';
import type { NetworkParams } from './network';
import { outputScript, type ScriptType } from './script';
import { hashTypeFor, signInput } from './sign';
import { cloneTx, txid, txToHex, vsize, type Tx, type TxOut } from './tx';
import type { DraftTransaction } from './txbuilder';

export interface WalletSecret {
  mnemonic: string;
  passphrase: string;
}

export interface SignedTransaction {
  tx: Tx;
  hex: string;
  txid: string;
  vsize: number;
  fee: number;
  feeRate: number;
}

export function signDraft(draft: DraftTransaction, secret: WalletSecret, scriptType: ScriptType, derivation: string, expectedFingerprint: string, net: NetworkParams): SignedTransaction {
  const { fingerprint, account } = deriveAccountPrivate(secret.mnemonic, secret.passphrase, derivation, net);
  if (fingerprint !== expectedFingerprint) {
    throw new Error('This seed and passphrase do not match the wallet. Check the passphrase.');
  }
  const tx = cloneTx(draft.tx);
  const spent: TxOut[] = draft.coins.map((c) => ({ value: c.value, script: fromHex(c.script) }));
  const hashType = hashTypeFor(scriptType, draft.unified);
  draft.coins.forEach((c, i) => {
    const privKey = childPrivateKey(account, c.chain, c.index);
    const pubKey = account.deriveChild(c.chain).deriveChild(c.index).publicKey!;
    if (toHex(outputScript(scriptType, pubKey)) !== c.script) throw new Error(`Coin ${c.txid}:${c.vout} does not belong to this wallet`);
    signInput(tx, i, spent, { type: scriptType, privKey, pubKey }, hashType);
    privKey.fill(0);
  });
  const size = vsize(tx);
  return { tx, hex: txToHex(tx), txid: txid(tx), vsize: size, fee: draft.fee, feeRate: draft.fee / size };
}
