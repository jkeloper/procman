import { afterEach, describe, expect, it, vi } from 'vitest';
import { transportRequest } from '../transport';
import type { PairInfo } from '../pair';

const tunnelPair: PairInfo = {
  connectionMode: 'tunnel',
  host: 'policy-test.trycloudflare.com',
  port: 443,
  scheme: 'https',
  token: 'tunnel-token',
  certFingerprintSha256: null,
};

describe('browser transport policy', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses ordinary fetch for a strict tunnel without native marker headers', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      void url;
      void init;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await transportRequest(tunnelPair, '/api/ping', {
      headers: { Authorization: 'Bearer tunnel-token' },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://policy-test.trycloudflare.com/api/ping',
      { headers: { Authorization: 'Bearer tunnel-token' } },
    );
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty('X-Procman-Transport');
  });

  it('blocks direct LAN before any browser network request is attempted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const lanPair: PairInfo = {
      connectionMode: 'lan',
      host: '192.168.1.40',
      port: 7777,
      scheme: 'https',
      token: 'lan-token',
      certFingerprintSha256: 'AB'.repeat(32),
    };

    await expect(transportRequest(lanPair, '/api/ping')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONNECTION_MODE',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
