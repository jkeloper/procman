// Pairing state — stored in localStorage.

const KEY = 'procman.pair';

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
  return `http://${pair.host}:${pair.port}`;
}

export function authHeader(p?: PairInfo | null): HeadersInit {
  const pair = p ?? loadPair();
  if (!pair) throw new Error('not paired');
  return { Authorization: `Bearer ${pair.token}` };
}
