// Crossbill on StartOS: the server. Node 22.18 or later runs it as TypeScript, with no build step:
//
//   node server/main.ts                          serve (the settings come from CROSSBILL_* environment variables)
//   node server/main.ts set-password [password]  change the sign-in password (a random one if none is given,
//                                                printed once); signs out every session
//   node server/main.ts lightning-payments on|off|status
//                                                whether the page may pay on Lightning (off until turned on)
//
// docs/server.md lists the settings and how to try it against a real node from a Mac.

import { randomPassword, setPassword } from './auth.ts';
import { startServer } from './app.ts';
import { ConfigError, configFromEnv } from './config.ts';
import { DataStore } from './store.ts';
import { resolve } from 'node:path';

function dataStore(): DataStore {
  return new DataStore(resolve(process.env.CROSSBILL_DATA_DIR ?? './data'));
}

async function main(argv: string[]): Promise<number> {
  const [cmd = 'serve', ...args] = argv;
  if (cmd === 'set-password') {
    const password = args[0] ?? randomPassword();
    setPassword(dataStore(), password);
    console.log(args[0] ? 'Password changed. Every session is signed out.' : `New password: ${password}\nEvery session is signed out.`);
    return 0;
  }
  if (cmd === 'lightning-payments') {
    const store = dataStore();
    const want = args[0];
    if (want === 'on' || want === 'off') store.updateSettings({ lightningPayments: want === 'on' });
    else if (want && want !== 'status') {
      console.error('Use: lightning-payments on|off|status');
      return 2;
    }
    const on = store.settings().lightningPayments;
    const env = process.env.CROSSBILL_LIGHTNING_PAYMENTS;
    console.log(`Lightning payments are ${on ? 'on' : 'off'}${env ? ` (CROSSBILL_LIGHTNING_PAYMENTS=${env} overrides this while it's set)` : ''}.`);
    return 0;
  }
  if (cmd !== 'serve') {
    console.error(`Unknown command: ${cmd}. Use serve, set-password or lightning-payments.`);
    return 2;
  }
  const config = configFromEnv();
  const s = await startServer(config);
  const stop = () => {
    void s.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return -1;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e: unknown) => {
    console.error(e instanceof ConfigError ? `crossbill: ${e.message}` : e);
    process.exit(1);
  },
);
