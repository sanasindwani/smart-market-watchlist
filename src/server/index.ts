/**
 * HTTP layer. Thin on purpose — every route is a few lines of validation
 * plus one call into a service. If a route is doing arithmetic, it belongs
 * in the engine instead.
 *
 * One process serves both the API and the built React client, so there is
 * exactly one thing to deploy.
 */

import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prisma, nowISO, advanceClock, resetClock, demoEnabled, clockOffsetMinutes } from "./prisma.ts";
import { login, register, requireAuth, type AuthedRequest } from "./auth.ts";
import { getDigest, markRead } from "./digestService.ts";
import { ensureSymbol } from "../worker/index.ts";
import { INDEX_SYMBOL, lookup, search } from "../data/universe.ts";

const app = express();
app.use(cors());
app.use(express.json());

const wrap =
  (fn: (req: AuthedRequest, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) => {
    fn(req as AuthedRequest, res).catch((err: Error) => {
      // Client-safe message only; stack traces stay in the logs.
      console.error(err);
      res.status(400).json({ error: err.message });
    });
  };

// ── health ───────────────────────────────────────────────────────────────

app.get("/api/health", wrap(async (_req, res) => {
  const symbols = await prisma.symbol.count();
  const quotes = await prisma.quote.count();
  res.json({ ok: true, at: nowISO(), symbols, quotes, demo: demoEnabled() });
}));

// ── auth ─────────────────────────────────────────────────────────────────

app.post("/api/auth/register", wrap(async (req, res) => {
  const { email, password } = req.body ?? {};
  res.json(await register(String(email ?? ""), String(password ?? "")));
}));

app.post("/api/auth/login", wrap(async (req, res) => {
  const { email, password } = req.body ?? {};
  res.json(await login(String(email ?? ""), String(password ?? "")));
}));

app.get("/api/me", requireAuth, wrap(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { email: true, createdAt: true },
  });
  res.json(user);
}));

// ── symbol search ────────────────────────────────────────────────────────

app.get("/api/symbols", wrap(async (req, res) => {
  res.json(search(String(req.query.q ?? "")));
}));

// ── watchlist CRUD ───────────────────────────────────────────────────────

app.get("/api/watchlist", requireAuth, wrap(async (req, res) => {
  const items = await prisma.watchlistItem.findMany({
    where: { userId: req.userId },
    orderBy: { rank: "asc" },
  });
  const quotes = await prisma.quote.findMany({
    where: { symbol: { in: items.map((i) => i.symbol) } },
  });
  const byS = new Map(quotes.map((q) => [q.symbol, q]));

  res.json(
    items.map((i) => ({
      symbol: i.symbol,
      name: lookup(i.symbol)?.name ?? i.symbol,
      rank: i.rank,
      addedAt: i.addedAt,
      quote: byS.get(i.symbol)
        ? {
            price: byS.get(i.symbol)!.price,
            asOf: byS.get(i.symbol)!.asOf,
            status: byS.get(i.symbol)!.status,
            note: byS.get(i.symbol)!.note,
          }
        : null,
    }))
  );
}));

app.post("/api/watchlist", requireAuth, wrap(async (req, res) => {
  const symbol = String(req.body?.symbol ?? "").toUpperCase();
  if (!lookup(symbol)) throw new Error(`We don't have ${symbol} listed`);
  if (symbol === INDEX_SYMBOL) throw new Error("NIFTY is tracked automatically");

  // Register + backfill happens once, globally, the first time ANY user
  // adds this symbol. The second user to add it pays nothing.
  await ensureSymbol(symbol);

  const count = await prisma.watchlistItem.count({ where: { userId: req.userId } });
  await prisma.watchlistItem.upsert({
    where: { userId_symbol: { userId: req.userId!, symbol } },
    create: { userId: req.userId!, symbol, rank: count },
    update: {},
  });
  res.json({ ok: true, symbol });
}));

app.delete("/api/watchlist/:symbol", requireAuth, wrap(async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  await prisma.watchlistItem.deleteMany({ where: { userId: req.userId, symbol } });
  // The baseline goes too. Keeping it would mean re-adding the symbol next
  // month silently diffs against a price from before you removed it.
  await prisma.baseline.deleteMany({ where: { userId: req.userId, symbol } });
  res.json({ ok: true });
}));

app.post("/api/watchlist/reorder", requireAuth, wrap(async (req, res) => {
  const order: string[] = req.body?.order ?? [];
  await prisma.$transaction(
    order.map((symbol, rank) =>
      prisma.watchlistItem.updateMany({
        where: { userId: req.userId, symbol },
        data: { rank },
      })
    )
  );
  res.json({ ok: true });
}));

// ── alert levels ─────────────────────────────────────────────────────────

app.post("/api/alerts", requireAuth, wrap(async (req, res) => {
  const { symbol, value, direction } = req.body ?? {};
  if (direction !== "above" && direction !== "below") {
    throw new Error("Direction must be above or below");
  }
  const level = await prisma.alertLevel.upsert({
    where: {
      userId_symbol_value_direction: {
        userId: req.userId!,
        symbol: String(symbol).toUpperCase(),
        value: Number(value),
        direction,
      },
    },
    create: {
      userId: req.userId!,
      symbol: String(symbol).toUpperCase(),
      value: Number(value),
      direction,
    },
    update: {},
  });
  res.json(level);
}));

app.delete("/api/alerts/:id", requireAuth, wrap(async (req, res) => {
  await prisma.alertLevel.deleteMany({
    where: { id: req.params.id, userId: req.userId },
  });
  res.json({ ok: true });
}));

// ── the briefing ─────────────────────────────────────────────────────────

app.get("/api/digest", requireAuth, wrap(async (req, res) => {
  res.json(await getDigest(req.userId!, Number(req.query.limit ?? 5)));
}));

/** Called when the user leaves the briefing, with how long they looked. */
app.post("/api/digest/read", requireAuth, wrap(async (req, res) => {
  const seconds = Number(req.body?.sessionSeconds ?? 0);
  res.json(await markRead(req.userId!, seconds));
}));

// ── symbol detail ────────────────────────────────────────────────────────

app.get("/api/symbols/:symbol", requireAuth, wrap(async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const [quote, stat, bars, events, baseline, levels] = await Promise.all([
    prisma.quote.findUnique({ where: { symbol } }),
    prisma.symbolStat.findUnique({ where: { symbol } }),
    prisma.bar.findMany({
      where: { symbol },
      orderBy: { date: "desc" },
      take: 90,
    }),
    prisma.symbolEvent.findMany({
      where: { symbol },
      orderBy: { at: "desc" },
      take: 20,
    }),
    prisma.baseline.findUnique({
      where: { userId_symbol: { userId: req.userId!, symbol } },
    }),
    prisma.alertLevel.findMany({ where: { userId: req.userId, symbol } }),
  ]);

  res.json({
    symbol,
    name: lookup(symbol)?.name ?? symbol,
    sector: lookup(symbol)?.sector ?? null,
    quote,
    stat,
    bars: bars.reverse(),
    events,
    baseline,
    levels,
  });
}));

// ── demo controls ────────────────────────────────────────────────────────
// Guarded by DEMO_MODE. Lets a reviewer see "come back tomorrow" in one
// click instead of waiting until tomorrow.

app.post("/api/demo/advance", wrap(async (req, res) => {
  const minutes = Number(req.body?.minutes ?? 60);
  advanceClock(minutes);
  res.json({ offsetMinutes: clockOffsetMinutes(), at: nowISO() });
}));

app.post("/api/demo/reset", wrap(async (_req, res) => {
  if (!demoEnabled()) throw new Error("demo clock is disabled");
  resetClock();
  res.json({ offsetMinutes: 0, at: nowISO() });
}));

// ── static client ────────────────────────────────────────────────────────

const dir = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(dir, "../../client/dist");
app.use(express.static(clientDist));
app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
