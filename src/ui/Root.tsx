import { useEffect, useState } from 'react';
import { StatusBar, Style } from '@capacitor/status-bar';
import { isNative } from '../app/native';
import { NavProvider, useApp, useNav, type Route } from './kit';
import { Home } from './Home';
import { Receive } from './Receive';
import { Send } from './Send';
import { Bump, TxDetail } from './Tx';
import { Settings, WalletInfo } from './Settings';
import { AddWallet, NodeForm, Welcome } from './Setup';

/** White status bar text over the black band (home, welcome, lock), and the system's choice elsewhere. */
function useStatusBar(onBlack: boolean) {
  useEffect(() => {
    if (!isNative) return;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    StatusBar.setStyle({ style: onBlack || dark ? Style.Dark : Style.Light }).catch(() => undefined);
  }, [onBlack]);
}

function Lock() {
  useStatusBar(true);
  const app = useApp();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void app.unlock().then((ok) => setFailed(!ok));
  }, [app]);
  return (
    <div className="lock">
      <img src="./bird.png" alt="" />
      <button className="btn primary" style={{ maxWidth: 320, background: '#fff', color: '#000' }} onClick={() => void app.unlock().then((ok) => setFailed(!ok))}>
        Open with Face ID
      </button>
      {failed && <p style={{ color: 'var(--on-mask-dim)' }}>Face ID didn’t confirm it’s you. Try again.</p>}
    </div>
  );
}

function Onboarding() {
  const app = useApp();
  const [step, setStep] = useState<'welcome' | 'node' | 'wallet'>(app.settings.node ? 'wallet' : 'welcome');
  useStatusBar(step === 'welcome');
  if (step === 'welcome') return <Welcome onStart={() => setStep('node')} />;
  if (step === 'node') return <NodeForm back={false} onSaved={() => setStep('wallet')} />;
  return <AddWallet back={false} onDone={() => undefined} />;
}

function Current({ route }: { route: Route }) {
  const nav = useNav();
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'receive':
      return <Receive />;
    case 'send':
      return <Send address={route.address} amount={route.amount} label={route.label} coins={route.coins} />;
    case 'tx':
      return <TxDetail txid={route.txid} />;
    case 'bump':
      return <Bump txid={route.txid} cancel={route.cancel} />;
    case 'settings':
      return <Settings />;
    case 'node':
      return <NodeForm onSaved={() => nav.pop()} />;
    case 'add-wallet':
      return <AddWallet seedFrom={route.seedFrom} />;
    case 'wallet-info':
      return <WalletInfo id={route.id} />;
  }
}

function Stack() {
  const nav = useNav();
  const route = nav.stack[nav.stack.length - 1];
  useStatusBar(route.name === 'home');
  return <Current route={route} />;
}

export function Root() {
  const app = useApp();
  if (!app.ready) return null;
  if (app.locked) return <Lock />;
  if (!app.settings.node || !app.active) {
    return (
      <NavProvider>
        <Onboarding />
      </NavProvider>
    );
  }
  return (
    <NavProvider>
      <Stack />
    </NavProvider>
  );
}
