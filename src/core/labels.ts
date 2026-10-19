// Labels and frozen coins, kept in BIP329 form so they move between this app and the desktop app with
// Shrike's own "Export Labels" and "Import Labels". A frozen coin is an output record with spendable false,
// which is how Sparrow writes it.

export type LabelType = 'tx' | 'addr' | 'pubkey' | 'input' | 'output' | 'xpub';

export interface LabelRecord {
  type: LabelType;
  ref: string;
  label?: string;
  origin?: string;
  spendable?: boolean;
}

const TYPES = new Set<LabelType>(['tx', 'addr', 'pubkey', 'input', 'output', 'xpub']);

export class LabelStore {
  private readonly records = new Map<string, LabelRecord>();

  constructor(records: LabelRecord[] = []) {
    for (const r of records) this.records.set(key(r.type, r.ref), { ...r });
  }

  get(type: LabelType, ref: string): string | undefined {
    return this.records.get(key(type, ref))?.label || undefined;
  }

  set(type: LabelType, ref: string, label: string): void {
    const k = key(type, ref);
    const existing = this.records.get(k);
    const trimmed = label.trim();
    if (!trimmed) {
      if (existing && existing.spendable === false) {
        delete existing.label;
      } else {
        this.records.delete(k);
      }
      return;
    }
    this.records.set(k, { ...(existing ?? { type, ref }), label: trimmed });
  }

  isFrozen(txid: string, vout: number): boolean {
    return this.records.get(key('output', `${txid}:${vout}`))?.spendable === false;
  }

  setFrozen(txid: string, vout: number, frozen: boolean): void {
    const ref = `${txid}:${vout}`;
    const k = key('output', ref);
    const existing = this.records.get(k);
    if (frozen) {
      this.records.set(k, { ...(existing ?? { type: 'output', ref }), spendable: false });
    } else if (existing) {
      delete existing.spendable;
      if (!existing.label) this.records.delete(k);
    }
  }

  /** A coin shows its own label, or else its address's, or else its transaction's, as Sparrow falls back. */
  coinLabel(txid: string, vout: number, address: string): string | undefined {
    return this.get('output', `${txid}:${vout}`) ?? this.get('addr', address) ?? this.get('tx', txid);
  }

  all(): LabelRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  /** BIP329 JSON Lines. */
  exportJsonl(origin?: string): string {
    return this.all()
      .map((r) => JSON.stringify(origin && !r.origin && r.type !== 'xpub' ? { ...r, origin } : r))
      .join('\n');
  }

  /** Merges BIP329 JSON Lines. Imported entries replace existing ones with the same type and ref. Returns how many were read. */
  importJsonl(text: string): number {
    let count = 0;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let r: unknown;
      try {
        r = JSON.parse(trimmed);
      } catch {
        throw new Error(`Line ${count + 1} is not valid JSON`);
      }
      if (!r || typeof r !== 'object') continue;
      const rec = r as Partial<LabelRecord>;
      if (!rec.type || !TYPES.has(rec.type) || typeof rec.ref !== 'string') continue;
      const out: LabelRecord = { type: rec.type, ref: rec.ref };
      if (typeof rec.label === 'string' && rec.label) out.label = rec.label;
      if (typeof rec.origin === 'string') out.origin = rec.origin;
      if (rec.type === 'output' && rec.spendable === false) out.spendable = false;
      if (out.label || out.spendable === false) {
        this.records.set(key(out.type, out.ref), out);
        count++;
      }
    }
    return count;
  }
}

function key(type: LabelType, ref: string): string {
  return `${type}\u0000${ref}`;
}
