// Network parameters. The BLAKE2b schedule and coinbase maturity come from Shrike's drongo Network.java,
// which in turn mirrors consensus.Blake2bHeight and CoinbaseMaturityLong in the Knots chainparams.

export type NetworkName = 'mainnet' | 'testnet4' | 'regtest';

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
  /** Confirmations a coinbase output needs before it can be spent under the fork's rules. */
  coinbaseMaturity: number;
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
    coinbaseMaturity: 6480,
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
    coinbaseMaturity: 6705,
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
    coinbaseMaturity: 100,
  },
};

export function networkFromRpcChain(chain: string): NetworkName | null {
  for (const n of Object.values(NETWORKS)) if (n.rpcChain === chain) return n.name;
  return null;
}
