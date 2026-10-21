// What a backup holds, and checking a restored one before any of it is used. Seed words, the node's RPC password,
// the two-factor key and the app PIN are never in it: those stay in this iPhone's Keychain, and the seed words on
// paper. src/core/backup.ts seals and opens the file.

import { NETWORKS, type NetworkName } from '../core/network';
import { decodeAddress, SCRIPT_TYPES, type ScriptType } from '../core/script';
import { normalizeExplorer } from '../core/explorer';
import { toHex } from '../core/bytes';
import type { LabelRecord } from '../core/labels';
import type { Contact, Settings, WalletConfig } from './model';

export interface BackupWallet {
  config: WalletConfig;
  labels: LabelRecord[];
  importedRange: number | null;
}

export interface BackupContents {
  kind: 'shrike-backup';
  v: 1;
  /** The app version that made it */
  app: string;
  createdAt: number;
  settings: Partial<Settings>;
  wallets: BackupWallet[];
  contacts: Contact[];
}

/** Settings a backup carries. The rest describe this iPhone's Keychain (two-factor, the PIN) or its own history. */
export const BACKUP_SETTINGS = [
  'network',
  'node',
  'unit',
  'lockOnOpen',
  'groupByAddress',
  'explorer',
  'appearance',
  'skin',
  'font',
  'skinTier',
  'prices',
  'pricesOverTor',
  'balanceView',
  'widgetBalance',
  'widgetWallet',
] as const satisfies readonly (keyof Settings)[];

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNet = (v: unknown): v is NetworkName => isStr(v) && Object.prototype.hasOwnProperty.call(NETWORKS, v);
/** IDs name files and Keychain items, so only the app's own form is taken: 16 hex digits */
const isId = (v: unknown): v is string => isStr(v) && /^[0-9a-f]{16}$/.test(v);
const newId = () => toHex(crypto.getRandomValues(new Uint8Array(8)));
/** The most addresses past the last used one a restored wallet watches */
const MAX_GAP = 500;

const SETTING_CHECKS: Record<(typeof BACKUP_SETTINGS)[number], (v: unknown) => boolean> = {
  network: isNet,
  node: (v) => {
    if (v === null) return true;
    const n = v as Record<string, unknown>;
    return (
      !!n &&
      typeof n === 'object' &&
      isStr(n.host) &&
      /^[a-z0-9.:\[\]-]+$/i.test(n.host) &&
      Number.isInteger(n.port) &&
      (n.port as number) > 0 &&
      (n.port as number) < 65536 &&
      isStr(n.user) &&
      isBool(n.useTor) &&
      isBool(n.tls)
    );
  },
  unit: (v) => v === 'BTC' || v === 'sats',
  lockOnOpen: isBool,
  groupByAddress: isBool,
  explorer: (v) => v === null || (isStr(v) && normalizeExplorer(v) === v),
  appearance: (v) => v === 'system' || v === 'light' || v === 'dark',
  skin: (v) => v === 'shrike' || v === 'redback' || v === 'northern' || v === 'gilded',
  font: (v) => v === 'atkinson' || v === 'system' || v === 'plex',
  skinTier: (v) => isNum(v) && v >= 0 && v <= 3 && Number.isInteger(v),
  prices: isBool,
  pricesOverTor: isBool,
  balanceView: (v) => v === 'coin' || v === 'usd',
  widgetBalance: isBool,
  widgetWallet: (v) => v === null || isId(v),
};

function walletOk(w: unknown): w is BackupWallet {
  const x = w as Partial<BackupWallet> | null;
  const c = x?.config as Partial<WalletConfig> | undefined;
  return (
    !!c &&
    isStr(c.id) &&
    isStr(c.name) &&
    isNet(c.network) &&
    SCRIPT_TYPES.includes(c.scriptType as ScriptType) &&
    isStr(c.fingerprint) &&
    isStr(c.derivation) &&
    isStr(c.xpub) &&
    isNum(c.gapLimit) &&
    isNum(c.createdAt) &&
    isBool(c.hasPassphrase) &&
    Array.isArray(x!.labels) &&
    (x!.importedRange === null || isNum(x!.importedRange))
  );
}

function labelOk(r: unknown): r is LabelRecord {
  const x = r as Partial<LabelRecord> | null;
  return !!x && isStr(x.type) && isStr(x.ref) && (x.label === undefined || isStr(x.label)) && (x.spendable === undefined || isBool(x.spendable));
}

function contactOk(c: unknown): c is Contact {
  const x = c as Partial<Contact> | null;
  if (!x || !isStr(x.name) || !isStr(x.address) || !isNet(x.network) || !isNum(x.createdAt)) return false;
  try {
    decodeAddress(x.address, NETWORKS[x.network]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks what came out of a backup and keeps only what's well formed: a damaged entry is left out rather than
 * stopping the restore. Throws if it isn't a backup's contents at all.
 */
export function checkBackupContents(o: unknown): BackupContents {
  const b = o as Partial<BackupContents> | null;
  if (!b || b.kind !== 'shrike-backup' || b.v !== 1 || !Array.isArray(b.wallets) || !Array.isArray(b.contacts) || !b.settings || typeof b.settings !== 'object') {
    throw new Error('This backup opened, but what’s inside isn’t in a form this version of Shrike reads');
  }
  const settings: Partial<Settings> = {};
  for (const k of BACKUP_SETTINGS) {
    const v = (b.settings as Record<string, unknown>)[k];
    if (v !== undefined && SETTING_CHECKS[k](v)) (settings as Record<string, unknown>)[k] = v;
  }
  return {
    kind: 'shrike-backup',
    v: 1,
    app: isStr(b.app) ? b.app : '',
    createdAt: isNum(b.createdAt) ? b.createdAt : 0,
    settings,
    wallets: b.wallets.filter(walletOk).map((w) => ({
      config: { ...w.config, id: isId(w.config.id) ? w.config.id : newId(), gapLimit: Math.min(MAX_GAP, Math.max(1, Math.floor(w.config.gapLimit))) },
      labels: w.labels.filter(labelOk),
      importedRange: w.importedRange,
    })),
    contacts: b.contacts.filter(contactOk).map((c) => ({
      id: isId(c.id) ? c.id : newId(),
      name: c.name,
      address: c.address,
      network: c.network,
      createdAt: c.createdAt,
      ...(isStr(c.note) ? { note: c.note } : {}),
      ...(isNum(c.lastUsed) ? { lastUsed: c.lastUsed } : {}),
    })),
  };
}
