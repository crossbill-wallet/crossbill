// Which Crossbill this build is. The iPhone app ("app") is the default, and the only one Capacitor ships. The
// StartOS build ("server") is the same screens, served by server/main.ts to a browser, with the node, Lightning
// and storage reached through that server. `vite build --mode server` makes it (vite.config.ts sets
// __CROSSBILL_TARGET__); nothing in the iPhone build changes.

export type Target = 'app' | 'server';

export const TARGET: Target = typeof __CROSSBILL_TARGET__ !== 'undefined' && __CROSSBILL_TARGET__ === 'server' ? 'server' : 'app';

/** The StartOS build: watch-only, signed on a Krux, the node and Lightning reached through the Crossbill server. */
export const isServer = TARGET === 'server';
