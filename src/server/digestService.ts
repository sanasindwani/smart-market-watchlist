/**
 * The read path.
 *
 * COUNT THE NETWORK CALLS IN THIS FILE: zero. Opening the app does not
 * touch Yahoo or Finnhub. Everything expensive was already done, once, by
 * the worker, for every user at the same time. What is left is a filtered
 * query and some arithmetic.
 *
 * That is the answer to "how does this scale for larger watchlists and
 * more users", and it is visible rather than asserted.
 */

import { prisma, nowISO } from "./prisma.ts";
import { INDEX_SYMBOL } from "../data/universe.ts";
import { buildDigest, advanceBaselines, type SymbolContext } from "../engine/digest.ts";
import { detectLevelCross } from "../engine/detect.ts";
import type {
  Bar,
  Baseline,
  CorporateAction,
  Digest,
  SymbolEvent,
} from "../engine/types.ts";

/** How far back we bother loading events. Older than this is not news. */
const EVENT_WINDOW_DAYS = 14;

export async function getDigest(userId: string, limit = 5): Promise<Digest & {
  index: { price: number; changePct: number | null } | null;
}> {
  const at = nowISO();

  const items = await prisma.watchlistItem.findMany({
    where: { userId },
    orderBy: { rank: "asc" },
  });
  const symbols = items.map((i) => i.symbol);

  if (symbols.length === 0) {
    return {
      generatedAt: at,
      lastCheckedAt: null,
      items: [],
      quiet: [],
      suppressed: [],
      counts: { high: 0, watch: 0, quiet: 0 },
      index: null,
    };
  }

  const since = new Date(Date.parse(at) - EVENT_WINDOW_DAYS * 86_400_000);

  // One round trip per table, not per symbol. With 200 watched symbols this
  // is still six queries, not twelve hundred.
  const [quotes, stats, bars, actions, events, baselineRows, ackRows, levels, indexQuote, indexStat] =
    await Promise.all([
      prisma.quote.findMany({ where: { symbol: { in: symbols } } }),
      prisma.symbolStat.findMany({ where: { symbol: { in: symbols } } }),
      prisma.bar.findMany({
        where: { symbol: { in: symbols } },
        orderBy: { date: "asc" },
      }),
      prisma.corporateAction.findMany({ where: { symbol: { in: symbols } } }),
      prisma.symbolEvent.findMany({
        where: { symbol: { in: symbols }, at: { gte: since } },
        orderBy: { at: "desc" },
      }),
      prisma.baseline.findMany({ where: { userId, symbol: { in: symbols } } }),
      prisma.acknowledgement.findMany({ where: { userId } }),
      prisma.alertLevel.findMany({ where: { userId } }),
      prisma.quote.findUnique({ where: { symbol: INDEX_SYMBOL } }),
      prisma.symbolStat.findUnique({ where: { symbol: INDEX_SYMBOL } }),
    ]);

  const byKey = <T extends { symbol: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.symbol, [...(m.get(r.symbol) ?? []), r]);
    return m;
  };

  const quoteBy = new Map(quotes.map((q) => [q.symbol, q]));
  const statBy = new Map(stats.map((s) => [s.symbol, s]));
  const barsBy = byKey(bars);
  const actionsBy = byKey(actions);
  const eventsBy = byKey(events);

  const contexts = new Map<string, SymbolContext>();
  for (const symbol of symbols) {
    const q = quoteBy.get(symbol);
    const s = statBy.get(symbol);
    // A symbol added seconds ago has no quote yet. Skipping it is correct —
    // it will appear on the next visit, and an empty card helps nobody.
    if (!q || !s) continue;

    const quote = {
      symbol,
      price: q.price,
      volume: q.volume,
      asOf: q.asOf.toISOString(),
      volumeToday: q.volume,
      sources: q.sources,
      status: q.status as "ok" | "stale" | "disputed" | "unconfirmed",
      note: q.note ?? undefined,
    };

    const symbolEvents: SymbolEvent[] = (eventsBy.get(symbol) ?? []).map((e) => ({
      symbol: e.symbol,
      kind: e.kind as SymbolEvent["kind"],
      at: e.at.toISOString(),
      magnitude: e.magnitude,
      detail: e.detail as Record<string, number | string>,
      dedupeKey: e.dedupeKey,
    }));

    // Level crossings are personal, so they are evaluated here rather than
    // in the worker. The user asked for these by hand; they outrank anything
    // we inferred on their behalf.
    const previous = (barsBy.get(symbol) ?? []).at(-1)?.close ?? quote.price;
    for (const lv of levels.filter((l) => l.symbol === symbol)) {
      const crossed = detectLevelCross(
        quote,
        { value: lv.value, direction: lv.direction as "above" | "below" },
        previous
      );
      if (crossed) symbolEvents.push(crossed);
    }

    contexts.set(symbol, {
      quote,
      stats: s,
      bars: (barsBy.get(symbol) ?? []) as Bar[],
      actions: (actionsBy.get(symbol) ?? []).map((a) => ({
        symbol,
        date: a.date,
        type: a.type as "split" | "dividend",
        ratio: a.ratio ?? undefined,
        amount: a.amount ?? undefined,
      })) as CorporateAction[],
      events: symbolEvents,
    });
  }

  const baselines = new Map<string, Baseline>(
    baselineRows.map((b) => [
      b.symbol,
      {
        symbol: b.symbol,
        price: b.price,
        seenAt: b.seenAt.toISOString(),
        indexPrice: b.indexPrice ?? undefined,
      },
    ])
  );

  // First visit to a symbol: seed the baseline at today's price so the next
  // visit has something to diff against. A brand-new symbol legitimately has
  // no "since you last looked" story yet, and inventing one would be a lie.
  for (const [symbol, ctx] of contexts) {
    if (baselines.has(symbol)) continue;
    await prisma.baseline.create({
      data: {
        userId,
        symbol,
        price: ctx.quote.price,
        seenAt: new Date(at),
        indexPrice: indexQuote?.price,
      },
    });
    baselines.set(symbol, {
      symbol,
      price: ctx.quote.price,
      seenAt: at,
      indexPrice: indexQuote?.price,
    });
  }

  const acknowledged = new Set(ackRows.map((a) => a.dedupeKey));
  const digest = buildDigest(
    contexts,
    baselines,
    acknowledged,
    at,
    indexQuote?.price,
    limit
  );

  return {
    ...digest,
    index:
      indexQuote && indexStat
        ? {
            price: indexQuote.price,
            changePct:
              indexStat.lastClose > 0
                ? (indexQuote.price / indexStat.lastClose - 1) * 100
                : null,
          }
        : null,
  };
}

/**
 * Write-back, called when the user has actually read the briefing.
 *
 * `sessionSeconds` comes from the client and is the guard against a
 * two-second glance wiping the reference point the whole product depends
 * on. The engine, not this file, decides whether it counts.
 */
export async function markRead(
  userId: string,
  sessionSeconds: number
): Promise<{ advanced: boolean; acknowledged: number }> {
  const digest = await getDigest(userId, 50);
  const at = nowISO();

  const items = await prisma.watchlistItem.findMany({ where: { userId } });
  const symbols = items.map((i) => i.symbol);

  const [quotes, indexQuote, baselineRows] = await Promise.all([
    prisma.quote.findMany({ where: { symbol: { in: symbols } } }),
    prisma.quote.findUnique({ where: { symbol: INDEX_SYMBOL } }),
    prisma.baseline.findMany({ where: { userId } }),
  ]);

  const contexts = new Map<string, SymbolContext>();
  for (const q of quotes) {
    contexts.set(q.symbol, {
      quote: {
        symbol: q.symbol,
        price: q.price,
        asOf: q.asOf.toISOString(),
        volumeToday: q.volume,
        sources: q.sources,
        status: q.status as "ok" | "stale" | "disputed" | "unconfirmed",
        note: q.note ?? undefined,
      },
      stats: {} as never,
      bars: [],
      actions: [],
      events: [],
    });
  }

  const previous = new Map<string, Baseline>(
    baselineRows.map((b) => [
      b.symbol,
      {
        symbol: b.symbol,
        price: b.price,
        seenAt: b.seenAt.toISOString(),
        indexPrice: b.indexPrice ?? undefined,
      },
    ])
  );

  const result = advanceBaselines(
    digest,
    contexts,
    previous,
    sessionSeconds,
    at,
    indexQuote?.price
  );

  // The engine refused: too short a glance to count as "checking".
  if (!result) return { advanced: false, acknowledged: 0 };

  await prisma.$transaction([
    ...[...result.baselines.values()].map((b) =>
      prisma.baseline.upsert({
        where: { userId_symbol: { userId, symbol: b.symbol } },
        create: {
          userId,
          symbol: b.symbol,
          price: b.price,
          seenAt: new Date(b.seenAt),
          indexPrice: b.indexPrice,
        },
        update: {
          price: b.price,
          seenAt: new Date(b.seenAt),
          indexPrice: b.indexPrice,
        },
      })
    ),
    prisma.acknowledgement.createMany({
      data: result.acknowledge.map((dedupeKey) => ({ userId, dedupeKey })),
      skipDuplicates: true,
    }),
  ]);

  return { advanced: true, acknowledged: result.acknowledge.length };
}
