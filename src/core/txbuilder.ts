// Builds unsigned transactions: coin selection (or the coins the person picked), change, fee, and the
// replace-by-fee variant. Sizes are measured on the real transaction with placeholder signatures of the
// largest size each input can carry, so the fee rate paid is never below the one asked for.

import { equal, toHex, type Bytes } from './bytes';
import { dustThreshold, outputScript, type ScriptType } from './script';
import { hashTypeFor, writeDummySignature } from './sign';
import { cloneTx, SEQUENCE_RBF, vsize, type Tx, type TxOut } from './tx';

export interface Coin {
  txid: string;
  vout: number;
  value: number;
  /** scriptPubKey hex */
  script: string;
  chain: 0 | 1;
  index: number;
  /** Confirmation height, or null while unconfirmed. */
  height: number | null;
}

export interface Payment {
  address: string;
  scriptPubKey: Bytes;
  /** Ignored when sendMax is set. */
  amount: number;
  sendMax?: boolean;
  label?: string;
}

export interface OutputInfo {
  script: Bytes;
  value: number;
  isChange: boolean;
  payment?: Payment;
}

export interface DraftTransaction {
  tx: Tx;
  coins: Coin[];
  outputs: OutputInfo[];
  fee: number;
  vsize: number;
  feeRate: number;
  unified: boolean;
  change: { chain: 1; index: number; value: number } | null;
}

export interface BuildRequest {
  scriptType: ScriptType;
  payments: Payment[];
  /** sat/vB */
  feeRate: number;
  /** Every coin that may be spent: not frozen, not immature. */
  available: Coin[];
  /** Coins the person picked. When set, exactly these are spent. */
  selected?: Coin[] | null;
  pubKeyFor: (chain: 0 | 1, index: number) => Bytes;
  changeIndex: number;
  unified: boolean;
  /** Current tip height, used as the locktime to discourage fee sniping, as Sparrow does. */
  tipHeight: number;
  /** Spend every coin from an address together, so an address is never left partly spent. */
  groupByAddress?: boolean;
  /**
   * For a fee bump: the inputs the replacement must keep, and the original's fee. BIP125 rule 4 then requires
   * the replacement to pay the original fee plus its own size at the incremental relay rate.
   */
  replacing?: { mustSpend: Coin[]; originalFee: number; incrementalRate?: number } | null;
  random?: (n: number) => number;
}

export class BuildError extends Error {}

function defaultRandom(n: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

function shuffle<T>(arr: T[], random: (n: number) => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function coinKey(c: Coin): string {
  return `${c.txid}:${c.vout}`;
}

/** Assembles the transaction for a given set of coins and outputs, with placeholder signatures for sizing. */
function assemble(req: BuildRequest, coins: Coin[], outputs: TxOut[]): Tx {
  const hashType = hashTypeFor(req.scriptType, req.unified);
  const tx: Tx = {
    version: 2,
    locktime: req.tipHeight,
    inputs: coins.map((c) => ({ prevout: { txid: c.txid, vout: c.vout }, scriptSig: new Uint8Array(0), sequence: SEQUENCE_RBF, witness: [] })),
    outputs,
  };
  coins.forEach((c, i) => writeDummySignature(tx, i, req.scriptType, req.pubKeyFor(c.chain, c.index), hashType));
  return tx;
}

function measure(req: BuildRequest, coins: Coin[], outputs: TxOut[]): number {
  return vsize(assemble(req, coins, outputs));
}

function feeFor(req: BuildRequest, size: number): number {
  const byRate = Math.ceil(size * req.feeRate);
  if (!req.replacing) return byRate;
  return Math.max(byRate, minimumReplacementFee(req.replacing.originalFee, size, req.replacing.incrementalRate ?? 1));
}

interface Plan {
  coins: Coin[];
  outputs: OutputInfo[];
  fee: number;
  size: number;
  changeValue: number | null;
}

/** Given a fixed coin set, works out amounts, change and fee. Returns null when the coins cannot pay. */
function planFor(req: BuildRequest, coins: Coin[], changeScript: Bytes): Plan | null {
  const total = coins.reduce((s, c) => s + c.value, 0);
  const maxPayment = req.payments.find((p) => p.sendMax);
  const fixed = req.payments.filter((p) => !p.sendMax).reduce((s, p) => s + p.amount, 0);

  const paymentOutputs = (maxValue: number): OutputInfo[] =>
    req.payments.map((p) => ({ script: p.scriptPubKey, value: p.sendMax ? maxValue : p.amount, isChange: false, payment: p }));
  const toTxOuts = (outs: OutputInfo[]) => outs.map((o) => ({ value: o.value, script: o.script }));

  if (maxPayment) {
    // Everything that is not a fixed payment goes to the max payment, so there is never change
    const outs = paymentOutputs(0);
    const size = measure(req, coins, toTxOuts(outs));
    const fee = feeFor(req, size);
    const maxValue = total - fixed - fee;
    if (maxValue < dustThreshold(maxPayment.scriptPubKey)) return null;
    return { coins, outputs: paymentOutputs(maxValue), fee, size, changeValue: null };
  }

  const outsNoChange = paymentOutputs(0);
  const sizeNoChange = measure(req, coins, toTxOuts(outsNoChange));
  const feeNoChange = feeFor(req, sizeNoChange);
  if (total < fixed + feeNoChange) return null;

  const withChange = [...outsNoChange, { script: changeScript, value: 0, isChange: true }];
  const sizeWithChange = measure(req, coins, toTxOuts(withChange));
  const feeWithChange = feeFor(req, sizeWithChange);
  const changeValue = total - fixed - feeWithChange;
  if (changeValue >= dustThreshold(changeScript)) {
    withChange[withChange.length - 1].value = changeValue;
    return { coins, outputs: withChange, fee: feeWithChange, size: sizeWithChange, changeValue };
  }
  // Change would be dust: it goes to the fee
  return { coins, outputs: outsNoChange, fee: total - fixed, size: sizeNoChange, changeValue: null };
}

/** Groups coins that share an address, so they are always spent together. */
function groupCoins(coins: Coin[], byAddress: boolean): Coin[][] {
  if (!byAddress) return coins.map((c) => [c]);
  const groups = new Map<string, Coin[]>();
  for (const c of coins) {
    const g = groups.get(c.script);
    if (g) g.push(c);
    else groups.set(c.script, [c]);
  }
  return [...groups.values()];
}

function groupValue(g: Coin[]): number {
  return g.reduce((s, c) => s + c.value, 0);
}

/**
 * Picks coins: confirmed coins first, and only reaching for unconfirmed ones when confirmed coins cannot
 * pay. Within a pool, the smallest single group that pays outright is preferred (fewest inputs, least
 * linking), and otherwise groups are added largest first.
 */
function selectCoins(req: BuildRequest, changeScript: Bytes): Plan {
  const mustSpend = req.replacing?.mustSpend ?? [];
  const mustKeys = new Set(mustSpend.map(coinKey));
  const rest = req.available.filter((c) => !mustKeys.has(coinKey(c)));
  const pools = [rest.filter((c) => c.height != null), rest];

  const base = mustSpend.length > 0 ? planFor(req, mustSpend, changeScript) : null;
  if (base) return base;

  let best: Plan | null = null;
  for (const pool of pools) {
    const groups = groupCoins(pool, req.groupByAddress ?? true).sort((a, b) => groupValue(b) - groupValue(a));
    // Smallest single group that covers everything
    for (let i = groups.length - 1; i >= 0; i--) {
      const plan = planFor(req, [...mustSpend, ...groups[i]], changeScript);
      if (plan) {
        best = plan;
        break;
      }
    }
    if (best) return best;
    // Largest first until it pays
    const acc: Coin[] = [...mustSpend];
    for (const g of groups) {
      acc.push(...g);
      const plan = planFor(req, acc, changeScript);
      if (plan) return plan;
    }
  }
  throw new BuildError('Not enough funds to pay this amount and the fee');
}

export function buildTransaction(req: BuildRequest): DraftTransaction {
  if (req.payments.length === 0) throw new BuildError('Add a recipient');
  if (req.payments.filter((p) => p.sendMax).length > 1) throw new BuildError('Only one recipient can take the maximum');
  if (!(req.feeRate > 0)) throw new BuildError('Set a fee rate');
  for (const p of req.payments) {
    if (!p.sendMax) {
      if (!Number.isSafeInteger(p.amount) || p.amount <= 0) throw new BuildError('Enter an amount for each recipient');
      if (p.amount < dustThreshold(p.scriptPubKey)) throw new BuildError(`${p.amount} sats is below the dust limit for ${p.address}`);
    }
  }
  const random = req.random ?? defaultRandom;
  const changePub = req.pubKeyFor(1, req.changeIndex);
  const changeScript = outputScript(req.scriptType, changePub);
  if (req.payments.some((p) => equal(p.scriptPubKey, changeScript))) throw new BuildError('A recipient is this wallet’s next change address');

  let plan: Plan | null;
  if (req.selected && req.selected.length > 0) {
    plan = planFor(req, req.selected, changeScript);
    if (!plan) throw new BuildError('The selected coins cannot pay this amount and the fee');
  } else if (req.payments.some((p) => p.sendMax)) {
    // Sending the maximum sweeps every spendable coin, as Sparrow's Max does
    const keep = req.replacing?.mustSpend ?? [];
    const keys = new Set(keep.map(coinKey));
    plan = planFor(req, [...keep, ...req.available.filter((c) => !keys.has(coinKey(c)))], changeScript);
    if (!plan) throw new BuildError('Not enough funds to pay the fee');
  } else {
    plan = selectCoins(req, changeScript);
  }

  const coins = shuffle(plan.coins, random);
  const outputs = shuffle(plan.outputs, random);
  const tx = assemble(req, coins, outputs.map((o) => ({ value: o.value, script: o.script })));
  const size = vsize(tx);
  // Clear the placeholders: the draft is unsigned
  const unsigned = cloneTx(tx);
  unsigned.inputs.forEach((i) => {
    i.scriptSig = new Uint8Array(0);
    i.witness = [];
  });
  const total = coins.reduce((s, c) => s + c.value, 0);
  const outTotal = outputs.reduce((s, o) => s + o.value, 0);
  const fee = total - outTotal;
  if (fee !== plan.fee) throw new Error('Fee arithmetic does not reconcile');
  if (fee > 0.05 * total && fee > 100_000) throw new BuildError(`The fee (${fee} sats) is unusually high. Check the fee rate.`);
  return {
    tx: unsigned,
    coins,
    outputs,
    fee,
    vsize: size,
    feeRate: fee / size,
    unified: req.unified,
    change: plan.changeValue != null ? { chain: 1, index: req.changeIndex, value: plan.changeValue } : null,
  };
}

/** BIP125 rule 4: a replacement pays for its own bandwidth at the incremental relay rate on top of the original fee. */
export function minimumReplacementFee(originalFee: number, replacementVsize: number, incrementalRate = 1): number {
  return originalFee + Math.ceil(replacementVsize * incrementalRate);
}

export function describeOutpoint(c: Coin): string {
  return `${c.txid}:${c.vout}`;
}

export { toHex };
