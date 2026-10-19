import { useEffect, useMemo, useState } from 'react';
import { BIP39_WORDS, newMnemonic, normalizeMnemonic } from '../core/keys';
import { NETWORKS, type NetworkName } from '../core/network';
import { SCRIPT_TYPE_INFO, SCRIPT_TYPES, type ScriptType } from '../core/script';
import type { NodeStatus } from '../core/sync';
import { friendlyError, type NodeSettings, type RescanChoice } from '../app/model';
import { isOptedIn } from '../core/replay';
import { nodeAddressFields } from '../core/rpc';
import { seedWordsFeedback, WORD_COUNTS } from '../core/seedwords';
import { Choice, Field, ReplayStatus, Screen, ScreenshotWarning, Toggle, useApp, useNav, useScreenshotAlert } from './kit';

export function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="welcome">
      <img src="./bird.png" alt="" />
      <h1>Shrike for iPhone</h1>
      <p>Your own Bitcoin Knots node, your own keys, and the BLAKE2b chain. Every send is checked for replay protection before you sign it.</p>
      <p>You’ll need your node’s RPC onion address, user and password, and your wallet’s seed words.</p>
      <div className="spacer" />
      <button className="btn primary" onClick={onStart}>
        Connect your node
      </button>
    </div>
  );
}

export function NodeForm({ onSaved, back = true }: { onSaved: () => void; back?: boolean }) {
  const app = useApp();
  const existing = app.settings.node;
  const [network, setNetwork] = useState<NetworkName>(app.settings.network);
  const [host, setHost] = useState(existing?.host ?? '');
  const [port, setPort] = useState(String(existing?.port ?? NETWORKS[app.settings.network].defaultRpcPort));
  const [user, setUser] = useState(existing?.user ?? '');
  const [password, setPassword] = useState('');
  const [useTor, setUseTor] = useState(existing?.useTor ?? true);
  const [tls, setTls] = useState(existing?.tls ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<NodeStatus | null>(null);

  const isOnion = host.trim().toLowerCase().endsWith('.onion');
  const node: NodeSettings = { host: host.trim(), port: Number(port), user: user.trim(), useTor: isOnion || useTor, tls };
  const valid = node.host && !node.host.includes('/') && Number.isInteger(node.port) && node.port > 0 && node.port < 65536 && node.user && password;

  // A pasted URL (https://abc…xyz.onion) fills in host, port and HTTPS. Plain typing is left alone until the field
  // loses focus, so "abc.onion:83" isn't cut off mid-port.
  const applyAddress = (value: string, final: boolean) => {
    if (!final && !value.includes('://')) {
      setHost(value);
      return;
    }
    const a = nodeAddressFields(value);
    setHost(a.host);
    if (a.port) setPort(String(a.port));
    if (a.tls !== undefined) setTls(a.tls);
  };

  return (
    <Screen title="Your node" back={back}>
      <p className="note" style={{ marginTop: 0 }}>
        On StartOS, open Bitcoin Knots, then Interfaces, then RPC, and copy the address in the Tor section. For the user and password, run <strong>Generate RPC User Credentials</strong> in Bitcoin Knots’ actions. A phone can’t read the
        node’s cookie file, so it needs a user of its own.
      </p>
      <div className="field">
        <span className="label">Network</span>
        <div className="segmented" role="group" aria-label="Network">
          {(['mainnet', 'testnet4', 'regtest'] as NetworkName[]).map((n) => (
            <button
              key={n}
              aria-pressed={network === n}
              onClick={() => {
                setNetwork(n);
                // An HTTPS address sits behind a proxy on 443, whatever the network
                if (!tls) setPort(String(NETWORKS[n].defaultRpcPort));
              }}
            >
              {n === 'mainnet' ? 'Mainnet' : n === 'testnet4' ? 'Testnet4' : 'Regtest'}
            </button>
          ))}
        </div>
      </div>
      <Field label="RPC address" htmlFor="host" hint="Paste the whole address, https:// included. It must be the RPC interface’s, not Peer’s or Fulcrum’s.">
        <input
          id="host"
          className="input mono"
          value={host}
          onChange={(e) => applyAddress(e.target.value, false)}
          onBlur={(e) => applyAddress(e.target.value, true)}
          placeholder="abcdef…xyz.onion"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </Field>
      <Field label="Port" htmlFor="port">
        <input id="port" className="input mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
      </Field>
      <Field label="RPC user" htmlFor="user">
        <input id="user" className="input" value={user} onChange={(e) => setUser(e.target.value)} autoCapitalize="none" autoCorrect="off" />
      </Field>
      <Field label="RPC password" htmlFor="pw" hint="Kept in the iPhone Keychain on this device only.">
        <input id="pw" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={existing ? 'Enter it again to change settings' : ''} />
      </Field>
      <Toggle
        label="Use HTTPS"
        detail="On for StartOS, which serves RPC over HTTPS (port 443 on its onion address). Off for a plain bitcoind RPC port such as 8332."
        checked={tls}
        onChange={(v) => {
          setTls(v);
          if (v && port === String(NETWORKS[network].defaultRpcPort)) setPort('443');
          if (!v && port === '443') setPort(String(NETWORKS[network].defaultRpcPort));
        }}
      />
      <Toggle label="Connect through Tor" detail={isOnion ? 'Always on for .onion addresses' : 'Leave on unless the node is on your own network or VPN'} checked={isOnion || useTor} onChange={setUseTor} />
      <div style={{ height: 18 }} />

      {status && (
        <>
          <div className="banner">
            Connected to {status.subversion.replace(/^\/|\/$/g, '')} at block {status.blocks.toLocaleString('en-US')}
            {status.initialBlockDownload ? ', still syncing the chain' : ''}.
          </div>
          <ReplayStatus decision={status.replayDecision} compact={isOptedIn(status.replayDecision)} />
        </>
      )}
      {error && <div className="banner error">{error}</div>}
      {busy && app.conn.message && <p className="note">{app.conn.message}{app.conn.progress != null ? ` (${app.conn.progress}%)` : ''}</p>}

      {!status ? (
        <button
          className="btn primary"
          disabled={!valid || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setStatus(await app.testNode(node, password, network));
            } catch (e) {
              setError(friendlyError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Connecting' : 'Connect'}
        </button>
      ) : (
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await app.saveNode(node, password, network);
              onSaved();
            } catch (e) {
              setError(friendlyError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Save and continue
        </button>
      )}
    </Screen>
  );
}

type Step = 'choose' | 'words' | 'new' | 'verify' | 'pass' | 'type';

export function AddWallet({ back = true, onDone, seedFrom }: { back?: boolean; onDone?: () => void; seedFrom?: string }) {
  const app = useApp();
  const nav = useNav();
  // Opening another wallet's seed words with a passphrase. The words come from the Keychain, behind Face ID
  const source = seedFrom ? app.wallets.find((x) => x.config.id === seedFrom) : undefined;
  const [step, setStep] = useState<Step>(source ? 'pass' : 'choose');
  const [mode, setMode] = useState<'restore' | 'create'>('restore');
  const [count, setCount] = useState<number>(24);
  const [words, setWords] = useState('');
  const [settled, setSettled] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [generated, setGenerated] = useState<string>('');
  const [fromSeed, setFromSeed] = useState('');
  const [checks, setChecks] = useState<{ pos: number; value: string }[]>([]);
  const [found, setFound] = useState<ScriptType[] | null>(null);
  const [scriptType, setScriptType] = useState<ScriptType>(source?.config.scriptType ?? 'P2WPKH');
  const [rescan, setRescan] = useState<RescanChoice>({ kind: 'date' });
  const [since, setSince] = useState('');
  const [name, setName] = useState(source ? `${source.config.name} (passphrase)` : app.wallets.length ? `Wallet ${app.wallets.length + 1}` : 'My wallet');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shot = useScreenshotAlert(step === 'words' || step === 'new' || step === 'verify');

  // The last word counts as finished after a pause, so a pasted seed is judged without needing a trailing space
  useEffect(() => {
    setSettled(false);
    const t = setTimeout(() => setSettled(true), 1200);
    return () => clearTimeout(t);
  }, [words]);

  const mnemonic = mode === 'create' ? generated : source ? fromSeed : normalizeMnemonic(words);
  const effectivePassphrase = source ? passphrase : usePassphrase ? passphrase : '';
  const wordList = normalizeMnemonic(words).split(' ').filter(Boolean);
  const last = words.endsWith(' ') ? '' : (wordList[wordList.length - 1] ?? '');
  const suggestions = useMemo(() => (last.length >= 2 ? BIP39_WORDS.filter((w) => w.startsWith(last)).slice(0, 6) : []), [last]);
  const feedback = seedWordsFeedback(words, count, settled);
  const wordsValid = feedback.valid;

  const done = onDone ?? (() => nav.reset());

  const toType = async () => {
    setBusy(true);
    setError(null);
    try {
      const f = await app.findOnNode(mnemonic, effectivePassphrase);
      setFound(f);
      if (f.length) {
        setScriptType(f[0]);
        setRescan({ kind: 'existing' });
      } else {
        setRescan(mode === 'create' ? { kind: 'new' } : { kind: 'date' });
      }
      setStep('type');
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  if (step === 'choose') {
    return (
      <Screen title="Add a wallet" back={back}>
        <Choice checked={mode === 'restore'} onSelect={() => setMode('restore')} title="Use my seed words" detail="The wallet you already have in Shrike on your computer, or any BIP39 seed." />
        <Choice checked={mode === 'create'} onSelect={() => setMode('create')} title="Create a new wallet" detail="New 24 seed words, made on this phone." />
        <div style={{ height: 12 }} />
        <button
          className="btn primary"
          onClick={() => {
            if (mode === 'create') {
              setGenerated(newMnemonic(24));
              setStep('new');
            } else setStep('words');
          }}
        >
          Continue
        </button>
      </Screen>
    );
  }

  if (step === 'pass' && source) {
    const match = passphrase === passphrase2;
    const allowEmpty = source.config.hasPassphrase;
    const ok = match && (passphrase.length > 0 || allowEmpty);
    return (
      <Screen title="Passphrase wallet" back={back}>
        <p style={{ marginTop: 0 }}>
          This opens the seed words of <strong>{source.config.name}</strong> with a passphrase you choose. Each passphrase gives its own wallet with its own addresses, so this one starts separate and{' '}
          {source.config.name} keeps its coins until you send them over.
        </p>
        <Field label="Passphrase" htmlFor="pp1" hint={allowEmpty ? 'Leave both empty to open the seed words with no passphrase.' : 'Any text. Capitals and spaces count.'}>
          <input id="pp1" className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" />
        </Field>
        <Field label="Type it again" htmlFor="pp2" error={passphrase2 && !match ? 'The two don’t match' : null}>
          <input id="pp2" className="input" type="password" value={passphrase2} onChange={(e) => setPassphrase2(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" />
        </Field>
        <div className="banner">Write the passphrase on the same paper as the seed words. Coins in this wallet can only be recovered with both, by anyone, including you.</div>
        {error && <div className="banner error">{error}</div>}
        <button
          className="btn primary"
          disabled={!ok || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const s = await app.revealSeed(source.config.id, 'Use the seed words with a passphrase');
              if (!s) throw new Error('The seed words for this wallet are no longer on this phone.');
              if (s.passphrase === passphrase) throw new Error(`That’s the passphrase ${source.config.name} already uses.`);
              setFromSeed(s.mnemonic);
              const f = await app.findOnNode(s.mnemonic, passphrase);
              setFound(f);
              if (f.length) {
                setScriptType(f[0]);
                setRescan({ kind: 'existing' });
              } else {
                setRescan({ kind: 'new' });
              }
              setStep('type');
            } catch (e) {
              setError(friendlyError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Checking your node' : 'Continue'}
        </button>
      </Screen>
    );
  }

  if (step === 'words') {
    return (
      <Screen title="Seed words" back={false} end={<button onClick={() => setStep('choose')}>Cancel</button>}>
        {shot && <ScreenshotWarning />}
        <div className="field">
          <span className="label">Number of words</span>
          <div className="segmented" role="group" aria-label="Number of words">
            {WORD_COUNTS.map((n) => (
              <button key={n} aria-pressed={count === n} onClick={() => setCount(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <Field label="Seed words" htmlFor="words" error={feedback.error} hint={feedback.error ? undefined : feedback.hint}>
          <textarea id="words" className="input mono" rows={5} value={words} onChange={(e) => setWords(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" />
          {suggestions.length > 0 && (
            <div className="suggest">
              {suggestions.map((s) => (
                <button key={s} onClick={() => setWords([...wordList.slice(0, -1), s].join(' ') + ' ')}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </Field>
        <Toggle label="This seed has a passphrase" detail="The extra word some wallets call the 25th word." checked={usePassphrase} onChange={setUsePassphrase} />
        {usePassphrase && (
          <div style={{ marginTop: 14 }}>
            <Field label="Passphrase" htmlFor="pp" hint="Exactly as you set it. A different passphrase opens a different, empty wallet.">
              <input id="pp" className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoCapitalize="none" autoCorrect="off" />
            </Field>
          </div>
        )}
        <div style={{ height: 18 }} />
        {error && <div className="banner error">{error}</div>}
        <button className="btn primary" disabled={!wordsValid || busy} onClick={toType}>
          {busy ? 'Checking your node' : 'Continue'}
        </button>
      </Screen>
    );
  }

  if (step === 'new') {
    return (
      <Screen title="New seed words" back={false} end={<button onClick={() => setStep('choose')}>Cancel</button>}>
        {shot && <ScreenshotWarning />}
        <p style={{ marginTop: 0 }}>Write these 24 words on paper, in order. They are the only way to get this wallet back if you lose the phone.</p>
        <ol className="words">
          {generated.split(' ').map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ol>
        <button
          className="btn primary"
          onClick={() => {
            const pos = new Set<number>();
            while (pos.size < 3) pos.add(crypto.getRandomValues(new Uint32Array(1))[0] % 24);
            setChecks([...pos].sort((a, b) => a - b).map((p) => ({ pos: p, value: '' })));
            setStep('verify');
          }}
        >
          I’ve written them down
        </button>
      </Screen>
    );
  }

  if (step === 'verify') {
    const genWords = generated.split(' ');
    const ok = checks.every((c) => c.value.trim().toLowerCase() === genWords[c.pos]);
    return (
      <Screen title="Check your words" back={false} end={<button onClick={() => setStep('new')}>Back</button>}>
        {shot && <ScreenshotWarning />}
        <p style={{ marginTop: 0 }}>Type these words from your paper copy.</p>
        {checks.map((c, i) => (
          <Field key={c.pos} label={`Word ${c.pos + 1}`} htmlFor={`chk-${i}`}>
            <input
              id={`chk-${i}`}
              className="input mono"
              value={c.value}
              onChange={(e) => setChecks(checks.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
        ))}
        {error && <div className="banner error">{error}</div>}
        <button className="btn primary" disabled={!ok || busy} onClick={toType}>
          {busy ? 'Checking your node' : 'Continue'}
        </button>
      </Screen>
    );
  }

  // step === 'type'
  const types = found && found.length ? found : SCRIPT_TYPES;
  const sinceUnix = since ? Math.floor(new Date(since + 'T00:00:00Z').getTime() / 1000) - 86400 * 2 : NaN;
  const rescanReady = rescan.kind !== 'date' || Number.isFinite(sinceUnix);
  return (
    <Screen title="Wallet details" back={false} end={<button onClick={() => setStep(source ? 'pass' : mode === 'create' ? 'new' : 'words')}>Back</button>}>
      {found && found.length > 0 ? (
        <div className="banner">Your node already watches this wallet for Shrike on your computer, so its history is ready with no scan.</div>
      ) : null}
      <Field label="Name" htmlFor="name">
        <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="section-title">Address type</div>
      {types.map((t) => (
        <Choice key={t} checked={scriptType === t} onSelect={() => setScriptType(t)} title={SCRIPT_TYPE_INFO[t].label} detail={found?.includes(t) ? 'Found on your node' : t === 'P2WPKH' ? 'Shrike’s default' : undefined} />
      ))}
      {!(found && found.includes(scriptType)) && (
        <>
          <div className="section-title">History</div>
          {mode === 'create' ? (
            <p className="note">A new wallet has no history, so your node only watches from now on.</p>
          ) : (
            <>
              <Choice checked={rescan.kind === 'date'} onSelect={() => setRescan({ kind: 'date' })} title="Scan from a date" detail="Your node looks for payments from the day before this date onward." />
              {rescan.kind === 'date' && (
                <div className="field">
                  <input className="input" type="date" value={since} onChange={(e) => setSince(e.target.value)} aria-label="Date the wallet was created" />
                </div>
              )}
              <Choice checked={rescan.kind === 'full'} onSelect={() => setRescan({ kind: 'full' })} title="Scan the whole chain" detail="Finds everything, but can take hours on a small node." />
              <Choice checked={rescan.kind === 'new'} onSelect={() => setRescan({ kind: 'new' })} title="It has never been used" detail="No scan. Payments made before today won’t show." />
            </>
          )}
        </>
      )}
      {busy && app.conn.message && (
        <p className="note">
          {app.conn.message}
          {app.conn.progress != null ? ` (${app.conn.progress}%)` : ''}
        </p>
      )}
      {error && <div className="banner error">{error}</div>}
      <button
        className="btn primary"
        disabled={busy || !rescanReady || !name.trim()}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const choice: RescanChoice = found?.includes(scriptType) ? { kind: 'existing' } : mode === 'create' ? { kind: 'new' } : rescan.kind === 'date' ? { kind: 'date', since: sinceUnix } : rescan;
            await app.addWallet({ name, mnemonic, passphrase: effectivePassphrase, scriptType, rescan: choice });
            done();
          } catch (e) {
            setError(friendlyError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Adding' : 'Add wallet'}
      </button>
      <p className="note">The seed words go into the iPhone Keychain on this device, and Face ID is asked for each time you sign.</p>
    </Screen>
  );
}
