import { useMemo, useState } from 'react';
import { fromHex } from '../core/bytes';
import { replayReadback } from '../core/sign';
import { formatAmount, formatFeeRate } from '../core/units';
import type { DraftTransaction } from '../core/txbuilder';
import { friendlyError } from '../app/model';
import { ShrikeNative } from '../app/native';
import { explorerName, explorerOpenUrl, explorerTxUrl } from '../core/explorer';
import { Address, Amount, EyeMark, Field, Screen, copyText, shortAddress, timeAgo, useApp, useNav } from './kit';
import { Review } from './Send';

export function TxDetail({ txid }: { txid: string }) {
  const app = useApp();
  const nav = useNav();
  const w = app.active!;
  const t = w.snapshot?.txs.find((x) => x.txid === txid);
  const [label, setLabel] = useState(w.labels.get('tx', txid) ?? '');
  const [copied, setCopied] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const unit = app.settings.unit;
  const explorer = app.settings.explorer;

  const readback = useMemo(() => {
    if (!t || !t.inputs.some((i) => i.mine)) return null;
    const spent = t.inputs.map((i) => (i.value != null && i.mine ? { value: i.value, script: fromHex(w.index.script(i.mine.chain, i.mine.index)) } : null));
    const pubs = t.inputs.map((i) => (i.mine ? w.key.pubKey(i.mine.chain, i.mine.index) : null));
    return replayReadback(t.tx, spent, w.config.scriptType, pubs);
  }, [t, w]);

  if (!t) {
    return (
      <Screen title="Transaction">
        <div className="empty">
          <strong>Not in this wallet</strong>
          It may have been replaced or dropped by your node.
        </div>
      </Screen>
    );
  }

  const status = t.confirmations === 0 ? 'Unconfirmed' : `${t.confirmations.toLocaleString('en-US')} confirmation${t.confirmations === 1 ? '' : 's'}, block ${t.height?.toLocaleString('en-US')}`;
  const childSpends = t.outputs.some((o) => o.spentBy);
  const canBump = t.confirmations === 0 && t.replaceable && t.allInputsMine && t.fee != null && !childSpends;

  return (
    <Screen title={t.net >= 0 ? 'Received' : 'Sent'}>
      <div className="big-amount">
        <Amount sats={t.net} unit={unit} sign />
      </div>
      <p className="note" style={{ marginTop: 0 }}>
        {status}
        <br />
        {timeAgo(t.time)}
      </p>

      <div className="txid-block">
        <div className="label">Transaction ID</div>
        <div className="txid">{txid}</div>
        <div className="txid-actions">
          <button
            className="btn secondary small"
            onClick={async () => {
              if (await copyText(txid)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            }}
          >
            {copied ? 'Copied' : 'Copy ID'}
          </button>
          {explorer && (
            <button
              className="btn secondary small"
              onClick={async () => {
                setOpenError(null);
                const url = explorerOpenUrl(explorerTxUrl(explorer, txid, app.settings.network));
                try {
                  const { opened } = await ShrikeNative.openUrl({ url });
                  if (!opened) setOpenError(url.startsWith('onion') ? 'Install Onion Browser from the App Store to open onion addresses.' : 'No app on this phone opened the link.');
                } catch (e) {
                  setOpenError(friendlyError(e));
                }
              }}
            >
              View on {explorerName(explorer)}
            </button>
          )}
        </div>
        {openError && <p className="note">{openError}</p>}
      </div>

      {readback && (
        <div className={`replay ${readback === 'protected' ? 'on' : readback === 'unprotected' ? 'off' : ''}`}>
          {readback !== 'unchecked' && <EyeMark on={readback === 'protected'} />}
          <div>
            <div className="state">{readback === 'protected' ? 'Replay protected' : readback === 'unprotected' ? 'Not replay protected' : 'Replay protection not checked'}</div>
            <div className="why">
              {readback === 'protected'
                ? 'A signature from this wallet opts in to the unified signature hash and verifies, so this transaction cannot be replayed on the SHA256d chain.'
                : readback === 'unprotected'
                  ? 'Every signature from this wallet uses the legacy hash, so where these coins also exist on the SHA256d chain this transaction can be replayed there.'
                  : 'The signatures could not all be checked from what this wallet holds.'}
            </div>
          </div>
        </div>
      )}

      <Field label="Label" htmlFor="tx-label">
        <input id="tx-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => void app.setLabel(w, 'tx', txid, label)} placeholder="What this transaction was" />
      </Field>

      {t.confirmations === 0 && t.replaceable && t.allInputsMine && childSpends && (
        <p className="note">A later transaction spends this one’s change, so raise the fee on that one instead. Its fee helps confirm both.</p>
      )}
      {canBump && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8 }}>
          <button className="btn primary" onClick={() => nav.push({ name: 'bump', txid })}>
            Raise the fee
          </button>
          <button className="btn secondary" onClick={() => nav.push({ name: 'bump', txid, cancel: true })}>
            Cancel it
          </button>
        </div>
      )}

      <dl className="facts">
        {t.fee != null && !t.coinbase && (
          <div>
            <dt>Fee</dt>
            <dd>
              <Amount sats={t.fee} unit={unit} />
              <div className="note mono">{formatFeeRate(t.fee / t.vsize)}</div>
            </dd>
          </div>
        )}
        <div>
          <dt>Size</dt>
          <dd className="mono">{t.vsize} vB</dd>
        </div>
      </dl>

      <div className="section-title">From</div>
      <ul className="list" style={{ margin: '0 calc(var(--pad) * -1)' }}>
        {t.coinbase ? (
          <li className="row" style={{ cursor: 'default' }}>
            <div className="main">New coins from a mined block</div>
          </li>
        ) : (
          t.inputs.map((i, k) => (
            <li key={k} className="row" style={{ cursor: 'default' }}>
              <div className="main">
                <div className="title" style={{ fontFamily: 'var(--mono)', fontWeight: 400, fontSize: 'var(--t-sm)' }}>
                  {i.address ? shortAddress(i.address) : `${i.txid.slice(0, 10)}…:${i.vout}`}
                </div>
                <div className="meta">{i.mine ? `This wallet, m/${i.mine.chain}/${i.mine.index}` : 'Someone else'}</div>
              </div>
              {i.value != null && <div className="amt">{formatAmount(i.value, unit)}</div>}
            </li>
          ))
        )}
      </ul>

      <div className="section-title">To</div>
      <ul className="list" style={{ margin: '0 calc(var(--pad) * -1)' }}>
        {t.outputs.map((o) => (
          <li key={o.vout} className="row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
            <div className="main">
              {o.address ? <Address value={o.address} size="sm" /> : <span className="note">Data output</span>}
              <div className="meta">{o.mine ? (o.mine.chain === 1 ? `Change, m/1/${o.mine.index}` : `This wallet, m/0/${o.mine.index}`) : 'Someone else'}</div>
            </div>
            <div className="amt">{formatAmount(o.value, unit)}</div>
          </li>
        ))}
      </ul>

    </Screen>
  );
}

export function Bump({ txid, cancel }: { txid: string; cancel?: boolean }) {
  const app = useApp();
  const nav = useNav();
  const w = app.active!;
  const t = w.snapshot?.txs.find((x) => x.txid === txid);
  const original = t && t.fee != null ? t.fee / t.vsize : 1;
  const incremental = app.node?.incrementalFee ?? 1;
  const suggested = Math.max(app.fees?.[1] ?? 0, original + incremental, app.minFeeRate());
  const [rate, setRate] = useState(String(Math.ceil(suggested * 100) / 100));
  const [review, setReview] = useState<DraftTransaction | null>(null);

  const built = useMemo(() => {
    if (!t) return { draft: null, error: 'Transaction not found' };
    try {
      return { draft: app.buildReplacement(w, t, Number(rate), cancel), error: null };
    } catch (e) {
      return { draft: null, error: friendlyError(e) };
    }
  }, [t, rate, cancel, app, w]);

  if (review && t) return <Review w={w} draft={review} onBack={() => setReview(null)} onDone={() => nav.reset()} title={cancel ? 'Cancel' : 'Raise the fee'} replacing={t.txid} />;

  return (
    <Screen title={cancel ? 'Cancel transaction' : 'Raise the fee'}>
      <p>
        {cancel
          ? 'This sends the same coins back to this wallet with a higher fee. If it confirms first, the original payment never happens.'
          : 'This sends the same payment again with a higher fee, replacing the original. Only one of the two can confirm.'}
      </p>
      <dl className="facts">
        <div>
          <dt>Current rate</dt>
          <dd className="mono">{formatFeeRate(original)}</dd>
        </div>
        {app.fees?.[1] && (
          <div>
            <dt>Next block now</dt>
            <dd className="mono">{formatFeeRate(app.fees[1])}</dd>
          </div>
        )}
      </dl>
      <Field label="New fee rate in sat/vB" htmlFor="bump-rate" hint={`It has to be above ${formatFeeRate(original)}.`}>
        <input id="bump-rate" className="input mono" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
      </Field>
      {built.draft && (
        <dl className="facts">
          <div>
            <dt>New fee</dt>
            <dd>
              <Amount sats={built.draft.fee} unit={app.settings.unit} />
            </dd>
          </div>
        </dl>
      )}
      {built.error && <div className="banner error">{built.error}</div>}
      <button className="btn primary" disabled={!built.draft} onClick={() => setReview(built.draft)}>
        Review
      </button>
    </Screen>
  );
}
