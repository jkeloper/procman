import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.procman.remote',
  appName: 'procman',
  webDir: 'dist',
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
