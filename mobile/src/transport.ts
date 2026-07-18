import { PinnedTransport, type PinnedStreamEvent } from './nativeTransport';
import { isNativeIOS } from './platform';
import {
  baseUrl,
  validatePairInfo,
  type PairInfo,
} from './pair';

export type TransportErrorCode =
  | 'AUTH_REVOKED'
  | 'INVALID_OPTIONS'
  | 'TLS_PIN_REQUIRED'
  | 'CERTIFICATE_PIN_MISMATCH'
  | 'TLS_HOST_MISMATCH'
  | 'TLS_TRUST_FAILED'
  | 'TLS_REDIRECT_REJECTED'
  | 'REQUEST_CANCELLED'
  | 'UNSUPPORTED_CONNECTION_MODE'
  | 'NATIVE_TRANSPORT_REQUIRED';

const SECURITY_MESSAGE = 'Certificate changed — unpair and scan again.';
export const PINNED_REST_MARKER = 'ios-pinned-v1';
export const PINNED_WEBSOCKET_PROTOCOL = 'procman-native-pinned-v1';

export class TransportError extends Error {
  readonly code: TransportErrorCode | string;

  constructor(code: TransportErrorCode | string, message?: string) {
    super(message ?? messageForCode(code));
    this.name = 'TransportError';
    this.code = code;
  }
}

export function isTerminalTransportError(error: unknown): boolean {
  const code = transportErrorCode(error);
  return (
    code === 'AUTH_REVOKED' ||
    code === 'CERTIFICATE_PIN_MISMATCH' ||
    code === 'TLS_PIN_REQUIRED' ||
    code === 'TLS_HOST_MISMATCH' ||
    code === 'TLS_TRUST_FAILED' ||
    code === 'TLS_REDIRECT_REJECTED' ||
    code === 'NATIVE_TRANSPORT_REQUIRED' ||
    code === 'UNSUPPORTED_CONNECTION_MODE'
  );
}

export function transportErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function messageForCode(code: string, nativeMessage?: string | null): string {
  switch (code) {
    case 'AUTH_REVOKED':
      return 'Pairing token changed — unpair and scan again.';
    case 'CERTIFICATE_PIN_MISMATCH':
    case 'TLS_HOST_MISMATCH':
    case 'TLS_TRUST_FAILED':
    case 'TLS_REDIRECT_REJECTED':
      return SECURITY_MESSAGE;
    case 'TLS_PIN_REQUIRED':
      return 'Secure LAN pairing is incomplete — unpair and scan again.';
    case 'REQUEST_CANCELLED':
      return 'Request cancelled';
    case 'NATIVE_TRANSPORT_REQUIRED':
    case 'UNSUPPORTED_CONNECTION_MODE':
      return 'Direct LAN access requires the procman iOS app. Use a Cloudflare Tunnel in a browser.';
    case 'INVALID_OPTIONS':
      return 'The secure connection options are invalid.';
    default:
      // Unrecognized (non-terminal) codes keep the native description when
      // one exists — "Could not connect to the server" beats a generic
      // "Connection failed" for LAN troubleshooting.
      return nativeMessage?.trim() ? nativeMessage : 'Connection failed';
  }
}

function mapNativeError(error: unknown): Error {
  const code = transportErrorCode(error);
  if (code) {
    const nativeMessage =
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : null;
    return new TransportError(code, messageForCode(code, nativeMessage));
  }
  return error instanceof Error ? error : new Error(String(error));
}

let nextRequestId = 1;
let nextConnectionId = 1;

function uniqueId(prefix: string, sequence: number): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `${prefix}-${random}` : `${prefix}-${Date.now()}-${sequence}`;
}

function headersRecord(headers?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function stringBody(body: BodyInit | null | undefined): string | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new TransportError('INVALID_OPTIONS', 'Native LAN requests require a string request body.');
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function statusText(status: number): string {
  switch (status) {
    case 200: return 'OK';
    case 201: return 'Created';
    case 204: return 'No Content';
    case 400: return 'Bad Request';
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 409: return 'Conflict';
    case 429: return 'Too Many Requests';
    case 500: return 'Internal Server Error';
    case 503: return 'Service Unavailable';
    default: return '';
  }
}

/**
 * Send one authenticated API request through the connection-mode appropriate
 * transport. Tunnel traffic intentionally stays on the browser networking
 * stack; pinned LAN traffic can only use the native iOS plugin.
 */
export async function transportRequest(
  pairInput: PairInfo,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const pair = validatePairInfo(pairInput);
  const url = `${baseUrl(pair)}${path}`;

  if (pair.connectionMode === 'tunnel') {
    return fetch(url, init);
  }
  if (!isNativeIOS()) {
    throw new TransportError('NATIVE_TRANSPORT_REQUIRED');
  }

  const fingerprint = pair.certFingerprintSha256;
  if (!fingerprint) throw new TransportError('TLS_PIN_REQUIRED');
  if (init.signal?.aborted) throw abortError();

  const requestId = uniqueId('request', nextRequestId++);
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void PinnedTransport.cancelRequest({ requestId }).catch(() => {
      // The request may have completed between the abort and native cancel.
    });
  };
  init.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const nativeHeaders = headersRecord(init.headers);
    for (const key of Object.keys(nativeHeaders)) {
      if (key.toLowerCase() === 'x-procman-transport') delete nativeHeaders[key];
    }
    nativeHeaders['X-Procman-Transport'] = PINNED_REST_MARKER;
    const nativeResponse = await PinnedTransport.request({
      requestId,
      url,
      method: init.method ?? 'GET',
      headers: nativeHeaders,
      body: stringBody(init.body),
      fingerprint,
    });
    if (aborted) throw abortError();
    const hasBody = nativeResponse.body.length > 0 && nativeResponse.status !== 204;
    return new Response(hasBody ? nativeResponse.body : null, {
      status: nativeResponse.status,
      statusText: statusText(nativeResponse.status),
      headers: nativeResponse.headers,
    });
  } catch (error) {
    if (aborted || transportErrorCode(error) === 'REQUEST_CANCELLED') throw abortError();
    throw mapNativeError(error);
  } finally {
    init.signal?.removeEventListener('abort', onAbort);
  }
}

export interface TransportSocketHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: (code?: number, reason?: string) => void;
  onError: (error: Error) => void;
}

export interface TransportSocket {
  close: () => void;
}

/** Open a WebSocket using the exact same validated pin as REST requests. */
export async function openTransportSocket(
  pairInput: PairInfo,
  path: string,
  protocols: string[],
  handlers: TransportSocketHandlers,
): Promise<TransportSocket> {
  const pair = validatePairInfo(pairInput);
  const url = `${baseUrl(pair).replace(/^http/, 'ws')}${path}`;

  if (pair.connectionMode === 'tunnel') {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, protocols);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    socket.onopen = handlers.onOpen;
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') handlers.onMessage(event.data);
    };
    socket.onclose = (event) => handlers.onClose(event?.code, event?.reason);
    socket.onerror = () => handlers.onError(new Error('WebSocket connection failed'));
    return { close: () => socket.close() };
  }

  if (!isNativeIOS()) throw new TransportError('NATIVE_TRANSPORT_REQUIRED');
  const fingerprint = pair.certFingerprintSha256;
  if (!fingerprint) throw new TransportError('TLS_PIN_REQUIRED');

  const connectionId = uniqueId('stream', nextConnectionId++);
  let listenerRemoved = false;
  let listener: { remove: () => Promise<void> } | null = null;
  const registeredListener = await PinnedTransport.addListener('streamEvent', (event) => {
    if (event.connectionId !== connectionId) return;
    if ((event.type === 'close' || event.type === 'error') && !listenerRemoved) {
      listenerRemoved = true;
      if (listener) void listener.remove();
    }
    handleNativeStreamEvent(event, handlers);
  });
  listener = registeredListener;
  if (listenerRemoved) await listener.remove();

  try {
    await PinnedTransport.openWebSocket({
      connectionId,
      url,
      protocols: [...protocols, PINNED_WEBSOCKET_PROTOCOL],
      fingerprint,
    });
  } catch (error) {
    listenerRemoved = true;
    await registeredListener.remove();
    throw mapNativeError(error);
  }

  let closed = false;
  return {
    close: () => {
      if (closed) return;
      closed = true;
      if (!listenerRemoved) {
        listenerRemoved = true;
        void registeredListener.remove();
      }
      void PinnedTransport.closeWebSocket({ connectionId }).catch(() => {
        // Closing an already-closed native task is intentionally idempotent.
      });
    },
  };
}

function handleNativeStreamEvent(
  event: PinnedStreamEvent,
  handlers: TransportSocketHandlers,
): void {
  switch (event.type) {
    case 'open':
      handlers.onOpen();
      break;
    case 'message':
      if (typeof event.data === 'string') handlers.onMessage(event.data);
      break;
    case 'close':
      handlers.onClose(
        typeof event.code === 'number' ? event.code : undefined,
        event.reason,
      );
      break;
    case 'error': {
      const code = event.code ?? 'WEBSOCKET_ERROR';
      const message = isTerminalTransportError({ code })
        ? messageForCode(code)
        : event.reason || messageForCode(code);
      handlers.onError(new TransportError(code, message));
      break;
    }
  }
}
