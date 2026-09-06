/** Thin fetch wrapper. Token lives in localStorage; all real state is server-side. */

const KEY = "watchlist.token";

export function getToken(): string | null {
  return localStorage.getItem(KEY);
}
export function setToken(t: string | null) {
  if (t) localStorage.setItem(KEY, t);
  else localStorage.removeItem(KEY);
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "Something went wrong");
  return body as T;
}

export const api = {
  register: (email: string, password: string) =>
    call<{ token: string; email: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    call<{ token: string; email: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  digest: () => call<Digest>("/digest"),
  markRead: (sessionSeconds: number) =>
    call<{ advanced: boolean; acknowledged: number }>("/digest/read", {
      method: "POST",
      body: JSON.stringify({ sessionSeconds }),
    }),

  watchlist: () => call<WatchRow[]>("/watchlist"),
  add: (symbol: string) =>
    call("/watchlist", { method: "POST", body: JSON.stringify({ symbol }) }),
  remove: (symbol: string) => call(`/watchlist/${symbol}`, { method: "DELETE" }),
  searchSymbols: (q: string) =>
    call<Listing[]>(`/symbols?q=${encodeURIComponent(q)}`),
  detail: (symbol: string) => call<Detail>(`/symbols/${symbol}`),
  addAlert: (symbol: string, value: number, direction: "above" | "below") =>
    call("/alerts", {
      method: "POST",
      body: JSON.stringify({ symbol, value, direction }),
    }),

  advanceClock: (minutes: number) =>
    call<{ offsetMinutes: number }>("/demo/advance", {
      method: "POST",
      body: JSON.stringify({ minutes }),
    }),
  resetClock: () => call<{ offsetMinutes: number }>("/demo/reset", { method: "POST" }),
  health: () => call<{ demo: boolean; symbols: number }>("/health"),
};

// ── shapes returned by the API ───────────────────────────────────────────

export type Listing = { symbol: string; name: string; sector: string };

export type WatchRow = {
  symbol: string;
  name: string;
  quote: { price: number; asOf: string; status: string; note?: string } | null;
};

export type DigestItem = {
  event: { symbol: string; kind: string; at: string; magnitude: number };
  score: number;
  attention: "high" | "watch" | "normal";
  headline: string;
  bullets: string[];
  dedupeKeys: string[];
};

export type Digest = {
  generatedAt: string;
  lastCheckedAt: string | null;
  items: DigestItem[];
  quiet: string[];
  suppressed: { symbol: string; reason: string }[];
  counts: { high: number; watch: number; quiet: number };
  index: { price: number; changePct: number | null } | null;
};

export type Detail = {
  symbol: string;
  name: string;
  sector: string | null;
  quote: { price: number; asOf: string; status: string; note?: string } | null;
  stat: {
    dailyVol: number;
    idioVol: number;
    avgVolume: number;
    high52w: number;
    low52w: number;
    lastClose: number;
  } | null;
  bars: { date: string; close: number }[];
  events: { id: string; kind: string; at: string; magnitude: number }[];
  baseline: { price: number; seenAt: string } | null;
  levels: { id: string; value: number; direction: string }[];
};

export const rupees = (n: number) =>
  `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function ago(iso: string, from = Date.now()): string {
  const mins = Math.max(0, Math.round((from - Date.parse(iso)) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return h === 1 ? "an hour ago" : `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
