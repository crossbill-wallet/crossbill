// Which notifications a check owes: a payment's first confirmation and its sixth, and Lightning payments that
// finished. Pure, so the rules are tested without a phone. src/app/notify.ts reads the wallets, keeps the state
// file and hands what comes out of here to iOS.

/** Which kinds of notification are on. */
export interface NoticeKinds {
  firstConf: boolean;
  sixthConf: boolean;
  lightning: boolean;
  /** Put the amount in the notification. Off by default: notifications show on the Lock Screen */
  amounts: boolean;
}

/** One transaction as a check sees it. height is the block it's in, null while unconfirmed. */
export interface NoticeTx {
  txid: string;
  height: number | null;
  /** Change in the wallet's balance, in sats: more than zero is a payment received */
  net: number;
}

/** A finished or unfinished Lightning payment, from the node's activity list. */
export interface NoticeLightning {
  id: string;
  kind: 'onchain' | 'lightning';
  direction: 'in' | 'out';
  amountSat: number;
  status: string;
  /** A SHA256 invoice paid through a bridge: its own state decides, as on the Lightning tab */
  bitcoinInvoice?: { state: string } | null;
}

export interface Notice {
  /** Stays the same for the same event, so a check that runs twice can't say it twice */
  id: string;
  title: string;
  body: string;
}

/** What the checks remember between runs. */
export interface NoticeState {
  /** The chain tip the last check saw, per network. Missing means the next check only takes note */
  tips: Record<string, number>;
  /** Notices already given, newest last, so a reorg or a second wallet holding the same payment doesn't repeat one */
  given: string[];
  /** Finished Lightning payments already seen. null until the first look, which only takes note */
  lightningSeen: string[] | null;
}

export const EMPTY_NOTICE_STATE: NoticeState = { tips: {}, given: [], lightningSeen: null };

/** More blocks than this since the last check, about a day's worth, and the check only takes note */
const STALE_BLOCKS = 144;

/** How many given notices and seen Lightning payments are kept. The node lists its last 40 payments */
const KEEP = 300;

/**
 * Lightning activity states that mean the payment went through. The dashboard says "complete" (and "paid" for a
 * bridge's SHA256 invoice); the others are kept in case it words it differently. Anything else, such as pending,
 * failed or returned, says nothing.
 */
const FINISHED = new Set(['complete', 'completed', 'succeeded', 'success', 'settled', 'paid', 'confirmed']);

export type Formatter = (sats: number) => string;

function payment(net: number, kinds: NoticeKinds, fmt: Formatter): string {
  if (!kinds.amounts) return net > 0 ? 'A payment you received' : 'A payment you sent';
  return net > 0 ? `${fmt(net)} you received` : `${fmt(-net)} you sent`;
}

/**
 * The confirmations reached since the last check, for one network's wallets. A first confirmation is the block a
 * transaction went into; the sixth is five blocks after it. When both happened since the last check (the phone was
 * off a while), only the sixth is said. The first check on a network only notes the tip, so turning notifications
 * on never brings a flood of old payments, and nor does adding a wallet with a long history.
 */
export function confirmationNotices(
  state: NoticeState,
  network: string,
  tip: number,
  txs: NoticeTx[],
  kinds: NoticeKinds,
  fmt: Formatter,
): { notices: Notice[]; state: NoticeState } {
  const last = state.tips[network];
  const tips = { ...state.tips, [network]: Math.max(tip, last ?? 0) };
  // After more than a day without a check (the phone was off, or a duress session held the checks), it's old news
  if (last == null || tip <= last || tip - last > STALE_BLOCKS) return { notices: [], state: { ...state, tips } };
  const given = new Set(state.given);
  const notices: Notice[] = [];
  for (const tx of txs) {
    if (tx.height == null || tx.net === 0) continue;
    const sixthAt = tx.height + 5;
    const sixth = sixthAt > last && sixthAt <= tip;
    const first = tx.height > last && tx.height <= tip;
    // Both since the last check: the sixth says it all, unless only first confirmations are wanted
    if (sixth && kinds.sixthConf) {
      const id = `${network}:${tx.txid}:6`;
      if (!given.has(id)) {
        given.add(id);
        notices.push({ id, title: 'Confirmed 6 times', body: `${payment(tx.net, kinds, fmt)} has 6 confirmations.` });
      }
    } else if (first && kinds.firstConf) {
      const id = `${network}:${tx.txid}:1`;
      if (!given.has(id)) {
        given.add(id);
        notices.push({ id, title: 'First confirmation', body: `${payment(tx.net, kinds, fmt)} is in a block.` });
      }
    }
  }
  return { notices, state: { ...state, tips, given: [...given].slice(-KEEP) } };
}

/**
 * Lightning payments that finished since the last look. The first look only takes note. On-chain payments the
 * Lightning node makes are left out: they aren't Lightning payments, and their confirmations aren't counted here.
 */
export function lightningNotices(state: NoticeState, items: NoticeLightning[], kinds: NoticeKinds, fmt: Formatter): { notices: Notice[]; state: NoticeState } {
  const done = items.filter((i) => i.kind === 'lightning' && FINISHED.has((i.bitcoinInvoice?.state ?? i.status).toLowerCase()));
  if (state.lightningSeen == null) return { notices: [], state: { ...state, lightningSeen: done.map((i) => i.id).slice(-KEEP) } };
  const seen = new Set(state.lightningSeen);
  const notices: Notice[] = [];
  // The node lists the newest first: say them oldest first
  for (const i of [...done].reverse()) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    if (!kinds.lightning) continue;
    const amount = kinds.amounts && i.amountSat > 0 ? `${fmt(i.amountSat)} ` : '';
    notices.push(
      i.direction === 'in'
        ? { id: `ln:${i.id}`, title: 'Lightning payment received', body: amount ? `You received ${amount}over Lightning.` : 'You received a payment over Lightning.' }
        : { id: `ln:${i.id}`, title: 'Lightning payment sent', body: amount ? `Your payment of ${amount.trim()} went through.` : 'Your Lightning payment went through.' },
    );
  }
  return { notices, state: { ...state, lightningSeen: [...seen].slice(-KEEP) } };
}
