/**
 * Market data providers, behind ONE interface.
 *
 * Two real providers is not gold-plating. It is what makes the "conflicting
 * data" story real instead of hypothetical — with a single source you can
 * never actually demonstrate a disputed quote.
 *
 * The third provider, `seed`, is deterministic and offline. It exists so
 * the whole app runs on a laptop with no API keys and no internet, and so
 * the demo shows a 3σ move in ten seconds instead of waiting for the market.
 */

import type { Bar, CorporateAction, SourceQuote } from "../engine/types.ts";

export interface MarketProvider {
  readonly name: string;
  /** Latest price. Returns null rather than throwing — one dead provider
   *  must never take the poll loop down. */
  quote(symbol: string): Promise<SourceQuote | null>;
  /** Daily history, most recent last. */
  bars(symbol: string, days: number): Promise<Bar[]>;
  /** Splits and dividends. Only Yahoo gives us these for NSE. */
  actions(symbol: string): Promise<CorporateAction[]>;
}

/** NSE symbols need the .NS suffix on Yahoo. NIFTY is ^NSEI. */
export function toYahoo(symbol: string): string {
  if (symbol === "NIFTY") return "^NSEI";
  return `${symbol}.NS`;
}

// ─────────────────────────────────────────────────────────────────────────
// Yahoo — primary. Free, no key, and the only one that gives us splits.
// ─────────────────────────────────────────────────────────────────────────

export class YahooProvider implements MarketProvider {
  readonly name = "yahoo";

  async quote(symbol: string): Promise<SourceQuote | null> {
    try {
      const yf = (await import("yahoo-finance2")).default;
      const q = await yf.quote(toYahoo(symbol));
      if (!q?.regularMarketPrice) return null;
      return {
        source: this.name,
        price: q.regularMarketPrice,
        // The provider's own timestamp, never our clock. If Yahoo says this
        // price is from 15 minutes ago, the user needs to know that.
        asOf: new Date(
          (q.regularMarketTime as unknown as Date) ?? Date.now()
        ).toISOString(),
        volumeToday: q.regularMarketVolume ?? 0,
      };
    } catch {
      return null;
    }
  }

  async bars(symbol: string, days: number): Promise<Bar[]> {
    try {
      const yf = (await import("yahoo-finance2")).default;
      const from = new Date(Date.now() - days * 1.5 * 86_400_000);
      const rows = await yf.chart(toYahoo(symbol), {
        period1: from,
        interval: "1d",
      });
      return (rows.quotes ?? [])
        .filter((r: any) => r.close != null)
        .map((r: any) => ({
          date: new Date(r.date).toISOString().slice(0, 10),
          open: r.open ?? r.close,
          high: r.high ?? r.close,
          low: r.low ?? r.close,
          close: r.close,
          volume: r.volume ?? 0,
        }));
    } catch {
      return [];
    }
  }

  async actions(symbol: string): Promise<CorporateAction[]> {
    try {
      const yf = (await import("yahoo-finance2")).default;
      const from = new Date(Date.now() - 400 * 86_400_000);
      const res = await yf.chart(toYahoo(symbol), {
        period1: from,
        interval: "1d",
        events: "div|split",
      });

      const out: CorporateAction[] = [];
      for (const s of res.events?.splits ?? []) {
        out.push({
          symbol,
          date: new Date((s as any).date).toISOString().slice(0, 10),
          type: "split",
          // Yahoo gives numerator/denominator; a 1:2 split is 2/1 = 2.
          ratio: (s as any).numerator / (s as any).denominator,
        });
      }
      for (const d of res.events?.dividends ?? []) {
        out.push({
          symbol,
          date: new Date((d as any).date).toISOString().slice(0, 10),
          type: "dividend",
          amount: (d as any).amount,
        });
      }
      return out;
    } catch {
      return [];
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Finnhub — secondary. Exists purely so we have a second opinion.
// ─────────────────────────────────────────────────────────────────────────

export class FinnhubProvider implements MarketProvider {
  readonly name = "finnhub";
  private key: string;
  // Written out longhand rather than as a TS parameter property, because
  // Node's native type-stripping cannot handle those and we want the app
  // to run with no build step.
  constructor(key: string) {
    this.key = key;
  }

  async quote(symbol: string): Promise<SourceQuote | null> {
    if (!this.key) return null;
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=NSE:${symbol}&token=${this.key}`
      );
      if (!res.ok) return null;
      const j = (await res.json()) as { c?: number; t?: number };
      if (!j.c) return null;
      return {
        source: this.name,
        price: j.c,
        asOf: new Date((j.t ?? 0) * 1000).toISOString(),
        volumeToday: 0, // Finnhub's free tier omits volume; Yahoo covers it.
      };
    } catch {
      return null;
    }
  }

  // Finnhub's free tier does not give usable NSE history, so it only ever
  // acts as a price cross-check. Being explicit beats a silent empty array.
  async bars(): Promise<Bar[]> {
    return [];
  }
  async actions(): Promise<CorporateAction[]> {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Seed — offline, deterministic, and the reason the demo is repeatable.
// ─────────────────────────────────────────────────────────────────────────

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = (h ^ s.charCodeAt(i)) * 16777619;
  return Math.abs(h) % 100000;
}

/** Baseline price and daily volatility per symbol, so the fake data is at
 *  least plausible for NSE rather than uniformly random. */
const PROFILE: Record<string, { price: number; vol: number }> = {
  NIFTY: { price: 24_000, vol: 0.007 },
  RELIANCE: { price: 1420, vol: 0.011 },
  TCS: { price: 3800, vol: 0.011 },
  INFY: { price: 1860, vol: 0.013 },
  HDFCBANK: { price: 1650, vol: 0.01 },
  ICICIBANK: { price: 1280, vol: 0.012 },
  ZOMATO: { price: 240, vol: 0.019 },
  TATAMOTORS: { price: 980, vol: 0.016 },
  BAJFINANCE: { price: 7200, vol: 0.014 },
  SBIN: { price: 840, vol: 0.014 },
  ITC: { price: 470, vol: 0.009 },
  WIPRO: { price: 290, vol: 0.014 },
};

export class SeedProvider implements MarketProvider {
  readonly name: string;
  /** Offsets injected by the demo script to force specific behaviours. */
  private overrides: Record<string, Partial<SourceQuote>>;

  constructor(overrides: Record<string, Partial<SourceQuote>> = {}, name = "seed") {
    this.overrides = overrides;
    this.name = name;
  }

  private series(symbol: string, days: number): Bar[] {
    const p = PROFILE[symbol] ?? { price: 1000, vol: 0.013 };
    const r = rng(hash(symbol));
    const bars: Bar[] = [];
    let price = p.price;
    const start = new Date(Date.now() - days * 1.4 * 86_400_000);

    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + Math.floor(i * 1.4));
      const u1 = Math.max(r(), 1e-9);
      const shock =
        Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * r()) * p.vol;
      const open = price;
      price = price * Math.exp(shock);
      bars.push({
        date: d.toISOString().slice(0, 10),
        open,
        high: Math.max(open, price) * 1.004,
        low: Math.min(open, price) * 0.996,
        close: price,
        volume: Math.round(2_000_000 * (0.7 + r() * 0.6)),
      });
    }
    return bars;
  }

  async quote(symbol: string): Promise<SourceQuote | null> {
    const bars = this.series(symbol, 250);
    const last = bars[bars.length - 1];
    return {
      source: this.name,
      price: last.close,
      asOf: new Date().toISOString(),
      volumeToday: last.volume,
      ...this.overrides[symbol],
    };
  }

  async bars(symbol: string, days: number): Promise<Bar[]> {
    return this.series(symbol, days);
  }

  async actions(): Promise<CorporateAction[]> {
    return [];
  }
}

/**
 * Which providers are live is an environment decision, not a code one.
 * No keys and no internet still gives you a working app.
 */
export function buildProviders(): MarketProvider[] {
  if (process.env.DATA_SOURCE === "seed") {
    // Two seed providers so the reconciliation path is genuinely exercised
    // offline — otherwise every quote would be "unconfirmed".
    return [new SeedProvider({}, "seed"), new SeedProvider({}, "seed-b")];
  }
  const list: MarketProvider[] = [new YahooProvider()];
  if (process.env.FINNHUB_API_KEY) {
    list.push(new FinnhubProvider(process.env.FINNHUB_API_KEY));
  }
  return list;
}
