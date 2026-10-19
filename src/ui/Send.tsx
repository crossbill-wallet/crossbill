import { useMemo, useState } from 'react';
import { decodeAddress } from '../core/script';
import { formatAmount, formatFeeRate, parseAmount, unitLabel, type Unit } from '../core/units';
import type { DraftTransaction, Payment } from '../core/txbuilder';
import { friendlyError, toCoin, type WalletRuntime } from '../app/model';
import { ShrikeNative } from '../app/native';
import { Address, Amount, Field, ReplayStatus, Screen, Sheet, parsePaymentText, shortAddress, useApp, useNav } from './kit';

interface Recipient {
  address: string;
  amountText: string;
  max: boolean;
  label: string;
}

const FEE_CHOICES: { target: number; label: string }[] = [
  { target: 1, label: 'Next block' },
  { target: 3, label: 'About 30 minutes' },
  { target: 10, label: 'About 2 hours' },
  { target: 50, label: 'About 8 hours' },
];

function satsToText(sats: number, unit: Unit): string {
  return unit === 'sats' ? String(sats) : (sats / 1e8).toFixed(8).replace(/\.?0+$/, '');
}

export function Send({ address, amount, label, coins }: { address?: string; amount?: number; label?: string; coins?: string[] }) {
  const app = useApp();
  const nav = useNav();
  const w = app.active!;
  const unit = app.settings.unit;
  const [recipients, setRecipients] = useState<Recipient[]>([{ address: address ?? '', amountText: amount ? satsToText(amount, unit) : '', max: false, label: label ?? '' }]);
  const [feeTarget, setFeeTarget] = useState<number | 'custom'>(app.fees && app.fees[3] ? 3 : 'custom');
  const [customRate, setCustomRate] = useState(String(Math.max(1, Math.ceil(app.minFeeRate()))));
  const [picked, setPicked] = useState<Set<string>>(new Set(coins ?? []));
  const [picking, setPicking] = useState(false);
  const [review, setReview] = useState<DraftTransaction | null>(null);
  // Which recipient the "My wallets" sheet fills in, if it's open
  const [toOwnFor, setToOwnFor] = useState<number | null>(null);
  const ownWallets = app.networkWallets().filter((x) => x.config.id !== w.config.id);

  const feeRate = feeTarget === 'custom' ? Number(customRate) : (app.fees?.[feeTarget] ?? NaN);

  const parsed = recipients.map((r) => {
    let err: string | null = null;
    let script: Uint8Array | null = null;
    if (r.address.trim()) {
      try {
        script = decodeAddress(r.address, app.net).scriptPubKey;
      } catch (e) {
        err = friendlyError(e);
      }
    }
    const sats = r.max ? 0 : parseAmount(r.amountText, unit);
    return { r, script, addrErr: err, sats };
  });

  const selectedCoins = app.coins(w).filter((c) => picked.has(`${c.txid}:${c.vout}`));

  const build = useMemo(() => {
    if (!parsed.every((p) => p.script && (p.r.max || p.sats))) return { draft: null, error: null };
    if (!(feeRate > 0)) return { draft: null, error: 'Choose a fee rate' };
    try {
      const payments: Payment[] = parsed.map((p) => ({ address: p.r.address.trim(), scriptPubKey: p.script!, amount: p.sats ?? 0, sendMax: p.r.max, label: p.r.label.trim() || undefined }));
      return { draft: app.buildDraft(w, payments, feeRate, selectedCoins.length ? selectedCoins.map(toCoin) : null), error: null };
    } catch (e) {
      return { draft: null, error: friendlyError(e) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(recipients), feeRate, [...picked].join(), app.version]);

  const update = (i: number, patch: Partial<Recipient>) => setRecipients(recipients.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  if (review) return <Review w={w} draft={review} onBack={() => setReview(null)} onDone={() => nav.reset()} />;

  return (
    <Screen title="Send">
      {recipients.map((r, i) => {
        const p = parsed[i];
        return (
          <div key={i} style={{ marginBottom: recipients.length > 1 ? 24 : 0 }}>
            {recipients.length > 1 && (
              <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                Recipient {i + 1}
                <button className="btn quiet" onClick={() => setRecipients(recipients.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            )}
            <Field label="Pay to" htmlFor={`to-${i}`} error={p.addrErr}>
              <div className="input-row">
                <textarea
                  id={`to-${i}`}
                  className="input mono"
                  rows={2}
                  style={{ minHeight: 64 }}
                  value={r.address}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Address"
                  onChange={(e) => {
                    const v = parsePaymentText(e.target.value);
                    update(i, { address: v.address, ...(v.amount ? { amountText: satsToText(v.amount, unit), max: false } : {}), ...(v.label ? { label: v.label } : {}) });
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  className="btn secondary small"
                  onClick={async () => {
                    const res = await ShrikeNative.scanQr();
                    if (res.value) {
                      const v = parsePaymentText(res.value);
                      update(i, { address: v.address, ...(v.amount ? { amountText: satsToText(v.amount, unit), max: false } : {}), ...(v.label ? { label: v.label } : {}) });
                    }
                  }}
                >
                  Scan QR code
                </button>
                <button
                  className="btn secondary small"
                  onClick={async () => {
                    try {
                      const t = await navigator.clipboard.readText();
                      const v = parsePaymentText(t);
                      update(i, { address: v.address, ...(v.amount ? { amountText: satsToText(v.amount, unit), max: false } : {}), ...(v.label ? { label: v.label } : {}) });
                    } catch {
                      // clipboard read refused
                    }
                  }}
                >
                  Paste
                </button>
                {ownWallets.length > 0 && (
                  <button className="btn secondary small" onClick={() => setToOwnFor(i)}>
                    My wallets
                  </button>
                )}
              </div>
            </Field>
            <Field label={`Amount in ${unitLabel(unit)}`} htmlFor={`amt-${i}`} error={!r.max && r.amountText && !p.sats ? 'Enter a positive amount' : null}>
              <div className="input-row">
                <input
                  id={`amt-${i}`}
                  className="input mono"
                  inputMode="decimal"
                  value={r.max ? 'Everything that is left' : r.amountText}
                  disabled={r.max}
                  onChange={(e) => update(i, { amountText: e.target.value })}
                  placeholder={unit === 'BTC' ? '0.00000000' : '0'}
                />
                <button
                  className="btn secondary small"
                  aria-pressed={r.max}
                  style={r.max ? { borderColor: 'var(--ink)', boxShadow: 'inset 0 0 0 1px var(--ink)' } : undefined}
                  onClick={() => setRecipients(recipients.map((x, j) => ({ ...x, max: j === i ? !r.max : false })))}
                >
                  Max
                </button>
              </div>
            </Field>
            <Field label="Label" htmlFor={`label-${i}`} hint="Saved with the transaction. Optional.">
              <input id={`label-${i}`} className="input" value={r.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="What this payment is for" />
            </Field>
          </div>
        );
      })}
      <button className="btn quiet" onClick={() => setRecipients([...recipients, { address: '', amountText: '', max: false, label: '' }])}>
        Add another recipient
      </button>

      <div className="section-title">Fee</div>
      <div style={{ display: 'grid', gap: 8 }}>
        {FEE_CHOICES.filter((c) => app.fees?.[c.target]).map((c) => (
          <button key={c.target} className="choice" role="radio" aria-checked={feeTarget === c.target} onClick={() => setFeeTarget(c.target)} style={{ marginBottom: 0 }}>
            <span className="dot" />
            <span style={{ flex: 1, display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <span className="what">{c.label}</span>
              <span className="mono">{formatFeeRate(app.fees![c.target])}</span>
            </span>
          </button>
        ))}
        <button className="choice" role="radio" aria-checked={feeTarget === 'custom'} onClick={() => setFeeTarget('custom')} style={{ marginBottom: 0 }}>
          <span className="dot" />
          <span style={{ flex: 1 }}>
            <span className="what">Set the rate yourself</span>
            {!app.fees || Object.keys(app.fees).length === 0 ? <div className="why">Your node has no fee estimates yet.</div> : null}
          </span>
        </button>
        {feeTarget === 'custom' && (
          <div className="input-row" style={{ alignItems: 'center' }}>
            <input className="input mono" inputMode="decimal" value={customRate} onChange={(e) => setCustomRate(e.target.value)} aria-label="Fee rate in sat/vB" />
            <span className="note">sat/vB</span>
          </div>
        )}
      </div>

      <div className="section-title">Coins</div>
      <button className="row" style={{ padding: '12px 0' }} onClick={() => setPicking(true)}>
        <div className="main">
          <div className="title">{picked.size ? `${picked.size} coin${picked.size > 1 ? 's' : ''} chosen` : 'Chosen automatically'}</div>
          <div className="meta">{picked.size ? <Amount sats={selectedCoins.reduce((s, c) => s + c.value, 0)} unit={unit} /> : 'Confirmed coins first, whole addresses together'}</div>
        </div>
        <span className="note">Choose</span>
      </button>

      <ReplayStatus decision={app.replayDecision()} compact />
      {app.sendBlocker() && <div className="banner">{app.sendBlocker()}</div>}

      {build.draft && (
        <dl className="facts">
          <div>
            <dt>Fee</dt>
            <dd>
              <Amount sats={build.draft.fee} unit={unit} />
            </dd>
          </div>
          <div>
            <dt>Rate</dt>
            <dd className="mono">{formatFeeRate(build.draft.feeRate)}</dd>
          </div>
        </dl>
      )}
      {build.error && <div className="banner error">{build.error}</div>}

      <button className="btn primary" disabled={!build.draft} onClick={() => setReview(build.draft)}>
        Review
      </button>

      {picking && (
        <Sheet title="Choose coins" onClose={() => setPicking(false)}>
          <p className="note" style={{ marginTop: 0 }}>
            Only the coins you tick are spent. Leave all unticked to let the wallet choose.
          </p>
          <ul className="list" style={{ margin: '0 calc(var(--pad) * -1)' }}>
            {app.coins(w).map((c) => {
              const k = `${c.txid}:${c.vout}`;
              const disabled = c.frozen || c.immature;
              return (
                <li key={k}>
                  <label className="row" style={{ opacity: disabled ? 0.5 : 1 }}>
                    <input
                      type="checkbox"
                      checked={picked.has(k)}
                      disabled={disabled}
                      onChange={(e) => {
                        const n = new Set(picked);
                        if (e.target.checked) n.add(k);
                        else n.delete(k);
                        setPicked(n);
                      }}
                      style={{ width: 22, height: 22 }}
                    />
                    <div className="main">
                      <div className="title">{c.label ?? shortAddress(c.address)}</div>
                      <div className="meta">{c.frozen ? 'Frozen' : c.immature ? 'Still maturing' : c.height == null ? 'Unconfirmed' : `${c.confirmations} confirmation${c.confirmations === 1 ? '' : 's'}`}</div>
                    </div>
                    <div className="amt">{formatAmount(c.value, unit)}</div>
                  </label>
                </li>
              );
            })}
          </ul>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 16 }}>
            <button className="btn secondary" onClick={() => setPicked(new Set())}>
              Clear
            </button>
            <button className="btn primary" onClick={() => setPicking(false)}>
              Done
            </button>
          </div>
        </Sheet>
      )}
      {toOwnFor != null && (
        <Sheet title="Send to one of your wallets" onClose={() => setToOwnFor(null)}>
          <p className="note" style={{ marginTop: 0 }}>
            Fills in the next unused receive address of the wallet you pick.
          </p>
          {ownWallets.map((x) => (
            <button
              key={x.config.id}
              className="choice"
              onClick={() => {
                const to = app.freshReceive(x);
                const r = recipients[toOwnFor];
                update(toOwnFor, { address: to.address, label: r?.label.trim() ? r.label : `To ${x.config.name}` });
                setToOwnFor(null);
              }}
            >
              <span>
                <span className="what">{x.config.name}</span>
                <div className="why">
                  <Amount sats={(x.snapshot?.balance.confirmed ?? 0) + (x.snapshot?.balance.unconfirmed ?? 0)} unit={unit} />
                </div>
              </span>
            </button>
          ))}
        </Sheet>
      )}
    </Screen>
  );
}

export function Review({ w, draft, onBack, onDone, title = 'Review', replacing }: { w: WalletRuntime; draft: DraftTransaction; onBack: () => void; onDone: () => void; title?: string; replacing?: string }) {
  const app = useApp();
  const unit = app.settings.unit;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const payments = draft.outputs.filter((o) => !o.isChange);
  const total = payments.reduce((s, o) => s + o.value, 0) + draft.fee;
  const decision = app.replayDecision();

  if (sent) {
    return (
      <Screen title="Sent" back={false}>
        <div className="big-amount" style={{ marginTop: 20 }}>
          <Amount sats={total} unit={unit} />
        </div>
        <p>Your node accepted the transaction and is relaying it.</p>
        <ReplayStatus decision={decision} compact />
        <div className="section-title">Transaction ID</div>
        <div className="txid">{sent}</div>
        <div style={{ height: 28 }} />
        <button className="btn primary" onClick={onDone}>
          Done
        </button>
      </Screen>
    );
  }

  return (
    <div className="screen">
      <header className="bar">
        <div className="side">
          <button onClick={onBack}>Edit</button>
        </div>
        <h1>{title}</h1>
        <div className="side end" />
      </header>
      <main className="body">
        {replacing && <div className="banner">This replaces transaction {replacing.slice(0, 12)}… Only one of the two can confirm.</div>}
        {payments.map((o, i) => (
          <div key={i} style={{ marginBottom: 22 }}>
            <div className="note">{o.payment?.label ?? (payments.length > 1 ? `Payment ${i + 1}` : 'Paying')}</div>
            <div className="big-amount">
              <Amount sats={o.value} unit={unit} />
            </div>
            <div className="note" style={{ marginTop: 8 }}>
              To
            </div>
            <Address value={o.payment?.address || ''} size="lg" />
          </div>
        ))}

        <ReplayStatus decision={decision} />

        <dl className="facts">
          <div>
            <dt>Fee</dt>
            <dd>
              <Amount sats={draft.fee} unit={unit} />
            </dd>
          </div>
          <div>
            <dt>Fee rate</dt>
            <dd className="mono">
              {formatFeeRate(draft.feeRate)}, {draft.vsize} vB
            </dd>
          </div>
          <div>
            <dt>Coins spent</dt>
            <dd>
              {draft.coins.length} coin{draft.coins.length > 1 ? 's' : ''}, <Amount sats={draft.coins.reduce((s, c) => s + c.value, 0)} unit={unit} />
            </dd>
          </div>
          {draft.change && (
            <div>
              <dt>Change back to you</dt>
              <dd>
                <Amount sats={draft.change.value} unit={unit} />
              </dd>
            </div>
          )}
          <div>
            <dt>Total leaving the wallet</dt>
            <dd style={{ fontWeight: 700 }}>
              <Amount sats={total} unit={unit} />
            </dd>
          </div>
        </dl>
        <p className="note">Check each address group by group against where it came from. Sending can’t be undone once it confirms.</p>
        {error && <div className="banner error">{error}</div>}
        <button
          className="btn primary"
          disabled={sending}
          onClick={async () => {
            setSending(true);
            setError(null);
            try {
              const original = replacing ? w.snapshot?.txs.find((t) => t.txid === replacing) : undefined;
              const s = await app.signAndBroadcast(w, draft, original ? app.txLabel(w, original) : undefined, replacing);
              setSent(s.txid);
            } catch (e) {
              setError(friendlyError(e));
            } finally {
              setSending(false);
            }
          }}
        >
          {sending ? 'Signing and sending' : 'Sign and send'}
        </button>
        <p className="note" style={{ textAlign: 'center' }}>
          Face ID opens the seed for this one signature only.
        </p>
      </main>
    </div>
  );
}
