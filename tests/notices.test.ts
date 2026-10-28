import { describe, expect, it } from 'vitest';
import { confirmationNotices, EMPTY_NOTICE_STATE, lightningNotices, type NoticeKinds, type NoticeState } from '../src/core/notices';

const ALL: NoticeKinds = { firstConf: true, sixthConf: true, lightning: true, amounts: false };
const fmt = (s: number) => `${s} sats`;
const primed = (tip: number): NoticeState => ({ ...EMPTY_NOTICE_STATE, tips: { mainnet: tip } });

describe('confirmation notices', () => {
  it('only takes note on the first check, so turning on brings no flood', () => {
    const r = confirmationNotices(EMPTY_NOTICE_STATE, 'mainnet', 100, [{ txid: 'a', height: 100, net: 5 }], ALL, fmt);
    expect(r.notices).toEqual([]);
    expect(r.state.tips.mainnet).toBe(100);
  });

  it('says the first confirmation once the payment is in a block', () => {
    const r = confirmationNotices(primed(100), 'mainnet', 101, [{ txid: 'a', height: 101, net: 5000 }], ALL, fmt);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0].title).toBe('First confirmation');
    expect(r.notices[0].body).toBe('A payment you received is in a block.');
  });

  it('says the sixth confirmation five blocks later, and not the first again', () => {
    const one = confirmationNotices(primed(100), 'mainnet', 101, [{ txid: 'a', height: 101, net: -700 }], ALL, fmt);
    const six = confirmationNotices(one.state, 'mainnet', 106, [{ txid: 'a', height: 101, net: -700 }], ALL, fmt);
    expect(six.notices.map((n) => n.title)).toEqual(['Confirmed 6 times']);
    expect(six.notices[0].body).toBe('A payment you sent has 6 confirmations.');
    const again = confirmationNotices(six.state, 'mainnet', 110, [{ txid: 'a', height: 101, net: -700 }], ALL, fmt);
    expect(again.notices).toEqual([]);
  });

  it('says only the sixth when both happened since the last check', () => {
    const r = confirmationNotices(primed(100), 'mainnet', 110, [{ txid: 'a', height: 103, net: 5 }], ALL, fmt);
    expect(r.notices.map((n) => n.title)).toEqual(['Confirmed 6 times']);
  });

  it('stays quiet about old payments, unconfirmed ones and a tip that did not move', () => {
    const txs = [
      { txid: 'old', height: 50, net: 5 },
      { txid: 'mempool', height: null, net: 5 },
    ];
    expect(confirmationNotices(primed(100), 'mainnet', 101, txs, ALL, fmt).notices).toEqual([]);
    expect(confirmationNotices(primed(100), 'mainnet', 100, [{ txid: 'a', height: 100, net: 5 }], ALL, fmt).notices).toEqual([]);
  });

  it('says it once when two wallets hold the same payment, and after a reorg', () => {
    const tx = { txid: 'a', height: 101, net: 5 };
    const r = confirmationNotices(primed(100), 'mainnet', 101, [tx, tx], ALL, fmt);
    expect(r.notices).toHaveLength(1);
    // The block is replaced and the tip goes back, then forward again
    const back = confirmationNotices({ ...r.state, tips: { mainnet: 100 } }, 'mainnet', 101, [tx], ALL, fmt);
    expect(back.notices).toEqual([]);
  });

  it('respects the kinds turned off and shows amounts only when asked', () => {
    const tx = [{ txid: 'a', height: 101, net: 2500 }];
    expect(confirmationNotices(primed(100), 'mainnet', 101, tx, { ...ALL, firstConf: false }, fmt).notices).toEqual([]);
    const shown = confirmationNotices(primed(100), 'mainnet', 101, tx, { ...ALL, amounts: true }, fmt);
    expect(shown.notices[0].body).toBe('2500 sats you received is in a block.');
  });

  it('keeps each network apart', () => {
    const r = confirmationNotices(primed(100), 'testnet', 5000, [{ txid: 'a', height: 5000, net: 5 }], ALL, fmt);
    expect(r.notices).toEqual([]);
    expect(r.state.tips).toEqual({ mainnet: 100, testnet: 5000 });
  });
});

describe('Lightning notices', () => {
  const item = (id: string, direction: 'in' | 'out', status = 'complete') => ({ id, kind: 'lightning' as const, direction, amountSat: 21_000, status });

  it('only takes note on the first look', () => {
    const r = lightningNotices(EMPTY_NOTICE_STATE, [item('x', 'in')], ALL, fmt);
    expect(r.notices).toEqual([]);
    expect(r.state.lightningSeen).toEqual(['x']);
  });

  it('says new payments received and sent, oldest first, once each', () => {
    const start = lightningNotices(EMPTY_NOTICE_STATE, [item('x', 'in')], ALL, fmt).state;
    const r = lightningNotices(start, [item('z', 'out'), item('y', 'in'), item('x', 'in')], ALL, fmt);
    expect(r.notices.map((n) => n.title)).toEqual(['Lightning payment received', 'Lightning payment sent']);
    expect(lightningNotices(r.state, [item('z', 'out'), item('y', 'in'), item('x', 'in')], ALL, fmt).notices).toEqual([]);
  });

  it('waits for a pending payment to finish, and leaves the node’s on-chain payments out', () => {
    const start = lightningNotices(EMPTY_NOTICE_STATE, [], ALL, fmt).state;
    const pending = lightningNotices(start, [item('p', 'out', 'pending'), { ...item('c', 'in'), kind: 'onchain' as const }], ALL, fmt);
    expect(pending.notices).toEqual([]);
    const done = lightningNotices(pending.state, [item('p', 'out')], { ...ALL, amounts: true }, fmt);
    expect(done.notices[0].body).toBe('Your payment of 21000 sats went through.');
  });

  it('marks payments seen while Lightning notifications are off, so turning them on says nothing old', () => {
    const start = lightningNotices(EMPTY_NOTICE_STATE, [], ALL, fmt).state;
    const off = lightningNotices(start, [item('a', 'in')], { ...ALL, lightning: false }, fmt);
    expect(off.notices).toEqual([]);
    expect(lightningNotices(off.state, [item('a', 'in')], ALL, fmt).notices).toEqual([]);
  });
});

describe('review fixes', () => {
  it('says the first confirmation when both happened but only first confirmations are wanted', () => {
    const r = confirmationNotices(primed(100), 'mainnet', 110, [{ txid: 'a', height: 103, net: 5 }], { ...ALL, sixthConf: false }, fmt);
    expect(r.notices.map((n) => n.title)).toEqual(['First confirmation']);
  });

  it('goes by a bridge payment’s own state', () => {
    const start = lightningNotices(EMPTY_NOTICE_STATE, [], ALL, fmt).state;
    const returned = { id: 'b', kind: 'lightning' as const, direction: 'out' as const, amountSat: 0, status: 'complete', bitcoinInvoice: { state: 'returned' } };
    expect(lightningNotices(start, [returned], ALL, fmt).notices).toEqual([]);
    const paid = { ...returned, id: 'c', bitcoinInvoice: { state: 'paid' } };
    expect(lightningNotices(start, [paid], ALL, fmt).notices).toHaveLength(1);
  });

  it('only takes note after more than a day without a check', () => {
    const r = confirmationNotices(primed(100), 'mainnet', 300, [{ txid: 'a', height: 290, net: 5 }], ALL, fmt);
    expect(r.notices).toEqual([]);
    expect(r.state.tips.mainnet).toBe(300);
  });
});
