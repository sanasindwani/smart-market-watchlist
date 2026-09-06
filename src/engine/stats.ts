/**
 * Pure statistics. No I/O. Run once a night per symbol by a job.
 *
 * WHY THIS FILE EXISTS
 * A 2% move in HDFCBANK is a real event. A 2% move in a small-cap is a
 * quiet Tuesday. A single global "alert me above 3%" threshold is the
 * naive design and it produces a useless, noisy feed. So instead we
 * measure each stock against its OWN normal behaviour.
 */

import type { Bar, CorporateAction, SymbolStats } from "./types.ts";
import { CONFIG } from "./types.ts";

/** Natural-log returns between consecutive closes. */
export function logReturns(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    const curr = bars[i].close;
    if (prev > 0 && curr > 0) out.push(Math.log(curr / prev));
  }
  return out;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Realised daily volatility over the last `window` sessions.
 * This single number is the denominator of everything the product does.
 */
export function realisedVol(bars: Bar[], window = 30): number {
  const recent = bars.slice(-(window + 1));
  return stdev(logReturns(recent));
}

export function averageVolume(bars: Bar[], window = 30): number {
  const recent = bars.slice(-window);
  if (recent.length === 0) return 0;
  return recent.reduce((a, b) => a + b.volume, 0) / recent.length;
}

/**
 * Volatility of the stock AFTER stripping out the market's move.
 *
 * WHY THIS IS THE BETTER DENOMINATOR
 * Absolute movement is misleading. A stock up 3% on a day NIFTY is up
 * 2.8% has told you almost nothing. A stock up 3% on a day NIFTY is flat
 * is a real, stock-specific event. Measuring the excess return against
 * the volatility OF the excess return separates the two cleanly.
 *
 * Falls back to plain realised vol when no index history is supplied.
 */
export function idiosyncraticVol(
  bars: Bar[],
  indexBars: Bar[] | undefined,
  window = 30,
  beta = CONFIG.beta
): number {
  if (!indexBars || indexBars.length < 2) return realisedVol(bars, window);

  const indexByDate = new Map(indexBars.map((b) => [b.date, b.close]));
  const recent = bars.slice(-(window + 1));

  const excess: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const p0 = recent[i - 1].close;
    const p1 = recent[i].close;
    const i0 = indexByDate.get(recent[i - 1].date);
    const i1 = indexByDate.get(recent[i].date);
    if (!p0 || !p1 || !i0 || !i1) continue;
    excess.push(Math.log(p1 / p0) - beta * Math.log(i1 / i0));
  }

  // Not enough overlapping sessions to trust the estimate — degrade safely.
  if (excess.length < 10) return realisedVol(bars, window);
  return stdev(excess);
}

/**
 * Build the nightly stats row for one symbol.
 *
 * NOTE the `actions` argument. Raw historical closes around a split are
 * discontinuous, and a discontinuity inflates volatility enormously —
 * which would then silently RAISE the bar for that stock and hide real
 * events for weeks. So we adjust history before measuring it.
 */
export function computeStats(
  symbol: string,
  bars: Bar[],
  actions: CorporateAction[] = [],
  indexBars?: Bar[]
): SymbolStats {
  const adjusted = adjustHistory(bars, actions);
  const window52w = adjusted.slice(-252);

  return {
    symbol,
    dailyVol: realisedVol(adjusted, 30),
    idioVol: idiosyncraticVol(adjusted, indexBars, 30),
    avgVolume: averageVolume(adjusted, 30),
    high52w: Math.max(...window52w.map((b) => b.high)),
    low52w: Math.min(...window52w.map((b) => b.low)),
    lastClose: adjusted[adjusted.length - 1].close,
  };
}

/**
 * Rewrite historical bars into today's share terms.
 *
 * A 1:2 split on 2026-06-01 means every bar BEFORE that date was quoted
 * in units of twice as many rupees per share. Divide them by the ratio
 * and the series becomes continuous again.
 */
export function adjustHistory(bars: Bar[], actions: CorporateAction[]): Bar[] {
  const splits = actions.filter((a) => a.type === "split" && a.ratio);
  if (splits.length === 0) return bars;

  return bars.map((bar) => {
    // Product of every split that happened AFTER this bar.
    const factor = splits
      .filter((s) => s.date > bar.date)
      .reduce((acc, s) => acc * (s.ratio as number), 1);

    if (factor === 1) return bar;
    return {
      ...bar,
      open: bar.open / factor,
      high: bar.high / factor,
      low: bar.low / factor,
      close: bar.close / factor,
      volume: bar.volume * factor,
    };
  });
}

/**
 * How many TRADING sessions passed between two timestamps.
 * We count real bars rather than calendar days — otherwise a user who
 * checks on Friday and returns on Monday is told three days of
 * volatility were available when only one session actually traded,
 * and every Monday morning looks artificially calm.
 */
export function tradingDaysBetween(
  bars: Bar[],
  fromISO: string,
  toISO: string
): number {
  const from = fromISO.slice(0, 10);
  const to = toISO.slice(0, 10);
  const count = bars.filter((b) => b.date > from && b.date <= to).length;
  return Math.max(count, 1); // never zero — we divide by this
}
