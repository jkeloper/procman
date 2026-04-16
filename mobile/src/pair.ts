// Pairing state — stored in localStorage.

const KEY = 'procman.pair';

/**
 * Detect a pairing payload in the current URL hash and store it
 * automatically. The desktop QR code encodes:
 *   https://procman.example.com/#token=<token>
 *
 * When a mobile camera scans the QR and opens the URL, this function
 * runs on first PWA load, extracts the token, derives host/port from
 * the URL itself, saves the pair, and strips the hash so the token
 * doesn't sit in the address bar.
 *
 * Returns the parsed pair if one was applied, otherwise null.
 */
export function tryAutoPairFromHash(): PairInfo | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (!hash || !hash.startsWith('#')) return null;
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get('token');
  if (!token) return null;
  // Pull host/port from the current location
  const loc = window.location;
  const host = loc.hostname;
  const isHttps = loc.protocol === 'https:';
  const port = loc.port
    ? parseInt(loc.port, 10)
    : isHttps
    ? 443
    : 80;
  const info: PairInfo = { host, port, token };
  savePair(info);
  // Clean the URL bar so the token isn't visible to bystanders
  history.replaceState(
    null,
    '',
    loc.pathname + loc.search,
  );
  return info;
}

export interface PairInfo {
  host: string;
  port: number;
  token: string;
}

export function savePair(info: PairInfo) {
  localStorage.setItem(KEY, JSON.stringify(info));
}

export function loadPair(): PairInfo | null {
  const s = localStorage.getItem(KEY);
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    if (
      typeof parsed.host === 'string' &&
      typeof parsed.port === 'number' &&
      typeof parsed.token === 'string'
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

export function clearPair() {
  localStorage.removeItem(KEY);
}

export function baseUrl(p?: PairInfo | null): string {
  const pair = p ?? loadPair();
  if (!pair) throw new Error('not paired');
  // Tunnel URLs use https on port 443 (no :port suffix needed)
  if (pair.port === 443) {
    return `https://${pair.host}`;
  }
  if (pair.port === 80) {
    return `http://${pair.host}`;
  }
  return `http://${pair.host}:${pair.port}`;
}

export function authHeader(p?: PairInfo | null): HeadersInit {
  const pair = p ?? loadPair();
  if (!pair) throw new Error('not paired');
  return { Authorization: `Bearer ${pair.token}` };
}
