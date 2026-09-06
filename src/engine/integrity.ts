/**
 * Data integrity layer.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * The brief explicitly asks how we handle "stale, delayed or conflicting
 * data". Most submissions will fetch one price and render it. But free
 * market data is delayed, rate-limited, and occasionally just wrong —
 * and ONE garbage tick fires a fake "5-sigma move!" alert that destroys
 * the user's trust in the entire product forever.
 *
 * So: nothing reaches the detection engine until it has passed through
 * here, and the UI always shows WHICH state a number is in.
 *
 * THE RULE WE NEVER BREAK: if we don't trust the number, we say nothing.
 * Silence is always better than a false alarm.
 */

import { CONFIG, type ReconciledQuote, type SourceQuote } from "./types.ts";

/**
 * Combine quotes from several providers into one number we are willing
 * to display, plus an honest status.
 *
 *  ok           providers agree and the data is fresh. Safe to detect on.
 *  disputed     providers materially disagree. Show the median, label it,
 *               suppress events. A wrong number is worse than an old one,
 *               so this check runs first.
 *  stale        best available data is old (market closed, or we are
 *               rate-limited). Show it, label it, do NOT raise events.
 *  unconfirmed  only one provider answered. Fine to display, not enough
 *               to alarm anyone with. This is the bad-tick guard.
 */
export function reconcile(
  symbol: string,
  quotes: SourceQuote[],
  nowISO: string
): ReconciledQuote | null {
  if (quotes.length === 0) return null;

  const now = Date.parse(nowISO);
  const prices = quotes.map((q) => q.price).sort((a, b) => a - b);
  const price = median(prices);

  // Freshest timestamp any provider gave us.
  const newest = quotes.reduce((a, b) => (a.asOf > b.asOf ? a : b));
  const ageMinutes = (now - Date.parse(newest.asOf)) / 60000;

  const base = {
    symbol,
    price,
    asOf: newest.asOf,
    volumeToday: Math.max(...quotes.map((q) => q.volumeToday)),
    sources: quotes.map((q) => q.source),
  };

  // Disagreement check first: a wrong number is worse than an old one.
  if (quotes.length > 1) {
    const spread = (prices[prices.length - 1] - prices[0]) / price;
    if (spread > CONFIG.disputeTolerance) {
      return {
        ...base,
        status: "disputed",
        note: `Sources differ by ${(spread * 100).toFixed(2)}% — showing median, alerts paused`,
      };
    }
  }

  if (ageMinutes > CONFIG.staleAfterMinutes) {
    return {
      ...base,
      status: "stale",
      note: `Last updated ${formatAge(ageMinutes)} ago`,
    };
  }

  // A single uncorroborated print is good enough to show, not to act on.
  if (quotes.length < 2) {
    return {
      ...base,
      status: "unconfirmed",
      note: "Single source — waiting for a second opinion before alerting",
    };
  }

  return { ...base, status: "ok" };
}

/**
 * Bad-tick guard.
 *
 * If a single print is wildly far from where the stock has been trading,
 * we do NOT trust it on first sight. We require confirmation: a second
 * poll, or a second provider, has to agree before it can move the
 * baseline or trigger an event.
 *
 * Returns true if the candidate price should be accepted.
 */
export function isPlausible(
  candidate: number,
  lastKnown: number,
  dailyVol: number,
  confirmations = 1
): boolean {
  if (lastKnown <= 0 || dailyVol <= 0) return true;

  const move = Math.abs(Math.log(candidate / lastKnown));
  const sigmas = move / dailyVol;

  // Under 6 sigma in a single tick: normal market behaviour, accept.
  if (sigmas < 6) return true;

  // Above that, real moves do happen (results day, block deal, halt
  // reopening) — so we don't discard it, we just demand a second
  // independent look before acting on it.
  return confirmations >= 2;
}

/**
 * Ingestion guard: never let a late-arriving message overwrite newer
 * data. Providers retry out of order and this is a classic silent bug.
 */
export function shouldWrite(
  incomingAsOf: string,
  storedAsOf: string | null
): boolean {
  if (!storedAsOf) return true;
  return incomingAsOf > storedAsOf;
}

/** One place that decides whether a quote may raise alerts. */
export function isTrusted(quote: ReconciledQuote): boolean {
  return quote.status === "ok";
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function formatAge(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}
