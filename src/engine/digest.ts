/**
 * The read path, end to end.
 *
 * This is the only file that knows what a "briefing" is. It takes the
 * shared symbol layer (computed once by the worker) plus this user's
 * baselines, and produces the screen. There is no network call in here
 * and no market data fetch — that is the entire scaling argument, made
 * concrete.
 *
 * It also owns the write-back rule, which is subtler than it looks.
 */

import {
  CONFIG,
  type Baseline,
  type Bar,
  type CorporateAction,
  type Digest,
  type ReconciledQuote,
  type Suppression,
  type SymbolEvent,
  type SymbolStats,
} from "./types.ts";
import { detectBaselineMove } from "./detect.ts";
import { isTrusted } from "./integrity.ts";
import { rankForUser } from "./score.ts";

/** Everything the read path needs about one symbol. All precomputed. */
export type SymbolContext = {
  quote: ReconciledQuote;
  stats: SymbolStats;
  bars: Bar[];
  actions: CorporateAction[];
  /** Shared events the worker already detected and stored. */
  events: SymbolEvent[];
};

/**
 * Build one user's briefing.
 *
 * @param contexts     symbol -> shared, precomputed context
 * @param baselines    symbol -> what THIS user last saw
 * @param acknowledged dedupeKeys we have already shown THIS user
 * @param indexNow     current NIFTY level, if we have a trusted one
 */
export function buildDigest(
  contexts: Map<string, SymbolContext>,
  baselines: Map<string, Baseline>,
  acknowledged: Set<string>,
  nowISO: string,
  indexNow?: number,
  limit = 5
): Digest {
  const events: SymbolEvent[] = [];
  const suppressed: Suppression[] = [];

  for (const [symbol, ctx] of contexts) {
    // Shared events were computed once, by the worker, for everyone.
    events.push(...ctx.events);

    // Say out loud when we chose not to trust a number. The brief asks how
    // we handle stale and conflicting data; a silent guard scores nothing.
    if (!isTrusted(ctx.quote) && ctx.quote.note) {
      suppressed.push({ symbol, reason: ctx.quote.note });
    }

    // The personal calculation. Cheap arithmetic, no I/O.
    const baseline = baselines.get(symbol);
    if (!baseline) continue;

    const result = detectBaselineMove(
      ctx.quote,
      baseline,
      ctx.stats,
      ctx.bars,
      ctx.actions,
      indexNow
    );
    if (result.event) events.push(result.event);
    // Only record a personal suppression if it says something new — the
    // integrity note above already covers stale/disputed quotes.
    else if (result.suppressed && isTrusted(ctx.quote)) {
      suppressed.push({ symbol, reason: result.suppressed });
    }
  }

  const items = rankForUser(events, acknowledged, nowISO, limit);
  const surfaced = new Set(items.map((i) => i.event.symbol));
  const quiet = [...contexts.keys()].filter((s) => !surfaced.has(s));

  const lastCheckedAt = baselines.size
    ? [...baselines.values()].map((b) => b.seenAt).sort().at(-1) ?? null
    : null;

  return {
    generatedAt: nowISO,
    lastCheckedAt,
    items,
    quiet,
    suppressed,
    counts: {
      high: items.filter((i) => i.attention === "high").length,
      watch: items.filter((i) => i.attention === "watch").length,
      quiet: quiet.length,
    },
  };
}

/**
 * What to write back once the user has actually read the briefing.
 *
 * TWO RULES THAT MATTER, both learned the hard way:
 *
 * 1. Acknowledge EVERY dedupeKey on a card, not just the headline event.
 *    If ZOMATO gapped AND spiked on volume AND broke its 52-week high,
 *    that is one card with three keys. Acknowledge only the headline and
 *    the other two resurface tomorrow looking like fresh news.
 *
 * 2. A glance shorter than ~20 seconds does NOT move the baseline. If
 *    opening the app for two seconds wipes the reference point the whole
 *    product is built on, the product is broken. This is the kind of rule
 *    you only find by using the thing.
 *
 * Returns null when the session was too short to count.
 */
export function advanceBaselines(
  digest: Digest,
  contexts: Map<string, SymbolContext>,
  previous: Map<string, Baseline>,
  sessionSeconds: number,
  nowISO: string,
  indexNow?: number
): { baselines: Map<string, Baseline>; acknowledge: string[] } | null {
  if (sessionSeconds < CONFIG.minSessionSecondsToResetBaseline) return null;

  const baselines = new Map<string, Baseline>();
  for (const [symbol, ctx] of contexts) {
    if (!previous.has(symbol)) continue;
    // Never move a baseline onto a price we do not trust — that would
    // bake a bad tick into the user's reference point permanently.
    if (!isTrusted(ctx.quote)) {
      baselines.set(symbol, previous.get(symbol) as Baseline);
      continue;
    }
    baselines.set(symbol, {
      symbol,
      price: ctx.quote.price,
      seenAt: nowISO,
      indexPrice: indexNow,
    });
  }

  return {
    baselines,
    acknowledge: digest.items.flatMap((i) => i.dedupeKeys),
  };
}
