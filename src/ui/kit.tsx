import { createContext, Fragment, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { app, type AppModel } from '../app/model';
import { isNative, ShrikeNative } from '../app/native';
import { DECISION_TEXT, decisionSummary, isOptedIn, type ReplayDecision } from '../core/replay';
import { cleanCode, looksLikeRecoveryCode } from '../core/totp';
import { formatAmount, unitLabel, type Unit } from '../core/units';

// ------------------------------------------------------------------ app state

export function useApp(): AppModel {
  useSyncExternalStore(
    (cb) => app.subscribe(cb),
    () => app.version,
  );
  return app;
}

/**
 * True once a screenshot is taken while `active` (a screen showing seed words is up). iOS can't prevent the
 * screenshot, so the screen says what to do about it instead.
 */
export function useScreenshotAlert(active: boolean): boolean {
  const [taken, setTaken] = useState(false);
  useEffect(() => {
    if (!active || !isNative) return;
    let handle: { remove: () => Promise<void> } | undefined;
    let gone = false;
    void ShrikeNative.addListener('screenshot', () => setTaken(true)).then((h) => {
      if (gone) void h.remove();
      else handle = h;
    });
    return () => {
      gone = true;
      void handle?.remove();
    };
  }, [active]);
  return taken;
}

export function ScreenshotWarning() {
  return (
    <div className="banner error" role="alert">
      That screenshot holds your seed words, and anyone who sees it can take the coins. Delete it from Photos, then from Recently Deleted. Paper is the only safe copy.
    </div>
  );
}

// ------------------------------------------------------------------ navigation

/** The four screens on the tab bar. Everything else is pushed on top of one of them. */
export type TabName = 'home' | 'market' | 'contacts' | 'settings';

export type Route =
  | { name: 'home' }
  | { name: 'market' }
  | { name: 'contacts' }
  | { name: 'settings' }
  | { name: 'receive' }
  | { name: 'send'; address?: string; amount?: number; label?: string; coins?: string[] }
  | { name: 'tx'; txid: string }
  | { name: 'bump'; txid: string; cancel?: boolean }
  | { name: 'node' }
  | { name: 'add-wallet'; seedFrom?: string }
  | { name: 'wallet-info'; id: string }
  | { name: 'contact'; id?: string; address?: string; label?: string }
  | { name: 'two-factor' }
  | { name: 'appearance' }
  | { name: 'explorer' }
  | { name: 'replay' }
  | { name: 'donate' }
  | { name: 'widgets' };

interface Nav {
  stack: Route[];
  push: (r: Route) => void;
  pop: () => void;
  reset: (r?: Route) => void;
}

const NavContext = createContext<Nav | null>(null);

export function NavProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);
  const nav = useMemo<Nav>(
    () => ({
      stack,
      push: (r) => setStack((s) => [...s, r]),
      pop: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
      reset: (r) => setStack([r ?? { name: 'home' }]),
    }),
    [stack],
  );
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [stack.length]);
  return <NavContext.Provider value={nav}>{children}</NavContext.Provider>;
}

export function useNav(): Nav {
  const n = useContext(NavContext);
  if (!n) throw new Error('No navigation');
  return n;
}

// ------------------------------------------------------------------ frame

export function Bar({ title, back = true, end }: { title: string; back?: boolean; end?: ReactNode }) {
  const nav = useNav();
  return (
    <header className="bar">
      <div className="side">
        {back && (
          <button onClick={nav.pop} aria-label="Back">
            <Chevron /> Back
          </button>
        )}
      </div>
      <h1>{title}</h1>
      <div className="side end">{end}</div>
    </header>
  );
}

export function Screen({ title, back, end, children }: { title: string; back?: boolean; end?: ReactNode; children: ReactNode }) {
  return (
    <div className="screen">
      <Bar title={title} back={back} end={end} />
      <main className="body">{children}</main>
    </div>
  );
}

export function Chevron({ dir = 'left' }: { dir?: 'left' | 'down' | 'right' }) {
  const rot = dir === 'left' ? 0 : dir === 'down' ? -90 : 180;
  return (
    <svg width="11" height="18" viewBox="0 0 11 18" aria-hidden style={{ transform: `rotate(${rot}deg)`, verticalAlign: '-3px' }}>
      <path d="M9.5 1.5 2 9l7.5 7.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Eight even teeth on a 24 grid, drawn from geometry (tip radius 10.3, root 8.1) so it stays symmetric. */
const GEAR_PATH =
  'M9.84 4.19L10.12 1.87A10.3 10.3 0 0 1 13.88 1.87L14.16 4.19A8.1 8.1 0 0 1 15.99 4.95L17.83 3.51A10.3 10.3 0 0 1 20.49 6.17L19.05 8.01A8.1 8.1 0 0 1 19.81 9.84L22.13 10.12A10.3 10.3 0 0 1 22.13 13.88L19.81 14.16A8.1 8.1 0 0 1 19.05 15.99L20.49 17.83A10.3 10.3 0 0 1 17.83 20.49L15.99 19.05A8.1 8.1 0 0 1 14.16 19.81L13.88 22.13A10.3 10.3 0 0 1 10.12 22.13L9.84 19.81A8.1 8.1 0 0 1 8.01 19.05L6.17 20.49A10.3 10.3 0 0 1 3.51 17.83L4.95 15.99A8.1 8.1 0 0 1 4.19 14.16L1.87 13.88A10.3 10.3 0 0 1 1.87 10.12L4.19 9.84A8.1 8.1 0 0 1 4.95 8.01L3.51 6.17A10.3 10.3 0 0 1 6.17 3.51L8.01 4.95A8.1 8.1 0 0 1 9.84 4.19Z';

export function GearIcon({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" d={GEAR_PATH} />
      <circle cx="12" cy="12" r="3.3" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

const ICON = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function WalletIcon({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...ICON}>
      <path d="M5.5 7.2 15.6 4.1a1 1 0 0 1 1.27.75L17.3 7" />
      <rect x="3" y="7" width="18" height="13" rx="2.6" />
      <path d="M21 11.6h-4.2a1.9 1.9 0 0 0 0 3.8H21" />
      <circle cx="16.9" cy="13.5" r="0.4" fill="currentColor" />
    </svg>
  );
}

export function MarketIcon({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...ICON}>
      <path d="M3.5 20.5h17" />
      <path d="M4 16.2 8.6 11l3.6 3 7.6-8.4" />
      <path d="M15.3 5.6h4.5v4.5" />
    </svg>
  );
}

export function ContactsIcon({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...ICON}>
      <rect x="5" y="2.8" width="15" height="18.4" rx="2.4" />
      <path d="M3 7.5h3.4M3 12h3.4M3 16.5h3.4" />
      <circle cx="12.6" cy="10" r="2.7" />
      <path d="M8.6 17c.8-2 2.3-3 4-3s3.2 1 4 3" />
    </svg>
  );
}

const SNOWFLAKE_PATH =
  'M12 22L12 2M20.66 17L3.34 7M20.66 7L3.34 17M14.9 3.8L12 6.5L9.1 3.8M6.35 5.39L7.24 9.25L3.45 10.41M3.45 13.59L7.24 14.75L6.35 18.61M9.1 20.2L12 17.5L14.9 20.2M17.65 18.61L16.76 14.75L20.55 13.59M20.55 10.41L16.76 9.25L17.65 5.39';

export function Snowflake({ size = 12 }: { size?: number }) {
  return (
    <svg className="snowflake" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d={SNOWFLAKE_PATH} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const TABS: { name: TabName; label: string; icon: (p: { size?: number }) => ReactNode }[] = [
  { name: 'home', label: 'Wallet', icon: WalletIcon },
  { name: 'market', label: 'Market', icon: MarketIcon },
  { name: 'contacts', label: 'Contacts', icon: ContactsIcon },
  { name: 'settings', label: 'Settings', icon: GearIcon },
];

/**
 * The tab bar along the bottom of the four main screens. It stays put while the screen above it scrolls, and
 * gives way to screens pushed on top, such as Send, which have a Back button instead.
 */
export function TabBar() {
  const nav = useNav();
  const current = nav.stack[0].name;
  useEffect(() => {
    document.body.classList.add('has-tabbar');
    return () => document.body.classList.remove('has-tabbar');
  }, []);
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <button
          key={t.name}
          aria-current={current === t.name ? 'page' : undefined}
          onClick={() => {
            if (current === t.name) window.scrollTo({ top: 0, behavior: 'smooth' });
            else nav.reset({ name: t.name });
          }}
        >
          <t.icon size={25} />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

/** One row of a settings list: a title, a line under it, and what's on the right. */
export function Row({ title, meta, end, onClick }: { title: ReactNode; meta?: ReactNode; end?: ReactNode; onClick: () => void }) {
  return (
    <button className="row setting" onClick={onClick}>
      <div className="main">
        <div className="title">{title}</div>
        {meta && <div className="meta">{meta}</div>}
      </div>
      {end != null && <span className="note">{end}</span>}
      <span className="go" aria-hidden>
        <Chevron dir="right" />
      </span>
    </button>
  );
}

// ------------------------------------------------------------------ text

/** Addresses in groups of four, alternating tone, so they can be checked a group at a time. */
export function Address({ value, size }: { value: string; size?: 'sm' | 'lg' }) {
  const chunks = value.match(/.{1,4}/g) ?? [];
  return (
    <span className="addr" style={size === 'sm' ? { fontSize: 'var(--t-sm)' } : size === 'lg' ? { fontSize: 'var(--t-lg)' } : undefined}>
      {chunks.map((c, i) => (
        <Fragment key={i}>
          <span className="chunk">{c}</span>
          {i < chunks.length - 1 ? ' ' : ''}
        </Fragment>
      ))}
    </span>
  );
}

export function shortAddress(a: string): string {
  return a.length > 18 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

export function Amount({ sats, unit, sign }: { sats: number; unit: Unit; sign?: boolean }) {
  return (
    <span className="mono">
      {formatAmount(sats, unit, { sign })} <span style={{ fontFamily: 'var(--sans)', color: 'var(--slate)', fontSize: '0.8em' }}>{unitLabel(unit)}</span>
    </span>
  );
}

export function timeAgo(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// ------------------------------------------------------------------ replay status

export function EyeMark({ on }: { on: boolean }) {
  return on ? (
    <svg className="mark" viewBox="0 0 22 22" aria-hidden>
      <path d="M2 11 11 4l9 7-9 7z" fill="var(--eye)" />
      <path d="M7 11.2 10 14l5-6" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg className="mark" viewBox="0 0 22 22" aria-hidden>
      <path d="M11 2 21 20H1z" fill="var(--ember)" />
      <path d="M11 8v6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="11" cy="17" r="1.3" fill="#fff" />
    </svg>
  );
}

export function ReplayStatus({ decision, compact }: { decision: ReplayDecision; compact?: boolean }) {
  const on = isOptedIn(decision);
  const t = DECISION_TEXT[decision];
  return (
    <div className={`replay ${on ? 'on' : 'off'}`} role="status">
      <EyeMark on={on} />
      <div>
        <div className="state">{decisionSummary(decision)}</div>
        {!compact && (
          <div className="why">
            {on
              ? (t.caveat ?? 'This wallet signs with the unified signature hash, so what it sends can’t be replayed on the SHA256d chain.')
              : `${t.reason ?? ''} The signature is valid on both chains, so where these coins also exist on the SHA256d chain it can be replayed there.${t.remedy ? ` ${t.remedy}` : ''}`}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ inputs

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <div className="error">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

/** Whether what was typed has the shape of an authenticator code or a recovery code, so it's worth checking. */
export function codeReady(v: string): boolean {
  return /^\d{6}$/.test(cleanCode(v)) || looksLikeRecoveryCode(v);
}

/**
 * Where a two-factor code is typed: six digits from the authenticator, or a recovery code instead. iOS offers
 * a code from the Passwords app above the keyboard when that's where the authenticator lives.
 */
export function SecondFactorField({ value, onChange, id = 'otp', autoFocus }: { value: string; onChange: (v: string) => void; id?: string; autoFocus?: boolean }) {
  const app = useApp();
  const [recovery, setRecovery] = useState(false);
  const wait = app.twoFactorWait();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!wait) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [wait]);
  return (
    <div className="field">
      <label htmlFor={id}>{recovery ? 'Recovery code' : 'Code from your authenticator'}</label>
      <input
        id={id}
        className="input mono code-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={recovery ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        autoCapitalize={recovery ? 'characters' : 'none'}
        autoCorrect="off"
        spellCheck={false}
        maxLength={recovery ? 12 : 7}
        placeholder={recovery ? 'XXXXX-XXXXX' : '000000'}
        autoFocus={autoFocus}
      />
      <div className={wait ? 'error' : 'hint'}>
        {wait
          ? `Too many wrong codes. Try again in ${wait < 90 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.`
          : recovery
            ? 'Each recovery code works once.'
            : 'The 6 digits your authenticator shows for Shrike. They change every 30 seconds.'}
      </div>
      <button
        type="button"
        className="btn quiet"
        onClick={() => {
          setRecovery(!recovery);
          onChange('');
        }}
      >
        {recovery ? 'Use the authenticator instead' : 'Use a recovery code'}
      </button>
    </div>
  );
}

export function Choice({ checked, onSelect, title, detail }: { checked: boolean; onSelect: () => void; title: string; detail?: ReactNode }) {
  return (
    <button type="button" className="choice" role="radio" aria-checked={checked} onClick={onSelect}>
      <span className="dot" />
      <span>
        <span className="what">{title}</span>
        {detail && <div className="why">{detail}</div>}
      </span>
    </button>
  );
}

export function Toggle({ label, detail, checked, onChange }: { label: string; detail?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <span>
        <span style={{ fontWeight: 700 }}>{label}</span>
        {detail && <div className="why">{detail}</div>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="grip" />
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Qr({ text }: { text: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then((s) => alive && setSvg(s));
    return () => {
      alive = false;
    };
  }, [text]);
  return <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} aria-label="QR code" role="img" />;
}

/** Opens a link in Safari, outside the app's Tor connection. False if nothing opened it. */
export async function openLink(url: string): Promise<boolean> {
  const r = await ShrikeNative.openUrl({ url }).catch(() => ({ opened: false }));
  return r.opened;
}

/**
 * Copies a secret (a two-factor key, recovery codes) so it stays on this iPhone, never reaching the Mac or iPad
 * through Universal Clipboard, and clears itself after `seconds`.
 */
export async function copyPrivately(text: string, seconds = 60): Promise<boolean> {
  try {
    await ShrikeNative.copyPrivately({ text, seconds });
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Parses a bitcoin: URI (BIP21) or a bare address. */
export function parsePaymentText(raw: string): { address: string; amount?: number; label?: string } {
  const s = raw.trim();
  if (!/^bitcoin:/i.test(s)) return { address: s };
  const [head, query] = s.slice(8).split('?');
  const out: { address: string; amount?: number; label?: string } = { address: head };
  if (query) {
    const p = new URLSearchParams(query);
    const amt = p.get('amount');
    if (amt && /^\d+(\.\d{1,8})?$/.test(amt)) {
      const [w, f = ''] = amt.split('.');
      out.amount = Number(w) * 100_000_000 + Number(f.padEnd(8, '0'));
    }
    const label = p.get('label') ?? p.get('message');
    if (label) out.label = label;
  }
  return out;
}
