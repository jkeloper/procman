import { beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  baseUrl,
  clearPair,
  isTryCloudflareHost,
  loadPair,
  normalizeSha256Fingerprint,
  parsePairingUrl,
  savePair,
  tryAutoPairFromHash,
  validatePairInfo,
} from '../pair';

const RAW_PIN = 'ab'.repeat(32);
const PIN = Array.from({ length: 32 }, () => 'AB').join(':');

function tunnelPair() {
  return {
    connectionMode: 'tunnel' as const,
    host: 'mobile-test.trycloudflare.com',
    port: 443,
    scheme: 'https' as const,
    token: 'pair-token',
    certFingerprintSha256: null,
  };
}

describe('mobile pairing policy and persistence', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/mobile?source=qr');
  });

  it('fails a browser LAN auto-pair closed and always strips its sensitive hash', () => {
    window.location.hash = `#token=secret-token&fp=${RAW_PIN}`;

    expect(tryAutoPairFromHash()).toBeNull();
    expect(loadPair()).toBeNull();
    expect(window.location.href).toBe('https://procman.test:9443/mobile?source=qr');
  });

  it('does not consume a hash that has no pairing token', () => {
    window.location.hash = '#fp=AA%3ABB';

    expect(tryAutoPairFromHash()).toBeNull();
    expect(loadPair()).toBeNull();
    expect(window.location.hash).toBe('#fp=AA%3ABB');
  });

  it('accepts only a strict HTTPS Cloudflare tunnel in a browser', () => {
    const pair = parsePairingUrl(
      'https://mobile-test.trycloudflare.com/#token=secret-token',
    );
    expect(pair).toEqual({
      ...tunnelPair(),
      token: 'secret-token',
    });

    expect(() => parsePairingUrl(
      'http://mobile-test.trycloudflare.com/#token=secret-token',
    )).toThrow('Secure HTTPS is required');
    expect(() => parsePairingUrl(
      'https://trycloudflare.com.evil.example/#token=secret-token',
    )).toThrow('requires the procman iOS app');
    expect(() => validatePairInfo({
      ...tunnelPair(),
      host: 'trycloudflare.com',
    })).toThrow('only HTTPS *.trycloudflare.com');
  });

  it('normalizes valid pins and requires HTTPS plus a pin for native LAN', () => {
    expect(normalizeSha256Fingerprint(RAW_PIN)).toBe(PIN);
    expect(normalizeSha256Fingerprint('AA:BB')).toBeNull();

    expect(validatePairInfo({
      connectionMode: 'lan',
      host: '192.168.1.20',
      port: 7777,
      scheme: 'https',
      token: 'lan-token',
      certFingerprintSha256: RAW_PIN,
    }, { nativeIOS: true })).toEqual({
      connectionMode: 'lan',
      host: '192.168.1.20',
      port: 7777,
      scheme: 'https',
      token: 'lan-token',
      certFingerprintSha256: PIN,
    });

    expect(() => validatePairInfo({
      connectionMode: 'lan',
      host: '192.168.1.20',
      port: 7777,
      scheme: 'http',
      token: 'lan-token',
      certFingerprintSha256: RAW_PIN,
    }, { nativeIOS: true })).toThrow('Secure HTTPS is required');
    expect(() => validatePairInfo({
      connectionMode: 'lan',
      host: '192.168.1.20',
      port: 7777,
      scheme: 'https',
      token: 'lan-token',
      certFingerprintSha256: null,
    }, { nativeIOS: true })).toThrow('requires a valid SHA-256');
  });

  it('migrates only an unambiguous legacy tunnel and persists its explicit mode', () => {
    localStorage.setItem(
      'procman.pair',
      JSON.stringify({
        host: 'legacy.trycloudflare.com',
        port: 443,
        token: 'legacy-token',
      }),
    );
    expect(loadPair()).toEqual({
      connectionMode: 'tunnel',
      host: 'legacy.trycloudflare.com',
      port: 443,
      scheme: 'https',
      token: 'legacy-token',
      certFingerprintSha256: null,
    });
    expect(JSON.parse(localStorage.getItem('procman.pair')!)).toMatchObject({
      connectionMode: 'tunnel',
      scheme: 'https',
    });

    localStorage.setItem(
      'procman.pair',
      JSON.stringify({ host: 'desktop.local', port: 443, token: 'unsafe' }),
    );
    expect(loadPair()).toBeNull();
    expect(localStorage.getItem('procman.pair')).toBeNull();

    localStorage.setItem('procman.pair', JSON.stringify({
      connectionMode: 'lan',
      host: '192.168.1.20',
      port: 7777,
      scheme: 'https',
      token: 'stale-pwa-token',
      certFingerprintSha256: RAW_PIN,
    }));
    expect(loadPair()).toBeNull();
    expect(localStorage.getItem('procman.pair')).toBeNull();
  });

  it('persists explicit tunnel state, builds its URL, and clears it', () => {
    savePair(tunnelPair());

    expect(loadPair()).toEqual(tunnelPair());
    expect(baseUrl()).toBe('https://mobile-test.trycloudflare.com');
    expect(authHeader()).toEqual({ Authorization: 'Bearer pair-token' });
    clearPair();
    expect(loadPair()).toBeNull();
    expect(() => baseUrl()).toThrow('not paired');
  });

  it('recognizes exact Cloudflare subdomains without substring spoofing', () => {
    expect(isTryCloudflareHost('alpha.trycloudflare.com')).toBe(true);
    expect(isTryCloudflareHost('TRYCloudflare.com')).toBe(false);
    expect(isTryCloudflareHost('trycloudflare.com.evil.test')).toBe(false);
    expect(isTryCloudflareHost('alpha-trycloudflare.com')).toBe(false);
  });
});
