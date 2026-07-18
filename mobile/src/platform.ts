import { Capacitor } from '@capacitor/core';

/** LAN certificate pinning is implemented only by the native iOS shell. */
export function isNativeIOS(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}
