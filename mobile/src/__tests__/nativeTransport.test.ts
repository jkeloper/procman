import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const native = vi.hoisted(() => {
  type Event =
    | { connectionId: string; type: 'open' }
    | { connectionId: string; type: 'message'; data?: string }
    | { connectionId: string; type: 'close'; code?: number; reason?: string }
    | { connectionId: string; type: 'error'; code?: string; reason?: string };
  let listener: ((event: Event) => void) | null = null;
  const removeListener = vi.fn(async () => undefined);
  return {
    request: vi.fn(),
    cancelRequest: vi.fn(async () => undefined),
    openWebSocket: vi.fn(async ({ connectionId }: { connectionId: string }) => ({ connectionId })),
    closeWebSocket: vi.fn(async () => undefined),
    addListener: vi.fn(async (_name: string, next: (event: Event) => void) => {
      listener = next;
      return { remove: removeListener };
    }),
    removeListener,
    emit(event: Event) {
      listener?.(event);
    },
    reset() {
      listener = null;
      removeListener.mockClear();
    },
  };
});

vi.mock('../platform', () => ({ isNativeIOS: () => true }));
vi.mock('../nativeTransport', () => ({ PinnedTransport: native }));

import { api, openStream, type StreamEvent } from '../api';
import { PairView } from '../PairView';
import { loadPair, savePair } from '../pair';
import {
  PINNED_REST_MARKER,
  PINNED_WEBSOCKET_PROTOCOL,
  transportRequest,
} from '../transport';

const RAW_PIN_A = '12'.repeat(32);
const PIN_A = Array.from({ length: 32 }, () => '12').join(':');
const RAW_PIN_B = 'ab'.repeat(32);
const PIN_B = Array.from({ length: 32 }, () => 'AB').join(':');

function lanPair(pin = RAW_PIN_A) {
  return {
    connectionMode: 'lan' as const,
    host: '192.168.1.40',
    port: 7777,
    scheme: 'https' as const,
    token: 'native-token',
    certFingerprintSha256: pin,
  };
}

function connectionId(): string {
  return native.openWebSocket.mock.calls.at(-1)?.[0].connectionId as string;
}

describe('native iOS pinned transport', () => {
  beforeEach(() => {
    native.reset();
    native.request.mockReset();
    native.cancelRequest.mockClear();
    native.openWebSocket.mockClear();
    native.closeWebSocket.mockClear();
    native.addListener.mockClear();
    native.request.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'test', projects: [], groups: [], settings: {} }),
    });
    savePair(lanPair());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses one normalized fingerprint and native-only marker for REST and WebSocket', async () => {
    await api.projects();
    expect(native.request).toHaveBeenCalledOnce();
    expect(native.request.mock.calls[0][0]).toMatchObject({
      url: 'https://192.168.1.40:7777/api/projects',
      method: 'GET',
      fingerprint: PIN_A,
      headers: {
        authorization: 'Bearer native-token',
        'X-Procman-Transport': PINNED_REST_MARKER,
      },
    });

    const events: StreamEvent[] = [];
    const statuses: boolean[] = [];
    const stop = openStream(
      (event) => events.push(event),
      (connected) => statuses.push(connected),
    );
    await vi.waitFor(() => expect(native.openWebSocket).toHaveBeenCalledOnce());
    expect(native.openWebSocket.mock.calls[0][0]).toMatchObject({
      url: 'wss://192.168.1.40:7777/api/stream',
      protocols: [
        'procman',
        'procman-token.native-token',
        PINNED_WEBSOCKET_PROTOCOL,
      ],
      fingerprint: PIN_A,
    });

    const id = connectionId();
    native.emit({ connectionId: id, type: 'open' });
    native.emit({
      connectionId: id,
      type: 'message',
      data: JSON.stringify({
        type: 'status',
        data: { id: 'worker', status: 'running', pid: 7, exit_code: null, ts_ms: 5 },
      }),
    });
    expect(statuses).toEqual([true]);
    expect(events[0]).toMatchObject({ type: 'status', id: 'worker', pid: 7 });

    stop();
    await vi.waitFor(() => expect(native.closeWebSocket).toHaveBeenCalledOnce());
  });

  it('routes the PairView LAN ping through the pinned request abstraction', async () => {
    native.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: '',
    });
    const onPaired = vi.fn();
    render(createElement(PairView, { onPaired }));

    fireEvent.change(screen.getByLabelText('Host / IP'), {
      target: { value: '192.168.1.55' },
    });
    fireEvent.change(screen.getByLabelText('Port'), {
      target: { value: '7443' },
    });
    fireEvent.change(screen.getByLabelText('SHA-256 certificate fingerprint'), {
      target: { value: RAW_PIN_B },
    });
    fireEvent.change(screen.getByLabelText('Token'), {
      target: { value: 'pair-view-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(onPaired).toHaveBeenCalledOnce());
    expect(native.request.mock.calls.at(-1)?.[0]).toMatchObject({
      url: 'https://192.168.1.55:7443/api/ping',
      fingerprint: PIN_B,
      headers: {
        authorization: 'Bearer pair-view-token',
        'X-Procman-Transport': PINNED_REST_MARKER,
      },
    });
  });

  it('keeps the saved pin and requests a fresh QR when PairView detects a mismatch', async () => {
    native.request.mockRejectedValueOnce({ code: 'CERTIFICATE_PIN_MISMATCH' });
    const onPaired = vi.fn();
    render(createElement(PairView, { onPaired }));

    fireEvent.change(screen.getByLabelText('Host / IP'), {
      target: { value: '192.168.1.55' },
    });
    fireEvent.change(screen.getByLabelText('Port'), {
      target: { value: '7443' },
    });
    fireEvent.change(screen.getByLabelText('SHA-256 certificate fingerprint'), {
      target: { value: RAW_PIN_B },
    });
    fireEvent.change(screen.getByLabelText('Token'), {
      target: { value: 'new-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText('Certificate changed — unpair and scan again.')).not.toBeNull();
    expect(onPaired).not.toHaveBeenCalled();
    expect(loadPair()?.certFingerprintSha256).toBe(PIN_A);
  });

  it('maps a REST certificate mismatch to the re-pair security message', async () => {
    native.request.mockRejectedValueOnce({
      code: 'CERTIFICATE_PIN_MISMATCH',
      message: 'native detail must not weaken the UX',
    });

    await expect(api.processes()).rejects.toMatchObject({
      code: 'CERTIFICATE_PIN_MISMATCH',
      message: 'Certificate changed — unpair and scan again.',
    });
  });

  it('stops reconnecting after a terminal native stream pin error', async () => {
    vi.useFakeTimers();
    const errors: Error[] = [];
    const stop = openStream(vi.fn(), vi.fn(), (error) => errors.push(error));
    await vi.waitFor(() => expect(native.openWebSocket).toHaveBeenCalledOnce());

    native.emit({
      connectionId: connectionId(),
      type: 'error',
      code: 'CERTIFICATE_PIN_MISMATCH',
      reason: 'presented certificate differs',
    });
    expect(native.removeListener).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(native.openWebSocket).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'CERTIFICATE_PIN_MISMATCH',
      message: 'Certificate changed — unpair and scan again.',
    });
    stop();
  });

  it('treats a missing native stream pin as terminal before any reconnect', async () => {
    vi.useFakeTimers();
    native.openWebSocket.mockRejectedValueOnce({ code: 'TLS_PIN_REQUIRED' });
    const errors: Error[] = [];
    const stop = openStream(vi.fn(), vi.fn(), (error) => errors.push(error));

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(native.openWebSocket).toHaveBeenCalledOnce();
    expect(errors[0]).toMatchObject({
      code: 'TLS_PIN_REQUIRED',
      message: 'Secure LAN pairing is incomplete — unpair and scan again.',
    });
    stop();
  });

  it('treats native close code 4001 as terminal authentication revocation', async () => {
    vi.useFakeTimers();
    const errors: Error[] = [];
    const stop = openStream(vi.fn(), vi.fn(), (error) => errors.push(error));
    await vi.waitFor(() => expect(native.openWebSocket).toHaveBeenCalledOnce());

    native.emit({
      connectionId: connectionId(),
      type: 'close',
      code: 4001,
      reason: 'pairing token rotated',
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(native.openWebSocket).toHaveBeenCalledOnce();
    expect(native.request).not.toHaveBeenCalled();
    expect(errors[0]).toMatchObject({
      code: 'AUTH_REVOKED',
      message: 'Pairing token changed — unpair and scan again.',
    });
    stop();
  });

  it('probes stale offline native credentials and stops reconnecting after 401', async () => {
    vi.useFakeTimers();
    native.openWebSocket.mockRejectedValueOnce(new Error('WebSocket handshake rejected'));
    native.request.mockResolvedValueOnce({ status: 401, headers: {}, body: '' });
    const errors: Error[] = [];
    const stop = openStream(vi.fn(), vi.fn(), (error) => errors.push(error));

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(native.openWebSocket).toHaveBeenCalledOnce();
    expect(native.request).toHaveBeenCalledOnce();
    expect(native.request.mock.calls[0][0]).toMatchObject({
      url: 'https://192.168.1.40:7777/api/ping',
      headers: {
        authorization: 'Bearer native-token',
        'X-Procman-Transport': PINNED_REST_MARKER,
      },
      fingerprint: PIN_A,
    });
    expect(errors[0]).toMatchObject({
      code: 'AUTH_REVOKED',
      message: 'Pairing token changed — unpair and scan again.',
    });
    stop();
  });

  it('uses a newly re-paired certificate instead of a rotated stale pin', async () => {
    expect(loadPair()?.certFingerprintSha256).toBe(PIN_A);
    savePair(lanPair(RAW_PIN_B));
    expect(loadPair()?.certFingerprintSha256).toBe(PIN_B);

    await transportRequest(loadPair()!, '/api/ping', {
      headers: { Authorization: 'Bearer native-token' },
    });
    expect(native.request.mock.calls.at(-1)?.[0].fingerprint).toBe(PIN_B);
  });

  it('cancels an in-flight native request when its AbortSignal fires', async () => {
    let rejectNative!: (reason: unknown) => void;
    native.request.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectNative = reject;
    }));
    const controller = new AbortController();
    const pending = transportRequest(loadPair()!, '/api/ping', {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(native.request).toHaveBeenCalledOnce());
    controller.abort();
    expect(native.cancelRequest).toHaveBeenCalledWith({
      requestId: native.request.mock.calls[0][0].requestId,
    });
    rejectNative({ code: 'REQUEST_CANCELLED' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
