// Whether a transaction this wallet builds opts in to the unified signature hash, and where it does not, why.
// Ported from Shrike's AppServices.chainDecision / heightDecision and UnifiedSigHashDecision. A seed held in
// this app always signs here, so the keystore checks the desktop makes for hardware signers never apply.

import { fromHex } from './bytes';
import type { NetworkParams } from './network';

export type ReplayDecision =
  | 'OPTED_IN'
  | 'OPTED_IN_UNCORROBORATED'
  | 'CHAIN_NOT_ACTIVATED'
  | 'CHAIN_UNSEEN'
  | 'CHAIN_HEIGHT_UNKNOWN'
  | 'BUILD_HAS_NO_SCHEDULE'
  | 'SCHEDULE_MISMATCH'
  | 'TIP_CONTRADICTS_SCHEDULE'
  | 'BEFORE_ACTIVATION_HEIGHT';

export const DECISION_TEXT: Record<ReplayDecision, { reason?: string; remedy?: string; caveat?: string }> = {
  OPTED_IN: {},
  OPTED_IN_UNCORROBORATED: {
    caveat:
      'The activation height could not be checked against the connected node, which reports none. This rests on the height built into this app alone.',
  },
  CHAIN_NOT_ACTIVATED: { reason: 'The fork is not active on this chain yet.' },
  CHAIN_UNSEEN: { reason: 'The chain cannot be seen from here. Connect to your node first.' },
  CHAIN_HEIGHT_UNKNOWN: { reason: 'The current block height is not known.' },
  BUILD_HAS_NO_SCHEDULE: { reason: 'This app has no activation height for this network.' },
  SCHEDULE_MISMATCH: { reason: 'This app and your node disagree on the activation height.' },
  TIP_CONTRADICTS_SCHEDULE: {
    reason: 'Your node announced a tip at or past the activation height that is not a fork header.',
    remedy: 'Check the node is following the fork and is fully synced before sending.',
  },
  BEFORE_ACTIVATION_HEIGHT: { reason: 'The chain has not reached the activation height.' },
};

export function isOptedIn(d: ReplayDecision): boolean {
  return d === 'OPTED_IN' || d === 'OPTED_IN_UNCORROBORATED';
}

export function decisionSummary(d: ReplayDecision): string {
  return isOptedIn(d) ? 'Replay protected' : 'Not replay protected';
}

export interface ChainView {
  /** Height of the tip the node reports, or null if unknown. */
  height: number | null;
  /** Whether the tip header is a v2 (BLAKE2b) header, or null if no tip has been seen. */
  tipIsV2: boolean | null;
  /** The activation height getdeploymentinfo reports, or null where the node says nothing. */
  nodeActivationHeight: number | null;
}

export function heightDecision(walletHeight: number | null, nodeHeight: number | null, blockHeight: number | null): ReplayDecision {
  if (blockHeight == null) return 'CHAIN_HEIGHT_UNKNOWN';
  if (walletHeight == null) return 'BUILD_HAS_NO_SCHEDULE';
  if (nodeHeight != null && nodeHeight !== walletHeight) return 'SCHEDULE_MISMATCH';
  if (blockHeight < walletHeight) return 'BEFORE_ACTIVATION_HEIGHT';
  if (nodeHeight == null) return 'OPTED_IN_UNCORROBORATED';
  return 'OPTED_IN';
}

export function chainDecision(net: NetworkParams, view: ChainView): ReplayDecision {
  if (view.tipIsV2 == null) return 'CHAIN_UNSEEN';
  const activation = net.blake2bHeight;
  if (!view.tipIsV2) {
    // Nothing authenticates the tip, so a v1 tip at or past the shipped height names the server, not the chain
    return activation != null && view.height != null && view.height >= activation ? 'TIP_CONTRADICTS_SCHEDULE' : 'CHAIN_NOT_ACTIVATED';
  }
  if (net.name === 'regtest') return 'OPTED_IN';
  return heightDecision(activation, view.nodeActivationHeight, view.height);
}

/** Bit 31 of the version word marks a v2 header (drongo BlockHeader.HEADER_V2_FLAG). */
export const HEADER_V2_FLAG = 0x80000000;
export const V1_HEADER_LENGTH = 80;
export const V2_HEADER_LENGTH = 164;

export interface HeaderSummary {
  isV2: boolean;
  version: number;
  /** The height field a v2 header carries, or null for v1. */
  height: number | null;
}

export function parseHeader(rawHex: string): HeaderSummary {
  const raw = fromHex(rawHex);
  if (raw.length !== V1_HEADER_LENGTH && raw.length !== V2_HEADER_LENGTH) throw new Error(`Unexpected header length ${raw.length}`);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const word = dv.getUint32(0, true);
  const isV2 = (word & HEADER_V2_FLAG) !== 0;
  if (isV2 !== (raw.length === V2_HEADER_LENGTH)) throw new Error('Header length does not match its version flag');
  // v2 layout: 80 bytes of v1 fields, then nonce2(4) nonce3(4) extranonce(16) timeOffset(4) txCount(2) flags(1)
  // xorKeyMaskClearBits(1) xorKey(16) height(4) mmRhs(32)
  const height = isV2 ? dv.getUint32(80 + 4 + 4 + 16 + 4 + 2 + 1 + 1 + 16, true) : null;
  return { isV2, version: (word & ~HEADER_V2_FLAG) >>> 0, height };
}
