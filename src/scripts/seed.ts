/**
 * Seed a reviewable demo.
 *
 *     npm run seed
 *
 * Creates demo@watchlist.app / demo1234 with a watchlist where all five
 * traps are already staged, and a baseline dated two days ago so the very
 * first screen a reviewer sees has a real story on it.
 *
 * A reviewer gets three to five minutes. Waiting for a genuine 3σ move
 * inside that window is not a plan.
 */

import bcrypt from "bcryptjs";
import { prisma } from "../server/prisma.ts";
import { SeedProvider } from "../data/providers.ts";
import { INDEX_SYMBOL, lookup } from "../data/universe.ts";
import { recomputeStats } from "../worker/index.ts";
import { reconcile } from "../engine/integrity.ts";
import { detectSymbolEvents } from "../engine/detect.ts";
import type { Bar, SourceQuote } from "../engine/types.ts";

const DAY = 86_400_000;
const NOW = new Date();
const iso = (d: Date | number) => new Date(d).toISOString();

/**
 * The staged scenario. Each entry bends today's quote away from the
 * generated history in a specific way, to force a specific behaviour.
 */
const SCENARIO: Record<
  string,
  { move: number; volume?: number; note: string; second?: Partial<SourceQuote> }
> = {
  // Broad rally: today is a +2.0% day for NIFTY. Everything else is judged
  // against that, which is the point.
  NIFTY: { move: 1.02, note: "market-wide rally" },

  ZOMATO: {
    move: 1.085,
    volume: 41_000_000,
    note: "the real event — gap + volume + 52w high",
  },
  TCS: {
    move: 1.031,
    note: "up 3.1% but NIFTY is up 2.0% — that is the market, not TCS",
  },
  INFY: {
    move: 0.5,
    note: "1-for-2 split — must NOT read as a 50% crash",
  },
  TATAMOTORS: {
    move: 1.0,
    note: "providers disagree by 3% — show median, raise nothing",
    second: { price: -1 }, // -1 is a sentinel, replaced with a 3% offset below
  },
  HDFCBANK: {
    move: 1.04,
    note: "quote is five hours old — label it, do not alert on it",
  },
  BAJFINANCE: {
    move: 1.11,
    note: "single source on a huge move — wait for a second opinion",
  },
  RELIANCE: { move: 1.002, note: "the quiet control" },
  ITC: { move: 0.998, note: "quiet" },
};

const WATCHLIST = [
  "ZOMATO",
  "TCS",
  "INFY",
  "TATAMOTORS",
  "HDFCBANK",
  "BAJFINANCE",
  "RELIANCE",
  "ITC",
];

async function main() {
  console.log("seeding…");

  await prisma.acknowledgement.deleteMany();
  await prisma.baseline.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.symbolEvent.deleteMany();
  await prisma.user.deleteMany();

  const provider = new SeedProvider();
  const symbols = [INDEX_SYMBOL, ...WATCHLIST];

  // ── history ────────────────────────────────────────────────────────────
  for (const symbol of symbols) {
    await prisma.symbol.upsert({
      where: { symbol },
      create: {
        symbol,
        name: symbol === INDEX_SYMBOL ? "NIFTY 50" : lookup(symbol)?.name ?? symbol,
        isIndex: symbol === INDEX_SYMBOL,
      },
      update: {},
    });

    const bars = await provider.bars(symbol, 250);
    await prisma.bar.deleteMany({ where: { symbol } });
    await prisma.bar.createMany({
      data: bars.map((b) => ({ symbol, ...b })),
      skipDuplicates: true,
    });
  }

  // INFY's split. Dated today, so a user whose baseline predates it sees the
  // adjustment machinery do its job.
  await prisma.corporateAction.deleteMany({ where: { symbol: "INFY" } });
  await prisma.corporateAction.create({
    data: {
      symbol: "INFY",
      date: iso(NOW).slice(0, 10),
      type: "split",
      ratio: 2,
    },
  });

  // Stats need the index first — every idioVol depends on it.
  await recomputeStats(INDEX_SYMBOL);
  for (const s of WATCHLIST) await recomputeStats(s);

  // ── today's quotes ─────────────────────────────────────────────────────
  const priceOf = new Map<string, number>();

  for (const symbol of symbols) {
    const stat = await prisma.symbolStat.findUnique({ where: { symbol } });
    if (!stat) continue;

    const plan = SCENARIO[symbol] ?? { move: 1, note: "" };
    const price = stat.lastClose * plan.move;
    priceOf.set(symbol, price);

    // HDFCBANK's feed died five hours ago. Everything else is fresh.
    const asOf =
      symbol === "HDFCBANK" ? iso(NOW.getTime() - 5 * 3600_000) : iso(NOW);

    const quotes: SourceQuote[] = [
      { source: "yahoo", price, asOf, volumeToday: plan.volume ?? stat.avgVolume },
    ];

    // BAJFINANCE stays single-source on purpose: that is the bad-tick guard.
    if (symbol !== "BAJFINANCE") {
      quotes.push({
        source: "finnhub",
        // TATAMOTORS: a genuine 3% disagreement between providers.
        price: symbol === "TATAMOTORS" ? price * 1.03 : price * 1.0004,
        asOf,
        volumeToday: plan.volume ?? stat.avgVolume,
      });
    }

    const reconciled = reconcile(symbol, quotes, iso(NOW));
    if (!reconciled) continue;

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
  }

  // ── events ─────────────────────────────────────────────────────────────
  const indexStat = await prisma.symbolStat.findUnique({
    where: { symbol: INDEX_SYMBOL },
  });
  const market = indexStat
    ? { price: priceOf.get(INDEX_SYMBOL)!, lastClose: indexStat.lastClose }
    : undefined;

  for (const symbol of WATCHLIST) {
    const [q, stat, bars, actions] = await Promise.all([
      prisma.quote.findUnique({ where: { symbol } }),
      prisma.symbolStat.findUnique({ where: { symbol } }),
      prisma.bar.findMany({ where: { symbol }, orderBy: { date: "asc" } }),
      prisma.corporateAction.findMany({ where: { symbol } }),
    ]);
    if (!q || !stat) continue;

    const events = detectSymbolEvents(
      {
        symbol,
        price: q.price,
        asOf: q.asOf.toISOString(),
        volumeToday: q.volume,
        sources: q.sources,
        status: q.status as "ok" | "stale" | "disputed" | "unconfirmed",
        note: q.note ?? undefined,
      },
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
        update: {},
      });
    }
  }

  // ── the demo user ──────────────────────────────────────────────────────
  const user = await prisma.user.create({
    data: {
      email: "demo@watchlist.app",
      passwordHash: await bcrypt.hash("demo1234", 10),
    },
  });

  const seenAt = new Date(NOW.getTime() - 2 * DAY);
  const indexThen = (priceOf.get(INDEX_SYMBOL) ?? 24000) / 1.02;

  for (const [rank, symbol] of WATCHLIST.entries()) {
    await prisma.watchlistItem.create({
      data: { userId: user.id, symbol, rank },
    });

    const stat = await prisma.symbolStat.findUnique({ where: { symbol } });
    if (!stat) continue;

    // The baseline is what they saw two days ago. For INFY that is the
    // PRE-split price, which is exactly the trap we want to demonstrate.
    await prisma.baseline.create({
      data: {
        userId: user.id,
        symbol,
        price: symbol === "INFY" ? stat.lastClose * 2 : stat.lastClose,
        seenAt,
        indexPrice: indexThen,
      },
    });
  }

  // One user-set level, so the personal-alert path is exercised too.
  const rel = await prisma.quote.findUnique({ where: { symbol: "RELIANCE" } });
  if (rel) {
    await prisma.alertLevel.create({
      data: {
        userId: user.id,
        symbol: "RELIANCE",
        value: Math.round(rel.price * 1.05),
        direction: "above",
      },
    });
  }

  console.log("\nseeded.\n");
  console.log("  sign in:  demo@watchlist.app / demo1234");
  console.log("  staged:");
  for (const s of WATCHLIST) {
    console.log(`    ${s.padEnd(12)} ${SCENARIO[s]?.note ?? ""}`);
  }
  console.log("");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
