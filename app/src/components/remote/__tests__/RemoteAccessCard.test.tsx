import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  serverStatus: vi.fn(),
  localIp: vi.fn(),
  getAuditLog: vi.fn(),
  tunnelStatus: vi.fn(),
  startServer: vi.fn(),
  stopServer: vi.fn(),
  rotateToken: vi.fn(),
  startTunnel: vi.fn(),
  stopTunnel: vi.fn(),
}));

vi.mock('@/api/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/api/tauri')>('@/api/tauri');
  return { ...actual, api: { ...actual.api, ...mocks } };
});

vi.mock('@/hooks/useSettings', () => ({
  useSettings: () => ({ settings: { lan_mode_opt_in: true } }),
}));

vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn().mockResolvedValue(undefined) },
}));

import { buildPairingUrl, RemoteAccessCard } from '../RemoteAccessCard';

const loopbackStatus = {
  running: true,
  port: 7777,
  mode: 'loopback' as const,
  tls: false,
  cert_fingerprint_sha256: null,
  token: 'remote-token',
};

const stoppedStatus = {
  running: false,
  port: null,
  mode: null,
  tls: false,
  cert_fingerprint_sha256: null,
  token: 'remote-token',
};

const remoteTunnel = {
  script_id: '__procman_remote_server__',
  url: 'https://pair-test.trycloudflare.com',
  pid: 4242,
  port: 7777,
};

describe('RemoteAccessCard mobile trust boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.serverStatus.mockResolvedValue(loopbackStatus);
    mocks.localIp.mockResolvedValue('192.168.1.40');
    mocks.getAuditLog.mockResolvedValue([]);
    mocks.tunnelStatus.mockResolvedValue([]);
    mocks.startServer.mockResolvedValue(undefined);
    mocks.stopServer.mockResolvedValue(undefined);
    mocks.rotateToken.mockResolvedValue(undefined);
    mocks.startTunnel.mockResolvedValue({
      running: true,
      url: remoteTunnel.url,
      pid: remoteTunnel.pid,
    });
    mocks.stopTunnel.mockResolvedValue(undefined);
  });

  it('separates LAN pin credentials from Tunnel pairing payloads', () => {
    const lan = new URL(buildPairingUrl({
      url: 'https://192.168.1.40:7777',
      token: 'lan-token',
      certFingerprint: 'AA:BB',
      mode: 'lan',
    }));
    const lanFragment = new URLSearchParams(lan.hash.slice(1));
    expect(lanFragment.get('token')).toBe('lan-token');
    expect(lanFragment.get('fp')).toBe('AA:BB');
    expect(lanFragment.get('mode')).toBe('lan');

    const tunnel = new URL(buildPairingUrl({
      url: remoteTunnel.url,
      token: 'tunnel-token',
      certFingerprint: null,
      mode: 'tunnel',
    }));
    const tunnelFragment = new URLSearchParams(tunnel.hash.slice(1));
    expect(tunnelFragment.get('token')).toBe('tunnel-token');
    expect(tunnelFragment.has('fp')).toBe(false);
    expect(tunnelFragment.get('mode')).toBe('tunnel');
  });

  it('does not allow a loopback Cloudflare Tunnel to start from LAN mode', async () => {
    mocks.serverStatus.mockResolvedValue({
      ...loopbackStatus,
      mode: 'lan',
      tls: true,
      cert_fingerprint_sha256: 'AA:BB',
    });
    render(<RemoteAccessCard />);

    const expose = await screen.findByRole('button', { name: 'Expose via Cloudflare' });
    expect(expose).toBeDisabled();
    fireEvent.click(expose);
    expect(mocks.startTunnel).not.toHaveBeenCalled();
  });

  it('stops the public Tunnel before stopping its loopback server', async () => {
    mocks.tunnelStatus.mockResolvedValue([remoteTunnel]);
    render(<RemoteAccessCard />);

    const stopButtons = await screen.findAllByRole('button', { name: 'Stop' });
    fireEvent.click(stopButtons[0]);

    await waitFor(() => expect(mocks.stopServer).toHaveBeenCalledOnce());
    expect(mocks.stopTunnel).toHaveBeenCalledWith('__procman_remote_server__');
    expect(mocks.stopTunnel.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.stopServer.mock.invocationCallOrder[0]);
  });

  it('keeps an orphaned remote Tunnel visible and stoppable while the server is off', async () => {
    mocks.serverStatus.mockResolvedValue(stoppedStatus);
    mocks.tunnelStatus.mockResolvedValue([remoteTunnel]);
    render(<RemoteAccessCard />);

    expect(await screen.findByText('connected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(mocks.stopTunnel).toHaveBeenCalledWith('__procman_remote_server__');
    });
    expect(mocks.stopServer).not.toHaveBeenCalled();
  });
});
