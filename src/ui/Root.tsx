import { useEffect, useReducer, useState } from 'react';
import { StatusBar, Style } from '@capacitor/status-bar';
import { applyLook, onSystemThemeChange, resolveTheme } from '../app/look';
import { isNative } from '../app/native';
import { NavProvider, TabBar, useApp, useNav, type Route } from './kit';
import { Home } from './Home';
import { Market } from './Market';
import { ContactEdit, Contacts } from './Contacts';
import { Receive } from './Receive';
import { Send } from './Send';
import { Bump, TxDetail } from './Tx';
import { Appearance, Donate, ExplorerScreen, ReplayScreen, Settings, WalletInfo } from './Settings';
import { AddWallet, NodeForm, Welcome } from './Setup';
import { RecoveryCodes, TwoFactorScreen, TwoFactorSetup } from './TwoFactor';
import { WidgetsScreen } from './Widgets';

/** When the page started, so the first lock screen after launch can hold the bird a little longer. */
const BOOT = Date.now();

/** Applies light or dark, the skin and the font, and follows the iPhone when set to match it. */
function useLook() {
  const app = useApp();
  const { appearance, font } = app.settings;
  const skin = app.skin;
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    applyLook({ appearance, skin, font });
    if (appearance !== 'system') return;
    return onSystemThemeChange(() => {
      applyLook({ appearance, skin, font });
      redraw();
    });
  }, [appearance, skin, font]);
}

/** White status bar text over the dark band (home, welcome, lock) and in dark mode; dark text otherwise. */
function useStatusBar(onBand: boolean) {
  const app = useApp();
  const dark = resolveTheme(app.settings.appearance) === 'dark';
  useEffect(() => {
    if (!isNative) return;
    StatusBar.setStyle({ style: onBand || dark ? Style.Dark : Style.Light }).catch(() => undefined);
  }, [onBand, dark]);
}

/**
 * The bird holds the screen for a moment before Face ID is asked for, longer just after launch so the launch
 * screen's bird settles into this one. The button shows only if Face ID was cancelled or failed.
 */
function Lock() {
  useStatusBar(true);
  const app = useApp();
  const [phase, setPhase] = useState<'hold' | 'asking' | 'failed'>('hold');
  const ask = () => {
    setPhase('asking');
    void app.unlock().then((ok) => {
      if (!ok) setPhase('failed');
    });
  };
  useEffect(() => {
    const t = setTimeout(ask, Date.now() - BOOT < 4000 ? 1600 : 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="lock">
      <img src="./bird.png" alt="" />
      <div className="lock-name">Shrike</div>
      <div className={`lock-actions${phase === 'failed' ? ' on' : ''}`} aria-hidden={phase !== 'failed'}>
        <button className="btn primary" onClick={ask} tabIndex={phase === 'failed' ? 0 : -1}>
          Open with Face ID
        </button>
        <p>Face ID didn’t confirm it’s you. Try again.</p>
      </div>
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
    case 'market':
      return <Market />;
    case 'contacts':
      return <Contacts />;
    case 'settings':
      return <Settings />;
    case 'receive':
      return <Receive />;
    case 'send':
      return <Send address={route.address} amount={route.amount} label={route.label} coins={route.coins} />;
    case 'tx':
      return <TxDetail txid={route.txid} />;
    case 'bump':
      return <Bump txid={route.txid} cancel={route.cancel} />;
    case 'node':
      return <NodeForm onSaved={() => nav.pop()} />;
    case 'add-wallet':
      return <AddWallet seedFrom={route.seedFrom} />;
    case 'wallet-info':
      return <WalletInfo id={route.id} />;
    case 'contact':
      return <ContactEdit id={route.id} address={route.address} label={route.label} />;
    case 'two-factor':
      return <TwoFactorScreen />;
    case 'appearance':
      return <Appearance />;
    case 'explorer':
      return <ExplorerScreen />;
    case 'replay':
      return <ReplayScreen />;
    case 'donate':
      return <Donate />;
    case 'widgets':
      return <WidgetsScreen />;
  }
}

/**
 * A tapped widget opens the app on its tab. If a screen is open on top of a tab, such as a send being written,
 * the app stays where it is rather than lose it.
 */
function useWidgetLinks() {
  const app = useApp();
  const nav = useNav();
  const want = app.pendingTab;
  useEffect(() => {
    if (!want) return;
    const tab = app.takePendingTab();
    if (tab && nav.stack.length === 1 && nav.stack[0].name !== tab) nav.reset({ name: tab });
  }, [want, app, nav]);
}

function Stack() {
  const nav = useNav();
  const route = nav.stack[nav.stack.length - 1];
  useStatusBar(route.name === 'home');
  useWidgetLinks();
  return (
    <>
      <Current route={route} />
      {nav.stack.length === 1 && <TabBar />}
    </>
  );
}

/**
 * Past setup. The first time here, two-factor is offered once, with Skip. It's decided when this mounts, so
 * turning it on partway through still leaves the recovery codes on screen until Done.
 */
function Main() {
  const app = useApp();
  const [offer, setOffer] = useState(() => !app.settings.twoFactorOffered && !app.settings.twoFactor);
  if (app.pendingRecoveryCodes) {
    return (
      <Codes
        codes={app.pendingRecoveryCodes}
        onDone={() => {
          app.acknowledgeRecoveryCodes();
          if (!app.settings.twoFactorOffered) void app.updateSettings({ twoFactorOffered: true });
          setOffer(false);
        }}
      />
    );
  }
  if (offer && !app.settings.twoFactor) {
    return (
      <Offer
        onDone={() => {
          void app.updateSettings({ twoFactorOffered: true });
          setOffer(false);
        }}
      />
    );
  }
  return <Stack />;
}

/** Recovery codes just made, shown until they're saved, even if the app locked in between. */
function Codes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  useStatusBar(false);
  return <RecoveryCodes codes={codes} title="Recovery codes" onDone={onDone} />;
}

function Offer({ onDone }: { onDone: () => void }) {
  useStatusBar(false);
  return <TwoFactorSetup onboarding onDone={onDone} />;
}

export function Root() {
  const app = useApp();
  useLook();
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
      <Main />
    </NavProvider>
  );
}
