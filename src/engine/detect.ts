/**
 * THE CORE OF THE PRODUCT.
 *
 * Notice that this file has TWO main exported functions, and the split
 * between them IS our scaling architecture:
 *
 *   detectSymbolEvents()  - facts that are true for EVERYBODY watching
 *                           this symbol (it gapped, volume was 4x, it
 *                           broke its 52-week high). Computed ONCE per
 *                           symbol by the worker, stored, and reused by
 *                           every user who watches it.
 *
 *   detectBaselineMove()  - the one thing that is genuinely personal:
 *                           how far it has moved since THIS user last
 *                           looked. Cheap arithmetic, computed at read
 *                           time. No network call in the request path.
 *
 * The naive design recomputes everything per user per symbol, so cost
 * grows as (users x symbols) and you die at ~10 users. Ours grows as
 * (distinct symbols). 10,000 users watching 200 unique NSE symbols is
 * 200 polls, not 2,000,000.
 */

import {
  CONFIG,
  type Bar,
  type Baseline,
  type CorporateAction,
  type ReconciledQuote,
  type SymbolEvent,
  type SymbolStats,
} from "./types.ts";
import { isTrusted } from "./integrity.ts";
import { tradingDaysBetween } from "./stats.ts";

/**
 * Shared, user-agnostic events for one symbol.
 * Run this in the worker after each successful poll.
 */
export function detectSymbolEvents(
  quote: ReconciledQuote,
  stats: SymbolStats,
  bars: Bar[],
  actions: CorporateAction[],
  /** Where NIFTY is now vs its own last close. Shared, so it belongs here. */
  market?: { price: number; lastClose: number }
): SymbolEvent[] {
  const events: SymbolEvent[] = [];
  const day = quote.asOf.slice(0, 10);

  // --- CORPORATE ACTIONS -------------------------------------------------
  // DELIBERATELY ABOVE THE INTEGRITY GATE. A split is a fact published by
  // the exchange, not an inference from a price we might not trust. If the
  // feed is stale we still owe the user the explanation for why their
  // stored price is suddenly half of today's — otherwise the ONE case the
  // whole adjustment machinery exists for goes unexplained.
  for (const action of actions) {
    if (action.date !== day) continue;
    events.push({
      symbol: quote.symbol,
      kind: "CORPORATE_ACTION",
      at: quote.asOf,
      magnitude: action.ratio ?? action.amount ?? 0,
      detail: {
        type: action.type,
        ratio: action.ratio ?? 0,
        amount: action.amount ?? 0,
      },
      dedupeKey: `${quote.symbol}:CORPORATE_ACTION:${action.type}:${action.date}`,
    });
  }

  // GOLDEN RULE: everything below here is inferred from a price. If we
  // don't trust the number, we raise nothing. Silence beats a false alarm.
  if (!isTrusted(quote)) return events;

  // --- 1. GAP: a large move in a SINGLE session ---------------------
  // Why separate from cumulative drift? Because 5% overnight is news,
  // and 5% drifting over three weeks is not. Same number, different
  // event, and the user cares about them differently.
  //
  // The market's own session move is subtracted first. A stock up 3% on a
  // day NIFTY is up 2.9% did not gap — the market did. This is the same
  // correction the personal layer applies, and it has to live here too or
  // the two layers will contradict each other on screen.
  if (stats.lastClose > 0) {
    const sessionMove = Math.log(quote.price / stats.lastClose);

    const hasMarket = market && market.price > 0 && market.lastClose > 0;
    const marketMove = hasMarket
      ? Math.log(market.price / market.lastClose)
      : 0;
    const excess = sessionMove - CONFIG.beta * marketMove;

    // Match the denominator to the numerator.
    const vol = hasMarket ? stats.idioVol : stats.dailyVol;
    const sigmas = vol > 0 ? excess / vol : 0;

    if (vol > 0 && Math.abs(sigmas) >= CONFIG.gapSigma) {
      events.push({
        symbol: quote.symbol,
        kind: "GAP",
        at: quote.asOf,
        magnitude: sigmas,
        detail: {
          pct: (Math.exp(sessionMove) - 1) * 100,
          indexPct: (Math.exp(marketMove) - 1) * 100,
          excessPct: (Math.exp(excess) - 1) * 100,
          relative: hasMarket ? 1 : 0,
          sigmas,
          from: stats.lastClose,
          to: quote.price,
        },
        dedupeKey: `${quote.symbol}:GAP:${day}`,
      });
    }
  }

  // --- 2. VOLUME SPIKE ----------------------------------------------
  // Unusual participation often shows up before the story is public.
  if (stats.avgVolume > 0) {
    const ratio = quote.volumeToday / stats.avgVolume;
    if (ratio >= CONFIG.volumeMultiple) {
      events.push({
        symbol: quote.symbol,
        kind: "VOLUME_SPIKE",
        at: quote.asOf,
        magnitude: ratio,
        detail: { ratio, volume: quote.volumeToday, average: stats.avgVolume },
        dedupeKey: `${quote.symbol}:VOLUME_SPIKE:${day}`,
      });
    }
  }

  // --- 3. 52-WEEK RANGE BREAK ---------------------------------------
  // A structural level, not a statistical one. People genuinely care.
  if (quote.price > stats.high52w) {
    events.push({
      symbol: quote.symbol,
      kind: "RANGE_BREAK",
      at: quote.asOf,
      magnitude: 1,
      detail: { direction: "high", level: stats.high52w, price: quote.price },
      dedupeKey: `${quote.symbol}:RANGE_BREAK:high:${day}`,
    });
  } else if (quote.price < stats.low52w) {
    events.push({
      symbol: quote.symbol,
      kind: "RANGE_BREAK",
      at: quote.asOf,
      magnitude: -1,
      detail: { direction: "low", level: stats.low52w, price: quote.price },
      dedupeKey: `${quote.symbol}:RANGE_BREAK:low:${day}`,
    });
  }

  return events;
}

/**
 * The outcome of the personal calculation. We return the suppression
 * reason as well as the event, because "we looked and deliberately said
 * nothing, here's why" is information the UI should show. Handling an
 * edge case invisibly earns nothing in a three-minute review.
 */
export type BaselineResult = {
  event: SymbolEvent | null;
  suppressed?: string;
};

/**
 * THE PERSONAL BIT. How far has this moved since *you* last looked?
 *
 * Three things make this better than a naive percentage:
 *
 *  1. We divide by the stock's own expected volatility over the elapsed
 *     window, so the threshold adapts to both the stock AND how long
 *     the user has been away. Being away a week should require a bigger
 *     move to be "surprising" than being away an hour.
 *
 *  2. We subtract the market's move first. A stock up 3% on a day NIFTY
 *     is up 2.8% has told you nothing. Up 3% while NIFTY is flat is a
 *     real, stock-specific event. Same headline number, opposite meaning.
 *
 *  3. We adjust the stored baseline for splits before comparing. Without
 *     this, a 1:2 split shows every user a fake -50% crash. This is the
 *     single most common way a watchlist like this embarrasses itself.
 */
export function detectBaselineMove(
  quote: ReconciledQuote,
  baseline: Baseline,
  stats: SymbolStats,
  bars: Bar[],
  actions: CorporateAction[],
  indexNow?: number
): BaselineResult {
  if (!isTrusted(quote)) {
    return { event: null, suppressed: quote.note ?? `quote is ${quote.status}` };
  }

  const adjustedBaseline = adjustBaseline(baseline, actions);
  if (adjustedBaseline <= 0) return { event: null };

  const sessions = tradingDaysBetween(bars, baseline.seenAt, quote.asOf);
  const actualMove = Math.log(quote.price / adjustedBaseline);

  // Strip out the market. Only possible if we stored the index level at
  // the moment they last looked — which costs one extra column.
  const canCompare =
    baseline.indexPrice !== undefined &&
    baseline.indexPrice > 0 &&
    indexNow !== undefined &&
    indexNow > 0;

  const indexMove = canCompare
    ? Math.log((indexNow as number) / (baseline.indexPrice as number))
    : 0;
  const excessMove = actualMove - CONFIG.beta * indexMove;

  // Match the denominator to the numerator: excess return is measured
  // against the volatility OF the excess return, not of the raw price.
  const vol = canCompare ? stats.idioVol : stats.dailyVol;
  if (vol <= 0) return { event: null };

  const expectedMove = vol * Math.sqrt(sessions);
  const sigmas = excessMove / expectedMove;

  if (Math.abs(sigmas) < CONFIG.moveSigma) {
    // The interesting near-miss: it moved a lot in absolute terms but the
    // whole market did too. Saying so is more useful than saying nothing.
    const rawSigmas = actualMove / (stats.dailyVol * Math.sqrt(sessions));
    if (canCompare && Math.abs(rawSigmas) >= CONFIG.moveSigma) {
      return {
        event: null,
        suppressed:
          `moved ${pct(actualMove)} but NIFTY moved ${pct(indexMove)} — ` +
          `that is the market, not the stock`,
      };
    }
    return { event: null };
  }

  return {
    event: {
      symbol: quote.symbol,
      kind: "PRICE_MOVE",
      at: quote.asOf,
      magnitude: sigmas,
      detail: {
        pct: (Math.exp(actualMove) - 1) * 100,
        indexPct: (Math.exp(indexMove) - 1) * 100,
        excessPct: (Math.exp(excessMove) - 1) * 100,
        relative: canCompare ? 1 : 0,
        sigmas,
        sessions,
        from: adjustedBaseline,
        to: quote.price,
        seenAt: baseline.seenAt,
        wasAdjusted: adjustedBaseline !== baseline.price ? 1 : 0,
      },
      dedupeKey: `${quote.symbol}:PRICE_MOVE:${baseline.seenAt}`,
    },
  };
}

/**
 * Restate an old baseline price in today's share terms.
 * Called before ANY comparison against a stored price.
 */
export function adjustBaseline(
  baseline: Baseline,
  actions: CorporateAction[]
): number {
  const factor = actions
    .filter(
      (a) =>
        a.type === "split" && a.ratio && a.date > baseline.seenAt.slice(0, 10)
    )
    .reduce((acc, a) => acc * (a.ratio as number), 1);

  return baseline.price / factor;
}

/** A price level the user set themselves. Always high priority. */
export function detectLevelCross(
  quote: ReconciledQuote,
  level: { value: number; direction: "above" | "below" },
  previousPrice: number
): SymbolEvent | null {
  if (!isTrusted(quote)) return null;

  const crossedUp =
    level.direction === "above" &&
    previousPrice <= level.value &&
    quote.price > level.value;
  const crossedDown =
    level.direction === "below" &&
    previousPrice >= level.value &&
    quote.price < level.value;

  if (!crossedUp && !crossedDown) return null;

  return {
    symbol: quote.symbol,
    kind: "LEVEL_CROSS",
    at: quote.asOf,
    magnitude: quote.price - level.value,
    detail: { level: level.value, direction: level.direction, price: quote.price },
    dedupeKey: `${quote.symbol}:LEVEL_CROSS:${level.direction}:${level.value}:${quote.asOf.slice(0, 10)}`,
  };
}

function pct(logMove: number): string {
  const p = (Math.exp(logMove) - 1) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}
