import type { CapacitorConfig } from '@capacitor/cli';

// The bundle ID only has to be unique within your Apple developer team. Change it if Xcode says it is taken.
const config: CapacitorConfig = {
  appId: 'com.shrikewallet.mobile.personal',
  appName: 'Shrike',
  webDir: 'dist',
  ios: {
    contentInset: 'never',
    backgroundColor: '#000000',
    // The page cannot be inspected from Safari on a Mac in release builds
    webContentsDebuggingEnabled: false,
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    CapacitorHttp: { enabled: false },
  },
};

export default config;
