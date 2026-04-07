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
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    scheme: 'procman',
    // Fix touch offset issue — prevent WKWebView from scaling content
    scrollEnabled: true,
  },
};

export default config;
