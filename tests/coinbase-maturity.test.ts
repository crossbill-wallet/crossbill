import { describe, expect, it } from 'vitest';
import { coinbaseMaturityAt, isCoinbaseImmature, NETWORKS } from '../src/core/network';

// The schedule is the node's relay policy in Knots 29.4.3 and later (CoinbaseMaturityPolicy):
// 6480 below block 979919, 25920 from block 979919.
describe('coinbase maturity follows the node, by the height of the block that made the coinbase', () => {
  const main = NETWORKS.mainnet;

  it('needs 6480 confirmations below block 979919', () => {
    expect(coinbaseMaturityAt(main, 0)).toBe(6480);
    expect(coinbaseMaturityAt(main, 973440)).toBe(6480);
    expect(coinbaseMaturityAt(main, 979918)).toBe(6480);
  });

  it('needs 25920 confirmations from block 979919', () => {
    expect(coinbaseMaturityAt(main, 979919)).toBe(25920);
    expect(coinbaseMaturityAt(main, 1_000_000)).toBe(25920);
  });

  it('reads a coinbase with no block yet as the longest rule', () => {
    expect(coinbaseMaturityAt(main, null)).toBe(25920);
  });

  it('keeps the other networks as they were', () => {
    expect(coinbaseMaturityAt(NETWORKS.testnet4, 979919)).toBe(6705);
    expect(coinbaseMaturityAt(NETWORKS.regtest, 979919)).toBe(100);
  });

  it('is spendable exactly when the confirmations reach the maturity', () => {
    expect(isCoinbaseImmature(main, 979918, 6479)).toBe(true);
    expect(isCoinbaseImmature(main, 979918, 6480)).toBe(false);
    expect(isCoinbaseImmature(main, 979919, 6480)).toBe(true);
    expect(isCoinbaseImmature(main, 979919, 25919)).toBe(true);
    expect(isCoinbaseImmature(main, 979919, 25920)).toBe(false);
    expect(isCoinbaseImmature(main, null, 0)).toBe(true);
  });
});
