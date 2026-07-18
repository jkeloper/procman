import { isNativeIOS } from './platform';

const KEY = 'procman.pair';

export type ConnectionMode = 'lan' | 'tunnel';

export interface PairInfo {
  connectionMode: ConnectionMode;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  token: string;
  certFingerprintSha256: string | null;
}

export class PairValidationError extends Error {
  readonly code:
    | 'INVALID_PAIR'
    | 'TLS_PIN_REQUIRED'
    | 'UNSUPPORTED_CONNECTION_MODE';

  constructor(
    code: PairValidationError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'PairValidationError';
    this.code = code;
  }
}

export interface PairValidationOptions {
  nativeIOS?: boolean;
}

export function isTryCloudflareHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  return normalized.length > '.trycloudflare.com'.length &&
    normalized.endsWith('.trycloudflare.com');
}

/** Return the canonical OpenSSL-style SHA-256 fingerprint or null. */
export function normalizeSha256Fingerprint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  let compact: string;
  if (/^[a-f\d]{64}$/i.test(trimmed)) {
    compact = trimmed;
  } else if (/^[a-f\d]{2}(?::[a-f\d]{2}){31}$/i.test(trimmed)) {
    compact = trimmed.replaceAll(':', '');
  } else {
    return null;
  }
  return compact
    .toUpperCase()
    .match(/.{2}/g)!
    .join(':');
}

export function validatePairInfo(
  input: PairInfo,
  options: PairValidationOptions = {},
): PairInfo {
  const nativeIOS = options.nativeIOS ?? isNativeIOS();
  const host = typeof input.host === 'string'
    ? input.host.trim().toLowerCase().replace(/\.$/, '')
    : '';
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!host || !token || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new PairValidationError('INVALID_PAIR', 'Host, port, and token are required.');
  }
  if (input.scheme !== 'https') {
    throw new PairValidationError('INVALID_PAIR', 'Secure HTTPS is required.');
  }

  if (input.connectionMode === 'tunnel') {
    if (!isTryCloudflareHost(host) || input.port !== 443) {
      throw new PairValidationError(
        'INVALID_PAIR',
        'Tunnel mode accepts only HTTPS *.trycloudflare.com URLs.',
      );
    }
    return {
      connectionMode: 'tunnel',
      host,
      port: 443,
      scheme: 'https',
      token,
      certFingerprintSha256: null,
    };
  }

  if (input.connectionMode !== 'lan') {
    throw new PairValidationError('INVALID_PAIR', 'Unknown connection mode.');
  }
  if (!nativeIOS) {
    throw new PairValidationError(
      'UNSUPPORTED_CONNECTION_MODE',
      'Direct LAN access requires the procman iOS app. Use a Cloudflare Tunnel in a browser.',
    );
  }
  const fingerprint = normalizeSha256Fingerprint(input.certFingerprintSha256);
  if (!fingerprint) {
    throw new PairValidationError(
      'TLS_PIN_REQUIRED',
      'LAN pairing requires a valid SHA-256 certificate fingerprint.',
    );
  }
  return {
    connectionMode: 'lan',
    host,
    port: input.port,
    scheme: 'https',
    token,
    certFingerprintSha256: fingerprint,
  };
}

function pairCandidateFromUnknown(value: unknown): PairInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const parsed = value as Record<string, unknown>;
  if (
    typeof parsed.host !== 'string' ||
    typeof parsed.port !== 'number' ||
    typeof parsed.token !== 'string'
  ) {
    return null;
  }

  const scheme = parsed.scheme === 'https'
    ? 'https'
    : parsed.scheme === undefined && parsed.port === 443
      ? 'https'
      : null;
  if (!scheme) return null;

  let connectionMode: ConnectionMode | null = null;
  if (parsed.connectionMode === 'lan' || parsed.connectionMode === 'tunnel') {
    connectionMode = parsed.connectionMode;
  } else if (isTryCloudflareHost(parsed.host)) {
    // Safe legacy migration: a strict Cloudflare hostname can only become a
    // tunnel pair. Arbitrary HTTPS hosts are never silently reclassified.
    connectionMode = 'tunnel';
  } else if (normalizeSha256Fingerprint(parsed.certFingerprintSha256)) {
    // A legacy LAN pair is accepted only when it already carries a full pin;
    // validation below will additionally require the native iOS runtime.
    connectionMode = 'lan';
  }
  if (!connectionMode) return null;

  return {
    connectionMode,
    host: parsed.host,
    port: parsed.port,
    scheme,
    token: parsed.token,
    certFingerprintSha256:
      typeof parsed.certFingerprintSha256 === 'string'
        ? parsed.certFingerprintSha256
        : null,
  };
}

export function savePair(info: PairInfo): PairInfo {
  const validated = validatePairInfo(info);
  localStorage.setItem(KEY, JSON.stringify(validated));
  return validated;
}

export function loadPair(): PairInfo | null {
  const serialized = localStorage.getItem(KEY);
  if (!serialized) return null;
  try {
    const candidate = pairCandidateFromUnknown(JSON.parse(serialized));
    if (!candidate) {
      localStorage.removeItem(KEY);
      return null;
    }
    const validated = validatePairInfo(candidate);
    // Persist explicit mode and canonical pin after a successful legacy load.
    if (serialized !== JSON.stringify(validated)) {
      localStorage.setItem(KEY, JSON.stringify(validated));
    }
    return validated;
  } catch {
    // Corrupt, unsafe legacy, or platform-incompatible state fails closed.
    localStorage.removeItem(KEY);
    return null;
  }
}

export function clearPair(): void {
  localStorage.removeItem(KEY);
}

export function parsePairingUrl(text: string): PairInfo {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PairValidationError('INVALID_PAIR', 'Invalid pairing URL.');
  }
  if (url.username || url.password) {
    throw new PairValidationError('INVALID_PAIR', 'Pairing URLs cannot include credentials.');
  }
  const params = new URLSearchParams(url.hash.slice(1));
  const token = params.get('token') ?? '';
  const fingerprint = params.get('fp') ?? params.get('cert_sha256');
  const connectionMode: ConnectionMode = isTryCloudflareHost(url.hostname)
    ? 'tunnel'
    : 'lan';
  const port = url.port
    ? Number.parseInt(url.port, 10)
    : url.protocol === 'https:'
      ? 443
      : 80;
  return validatePairInfo({
    connectionMode,
    // WHATWG URL keeps IPv6 hostnames bracketed ("[::1]"); store the bare
    // address so baseUrl()'s own bracketing doesn't double-wrap it.
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    scheme: url.protocol === 'https:' ? 'https' : 'http',
    token,
    certFingerprintSha256: fingerprint,
  });
}

/**
 * Apply the pairing fragment from a QR-opened URL. Once a token is detected,
 * the fragment is stripped even when policy validation rejects the pair so a
 * secret can never remain in browser history or the address bar.
 */
export function tryAutoPairFromHash(): PairInfo | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (!hash || !hash.startsWith('#')) return null;
  const params = new URLSearchParams(hash.slice(1));
  if (!params.get('token')) return null;

  try {
    const pair = parsePairingUrl(window.location.href);
    return savePair(pair);
  } catch {
    return null;
  } finally {
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search,
    );
  }
}

export function baseUrl(pairInput?: PairInfo | null): string {
  const pair = pairInput ? validatePairInfo(pairInput) : loadPair();
  if (!pair) throw new Error('not paired');
  const host = pair.host.includes(':') ? `[${pair.host}]` : pair.host;
  return pair.port === 443
    ? `https://${host}`
    : `https://${host}:${pair.port}`;
}

export function authHeader(pairInput?: PairInfo | null): HeadersInit {
  const pair = pairInput ? validatePairInfo(pairInput) : loadPair();
  if (!pair) throw new Error('not paired');
  return { Authorization: `Bearer ${pair.token}` };
}
