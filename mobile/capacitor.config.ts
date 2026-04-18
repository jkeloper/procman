import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.procman.remote',
  appName: 'procman',
  webDir: 'dist',
  // Note: procman mobile ships iOS-only (per project charter). The
  // `cleartext` / `androidScheme` fields below are Android-only and
  // therefore unused at runtime — retained only so the config does
  // not fail validation if someone inspects it with an Android toolchain.
  server: {
    cleartext: true,
    androidScheme: 'http',
  },
  ios: {
    // 'always' = WebView sits below status bar, no coordinate offset
    contentInset: 'always',
    preferredContentMode: 'mobile',
    scheme: 'procman',
    scrollEnabled: true,
  },
};

export default config;
