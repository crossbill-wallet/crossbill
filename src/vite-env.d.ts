/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
/** 'server' in the StartOS build (vite.config.ts); 'app' otherwise. Read it through src/app/target.ts */
declare const __CROSSBILL_TARGET__: string | undefined;
