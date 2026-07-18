import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStream, type StreamEvent } from '../api';
import { savePair } from '../pair';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static constructorCalls = 0;
  static failuresRemaining = 0;

  readonly url: string;
  readonly protocols: string | string[] | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string | URL, protocols?: string | string[]) {
    MockWebSocket.constructorCalls += 1;
    if (MockWebSocket.failuresRemaining > 0) {
      MockWebSocket.failuresRemaining -= 1;
      throw new Error('socket construction failed');
    }
    this.url = String(url);
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  close = vi.fn(() => {
    this.onclose?.({ code: 1000, reason: '' });
  });

  open() {
    this.onopen?.();
  }

  message(data: string) {
    this.onmessage?.({ data });
  }

  fail() {
    this.onerror?.();
    this.onclose?.({ code: 1006, reason: '' });
  }

  serverClose(code: number, reason = '') {
    this.onclose?.({ code, reason });
  }

  static reset() {
    MockWebSocket.instances = [];
    MockWebSocket.constructorCalls = 0;
    MockWebSocket.failuresRemaining = 0;
  }
}

describe('mobile WebSocket stream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    MockWebSocket.reset();
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    savePair({
      connectionMode: 'tunnel',
      host: 'desktop-test.trycloudflare.com',
      port: 443,
      scheme: 'https',
      token: 'secret-token',
      certFingerprintSha256: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses a secure URL and subprotocol auth, then parses wrapped status events', async () => {
    const events: StreamEvent[] = [];
    const statuses: boolean[] = [];
    const stop = openStream((event) => events.push(event), (connected) => statuses.push(connected));

    const socket = MockWebSocket.instances[0];
    expect(socket.url).toBe('wss://desktop-test.trycloudflare.com/api/stream');
    expect(socket.protocols).toEqual(['procman', 'procman-token.secret-token']);

    socket.open();
    socket.message(
      JSON.stringify({
        type: 'status',
        data: { id: 'worker', status: 'crashed', pid: null, exit_code: 1, ts_ms: 42 },
      }),
    );
    socket.message('{malformed');

    expect(statuses).toEqual([true]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'status',
      id: 'worker',
      status: 'crashed',
      exit_code: 1,
      ts_ms: 42,
    });

    stop();
    await Promise.resolve();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('reconnects with exponential backoff after construction failures', async () => {
    MockWebSocket.failuresRemaining = 2;

    const stop = openStream(vi.fn(), vi.fn());
    expect(MockWebSocket.constructorCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(999);
    expect(MockWebSocket.constructorCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.constructorCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(MockWebSocket.constructorCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.constructorCalls).toBe(3);
    expect(MockWebSocket.instances).toHaveLength(1);

    stop();
  });

  it('treats close code 4001 as terminal authentication revocation', async () => {
    const errors: Error[] = [];
    const stop = openStream(vi.fn(), vi.fn(), (error) => errors.push(error));
    const socket = MockWebSocket.instances[0];

    socket.serverClose(4001, 'pairing token rotated');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(MockWebSocket.constructorCalls).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'AUTH_REVOKED',
      message: 'Pairing token changed — unpair and scan again.',
    });
    stop();
  });

  it('probes stale offline tunnel credentials and stops reconnecting after 401', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const errors: Error[] = [];
    const stop = openStream(vi.fn(), vi.fn(), (error) => errors.push(error));
    const socket = MockWebSocket.instances[0];

    socket.fail();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://desktop-test.trycloudflare.com/api/ping',
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(MockWebSocket.constructorCalls).toBe(1);
    expect(errors[0]).toMatchObject({
      code: 'AUTH_REVOKED',
      message: 'Pairing token changed — unpair and scan again.',
    });
    stop();
  });

  it('reports disconnects, reconnects, and resets backoff after opening', async () => {
    const statuses: boolean[] = [];
    const stop = openStream(vi.fn(), (connected) => statuses.push(connected));
    const first = MockWebSocket.instances[0];

    first.open();
    first.close();
    expect(statuses).toEqual([true, false]);

    await vi.advanceTimersByTimeAsync(1_000);
    const second = MockWebSocket.instances[1];
    second.open();
    second.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    stop();
  });

  it('cancels a pending reconnect when the subscriber stops', async () => {
    const stop = openStream(vi.fn(), vi.fn());
    const socket = MockWebSocket.instances[0];
    socket.close();

    stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
