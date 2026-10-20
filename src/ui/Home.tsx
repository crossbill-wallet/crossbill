import { useEffect, useRef, useState } from 'react';
import { isOptedIn } from '../core/replay';
import { formatAmount, unitLabel } from '../core/units';
import { formatPrice, formatUsd } from '../core/price';
import { SKINS } from '../app/look';
import type { WalletRuntime } from '../app/model';
import { Address, Amount, Chevron, Sheet, Snowflake, shortAddress, timeAgo, useApp, useNav, Field } from './kit';

type Tab = 'activity' | 'coins' | 'addresses';

/** The list last looked at, so coming back from a transaction or a send lands on the same one. */
let lastTab: Tab = 'activity';

export function Home() {
  const app = useApp();
  const nav = useNav();
  const w = app.active!;
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (t: Tab) => {
    lastTab = t;
    setTabState(t);
  };
  const [switcher, setSwitcher] = useState(false);
  const snap = w.snapshot;
  const unit = app.settings.unit;
  const on = isOptedIn(app.replayDecision());
  const usd = app.settings.balanceView === 'usd' && app.settings.prices;
  const ticker = app.price.ticker;

  // The dollar figure keeps to a price under a minute old while it's showing
  useEffect(() => {
    if (!usd) return;
    void app.loadPrice();
    const t = setInterval(() => void app.loadPrice(), 60_000);
    return () => clearInterval(t);
  }, [usd, app]);

  const bal = snap?.balance ?? { confirmed: 0, unconfirmed: 0, immature: 0 };
  const sub: string[] = [];
  if (usd) {
    if (ticker) sub.push(`At ${formatPrice(ticker.last)} per XBT${app.settings.network !== 'mainnet' ? ', the mainnet price' : ''}`);
    else sub.push(app.price.error ? 'Price unavailable. Tap to show coins' : 'Getting the XBT price');
    if (ticker && bal.unconfirmed) sub.push(`${bal.unconfirmed > 0 ? '+' : '-'}${formatUsd(Math.abs(bal.unconfirmed), ticker.last)} unconfirmed`);
  } else {
    if (bal.unconfirmed) sub.push(`${formatAmount(bal.unconfirmed, unit, { sign: true })} ${unitLabel(unit)} unconfirmed`);
    if (bal.immature) sub.push(`${formatAmount(bal.immature, unit)} ${unitLabel(unit)} still maturing`);
  }
  const fresh = app.newSkin ? SKINS.find((s) => s.id === app.newSkin) : undefined;

  return (
    <div className="screen">
      <section className="band">
        <div className="top">
          <button className="wallet-name" onClick={() => setSwitcher(true)} aria-haspopup="dialog">
            <span className="name">{w.config.name}</span>
            <Chevron dir="down" />
          </button>
          <BlockHeight />
        </div>
        <StatusBanner />
        <button
          className={`balance${usd ? ' usd' : ''}`}
          onClick={() => app.settings.prices && void app.updateSettings({ balanceView: usd ? 'coin' : 'usd' })}
          aria-label={usd ? 'Balance in US dollars. Tap to show it in coins' : `Balance in ${unitLabel(unit)}${app.settings.prices ? '. Tap to show it in US dollars' : ''}`}
        >
          {usd ? (ticker ? formatUsd(bal.confirmed, ticker.last) : '$ ...') : formatAmount(bal.confirmed, unit)}
          <small>{usd ? 'USD' : unitLabel(unit)}</small>
        </button>
        <div className="sub">{sub.join(', ') || (snap ? ' ' : 'Not synced yet')}</div>
        <div className="sub replay-line">
          <span className={`glint ${app.node ? (on ? 'on' : 'warn') : ''}`} />
          <span className="clip">{app.node ? (on ? 'Sends are replay protected' : 'Sends are not replay protected') : 'Replay status shows once connected'}</span>
        </div>
        <div className="actions">
          <button onClick={() => nav.push({ name: 'receive' })}>Receive</button>
          <button onClick={() => nav.push({ name: 'send' })}>Send</button>
        </div>
      </section>

      {fresh && (
        <div className="unlock-banner" data-skin={fresh.id}>
          <span className="swatch" aria-hidden />
          <span className="text">
            <strong>{fresh.name} skin opened.</strong> Try it in Settings, Appearance.
          </span>
          <button
            className="btn small secondary"
            onClick={() => {
              app.dismissNewSkin();
              nav.push({ name: 'appearance' });
            }}
          >
            Look
          </button>
          <button className="close" aria-label="Dismiss" onClick={() => app.dismissNewSkin()}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path d="M2 2l10 10M12 2 2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      <nav className="tabs" role="tablist">
        {(['activity', 'coins', 'addresses'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'activity' ? 'Activity' : t === 'coins' ? 'Coins' : 'Addresses'}
          </button>
        ))}
      </nav>

      {app.node && app.sendBlocker() && (
        <div style={{ padding: '14px var(--pad) 0' }}>
          <div className="banner">{app.sendBlocker()}</div>
        </div>
      )}

      {tab === 'activity' && <Activity w={w} />}
      {tab === 'coins' && <Coins w={w} />}
      {tab === 'addresses' && <Addresses w={w} />}

      {switcher && (
        <Sheet title="Wallets" onClose={() => setSwitcher(false)}>
          {app.networkWallets().map((x) => (
            <button
              key={x.config.id}
              className="choice"
              role="radio"
              aria-checked={x.config.id === w.config.id}
              onClick={() => {
                app.selectWallet(x.config.id);
                setSwitcher(false);
              }}
            >
              <span className="dot" />
              <span>
                <span className="what">{x.config.name}</span>
                <div className="why">
                  <Amount sats={(x.snapshot?.balance.confirmed ?? 0) + (x.snapshot?.balance.unconfirmed ?? 0)} unit={unit} />
                </div>
              </span>
            </button>
          ))}
          <button
            className="btn secondary"
            style={{ width: '100%', marginTop: 6 }}
            onClick={() => {
              setSwitcher(false);
              nav.push({ name: 'add-wallet' });
            }}
          >
            Add a wallet
          </button>
        </Sheet>
      )}
    </div>
  );
}

/** The node's current block, and nothing else. Tapping it checks for new blocks now. */
function BlockHeight() {
  const app = useApp();
  const h = app.node?.blocks;
  return (
    <button className="blockh" onClick={() => void app.refresh()} aria-label={h != null ? `Block ${h.toLocaleString('en-US')}. Check for new blocks` : 'Check for new blocks'}>
      {h != null ? `Block ${h.toLocaleString('en-US')}` : ''}
    </button>
  );
}

type Status = { kind: 'busy' | 'error'; message: string; progress?: number };

function statusOf(app: ReturnType<typeof useApp>): Status | null {
  const c = app.conn;
  if (c.phase === 'error') return { kind: 'error', message: c.message ?? 'Can’t reach your node' };
  if (c.phase === 'tor' || c.phase === 'connecting' || c.phase === 'syncing' || c.phase === 'importing') {
    return { kind: 'busy', message: c.message ?? 'Connecting', progress: c.progress };
  }
  return null;
}

/**
 * Connection and sync progress, in a slot of fixed height under the wallet name, so nothing below it moves.
 * Routine work that finishes within a moment never shows, and once shown the banner stays long enough to read.
 */
function StatusBanner() {
  const app = useApp();
  const raw = statusOf(app);
  const key = raw ? `${raw.kind}|${raw.message}|${raw.progress ?? ''}` : '';
  const [shown, setShown] = useState<Status | null>(null);
  const [visible, setVisible] = useState(false);
  const [details, setDetails] = useState(false);
  const shownAt = useRef(0);
  // When the current stretch of work began, so progress updates don't keep pushing the banner back
  const busySince = useRef<number | null>(null);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      if (!visible) shownAt.current = Date.now();
      setShown(raw);
      setVisible(true);
    };
    if (raw) {
      if (busySince.current == null) busySince.current = Date.now();
      const wait = raw.kind === 'error' || visible ? 0 : Math.max(0, 700 - (Date.now() - busySince.current));
      if (wait === 0) show();
      else t = setTimeout(show, wait);
    } else {
      busySince.current = null;
      if (visible) t = setTimeout(() => setVisible(false), Math.max(0, 900 - (Date.now() - shownAt.current)));
    }
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const s = shown;
  return (
    <div className="status-slot" role="status" aria-live="polite">
      {s && (
        <button
          className={`status ${s.kind}${visible ? ' on' : ''}`}
          tabIndex={visible ? 0 : -1}
          aria-hidden={!visible}
          onClick={() => (s.kind === 'error' ? setDetails(true) : undefined)}
        >
          {s.kind === 'error' ? <span className="mark" /> : <span className="spinner" />}
          <span className="msg">{s.kind === 'error' ? 'Can’t reach your node' : s.message}</span>
          {s.kind === 'error' ? <span className="aside">Details</span> : s.progress != null ? <span className="aside">{s.progress}%</span> : null}
          {s.kind === 'busy' && s.progress != null && (
            <span className="bar">
              <span style={{ width: `${s.progress}%` }} />
            </span>
          )}
        </button>
      )}
      {details && s?.kind === 'error' && (
        <Sheet title="Can’t reach your node" onClose={() => setDetails(false)}>
          <p style={{ marginTop: 0, overflowWrap: 'anywhere' }}>{app.conn.phase === 'error' ? app.conn.message : s.message}</p>
          <p className="note">Your balance and history are from the last time the app reached your node. Sending waits until it answers again.</p>
          <button
            className="btn primary"
            onClick={() => {
              setDetails(false);
              void app.connect();
            }}
          >
            Try again
          </button>
        </Sheet>
      )}
    </div>
  );
}

function Activity({ w }: { w: WalletRuntime }) {
  const app = useApp();
  const nav = useNav();
  const txs = w.snapshot?.txs ?? [];
  if (!txs.length) {
    return (
      <div className="empty">
        <strong>No transactions yet</strong>
        {w.snapshot ? 'Receive to an address of this wallet and it shows up here once your node sees it.' : 'Connecting to your node to read this wallet’s history.'}
      </div>
    );
  }
  return (
    <ul className="list">
      {txs.map((t) => {
        const label = app.txLabel(w, t);
        const status = t.confirmations === 0 ? 'Unconfirmed' : t.confirmations < 6 ? `${t.confirmations} confirmation${t.confirmations > 1 ? 's' : ''}` : timeAgo(t.time);
        return (
          <li key={t.txid}>
            <button className="row" onClick={() => nav.push({ name: 'tx', txid: t.txid })}>
              <div className="main">
                <div className="title">{label ?? (t.coinbase ? 'Mined' : t.net >= 0 ? 'Received' : 'Sent')}</div>
                <div className="meta">
                  {status}
                  {t.confirmations === 0 && t.replaceable && t.allInputsMine && !t.outputs.some((o) => o.spentBy) ? ', fee can be raised' : ''}
                </div>
              </div>
              <div className={`amt ${t.net < 0 ? 'out' : ''}`}>{formatAmount(t.net, app.settings.unit, { sign: true })}</div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Coins({ w }: { w: WalletRuntime }) {
  const app = useApp();
  const nav = useNav();
  const [open, setOpen] = useState<string | null>(null);
  const coins = app.coins(w).sort((a, b) => b.value - a.value);
  const activation = app.net.blake2bHeight;
  if (!coins.length) {
    return (
      <div className="empty">
        <strong>No coins</strong>
        Coins this wallet can spend are listed here, one per output.
      </div>
    );
  }
  const sel = coins.find((c) => `${c.txid}:${c.vout}` === open);
  return (
    <>
      <ul className="list">
        {coins.map((c) => {
          const preFork = activation != null && c.height != null && c.height < activation;
          return (
            <li key={`${c.txid}:${c.vout}`}>
              <button className={`row${c.frozen ? ' frozen' : ''}`} onClick={() => setOpen(`${c.txid}:${c.vout}`)}>
                <div className="main">
                  <div className="title with-pills">
                    <span className="clip">{c.label ?? shortAddress(c.address)}</span>
                    {c.frozen && (
                      <span className="pill ice">
                        <Snowflake /> Frozen
                      </span>
                    )}
                    {c.immature && <span className="pill">Maturing</span>}
                    {preFork && <span className="pill ember">Pre-fork</span>}
                  </div>
                  <div className="meta">{c.height == null ? 'Unconfirmed' : `${c.confirmations.toLocaleString('en-US')} confirmation${c.confirmations === 1 ? '' : 's'}`}</div>
                </div>
                <div className="amt">{formatAmount(c.value, app.settings.unit)}</div>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="note" style={{ padding: '14px var(--pad)' }}>
        Pre-fork coins also exist on the SHA256d chain until you spend them with a replay-protected signature. Sending them to yourself separates them.
      </p>
      {sel && <CoinSheet w={w} coin={sel} onClose={() => setOpen(null)} onSpend={() => nav.push({ name: 'send', coins: [`${sel.txid}:${sel.vout}`] })} />}
    </>
  );
}

function CoinSheet({ w, coin, onClose, onSpend }: { w: WalletRuntime; coin: ReturnType<ReturnType<typeof useApp>['coins']>[number]; onClose: () => void; onSpend: () => void }) {
  const app = useApp();
  const nav = useNav();
  const ref = `${coin.txid}:${coin.vout}`;
  const [label, setLabel] = useState(w.labels.get('output', ref) ?? '');
  return (
    <Sheet title="Coin" onClose={onClose}>
      <div className="big-amount">
        <Amount sats={coin.value} unit={app.settings.unit} />
      </div>
      {coin.frozen && (
        <div className="ice-note">
          <Snowflake size={16} /> Frozen. Sends leave this coin alone until you unfreeze it.
        </div>
      )}
      <div style={{ margin: '10px 0 16px' }}>
        <Address value={coin.address} size="sm" />
      </div>
      <Field label="Label" htmlFor="coin-label">
        <input id="coin-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => void app.setLabel(w, 'output', ref, label)} placeholder="What this coin is" />
      </Field>
      <div style={{ display: 'grid', gap: 10 }}>
        <button className="btn primary" disabled={coin.frozen || coin.immature} onClick={onSpend}>
          Spend this coin
        </button>
        <button className="btn secondary" onClick={() => void app.setFrozen(w, coin.txid, coin.vout, !coin.frozen)}>
          {coin.frozen ? 'Unfreeze' : 'Freeze so it is never spent'}
        </button>
        <button
          className="btn quiet"
          onClick={() => {
            onClose();
            nav.push({ name: 'tx', txid: coin.txid });
          }}
        >
          View the transaction that created it
        </button>
      </div>
    </Sheet>
  );
}

function Addresses({ w }: { w: WalletRuntime }) {
  const app = useApp();
  const [chain, setChain] = useState<0 | 1>(0);
  const [open, setOpen] = useState<number | null>(null);
  const used = w.snapshot?.highestUsed[chain] ?? -1;
  const count = used + 1 + (chain === 0 ? w.config.gapLimit : 1);
  const received = new Map<string, number>();
  for (const t of w.snapshot?.txs ?? []) for (const o of t.outputs) if (o.mine?.chain === chain && o.address) received.set(o.address, (received.get(o.address) ?? 0) + o.value);
  const rows = Array.from({ length: count }, (_, i) => i);
  const sel = open != null ? app.addressAt(w, chain, open) : null;
  return (
    <>
      <div style={{ padding: '14px var(--pad) 6px' }}>
        <div className="segmented" role="group" aria-label="Address list">
          <button aria-pressed={chain === 0} onClick={() => setChain(0)}>
            Receive
          </button>
          <button aria-pressed={chain === 1} onClick={() => setChain(1)}>
            Change
          </button>
        </div>
      </div>
      <ul className="list">
        {rows.map((i) => {
          const a = app.addressAt(w, chain, i);
          const got = received.get(a);
          const label = w.labels.get('addr', a);
          return (
            <li key={i}>
              <button className="row" onClick={() => setOpen(i)}>
                <div className="main">
                  <div className="title" style={{ fontFamily: 'var(--mono)', fontWeight: 400, fontSize: 'var(--t-sm)' }}>
                    {shortAddress(a)}
                  </div>
                  <div className="meta">
                    {chain === 0 ? 'm/0/' : 'm/1/'}
                    {i}
                    {label ? `, ${label}` : ''}
                    {got == null ? ', unused' : ''}
                  </div>
                </div>
                {got != null && <div className="amt">{formatAmount(got, app.settings.unit)}</div>}
              </button>
            </li>
          );
        })}
      </ul>
      {sel != null && open != null && <AddressSheet w={w} address={sel} path={`m/${chain}/${open}`} onClose={() => setOpen(null)} />}
    </>
  );
}

function AddressSheet({ w, address, path, onClose }: { w: WalletRuntime; address: string; path: string; onClose: () => void }) {
  const app = useApp();
  const [label, setLabel] = useState(w.labels.get('addr', address) ?? '');
  const [copied, setCopied] = useState(false);
  return (
    <Sheet title={path} onClose={onClose}>
      <div style={{ marginBottom: 16 }}>
        <Address value={address} />
      </div>
      <Field label="Label" htmlFor="addr-label">
        <input id="addr-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => void app.setLabel(w, 'addr', address, label)} placeholder="Who or what this address is for" />
      </Field>
      <button
        className="btn secondary"
        style={{ width: '100%' }}
        onClick={async () => {
          setCopied(await navigator.clipboard.writeText(address).then(() => true, () => false));
        }}
      >
        {copied ? 'Copied' : 'Copy address'}
      </button>
    </Sheet>
  );
}
