import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CHART_RANGES, formatCompact, formatPercent, formatPrice, formatUsd, type Candle } from '../core/price';
import { friendlyError } from '../app/model';
import { LINK_GROUPS } from '../app/links';
import { Chevron, openLink, useApp } from './kit';
import { isServer } from '../app/target';

/** Price history per range, kept for five minutes so flipping between ranges doesn't ask again. */
const chartCache = new Map<string, { at: number; candles: Candle[] }>();

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function Market() {
  const app = useApp();
  const t = app.price.ticker;
  const [, tick] = useState(0);

  useEffect(() => {
    if (!app.settings.prices) return;
    const unwatch = app.watchPrice();
    void app.loadPrice(true);
    // A quiet refresh each minute. After a failure the reconnect panel runs its own retries instead
    const poll = setInterval(() => {
      if (!app.price.problem) void app.loadPrice(true);
    }, 60_000);
    // Keeps "updated ... ago" honest between answers
    const clock = setInterval(() => tick((x) => x + 1), 15_000);
    return () => {
      unwatch();
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [app, app.settings.prices]);

  const held = app.totalConfirmed();
  const p = app.price;
  const stale = p.problem != null && !p.loading;

  return (
    <div className="screen">
      {/* The price and its chart in the skin's band, as the balance is on the Wallet tab */}
      <section className="band market-band">
        <div className="top">
          <span className="band-title">Market</span>
        </div>
        {!app.settings.prices ? (
          <div className="price-card">
            <p style={{ marginTop: 0 }}>Prices are off, so this app doesn’t contact Neoxa Exchange.</p>
            <button className="btn secondary" onClick={() => void app.updateSettings({ prices: true })}>
              Turn prices on
            </button>
          </div>
        ) : (
          <>
            <div className="price-card">
            <div className="pair">
              XBT <span>/ USDC</span>
            </div>
            <div className={`price${stale ? ' stale' : ''}${!t ? ' empty' : ''}`}>
              {t ? formatPrice(t.last) : p.problem && !p.loading ? 'No price yet' : <span className="price-skeleton" aria-label="Getting the price" />}
            </div>
            <div className="change">
              {t && t.changePercent != null ? (
                <>
                  <span className={`delta ${t.changePercent < 0 ? 'down' : 'up'}`}>
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                      <path d={t.changePercent < 0 ? 'M1 2.5h8L5 8.5z' : 'M1 7.5h8L5 1.5z'} fill="currentColor" />
                    </svg>
                    {formatPercent(t.changePercent)}
                  </span>{' '}
                  in 24 hours
                </>
              ) : (
                ' '
              )}
            </div>
            <div className="source">
              {stale && t
                ? `Last price from Neoxa Exchange, ${ago(p.at)}`
                : `Neoxa Exchange${p.viaTor ? ', through Tor' : app.settings.pricesOverTor && p.at ? ', without Tor this time' : app.settings.pricesOverTor ? ', through Tor' : ''}${p.at ? `, updated ${ago(p.at)}` : ''}`}
              {p.loading && !p.showSteps ? <span className="spinner small" aria-label="Updating" /> : null}
            </div>
            </div>
            <PriceChart />
          </>
        )}
      </section>
      <main className="body">
        {app.settings.prices && <PriceConnection />}
        {app.settings.prices && (
          <>
          {t && (
            <dl className="facts">
              <div>
                <dt>24-hour range</dt>
                <dd className="mono">{t.low24h != null && t.high24h != null ? `${formatPrice(t.low24h)} to ${formatPrice(t.high24h)}` : 'Not given'}</dd>
              </div>
              <div>
                <dt>24-hour volume</dt>
                <dd className="mono">
                  {formatCompact(t.volume24h)} XBT{t.quoteVolume24h != null ? `, ${formatCompact(t.quoteVolume24h)} USDC` : ''}
                </dd>
              </div>
              <div>
                <dt>Best bid and ask</dt>
                <dd className="mono">{t.bestBid != null && t.bestAsk != null ? `${formatPrice(t.bestBid)}, ${formatPrice(t.bestAsk)}` : 'Not given'}</dd>
              </div>
              {t.trades24h != null && (
                <div>
                  <dt>Trades in 24 hours</dt>
                  <dd className="mono">{t.trades24h.toLocaleString('en-US')}</dd>
                </div>
              )}
              <div>
                <dt>{app.settings.network === 'mainnet' ? `Your wallets on this ${isServer ? 'server' : 'phone'}` : 'Your test coins, at this price'}</dt>
                <dd className="mono">{formatUsd(held, t.last)}</dd>
              </div>
            </dl>
          )}
            <p className="note">One exchange’s last trade, shown for reference. Prices on a young market can move fast and differ between exchanges.</p>
          </>
        )}

        <Fold title="About XBT">
      <div className="prose">
        <p>
          XBT here is bitcoin on the BLAKE2b chain. At block 961,640, on 30 August 2026, nodes running Bitcoin Knots changed Bitcoin’s proof of work from SHA256d to BLAKE2b, so the miners still on
          SHA256d can’t add blocks to this chain. Neoxa Exchange lists the coin as XBT, and as BTCB2 in its data.
        </p>
        <p>From the fork until 1 September 2027 the chain also limits arbitrary data in transactions, and blocks are capped at about 300 kB.</p>
        <p>
          Coins held before the fork exist on both chains. A send signed with the unified signature hash, which this app uses on the BLAKE2b chain, is valid only there, so it can’t be replayed on
          the other chain. The Coins list marks pre-fork coins.
        </p>
      </div>

        </Fold>

      {LINK_GROUPS.map((g) => (
        <Fold key={g.title} title={g.title}>
          <ul className="list links">
            {g.links.map((l) => (
              <li key={l.url}>
                <button className="row" onClick={() => void openLink(l.url)}>
                  <div className="main">
                    <div className="title">{l.name}</div>
                    <div className="meta wrap">{l.detail}</div>
                  </div>
                  <span className="go" aria-hidden>
                    <Chevron dir="right" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Fold>
      ))}
        <p className="note">Links open in Safari, outside this app’s Tor connection.</p>
      </main>
    </div>
  );
}

/** A heading that opens and closes what's under it. Closed until tapped, so the page stays short. */
function Fold({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`fold${open ? ' open' : ''}`}>
      <button className="fold-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <Chevron dir={open ? 'down' : 'right'} />
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}

/**
 * How getting the price is going, step by step, while reconnecting and after a failure: each step ticks off,
 * spins, or shows what went wrong, and a failed load says what to do and tries again by itself.
 */
function PriceConnection() {
  const app = useApp();
  const p = app.price;
  const failed = !p.loading && p.problem != null;
  const autoRetry = failed && p.problem!.kind !== 'tor-stuck';
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [, setNow] = useState(0);

  // After a failure, try again by itself: 15 seconds, then 30, 60, and every two minutes
  useEffect(() => {
    if (!autoRetry) {
      setRetryAt(null);
      return;
    }
    const delay = Math.min(120, 15 * 2 ** Math.max(0, p.failures - 1)) * 1000;
    setRetryAt(Date.now() + delay);
    const t = setTimeout(() => void app.loadPrice(true, { show: true }), delay);
    return () => clearTimeout(t);
  }, [autoRetry, p.failures, app]);

  useEffect(() => {
    if (retryAt == null) return;
    const t = setInterval(() => setNow((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [retryAt]);

  if (!p.showSteps || !p.steps) return null;
  const done = !p.loading && !failed;
  const title = failed ? p.problem!.title : done ? 'Connected' : p.attempt > 1 ? `Trying again, ${p.attempt} of 3` : p.ticker ? 'Reconnecting' : 'Connecting';
  const left = retryAt != null ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : null;

  return (
    <div className={`conn-panel${failed ? ' failed' : ''}`} role="status" aria-live="polite">
      <div className="conn-head">
        {failed ? <StepMark status="failed" /> : done ? <StepMark status="done" /> : <span className="spinner" aria-hidden />}
        <strong>{title}</strong>
      </div>
      <ol className="conn-steps">
        {p.steps.map((s) => (
          <li key={s.id} className={s.status}>
            <StepMark status={s.status} />
            <span>
              <span className="label">{s.label}</span>
              {s.note && <span className="step-note">{s.note}</span>}
            </span>
          </li>
        ))}
      </ol>
      {failed && (
        <>
          <p className="conn-detail">{p.problem!.detail}</p>
          <div className="conn-actions">
            <button className="btn primary" onClick={() => void app.loadPrice(true, { show: true })}>
              Try again now
            </button>
            {p.problem!.canGoDirect && (
              <button className="btn secondary" onClick={() => void app.loadPrice(true, { show: true, direct: true })}>
                Get it once without Tor
              </button>
            )}
          </div>
          {left != null && <p className="conn-retry">Trying again by itself in {left < 60 ? `${left} s` : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}</p>}
          {p.problem!.canGoDirect && <p className="conn-note">Without Tor, the exchange sees this {isServer ? 'server’s' : 'iPhone’s'} IP address for that one request. It asks for the price only, never for anything about your wallets.</p>}
          {p.problem!.technical && (
            <details className="conn-tech">
              <summary>Technical details</summary>
              <span className="mono">{p.problem!.technical}</span>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function StepMark({ status }: { status: 'pending' | 'active' | 'done' | 'failed' }) {
  if (status === 'active') return <span className="step-mark spinner" aria-label="Working" />;
  return (
    <svg className={`step-mark ${status}`} width="20" height="20" viewBox="0 0 20 20" aria-label={status === 'done' ? 'Done' : status === 'failed' ? 'Failed' : 'Waiting'}>
      {status === 'done' && (
        <>
          <circle cx="10" cy="10" r="9" />
          <path d="M5.8 10.3 8.6 13l5.6-6" />
        </>
      )}
      {status === 'failed' && (
        <>
          <circle cx="10" cy="10" r="9" />
          <path d="M7 7l6 6M13 7l-6 6" />
        </>
      )}
      {status === 'pending' && <circle cx="10" cy="10" r="8" />}
    </svg>
  );
}

/** Closing prices over a chosen range, drawn as one line. Touch and drag to read a point. */
function PriceChart() {
  const app = useApp();
  const [range, setRange] = useState('1w');
  const r = CHART_RANGES.find((x) => x.id === range)!;
  const [candles, setCandles] = useState<Candle[] | null>(() => chartCache.get(range)?.candles ?? null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // A chart that failed or never loaded tries again whenever a new price arrives, since that means the
  // connection is back
  const retryKey = error != null || candles == null ? app.price.at : 0;

  useEffect(() => {
    let alive = true;
    const cached = chartCache.get(range);
    setHover(null);
    // The hour's chart is a minute at a time, so it's asked again after a minute; the others after five
    if (cached && Date.now() - cached.at < (r.interval === '1m' ? 60_000 : 300_000)) {
      setCandles(cached.candles);
      setError(null);
      return;
    }
    setCandles(cached?.candles ?? null);
    app
      .loadCandles(r.interval, r.limit)
      .then((c) => {
        chartCache.set(range, { at: Date.now(), candles: c });
        if (alive) {
          setCandles(c);
          setError(null);
        }
      })
      .catch((e) => alive && setError(friendlyError(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, r.interval, r.limit, app, retryKey]);

  const W = 320;
  const H = 150;
  const geo = useMemo(() => {
    if (!candles || candles.length < 2) return null;
    const closes = candles.map((c) => c.close);
    const lo = Math.min(...closes);
    const hi = Math.max(...closes);
    const pad = (hi - lo) * 0.08 || hi * 0.01 || 1;
    const y = (v: number) => H - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * H;
    const x = (i: number) => (i / (candles.length - 1)) * W;
    const pts = candles.map((c, i) => `${x(i).toFixed(1)},${y(c.close).toFixed(1)}`);
    return { lo, hi, x, y, line: `M${pts.join('L')}`, area: `M0,${H}L${pts.join('L')}L${W},${H}Z` };
  }, [candles]);

  const first = candles?.[0]?.close;
  const last = candles?.[candles.length - 1]?.close;
  const sel = hover != null && candles ? candles[hover] : null;
  const change = first && last ? ((last - first) / first) * 100 : null;

  const pick = (clientX: number) => {
    const el = svgRef.current;
    if (!el || !candles || candles.length < 2) return;
    const box = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    setHover(Math.round(f * (candles.length - 1)));
  };

  return (
    <div className="chart">
      <div className="chart-read">
        {sel ? (
          <>
            <span className="mono">{formatPrice(sel.close)}</span>{' '}
            <span className="note">{new Date(sel.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: r.interval === '1d' ? undefined : 'numeric', minute: r.interval === '1d' ? undefined : '2-digit' })}</span>
          </>
        ) : change != null && candles ? (
          <span className="note">
            {formatPercent(change)}{' '}
            {candles.length < r.limit * 0.9
              ? `since ${new Date(candles[0].time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, as far back as this market goes`
              : `over the last ${r.label === '1H' ? 'hour' : r.label === '1D' ? 'day' : r.label === '1W' ? 'week' : r.label === '1M' ? 'month' : 'year'}`}
          </span>
        ) : (
          <span className="note">{error ? ' ' : 'Loading price history'}</span>
        )}
      </div>
      <div className="chart-box">
        {geo ? (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`XBT price over ${r.label}, from ${formatPrice(first!)} to ${formatPrice(last!)}`}
            onPointerDown={(e) => pick(e.clientX)}
            onPointerMove={(e) => (e.buttons || e.pointerType === 'mouse' ? pick(e.clientX) : undefined)}
            onPointerLeave={() => setHover(null)}
            onPointerUp={(e) => (e.pointerType !== 'mouse' ? setHover(null) : undefined)}
          >
            <path d={geo.area} className="area" />
            <path d={geo.line} className="line" vectorEffect="non-scaling-stroke" />
            {hover != null && candles && (
              <>
                <line x1={geo.x(hover)} x2={geo.x(hover)} y1={0} y2={H} className="cursor" vectorEffect="non-scaling-stroke" />
                <circle cx={geo.x(hover)} cy={geo.y(candles[hover].close)} r={3.5} className="dot" />
              </>
            )}
          </svg>
        ) : (
          <div className="chart-empty">
            {error
              ? app.price.problem
                ? 'The chart comes back with the connection.'
                : 'Couldn’t load the price history.'
              : candles && candles.length < 2
                ? 'Not enough trades yet to draw this range'
                : ''}
          </div>
        )}
        {geo && (
          <>
            <span className="axis top mono">{formatPrice(geo.hi)}</span>
            <span className="axis bottom mono">{formatPrice(geo.lo)}</span>
          </>
        )}
      </div>
      <div className="segmented" role="group" aria-label="Chart range">
        {CHART_RANGES.map((x) => (
          <button key={x.id} aria-pressed={range === x.id} onClick={() => setRange(x.id)}>
            {x.label}
          </button>
        ))}
      </div>
    </div>
  );
}
