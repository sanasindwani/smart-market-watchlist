/**
 * The ingestion worker. One process, three jobs.
 *
 * THE SCALING DECISION LIVES HERE, IN ONE LINE:
 *
 *     const symbols = await distinctWatchedSymbols();
 *
 * We poll the DISTINCT UNION of everything anyone watches. Ten thousand
 * users watching two hundred NSE names is two hundred polls, fanned out to
 * subscribers. The naive design polls per user per symbol, so cost grows as
 * (users × symbols) and you hit Yahoo's rate limit at roughly ten users.
 *
 * Nothing in here knows what a user is.
 */

import { prisma } from "../server/prisma.ts";
import { buildProviders, type MarketProvider } from "../data/providers.ts";
import { INDEX_SYMBOL, lookup } from "../data/universe.ts";
import { computeStats } from "../engine/stats.ts";
import { reconcile, shouldWrite } from "../engine/integrity.ts";
import { detectSymbolEvents } from "../engine/detect.ts";
import type { Bar, CorporateAction, SourceQuote } from "../engine/types.ts";

const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 60);
const BACKFILL_DAYS = 250;

const providers: MarketProvider[] = buildProviders();

// ─────────────────────────────────────────────────────────────────────────
// Symbol registration + backfill
// ─────────────────────────────────────────────────────────────────────────

/**
 * Called when a user adds a symbol nobody was watching yet. Backfills
 * history once, then the poll loop picks it up like any other symbol.
 */
export async function ensureSymbol(symbol: string): Promise<void> {
  const existing = await prisma.symbol.findUnique({ where: { symbol } });
  if (existing) return;

  const listing = lookup(symbol);
  await prisma.symbol.create({
    data: {
      symbol,
      name: listing?.name ?? symbol,
      isIndex: symbol === INDEX_SYMBOL,
    },
  });

  await backfill(symbol);
}

/** 250 sessions of daily bars plus a year of corporate actions. */
export async function backfill(symbol: string): Promise<void> {
  let bars: Bar[] = [];
  let actions: CorporateAction[] = [];

  for (const p of providers) {
    if (bars.length === 0) bars = await p.bars(symbol, BACKFILL_DAYS);
    if (actions.length === 0) actions = await p.actions(symbol);
  }
  if (bars.length === 0) {
    console.warn(`[backfill] no history for ${symbol}`);
    return;
  }

  await prisma.bar.createMany({
    data: bars.map((b) => ({ symbol, ...b })),
    skipDuplicates: true,
  });

  for (const a of actions) {
    await prisma.corporateAction.upsert({
      where: { symbol_date_type: { symbol, date: a.date, type: a.type } },
      create: { symbol, date: a.date, type: a.type, ratio: a.ratio, amount: a.amount },
      update: {},
    });
  }

  await recomputeStats(symbol);
  console.log(`[backfill] ${symbol}: ${bars.length} bars, ${actions.length} actions`);
}

// ─────────────────────────────────────────────────────────────────────────
// Nightly statistics
// ─────────────────────────────────────────────────────────────────────────

/**
 * Volatility, average volume, 52-week range. Slow-moving by nature, so it
 * runs once a night rather than on every page load.
 *
 * Note we pass the index's bars in: `idioVol` measures how much this stock
 * moves AFTER the market's move is removed, which is the denominator the
 * detection engine actually wants.
 */
export async function recomputeStats(symbol: string): Promise<void> {
  const [bars, actions, indexBars] = await Promise.all([
    prisma.bar.findMany({ where: { symbol }, orderBy: { date: "asc" } }),
    prisma.corporateAction.findMany({ where: { symbol } }),
    symbol === INDEX_SYMBOL
      ? Promise.resolve([])
      : prisma.bar.findMany({
          where: { symbol: INDEX_SYMBOL },
          orderBy: { date: "asc" },
        }),
  ]);
  if (bars.length < 30) return;

  const s = computeStats(
    symbol,
    bars as Bar[],
    actions.map((a) => ({
      symbol,
      date: a.date,
      type: a.type as "split" | "dividend",
      ratio: a.ratio ?? undefined,
      amount: a.amount ?? undefined,
    })),
    indexBars.length ? (indexBars as Bar[]) : undefined
  );

  await prisma.symbolStat.upsert({
    where: { symbol },
    create: { ...s },
    update: { ...s },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// The poll loop
// ─────────────────────────────────────────────────────────────────────────

async function distinctWatchedSymbols(): Promise<string[]> {
  const rows = await prisma.watchlistItem.findMany({
    distinct: ["symbol"],
    select: { symbol: true },
  });
  // The index is always polled, whether or not anyone "watches" it.
  return [...new Set([INDEX_SYMBOL, ...rows.map((r) => r.symbol)])];
}

export async function pollSymbol(symbol: string): Promise<void> {
  // Ask every provider. A dead provider returns null and we carry on with
  // whatever is left — one bad API must not take the loop down.
  const settled = await Promise.all(providers.map((p) => p.quote(symbol)));
  const quotes = settled.filter((q): q is SourceQuote => q !== null);
  if (quotes.length === 0) return;

  const reconciled = reconcile(symbol, quotes, new Date().toISOString());
  if (!reconciled) return;

  // Out-of-order guard. Providers retry, and a late reply overwriting a
  // newer price is a classic silent bug that produces phantom moves.
  const stored = await prisma.quote.findUnique({ where: { symbol } });
  if (!shouldWrite(reconciled.asOf, stored?.asOf.toISOString() ?? null)) return;

  await prisma.quote.upsert({
    where: { symbol },
    create: {
      symbol,
      price: reconciled.price,
      volume: reconciled.volumeToday,
      asOf: new Date(reconciled.asOf),
      status: reconciled.status,
      note: reconciled.note,
      sources: reconciled.sources,
    },
    update: {
      price: reconciled.price,
      volume: reconciled.volumeToday,
      asOf: new Date(reconciled.asOf),
      status: reconciled.status,
      note: reconciled.note,
      sources: reconciled.sources,
    },
  });

  if (symbol === INDEX_SYMBOL) return; // the index generates no events itself

  const [stat, bars, actions, indexQuote, indexStat] = await Promise.all([
    prisma.symbolStat.findUnique({ where: { symbol } }),
    prisma.bar.findMany({ where: { symbol }, orderBy: { date: "asc" } }),
    prisma.corporateAction.findMany({ where: { symbol } }),
    prisma.quote.findUnique({ where: { symbol: INDEX_SYMBOL } }),
    prisma.symbolStat.findUnique({ where: { symbol: INDEX_SYMBOL } }),
  ]);
  if (!stat) return;

  const market =
    indexQuote && indexStat
      ? { price: indexQuote.price, lastClose: indexStat.lastClose }
      : undefined;

  const events = detectSymbolEvents(
    reconciled,
    stat,
    bars as Bar[],
    actions.map((a) => ({
      symbol,
      date: a.date,
      type: a.type as "split" | "dividend",
      ratio: a.ratio ?? undefined,
      amount: a.amount ?? undefined,
    })),
    market
  );

  // Idempotent by dedupeKey. Running the worker twice cannot double-fire.
  for (const e of events) {
    await prisma.symbolEvent.upsert({
      where: { dedupeKey: e.dedupeKey },
      create: {
        symbol: e.symbol,
        kind: e.kind,
        at: new Date(e.at),
        magnitude: e.magnitude,
        detail: e.detail,
        dedupeKey: e.dedupeKey,
      },
      update: {}, // an event that already exists is never rewritten
    });
  }
}

export async function pollAll(): Promise<void> {
  const symbols = await distinctWatchedSymbols();
  // The index first: every other symbol's gap calculation depends on it.
  const ordered = [
    INDEX_SYMBOL,
    ...symbols.filter((s) => s !== INDEX_SYMBOL),
  ];

  for (const symbol of ordered) {
    try {
      await pollSymbol(symbol);
    } catch (err) {
      // One symbol failing must never stop the others.
      console.error(`[poll] ${symbol} failed:`, (err as Error).message);
    }
  }
  console.log(`[poll] ${ordered.length} symbols at ${new Date().toISOString()}`);
}

async function nightly(): Promise<void> {
  const symbols = await prisma.symbol.findMany({ select: { symbol: true } });
  // The index is recomputed first so every other idioVol uses fresh numbers.
  await recomputeStats(INDEX_SYMBOL);
  for (const { symbol } of symbols) {
    if (symbol === INDEX_SYMBOL) continue;
    try {
      await backfill(symbol); // top up bars, then recompute
    } catch (err) {
      console.error(`[nightly] ${symbol}:`, (err as Error).message);
    }
  }
  console.log("[nightly] stats recomputed");
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

if (process.argv[1]?.includes("worker")) {
  console.log(
    `[worker] starting, polling every ${POLL_SECONDS}s via ${providers.map((p) => p.name).join(" + ")}`
  );

  await pollAll();
  setInterval(() => void pollAll(), POLL_SECONDS * 1000);

  // Crude but honest: check every 30 minutes whether we have crossed 02:00
  // IST since the last run. A real deployment would use a cron trigger.
  let lastNightly = "";
  setInterval(
    () => {
      const ist = new Date(Date.now() + 5.5 * 3600_000);
      const day = ist.toISOString().slice(0, 10);
      if (ist.getUTCHours() === 2 && day !== lastNightly) {
        lastNightly = day;
        void nightly();
      }
    },
    30 * 60 * 1000
  );
}
