import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.procman.remote',
  appName: 'procman',
  webDir: 'dist',
  server: {
    // Allow HTTP connections to the procman desktop server on LAN
    cleartext: true,
    androidScheme: 'http',
  },
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    scheme: 'procman',
  },
};

export default config;
