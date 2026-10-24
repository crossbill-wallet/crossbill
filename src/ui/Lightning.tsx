// The Lightning tab: balances, activity, sending and receiving through the person's own Lightning Fork node, and
// pairing with it. The node does the work; these screens ask it and show what it says.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Share } from '@capacitor/share';
import { formatAmount, parseAmount, unitLabel } from '../core/units';
import { LfError, quoteSecondsLeft, type LfActivityItem, type LfFees, type LfInvoice, type LfOnchainEstimate, type LfQuote, type LfTarget } from '../core/lfapi';
import { fromOwnBridge, lightningError, type PaymentOutcome } from '../app/lightning';
import { isNative, ShrikeNative } from '../app/native';
import { Address, Amount, Chevron, Field, Qr, Screen, SecondFactorField, Sheet, codeReady, copyText, timeAgo, useApp, useNav } from './kit';

const sats = (n: number) => formatAmount(n, 'sats');

function useNow(every: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

function inWords(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.floor(seconds))} seconds`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}

// ------------------------------------------------------------------------------------------- the tab

export function LightningTab() {
  const app = useApp();
  const nav = useNav();
  const ln = app.lightning;
  const s = ln.state;
  const unit = app.settings.unit;

  useEffect(() => {
    void ln.refresh();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void ln.refresh();
    }, 30_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void ln.refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ln]);

  if (!ln.paired) {
    return (
      <Screen title="Lightning" back={false}>
        <NotPaired />
      </Screen>
    );
  }

  const w = s.wallet;
  const alias = s.bootstrap?.node?.alias || s.link?.alias || 'Your Lightning node';
  const where = s.route === 'lan' ? 'At home' : s.route === 'tor' ? 'Through Tor' : '';
  const sub: string[] = [];
  if (w) {
    sub.push(`${formatAmount(w.onchain.confirmedSat, unit)} ${unitLabel(unit)} on chain`);
    if (w.onchain.unconfirmedSat) sub.push(`${formatAmount(w.onchain.unconfirmedSat, unit, { sign: true })} confirming`);
  }
  const moving = w ? (w.lightning.inMotionSat ?? 0) + w.lightning.pendingOutboundSat : 0;

  return (
    <div className="screen">
      <section className="band">
        <div className="top">
          <button className="wallet-name" onClick={() => nav.push({ name: 'ln-settings' })} aria-label={`${alias}. Lightning settings`}>
            <span className="name">{alias}</span>
            <Chevron dir="right" />
          </button>
          <button className="blockh" onClick={() => void ln.refresh()} aria-label="Check your Lightning node now">
            {s.loading ? 'Checking' : where}
          </button>
        </div>
        <div className="status-slot" role="status" aria-live="polite">
          {s.loading && !w && (
            <div className="status busy on">
              <span className="spinner" />
              <span className="msg">Reaching your Lightning node</span>
            </div>
          )}
        </div>
        <div className="balance" aria-label={w ? `${formatAmount(w.lightning.outboundSat, unit)} ${unitLabel(unit)} you can send on Lightning` : 'Lightning balance not read yet'}>
          {w ? formatAmount(w.lightning.outboundSat, unit) : '...'}
          <small>{unitLabel(unit)}</small>
        </div>
        <div className="sub">{w ? `Can send on Lightning${moving ? `, ${formatAmount(moving, unit)} more on its way into channels` : ''}` : s.error ? 'Not read yet' : ' '}</div>
        <div className="sub">{sub.join(', ') || ' '}</div>
        <div className="actions">
          <button onClick={() => nav.push({ name: 'ln-receive' })}>Receive</button>
          <button onClick={() => nav.push({ name: 'ln-send' })}>Send</button>
        </div>
      </section>

      <div style={{ padding: '14px var(--pad) 0' }}>
        <PendingBanner />
        {s.needsPairing ? (
          <div className="banner error" role="alert">
            {s.needsPairing}
            <div className="button-row" style={{ marginTop: 10 }}>
              <button className="btn secondary small" onClick={() => nav.push({ name: 'ln-pair' })}>
                Pair again
              </button>
            </div>
          </div>
        ) : s.error ? (
          <div className="banner error" role="alert">
            {s.error}
            <div className="button-row" style={{ marginTop: 10 }}>
              <button className="btn secondary small" disabled={s.loading} onClick={() => void ln.refresh()}>
                {s.loading ? 'Trying' : 'Try again'}
              </button>
            </div>
          </div>
        ) : null}
        <Sha256Line />
      </div>

      <div className="section-title" style={{ padding: '0 var(--pad)' }}>
        Activity
      </div>
      <LnActivity />
    </div>
  );
}

/** How the node pays invoices on the SHA256 chain, in one line. */
function Sha256Line() {
  const app = useApp();
  const st = app.lightning.state;
  const p = st.sha256;
  const svc = p ?? st.bootstrap?.bitcoinInvoices ?? null;
  if (!svc) return null;
  const service = svc.configured ? svc.label || 'your bridge service' : null;
  let text: string;
  if (p?.ownBridge) {
    text = p.ownBridge.ready
      ? `SHA256 invoices are paid from your bridge: it can send ${sats(p.ownBridge.availableSat)} sats of BTC now.`
      : 'SHA256 invoices will be paid from your bridge once its SHA256 node is running and synced.';
    if (service) text += ` ${service} pays any it can’t, with XBT.`;
  } else if (service) {
    text = `SHA256 invoices are paid through ${service}, with XBT.`;
  } else if (p) {
    text = 'SHA256 invoices can’t be paid yet: set up a bridge in your node’s dashboard, under Paying SHA256 invoices.';
  } else {
    return null;
  }
  return (
    <p className="note" style={{ margin: '0 0 6px' }}>
      {text}
    </p>
  );
}

/** An amount of this chain's coin, named as such: on screens that also show BTC on the SHA256 chain. */
function Xbt({ n }: { n: number }) {
  const app = useApp();
  const unit = app.settings.unit;
  return (
    <span className="mono">
      {formatAmount(n, unit)} <span style={{ fontFamily: 'var(--sans)', color: 'var(--slate)', fontSize: '0.8em' }}>{unit === 'sats' ? 'sats of XBT' : 'XBT'}</span>
    </span>
  );
}

/** A pending payment: what Crossbill knows, and what asking again would do. */
function PendingBanner() {
  const app = useApp();
  const ln = app.lightning;
  const p = ln.state.pending;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  if (!p) return null;
  const check = ln.pendingCheck(p);
  return (
    <div className="banner" role="status">
      <strong>{p.summary}</strong>
      <div style={{ marginTop: 4 }}>
        {check === 'other-pairing'
          ? 'This was sent before Crossbill paired with your node again, so it can’t be asked about from here. Look for it in your node’s activity before paying again.'
          : (p.note ?? 'Waiting for your node to say how it went.')}
      </div>
      {check === 'check-or-pay' && (
        <div style={{ marginTop: 4 }}>Asking again uses the same request, so it is never paid twice. If your node never got it, asking again pays it now.</div>
      )}
      {err && <div style={{ marginTop: 6 }}>{err}</div>}
      <div className="button-row" style={{ marginTop: 10 }}>
        {check !== 'other-pairing' && (
          <button
            className="btn secondary small"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await ln.resumePending();
              } catch (e) {
                setErr(lightningError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Asking' : check === 'check' ? 'Check now' : 'Ask your node again'}
          </button>
        )}
        <button className="btn quiet small" disabled={busy} onClick={() => setStopping(true)}>
          Stop tracking it
        </button>
      </div>
      {stopping && (
        <Sheet title="Stop tracking this payment?" onClose={() => setStopping(false)}>
          <p style={{ marginTop: 0 }}>
            Crossbill stops asking about it. That doesn’t cancel it: if your node got it, it may still be paid. Check your node’s activity first, so you don’t pay twice.
          </p>
          <button
            className="btn primary"
            onClick={() => {
              setStopping(false);
              void ln.dismissPending();
            }}
          >
            Stop tracking it
          </button>
        </Sheet>
      )}
    </div>
  );
}

function activityTitle(it: LfActivityItem): string {
  if (it.description) return it.description;
  if (it.bitcoinInvoice) return 'SHA256 invoice';
  if (it.kind === 'onchain') return it.direction === 'in' ? 'Deposit' : 'Withdrawal';
  return it.direction === 'in' ? 'Received' : 'Sent';
}

function activityMeta(it: LfActivityItem): string {
  const parts: string[] = [];
  const bi = it.bitcoinInvoice;
  if (bi) parts.push(fromOwnBridge(bi) ? 'Paid from your bridge' : `Through ${bi.serviceLabel || 'a bridge'}`);
  else parts.push(it.kind === 'onchain' ? 'On chain' : 'Lightning');
  const state = bi?.state ?? it.status;
  if (state === 'pending') parts.push(it.kind === 'onchain' ? 'confirming' : 'in progress');
  else if (state === 'failed') parts.push('failed');
  else if (state === 'returned') parts.push('came back');
  else if (it.kind === 'onchain' && it.confirmations != null && it.confirmations < 6) parts.push(`${it.confirmations} confirmation${it.confirmations === 1 ? '' : 's'}`);
  if (it.timestamp) parts.push(timeAgo(it.timestamp));
  return parts.join(', ');
}

function LnActivity() {
  const app = useApp();
  const s = app.lightning.state;
  const unit = app.settings.unit;
  const [open, setOpen] = useState<LfActivityItem | null>(null);
  const items = s.activity;
  if (!items) {
    return <div className="empty">{s.loading ? 'Reading your node’s activity.' : 'Your node’s activity shows here once Crossbill reaches it.'}</div>;
  }
  if (!items.length) {
    return (
      <div className="empty">
        <strong>No payments yet</strong>
        Lightning payments and your node’s on-chain transactions show up here.
      </div>
    );
  }
  return (
    <>
      <ul className="list">
        {items.map((it) => {
          const own = fromOwnBridge(it.bitcoinInvoice);
          return (
            <li key={it.id}>
              <button className="row" onClick={() => setOpen(it)}>
                <div className="main">
                  <div className="title">{activityTitle(it)}</div>
                  <div className="meta">{activityMeta(it)}</div>
                </div>
                <div className={`amt ${it.direction === 'out' ? 'out' : ''}`}>
                  {own ? (
                    <>
                      {sats(it.bitcoinInvoice!.amountSat)} <span style={{ fontFamily: 'var(--sans)', fontSize: '0.8em', color: 'var(--slate)' }}>sats (BTC)</span>
                    </>
                  ) : (
                    formatAmount(it.direction === 'out' ? -it.amountSat : it.amountSat, unit, { sign: true })
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      {open && <ActivitySheet it={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ActivitySheet({ it, onClose }: { it: LfActivityItem; onClose: () => void }) {
  const app = useApp();
  const unit = app.settings.unit;
  const bi = it.bitcoinInvoice;
  const own = fromOwnBridge(bi);
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <Sheet title={activityTitle(it)} onClose={onClose}>
      <dl className="facts">
        {bi ? (
          <>
            <div>
              <dt>Paid on the SHA256 chain</dt>
              <dd>{sats(bi.amountSat)} sats of BTC</dd>
            </div>
            {own ? (
              <div>
                <dt>From</dt>
                <dd>Your bridge’s SHA256 node{bi.sha256FeeSat != null ? `, ${sats(bi.sha256FeeSat)} sats of routing` : ''}. No XBT spent.</dd>
              </div>
            ) : (
              <>
                <div>
                  <dt>Through</dt>
                  <dd>{bi.serviceLabel || 'A bridge service'}</dd>
                </div>
                <div>
                  <dt>Cost</dt>
                  <dd>
                    <Xbt n={it.amountSat + it.feeSat} />
                  </dd>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div>
              <dt>{it.direction === 'in' ? 'Received' : 'Sent'}</dt>
              <dd>
                <Amount sats={it.amountSat} unit={unit} />
              </dd>
            </div>
            {it.feeSat > 0 && (
              <div>
                <dt>Fee</dt>
                <dd>
                  <Amount sats={it.feeSat} unit={unit} />
                </dd>
              </div>
            )}
          </>
        )}
        <div>
          <dt>Kind</dt>
          <dd>{it.kind === 'onchain' ? 'On chain' : 'Lightning'}</dd>
        </div>
        {it.timestamp > 0 && (
          <div>
            <dt>When</dt>
            <dd>{timeAgo(it.timestamp)}</dd>
          </div>
        )}
      </dl>
      {it.reference && (
        <>
          <div className="section-title">{it.kind === 'onchain' ? 'Transaction ID' : 'Payment hash'}</div>
          <div className="txid">{it.reference}</div>
          <button className="btn quiet small" onClick={async () => setCopied((await copyText(it.reference)) ? 'ref' : null)}>
            {copied === 'ref' ? 'Copied' : 'Copy'}
          </button>
        </>
      )}
      {it.preimage && (
        <>
          <div className="section-title">Proof of payment</div>
          <div className="txid">{it.preimage}</div>
        </>
      )}
    </Sheet>
  );
}

function NotPaired() {
  const nav = useNav();
  return (
    <>
      <p style={{ marginTop: 0 }}>
        Crossbill can send and receive Lightning payments through your own Lightning Fork node. Your node holds the money and the keys; this iPhone gets a key to its dashboard, which you can remove there at any
        time.
      </p>
      <button className="btn primary" onClick={() => nav.push({ name: 'ln-pair' })}>
        Pair with your node
      </button>
    </>
  );
}

// ------------------------------------------------------------------------------------------- pairing

export function LightningPair() {
  const app = useApp();
  const nav = useNav();
  const ln = app.lightning;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pair = async (raw: string) => {
    if (!raw.trim()) return;
    setBusy(true);
    setError(null);
    try {
      ln.readPairingCode(raw);
      await ln.pair(raw);
      nav.reset({ name: 'lightning' });
    } catch (e) {
      setError(lightningError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Pair with your node">
      <ol className="prose" style={{ paddingLeft: 20, marginTop: 0 }}>
        <li>Open your Lightning Fork node’s dashboard on another screen.</li>
        <li>
          In its menu, choose <strong>Mobile app</strong>, then <strong>Pair a phone</strong>, and enter the dashboard’s password.
        </li>
        <li>Scan the code it shows. It works once, for five minutes.</li>
      </ol>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: '6px 0 18px' }}>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            const r = await ShrikeNative.scanQr({ title: 'Scan the pairing code' }).catch(() => ({ value: null }));
            if (r.value) {
              setText(r.value);
              void pair(r.value);
            }
          }}
        >
          Scan
        </button>
        <button
          className="btn secondary"
          disabled={busy}
          onClick={async () => {
            try {
              const t = await navigator.clipboard.readText();
              setText(t);
              void pair(t);
            } catch {
              setError('Crossbill couldn’t read the clipboard. Paste the code into the box below.');
            }
          }}
        >
          Paste
        </button>
      </div>
      <Field label="Or paste the code here" htmlFor="ln-code">
        <textarea id="ln-code" className="input mono" rows={3} value={text} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setText(e.target.value)} placeholder='{"lf":1,"code":"e_…"} or lightningfork://pair?c=…' />
      </Field>
      {text.trim() && !busy && (
        <button className="btn secondary" onClick={() => void pair(text)}>
          Pair
        </button>
      )}
      {busy && (
        <p className="note">
          <span className="spinner small" /> Pairing with your node. Away from home this goes through Tor and can take a minute.
        </p>
      )}
      {error && <div className="banner error">{error}</div>}
      <p className="note">
        At home, Crossbill reaches the node on your network and checks its certificate against the code. Away from home it uses the dashboard’s onion address through Tor: in StartOS, give Lightning Fork’s
        Dashboard interface an onion address with SSL off.
      </p>
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------- settings

export function LightningSettings() {
  const app = useApp();
  const nav = useNav();
  const ln = app.lightning;
  const s = ln.state;
  useEffect(() => {
    void ln.readSha256Payers();
  }, [ln]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!ln.paired || !s.link) {
    return (
      <Screen title="Lightning">
        <NotPaired />
        {note && <p className="note">{note}</p>}
      </Screen>
    );
  }
  const l = s.link;
  const e = l.endpoints;
  const p = s.sha256;
  return (
    <Screen title="Lightning">
      <dl className="facts">
        <div>
          <dt>Node</dt>
          <dd>{s.bootstrap?.node?.alias || l.alias || 'Lightning Fork'}</dd>
        </div>
        {s.bootstrap?.node?.version && (
          <div>
            <dt>Version</dt>
            <dd>{s.bootstrap.node.version}</dd>
          </div>
        )}
        <div>
          <dt>This iPhone in the dashboard</dt>
          <dd>{l.label}</dd>
        </div>
        <div>
          <dt>Paired</dt>
          <dd>{timeAgo(Math.floor(l.pairedAt / 1000))}</dd>
        </div>
        <div>
          <dt>At home</dt>
          <dd style={{ overflowWrap: 'anywhere', fontSize: 'var(--t-sm)' }}>
            {e.caPem && (e.lanUrl || e.lanIp) ? [e.lanUrl, e.lanIp].filter(Boolean).map((u) => u!.replace(/^https:\/\//, '')).join(', ') : 'Not set up'}
          </dd>
        </div>
        <div>
          <dt>Away from home</dt>
          <dd style={{ overflowWrap: 'anywhere', fontSize: 'var(--t-sm)' }}>
            {e.onionUrl ? `${e.onionUrl.replace(/^https?:\/\//, '').slice(0, 16)}….onion, through Tor` : 'No onion address yet'}
          </dd>
        </div>
        <div>
          <dt>SHA256 invoices</dt>
          <dd>{p?.ownBridge ? 'Paid from your own bridge, with BTC' : p?.configured ? `Through ${p.label || 'a service'}, with XBT` : p ? 'Not set up' : 'Not read yet'}</dd>
        </div>
      </dl>
      {!e.onionUrl && (
        <p className="note">
          To pay away from home, give Lightning Fork’s Dashboard interface an onion address in StartOS, with SSL off. Crossbill picks it up the next time it reaches the node at home.
        </p>
      )}
      {e.caPem && (
        <p className="note">At home, Crossbill only talks to a server whose certificate comes from the root it saw when pairing. After a restore or a new root on the server, pair again.</p>
      )}
      <button className="btn secondary" style={{ width: '100%' }} onClick={() => nav.push({ name: 'ln-pair' })}>
        Pair again
      </button>
      <button className="btn quiet" style={{ color: 'var(--ember)', display: 'block', marginTop: 10 }} onClick={() => setConfirm(true)}>
        Unpair this iPhone
      </button>
      {confirm && (
        <Sheet title="Unpair this iPhone?" onClose={() => setConfirm(false)}>
          <p style={{ marginTop: 0 }}>Crossbill removes its key from your node and forgets the node. Your money stays on the node. You can pair again from the dashboard at any time.</p>
          {s.pending && <div className="banner">A payment hasn’t finished ({s.pending.summary}). Crossbill stops tracking it; check your node’s activity before paying again.</div>}
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await ln.unpair();
              setBusy(false);
              setConfirm(false);
              if (r.removedThere) nav.reset({ name: 'settings' });
              else setNote('Crossbill forgot the node, but couldn’t reach it, so this iPhone may still be listed under Mobile app in its dashboard. Remove it there.');
            }}
          >
            {busy ? 'Unpairing' : 'Unpair'}
          </button>
        </Sheet>
      )}
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------- sending

export function LightningSend({ input }: { input?: string }) {
  const app = useApp();
  const nav = useNav();
  const ln = app.lightning;
  const [text, setText] = useState(input ?? '');
  const [target, setTarget] = useState<{ t: LfTarget; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ o: PaymentOutcome; t: LfTarget } | null>(null);

  const read = async (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const at = Date.now();
      const t = await ln.decode(v);
      if (t.kind === 'unsupported') setError(t.message || 'Your node can’t pay this. Check it’s a Lightning invoice, an offer or an address.');
      else setTarget({ t, at });
    } catch (e) {
      setError(lightningError(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (input) void read(input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (outcome) return <PaidView o={outcome.o} t={outcome.t} onDone={() => nav.reset({ name: 'lightning' })} />;
  if (target) {
    const back = () => setTarget(null);
    const done = (o: PaymentOutcome) => setOutcome({ o, t: target.t });
    if (target.t.kind === 'bitcoin-invoice') return <PaySha256 t={target.t} decodedAt={target.at} onBack={back} onOutcome={done} />;
    if (target.t.kind === 'onchain') return <SendOnchain t={target.t} onBack={back} onOutcome={done} />;
    return <PayLightning t={target.t} onBack={back} onOutcome={done} />;
  }

  return (
    <Screen title="Send">
      {ln.state.pending && <PendingBanner />}
      <Field label="Invoice, offer or address" htmlFor="ln-to" hint="A Lightning invoice or offer, on this chain or the SHA256 chain, or an address for your node’s on-chain wallet.">
        <textarea
          id="ln-to"
          className="input mono"
          rows={4}
          value={text}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="lnbc…, lno…, or an address"
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <div className="button-row">
        <button
          className="btn secondary small"
          disabled={busy}
          onClick={async () => {
            const r = await ShrikeNative.scanQr({ title: 'Scan an invoice' }).catch(() => ({ value: null }));
            if (r.value) {
              setText(r.value);
              void read(r.value);
            }
          }}
        >
          Scan
        </button>
        <button
          className="btn secondary small"
          disabled={busy}
          onClick={async () => {
            try {
              const t = await navigator.clipboard.readText();
              setText(t);
              void read(t);
            } catch {
              // clipboard read refused
            }
          }}
        >
          Paste
        </button>
      </div>
      {error && <div className="banner error">{error}</div>}
      <button className="btn primary" disabled={busy || !text.trim()} onClick={() => void read(text)}>
        {busy ? 'Asking your node' : 'Next'}
      </button>
    </Screen>
  );
}

/** The bar on a payment screen: Edit goes back to what was scanned. */
function PayScreen({ title, onBack, busy, children }: { title: string; onBack: () => void; busy?: boolean; children: ReactNode }) {
  return (
    <div className="screen">
      <header className="bar">
        <div className="side">
          <button onClick={onBack} disabled={busy}>
            Edit
          </button>
        </div>
        <h1>{title}</h1>
        <div className="side end" />
      </header>
      <main className="body">{children}</main>
    </div>
  );
}

function ApproveNote({ needCode }: { needCode: boolean }) {
  return (
    <p className="note" style={{ textAlign: 'center' }}>
      {needCode ? 'After the code, Face ID confirms it’s you. Your node makes the payment.' : 'Face ID confirms it’s you. Your node makes the payment.'}
    </p>
  );
}

function PayLightning({ t, onBack, onOutcome }: { t: LfTarget; onBack: () => void; onOutcome: (o: PaymentOutcome) => void }) {
  const app = useApp();
  const ln = app.lightning;
  const unit = app.settings.unit;
  const now = useNow(1000);
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needCode = app.settings.twoFactor;
  const amount = t.amountEditable ? parseAmount(amountText, unit) : t.amountSat;
  const offer = t.kind === 'offer';
  const left = t.expiresAt ? t.expiresAt - now / 1000 : null;
  const expired = t.expired || (left != null && left <= 0);
  const blocked = expired || !!t.ours;
  const canSend = ln.state.wallet?.lightning.outboundSat;
  const tooMuch = amount != null && canSend != null && amount > canSend;
  const summary = `${amount != null ? `${sats(amount)} sats` : 'Payment'}${t.description ? ` for ${t.description}` : ''}`;

  return (
    <PayScreen title={offer ? 'Pay an offer' : 'Pay an invoice'} onBack={onBack} busy={busy}>
      {t.amountEditable ? (
        <Field label={`Amount in ${unitLabel(unit)}`} htmlFor="ln-amt" error={amountText && amount == null ? 'Enter an amount' : tooMuch ? 'More than your channels can send now' : null}>
          <input id="ln-amt" className="input mono" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="0" autoFocus />
        </Field>
      ) : (
        <div className="big-amount" style={{ marginTop: 8 }}>
          <Amount sats={amount ?? 0} unit={unit} />
        </div>
      )}
      <dl className="facts">
        {t.description && (
          <div>
            <dt>For</dt>
            <dd>{t.description}</dd>
          </div>
        )}
        {t.issuer && (
          <div>
            <dt>From</dt>
            <dd>{t.issuer}</dd>
          </div>
        )}
        {t.destination && (
          <div>
            <dt>To node</dt>
            <dd className="mono">{`${t.destination.slice(0, 12)}…${t.destination.slice(-6)}`}</dd>
          </div>
        )}
        {left != null && !expired && (
          <div>
            <dt>Expires in</dt>
            <dd>{inWords(left)}</dd>
          </div>
        )}
        {canSend != null && (
          <div>
            <dt>Your channels can send</dt>
            <dd>
              <Amount sats={canSend} unit={unit} />
            </dd>
          </div>
        )}
      </dl>
      {offer && (
        <Field label="Note to the recipient" htmlFor="ln-note" hint="Optional. The recipient sees it with the payment.">
          <input id="ln-note" className="input" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} />
        </Field>
      )}
      {(t.message || expired) && <div className="banner">{expired ? 'This invoice has expired. Ask for a new one.' : t.message}</div>}
      {tooMuch && !t.amountEditable && <div className="banner">More than your channels can send now.</div>}
      {needCode && <SecondFactorField value={code} onChange={setCode} />}
      {error && <div className="banner error">{error}</div>}
      <button
        className="btn primary"
        disabled={busy || amount == null || blocked || tooMuch || (needCode && !codeReady(code))}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const o = await ln.payLightning({ request: t.request, amountSat: t.amountEditable ? amount! : undefined, payerNote: note.trim() || undefined, summary, code: needCode ? code : undefined });
            onOutcome(o);
          } catch (e) {
            if ((e as Error).message !== 'Cancelled') setError(lightningError(e));
            setCode('');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Paying' : 'Pay'}
      </button>
      <ApproveNote needCode={needCode} />
    </PayScreen>
  );
}

/**
 * A Lightning invoice on the SHA256 chain. With the node's own bridge, its SHA256 node pays it with BTC: no swap,
 * no fee, no XBT. Through a service, the price is asked for at once and holds for a short time, counted down here.
 */
function PaySha256({ t: first, decodedAt: firstAt, onBack, onOutcome }: { t: LfTarget; decodedAt: number; onBack: () => void; onOutcome: (o: PaymentOutcome) => void }) {
  const app = useApp();
  const ln = app.lightning;
  const now = useNow(500);
  // Read again after the price changed, on a node that gives no firm prices
  const [again, setAgain] = useState<{ t: LfTarget; at: number } | null>(null);
  const t = again?.t ?? first;
  const decodedAt = again?.at ?? firstAt;
  const [q, setQ] = useState<{ q: LfQuote; at: number } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteNote, setQuoteNote] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const needCode = app.settings.twoFactor;
  const est = t.estimate ?? null;
  const own = fromOwnBridge(q?.q ?? est);
  const amount = t.amountSat ?? 0;

  const getQuote = async () => {
    if (!ln.quotes || !t.payable) return;
    setQuoting(true);
    setQuoteNote(null);
    const at = Date.now();
    try {
      setQ({ q: await ln.quote(t.request), at });
    } catch (e) {
      setQ(null);
      if (e instanceof LfError && e.code === 'in_progress') {
        const wait = Number(e.details?.retryAfterSeconds) || 10;
        setQuoteNote(`The service is still holding its last price. Asking again in ${wait} seconds.`);
        retry.current = setTimeout(() => void getQuote(), wait * 1000);
      } else {
        setQuoteNote(lightningError(e));
      }
    } finally {
      setQuoting(false);
    }
  };

  useEffect(() => {
    void getQuote();
    return () => {
      if (retry.current) clearTimeout(retry.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const invoiceLeft = t.secondsLeft != null ? t.secondsLeft - (now - decodedAt) / 1000 : null;
  const priceLeft = q && !own ? quoteSecondsLeft(q.q, q.at, now) : null;
  const priceGone = priceLeft === 0;
  const invoiceGone = invoiceLeft != null && invoiceLeft <= 0;
  const maxIncoming = own ? 0 : (q?.q.maxIncomingSat ?? est?.maxIncomingSat ?? null);
  const waitingForQuote = ln.quotes && !own && !q;
  const summary = `${sats(amount)} sats (SHA256)${t.description ? ` for ${t.description}` : ''}`;
  const payable = t.payable && maxIncoming != null && !invoiceGone && !priceGone && !waitingForQuote;
  const ref = q?.q.reference ?? t.reference ?? null;

  return (
    <PayScreen title="Pay a SHA256 invoice" onBack={onBack} busy={busy}>
      <div className="note">A Lightning invoice on the SHA256 chain</div>
      <div className="big-amount">
        <span className="mono">{sats(amount)}</span> <span style={{ fontFamily: 'var(--sans)', fontSize: '0.8em', color: 'var(--slate)' }}>sats of BTC</span>
      </div>
      {t.description && <p style={{ marginTop: 4 }}>{t.description}</p>}

      {!t.payable ? (
        <div className="banner">{t.message || 'Your node can’t pay this invoice.'}</div>
      ) : own ? (
        <div className="banner" role="status">
          <strong>Paid from your bridge.</strong> Your bridge’s SHA256 node pays this with BTC from its channel: no swap, no fee, and none of your XBT.
          {est?.sha256AvailableSat != null ? ` It can send ${sats(est.sha256AvailableSat)} sats now.` : ''}
          {est?.sha256RoutingFeeLimitSat != null ? ` Routing costs at most ${sats(est.sha256RoutingFeeLimitSat)} sats of BTC.` : ''}
        </div>
      ) : (
        <>
          <div className="note" style={{ marginTop: 12 }}>
            {q ? 'You pay' : 'You pay at most'}
          </div>
          <div className="big-amount">{maxIncoming != null ? <Xbt n={maxIncoming} /> : '...'}</div>
          <dl className="facts">
            <div>
              <dt>Through</dt>
              <dd>{q?.q.serviceLabel || est?.serviceLabel || 'Your bridge service'}</dd>
            </div>
            {(q?.q.feeSat ?? est?.feeSat) != null && (
              <div>
                <dt>Service fee, included</dt>
                <dd>
                  <Xbt n={(q?.q.feeSat ?? est?.feeSat)!} />
                </dd>
              </div>
            )}
            <div>
              <dt>Routing, on top</dt>
              <dd>
                up to <Xbt n={q?.q.routingFeeLimitSat ?? est?.routingFeeLimitSat ?? 0} />
              </dd>
            </div>
            {ref && (
              <div>
                <dt>Against the market</dt>
                <dd>
                  {((ref.premium ?? 0) * 100).toFixed(1)}% over {ref.source}, within the {((ref.premiumAllowed ?? 0) * 100).toFixed(1)}% allowed
                  {ref.serviceWidening ? `, of which ${(ref.serviceWidening * 100).toFixed(1)}% is the service widening its fee` : ''}
                </dd>
              </div>
            )}
          </dl>
          {quoting && (
            <p className="note">
              <span className="spinner small" /> Getting a firm price from the service
            </p>
          )}
          {priceLeft != null && !priceGone && <p className="note">This price holds for {inWords(priceLeft)}.</p>}
          {priceGone && (
            <div className="banner">
              This price ran out.{' '}
              <button className="btn secondary small" disabled={quoting} onClick={() => void getQuote()}>
                Get a new price
              </button>
            </div>
          )}
          {quoteNote && <div className="banner">{quoteNote}</div>}
        </>
      )}
      {invoiceLeft != null && (
        <p className="note">{invoiceGone ? 'The invoice has expired. Ask for a new one.' : `The invoice expires in ${inWords(invoiceLeft)}.`}</p>
      )}
      {needCode && t.payable && <SecondFactorField value={code} onChange={setCode} />}
      {error && <div className="banner error">{error}</div>}
      <button
        className="btn primary"
        disabled={busy || !payable || (needCode && !codeReady(code))}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            // A firm price must still stand once the code and Face ID are done, not just when Pay was tapped
            const held = q;
            const stillValid = () => own || !held || quoteSecondsLeft(held.q, held.at, Date.now()) > 0;
            onOutcome(await ln.payBitcoinInvoice({ request: t.request, maxIncomingSat: maxIncoming!, summary, code: needCode ? code : undefined, stillValid }));
          } catch (e) {
            setCode('');
            if ((e as Error).message === 'Cancelled') return;
            if (e instanceof LfError && e.code === 'price_changed') {
              setError('The service’s price went up since it was shown. Check the new one below, and pay again if it suits you.');
              if (ln.quotes) void getQuote();
              else {
                const at = Date.now();
                ln.decode(t.request)
                  .then((fresh) => setAgain({ t: fresh, at }))
                  .catch((x) => setError(lightningError(x)));
              }
            } else if (/price ran out/.test((e as Error).message)) {
              setError((e as Error).message);
              void getQuote();
            } else {
              setError(lightningError(e));
            }
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Paying' : own ? 'Pay from your bridge' : 'Pay'}
      </button>
      <ApproveNote needCode={needCode} />
    </PayScreen>
  );
}

function SendOnchain({ t, onBack, onOutcome }: { t: LfTarget; onBack: () => void; onOutcome: (o: PaymentOutcome) => void }) {
  const app = useApp();
  const ln = app.lightning;
  const unit = app.settings.unit;
  const address = t.address ?? t.request;
  const [amountText, setAmountText] = useState(t.amountSat ? formatAmount(t.amountSat, unit).replace(/\s/g, '') : '');
  const [sendAll, setSendAll] = useState(false);
  const [fees, setFees] = useState<LfFees | null>(null);
  const [speed, setSpeed] = useState<'low' | 'medium' | 'high'>('medium');
  const [est, setEst] = useState<LfOnchainEstimate | null>(null);
  const [estErr, setEstErr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needCode = app.settings.twoFactor;
  const amount = sendAll ? null : parseAmount(amountText, unit);
  const rate = fees?.[speed].satPerVbyte ?? null;

  useEffect(() => {
    ln.fees()
      .then(setFees)
      .catch((e) => setEstErr(lightningError(e)));
  }, [ln]);

  useEffect(() => {
    setEst(null);
    if (!rate || (!sendAll && !amount)) return;
    let alive = true;
    const timer = setTimeout(() => {
      ln.estimateOnchain({ address, amountSat: amount ?? undefined, sendAll, satPerVbyte: rate })
        .then((e) => alive && (setEst(e), setEstErr(null)))
        .catch((e) => alive && setEstErr(lightningError(e)));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [ln, address, amount, sendAll, rate]);

  return (
    <PayScreen title="Send on chain" onBack={onBack} busy={busy}>
      <div className="note">To</div>
      <Address value={address} size="lg" />
      <p className="note">From your Lightning node’s on-chain wallet, not from this iPhone’s wallets.</p>
      <Field label={`Amount in ${unitLabel(unit)}`} htmlFor="lnoc-amt">
        <input id="lnoc-amt" className="input mono" inputMode="decimal" disabled={sendAll} value={sendAll ? '' : amountText} placeholder={sendAll ? 'Everything' : '0'} onChange={(e) => setAmountText(e.target.value)} />
      </Field>
      <button className="btn quiet small" onClick={() => setSendAll(!sendAll)}>
        {sendAll ? 'Enter an amount instead' : 'Send everything'}
      </button>
      {fees && (
        <Field label="Speed">
          <div className="segmented" role="group" aria-label="Speed">
            {(['low', 'medium', 'high'] as const).map((k) => (
              <button key={k} aria-pressed={speed === k} onClick={() => setSpeed(k)}>
                {fees[k].label || k}
                <div style={{ fontWeight: 400, fontSize: 'var(--t-xs)' }}>{fees[k].satPerVbyte} sat/vB</div>
              </button>
            ))}
          </div>
        </Field>
      )}
      {est && (
        <dl className="facts">
          <div>
            <dt>Sending</dt>
            <dd>
              <Amount sats={est.amountSat} unit={unit} />
            </dd>
          </div>
          <div>
            <dt>Fee</dt>
            <dd>
              <Amount sats={est.feeSat} unit={unit} />
            </dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd style={{ fontWeight: 700 }}>
              <Amount sats={est.totalSat} unit={unit} />
            </dd>
          </div>
        </dl>
      )}
      {estErr && <div className="banner">{estErr}</div>}
      {needCode && <SecondFactorField value={code} onChange={setCode} />}
      {error && <div className="banner error">{error}</div>}
      <button
        className="btn primary"
        disabled={busy || !est || !rate || (needCode && !codeReady(code))}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            onOutcome(await ln.sendOnchain({ address, amountSat: sendAll ? undefined : est!.amountSat, sendAll, satPerVbyte: rate!, summary: `${formatAmount(est!.amountSat, unit)} ${unitLabel(unit)} on chain`, code: needCode ? code : undefined }));
          } catch (e) {
            if ((e as Error).message !== 'Cancelled') setError(lightningError(e));
            setCode('');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Sending' : 'Send'}
      </button>
      <ApproveNote needCode={needCode} />
    </PayScreen>
  );
}

function PaidView({ o, t, onDone }: { o: PaymentOutcome; t: LfTarget; onDone: () => void }) {
  const app = useApp();
  const ln = app.lightning;
  const unit = app.settings.unit;
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState<PaymentOutcome>(o);
  const [err, setErr] = useState<string | null>(null);

  if (now.kind === 'waiting') {
    return (
      <Screen title="On its way" back={false}>
        <p style={{ marginTop: 8 }}>{now.note}</p>
        <p className="note">
          {ln.state.pending && ln.pendingCheck(ln.state.pending) === 'check'
            ? 'Your node has it. Crossbill keeps checking, with the same request, and shows it at the top of the Lightning tab until there’s an answer.'
            : 'It shows at the top of the Lightning tab. Asking your node again uses the same request, so it is never paid twice; if your node never got it, asking again pays it then.'}
        </p>
        {err && <div className="banner error">{err}</div>}
        <button
          className="btn secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const r = await ln.resumePending();
              if (r) setNow(r);
            } catch (e) {
              setErr(lightningError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Asking' : ln.state.pending && ln.pendingCheck(ln.state.pending) === 'check' ? 'Check now' : 'Ask your node again'}
        </button>
        <div style={{ height: 12 }} />
        <button className="btn primary" onClick={onDone}>
          Done
        </button>
      </Screen>
    );
  }

  if (now.kind === 'sent') {
    return (
      <Screen title="Sent" back={false}>
        <p style={{ marginTop: 8 }}>Your node sent the transaction.</p>
        <div className="section-title">Transaction ID</div>
        <div className="txid">{now.txid}</div>
        <div style={{ height: 28 }} />
        <button className="btn primary" onClick={onDone}>
          Done
        </button>
      </Screen>
    );
  }

  const r = now.result;
  const bi = r.bitcoinInvoice;
  const own = fromOwnBridge(bi);
  return (
    <Screen title="Paid" back={false}>
      <div className="big-amount" style={{ marginTop: 20 }}>
        {bi ? (
          <>
            <span className="mono">{sats(bi.amountSat)}</span> <span style={{ fontFamily: 'var(--sans)', fontSize: '0.8em', color: 'var(--slate)' }}>sats of BTC</span>
          </>
        ) : (
          <Amount sats={r.amountSat} unit={unit} />
        )}
      </div>
      <p>{t.description ? `For ${t.description}. ` : ''}{own ? 'Paid from your bridge’s SHA256 node. No XBT was spent.' : bi ? 'Paid on the SHA256 chain through your bridge service.' : 'Paid through your Lightning node.'}</p>
      <dl className="facts">
        {bi && !own && (
          <div>
            <dt>Cost</dt>
            <dd>
              <Xbt n={r.amountSat + r.feeSat} />
            </dd>
          </div>
        )}
        {!bi && (
          <div>
            <dt>Routing fee</dt>
            <dd>
              <Amount sats={r.feeSat} unit={unit} />
            </dd>
          </div>
        )}
        {own && bi?.sha256FeeSat != null && (
          <div>
            <dt>Routing, in BTC</dt>
            <dd className="mono">{sats(bi.sha256FeeSat)} sats</dd>
          </div>
        )}
      </dl>
      {r.preimage && (
        <>
          <div className="section-title">Proof of payment</div>
          <div className="txid">{r.preimage}</div>
        </>
      )}
      <div style={{ height: 28 }} />
      <button className="btn primary" onClick={onDone}>
        Done
      </button>
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------- receiving

type ReceiveKind = 'invoice' | 'offer' | 'address';

export function LightningReceive() {
  const [kind, setKind] = useState<ReceiveKind>('invoice');
  return (
    <Screen title="Receive">
      <div className="segmented" role="group" aria-label="How to be paid" style={{ marginBottom: 18 }}>
        {(
          [
            ['invoice', 'Invoice'],
            ['offer', 'Offer'],
            ['address', 'On chain'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {label}
          </button>
        ))}
      </div>
      {kind === 'invoice' && <ReceiveInvoice />}
      {kind === 'offer' && <ReceiveOffer />}
      {kind === 'address' && <ReceiveAddress />}
    </Screen>
  );
}

function ShareRow({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: '14px 0 18px' }}>
      <button className="btn secondary" onClick={async () => setCopied(await copyText(text))}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <button
        className="btn secondary"
        onClick={async () => {
          if (isNative) await Share.share({ text });
          else setCopied(await copyText(text));
        }}
      >
        Share
      </button>
    </div>
  );
}

function ReceiveInvoice() {
  const app = useApp();
  const ln = app.lightning;
  const unit = app.settings.unit;
  const [amountText, setAmountText] = useState('');
  const [memo, setMemo] = useState('');
  const [inv, setInv] = useState<LfInvoice | null>(null);
  const [state, setState] = useState<'open' | 'settled' | 'expired' | 'canceled' | 'accepted'>('open');
  const [paid, setPaid] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount = amountText.trim() ? parseAmount(amountText, unit) : null;

  useEffect(() => {
    if (!inv || state !== 'open') return;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const s = await ln.invoiceStatus(inv.paymentHash);
        if (!alive) return;
        if (s.state !== 'open') {
          setState(s.state);
          setPaid(s.amountPaidSat);
          if (s.state === 'settled') void ln.refresh();
        }
      } catch {
        // asked again on the next tick
      }
    }, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ln, inv, state]);

  if (inv && state === 'settled') {
    return (
      <>
        <div className="big-amount" style={{ marginTop: 10 }}>
          <Amount sats={paid} unit={unit} />
        </div>
        <p>Received{inv.memo ? ` for ${inv.memo}` : ''}. It’s in your node’s channels.</p>
        <button
          className="btn secondary"
          onClick={() => {
            setInv(null);
            setState('open');
            setAmountText('');
            setMemo('');
          }}
        >
          Make another invoice
        </button>
      </>
    );
  }

  if (inv) {
    const gone = state !== 'open' && state !== 'accepted';
    return (
      <>
        <Qr text={`lightning:${inv.paymentRequest}`.toUpperCase()} />
        <p className="note" style={{ textAlign: 'center' }}>
          {gone ? 'This invoice expired before it was paid.' : `${inv.amountSat != null ? `${formatAmount(inv.amountSat, unit)} ${unitLabel(unit)}` : 'Any amount'}${inv.memo ? `, ${inv.memo}` : ''}. Waiting for the payment.`}
        </p>
        {!gone && <ShareRow text={inv.paymentRequest} />}
        <button
          className="btn quiet"
          onClick={() => {
            setInv(null);
            setState('open');
          }}
        >
          {gone ? 'Make a new invoice' : 'Change the amount'}
        </button>
        <p className="note">This invoice is for the Bitcoin BLAKE2b chain. A Lightning wallet on the SHA256 chain refuses it.</p>
      </>
    );
  }

  return (
    <>
      <Field label={`Amount in ${unitLabel(unit)}`} htmlFor="lnr-amt" hint="Leave it empty to let the payer choose." error={amountText.trim() && amount == null ? 'Enter an amount' : null}>
        <input id="lnr-amt" className="input mono" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="Any amount" />
      </Field>
      <Field label="What it’s for" htmlFor="lnr-memo" hint="Shown to the payer.">
        <input id="lnr-memo" className="input" value={memo} maxLength={120} onChange={(e) => setMemo(e.target.value)} />
      </Field>
      {error && <div className="banner error">{error}</div>}
      <button
        className="btn primary"
        disabled={busy || (amountText.trim() !== '' && amount == null)}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setInv(await ln.createInvoice({ amountSat: amount ?? undefined, memo: memo.trim() || undefined }));
            setState('open');
          } catch (e) {
            setError(lightningError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Asking your node' : 'Make an invoice'}
      </button>
    </>
  );
}

function ReceiveOffer() {
  const app = useApp();
  const ln = app.lightning;
  const [desc, setDesc] = useState('');
  const [offer, setOffer] = useState<{ offer: string; uri: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (offer) {
    return (
      <>
        <Qr text={offer.uri} />
        <p className="note" style={{ textAlign: 'center' }}>
          An offer can be paid many times, by anyone who has it.
        </p>
        <ShareRow text={offer.offer} />
        <button className="btn quiet" onClick={() => setOffer(null)}>
          Make a different offer
        </button>
      </>
    );
  }
  return (
    <>
      <p className="note" style={{ marginTop: 0 }}>
        An offer (BOLT 12) is a reusable code: a payer’s wallet asks your node for a fresh invoice each time.
      </p>
      <Field label="What it’s for" htmlFor="lno-desc" hint="Optional. Shown to the payer.">
        <input id="lno-desc" className="input" value={desc} maxLength={120} onChange={(e) => setDesc(e.target.value)} />
      </Field>
      {error && <div className="banner error">{error}</div>}
      <button
        className="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setOffer(await ln.createOffer({ description: desc.trim() || undefined }));
          } catch (e) {
            setError(lightningError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Asking your node' : 'Make an offer'}
      </button>
    </>
  );
}

function ReceiveAddress() {
  const app = useApp();
  const ln = app.lightning;
  const [a, setA] = useState<{ address: string; uri: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async (fresh: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setA(await ln.receiveAddress(fresh));
    } catch (e) {
      setError(lightningError(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      {a ? (
        <>
          <Qr text={/^(bc|tb|bcrt)1/i.test(a.address) ? `bitcoin:${a.address.toUpperCase()}` : a.uri} />
          <div style={{ textAlign: 'center', marginBottom: 6 }}>
            <Address value={a.address} size="lg" />
          </div>
          <p className="note" style={{ textAlign: 'center', marginTop: 0 }}>
            Your Lightning node’s on-chain wallet, for opening channels. Not one of this iPhone’s wallets.
          </p>
          <ShareRow text={a.address} />
        </>
      ) : (
        !error && <p className="note">{busy ? 'Asking your node for an address.' : ''}</p>
      )}
      {error && <div className="banner error">{error}</div>}
      <button className="btn quiet" disabled={busy} onClick={() => void load(true)}>
        Use a new address
      </button>
    </>
  );
}
