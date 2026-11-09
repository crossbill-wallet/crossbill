// Network parameters. The BLAKE2b schedule and coinbase maturity come from Shrike's drongo Network.java,
// which in turn mirrors consensus.Blake2bHeight and CoinbaseMaturityLong in the Knots chainparams.
//
// Coinbase maturity on mainnet follows the height of the block that made the coinbase, as the node's relay
// policy applies it (Knots 29.4.3 and later, CoinbaseMaturityPolicy): 6480 confirmations (about 45 days) below
// block 979919, and 25920 (about 180 days) from block 979919. The app follows that policy rather than the
// looser consensus check, because it sends through the node. Rewards mined after RDTS expires (the parent's
// median time past reaching 1819756800, September 1st 2027 00:00 UTC) go back to 100. A block height cannot
// say that, so until the app reads block times for it, those rewards will read as still maturing. Fix that
// before the expiry.

export type NetworkName = 'mainnet' | 'testnet4' | 'regtest';

/** From this block height up, a coinbase output needs this many confirmations before it can be spent. */
export interface MaturityStep {
  fromHeight: number;
  confirmations: number;
}

export interface NetworkParams {
  name: NetworkName;
  /** The chain name Knots reports in getblockchaininfo. */
  rpcChain: string;
  bech32: string;
  p2pkhVersion: number;
  p2shVersion: number;
  bip32: { public: number; private: number };
  coinType: number;
  defaultRpcPort: number;
  /**
   * Height the BLAKE2b fork (and the unified opt-in signature hash with it) activates at, or null where this
   * build ships no schedule. Regtest picks its own through -testactivationheight, so there is nothing to ship.
   */
  blake2bHeight: number | null;
  /**
   * Confirmations a coinbase output needs before it can be spent under the fork's rules, by the height of the
   * block that made it. Ascending by fromHeight, and the first step starts at 0.
   */
  coinbaseMaturity: MaturityStep[];
}

export const NETWORKS: Record<NetworkName, NetworkParams> = {
  mainnet: {
    name: 'mainnet',
    rpcChain: 'main',
    bech32: 'bc',
    p2pkhVersion: 0x00,
    p2shVersion: 0x05,
    bip32: { public: 0x0488b21e, private: 0x0488ade4 },
    coinType: 0,
    defaultRpcPort: 8332,
    blake2bHeight: 961640,
    coinbaseMaturity: [
      { fromHeight: 0, confirmations: 6480 },
      { fromHeight: 979919, confirmations: 25920 },
    ],
  },
  testnet4: {
    name: 'testnet4',
    rpcChain: 'testnet4',
    bech32: 'tb',
    p2pkhVersion: 0x6f,
    p2shVersion: 0xc4,
    bip32: { public: 0x043587cf, private: 0x04358394 },
    coinType: 1,
    defaultRpcPort: 48332,
    blake2bHeight: 150308,
    coinbaseMaturity: [{ fromHeight: 0, confirmations: 6705 }],
  },
  regtest: {
    name: 'regtest',
    rpcChain: 'regtest',
    bech32: 'bcrt',
    p2pkhVersion: 0x6f,
    p2shVersion: 0xc4,
    bip32: { public: 0x043587cf, private: 0x04358394 },
    coinType: 1,
    defaultRpcPort: 18443,
    blake2bHeight: null,
    coinbaseMaturity: [{ fromHeight: 0, confirmations: 100 }],
  },
};

export function networkFromRpcChain(chain: string): NetworkName | null {
  for (const n of Object.values(NETWORKS)) if (n.rpcChain === chain) return n.name;
  return null;
}

/**
 * Confirmations a coinbase output needs, given the height of the block that made it. With no height (a coinbase
 * not yet in a block), the longest rule applies, so it can only read as maturing.
 */
export function coinbaseMaturityAt(net: NetworkParams, blockHeight: number | null): number {
  let needed = net.coinbaseMaturity[0].confirmations;
  for (const step of net.coinbaseMaturity) {
    if (blockHeight == null || blockHeight >= step.fromHeight) needed = step.confirmations;
  }
  return needed;
}

/** A coinbase output is spendable once its confirmations reach the maturity for its block's height. */
export function isCoinbaseImmature(net: NetworkParams, blockHeight: number | null, confirmations: number): boolean {
  return confirmations < coinbaseMaturityAt(net, blockHeight);
}
