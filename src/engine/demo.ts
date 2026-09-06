/**
 * RUN ME:  npm run demo
 *
 * No database, no API key, no network, and no install step — Node 22.6+
 * strips TypeScript natively. This runs the entire "smart" half of the
 * product on synthetic NSE data so the whole team can see and argue about
 * the behaviour on day one.
 *
 * It deliberately includes the five cases that break naive watchlists:
 *   - a genuine large move           -> should surface, loudly
 *   - a stock that split 1:2         -> must NOT look like a -50% crash
 *   - two providers disagreeing      -> must stay silent, not alert
 *   - a stale quote after hours      -> must be labelled, not faked
 *   - a stock that moved WITH NIFTY  -> must NOT be called news
 */

import { computeStats } from "./stats.ts";
import { reconcile } from "./integrity.ts";
import { detectSymbolEvents } from "./detect.ts";
import { advanceBaselines, buildDigest, type SymbolContext } from "./digest.ts";
import { rupees } from "./score.ts";
import type { Bar, Baseline, CorporateAction, SourceQuote } from "./types.ts";

// Fixed clock so the demo is identical every run. Never Date.now().
const NOW = "2026-09-04T10:30:00.000Z";

/** Deterministic pseudo-random so results are reproducible. */
function makeRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Generate `days` of plausible daily bars with a given daily volatility. */
function makeBars(startPrice: number, days: number, vol: number, seed: number): Bar[] {
  const rng = makeRng(seed);
  const bars: Bar[] = [];
  let price = startPrice;
  const start = new Date("2025-09-20T00:00:00Z");

  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + Math.floor(i * 1.4)); // skip weekends roughly
    const u1 = Math.max(rng(), 1e-9);
    const u2 = rng();
    const shock = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * vol;

    const open = price;
    price = price * Math.exp(shock);
    bars.push({
      date: d.toISOString().slice(0, 10),
      open,
      high: Math.max(open, price) * 1.004,
      low: Math.min(open, price) * 0.996,
      close: price,
      volume: Math.round(2_000_000 * (0.7 + rng() * 0.6)),
    });
  }
  return bars;
}

// ── THE MARKET ITSELF ───────────────────────────────────────────────────────
// NIFTY is just another symbol we poll. One extra row, and it lets us ask
// "did this stock move, or did everything move?"
const niftyBars = makeBars(24_000, 250, 0.007, 99);
const niftyLast = niftyBars[niftyBars.length - 1].close;
// Today is a broad rally: NIFTY is up 2.0% on the session. That single fact
// is what lets the demo show the difference between "this stock moved" and
// "everything moved".
const NIFTY_NOW = niftyLast * 1.02;
const MARKET = { price: NIFTY_NOW, lastClose: niftyLast };

type Case = {
  symbol: string;
  bars: Bar[];
  quotes: SourceQuote[];
  baseline: Baseline;
  actions: CorporateAction[];
};

const cases: Case[] = [];

// ── 1. RELIANCE — quiet. The control. Should NOT appear. ────────────────────
{
  const bars = makeBars(1420, 250, 0.011, 7);
  const last = bars[bars.length - 1].close;
  cases.push({
    symbol: "RELIANCE",
    bars,
    quotes: [
      { source: "yahoo", price: last * 1.002, asOf: NOW, volumeToday: 2_100_000 },
      { source: "finnhub", price: last * 1.0021, asOf: NOW, volumeToday: 2_090_000 },
    ],
    baseline: {
      symbol: "RELIANCE",
      price: last * 0.998,
      seenAt: "2026-09-02T14:00:00.000Z",
      indexPrice: NIFTY_NOW / 1.022, // NIFTY is +2.2% since they looked
    },
    actions: [],
  });
}

// ── 2. ZOMATO — a real event: big gap up on huge volume. ────────────────────
{
  const bars = makeBars(240, 250, 0.019, 13);
  const last = bars[bars.length - 1].close;
  const jumped = last * 1.085;
  cases.push({
    symbol: "ZOMATO",
    bars,
    quotes: [
      { source: "yahoo", price: jumped, asOf: NOW, volumeToday: 41_000_000 },
      { source: "finnhub", price: jumped * 1.0004, asOf: NOW, volumeToday: 40_800_000 },
    ],
    baseline: {
      symbol: "ZOMATO",
      price: last * 0.995,
      seenAt: "2026-09-01T11:00:00.000Z",
      indexPrice: NIFTY_NOW / 1.023,
    },
    actions: [],
  });
}

// ── 3. INFY — SPLIT TRAP. Price halved by a 1:2 split, not a crash. ─────────
{
  const bars = makeBars(1860, 250, 0.013, 29);
  const preSplit = bars[bars.length - 1].close;
  cases.push({
    symbol: "INFY",
    bars,
    quotes: [
      { source: "yahoo", price: preSplit / 2, asOf: NOW, volumeToday: 5_400_000 },
      { source: "finnhub", price: preSplit / 2, asOf: NOW, volumeToday: 5_390_000 },
    ],
    // User last saw the PRE-split price, two weeks ago.
    baseline: {
      symbol: "INFY",
      price: preSplit,
      seenAt: "2026-08-20T09:00:00.000Z",
      indexPrice: NIFTY_NOW / 1.035,
    },
    actions: [{ symbol: "INFY", date: "2026-09-04", type: "split", ratio: 2 }],
  });
}

// ── 4. TATAMOTORS — providers disagree by 3%. One of them is wrong. ─────────
{
  const bars = makeBars(980, 250, 0.016, 41);
  const last = bars[bars.length - 1].close;
  cases.push({
    symbol: "TATAMOTORS",
    bars,
    quotes: [
      { source: "yahoo", price: last * 1.03, asOf: NOW, volumeToday: 8_000_000 },
      { source: "finnhub", price: last * 0.999, asOf: NOW, volumeToday: 7_900_000 },
    ],
    baseline: {
      symbol: "TATAMOTORS",
      price: last * 0.97,
      seenAt: "2026-09-03T10:00:00.000Z",
      indexPrice: niftyLast,
    },
    actions: [],
  });
}

// ── 5. HDFCBANK — only a 5-hour-old quote. Label it, don't fake it. ─────────
{
  const bars = makeBars(1650, 250, 0.01, 53);
  const last = bars[bars.length - 1].close;
  cases.push({
    symbol: "HDFCBANK",
    bars,
    quotes: [
      { source: "yahoo", price: last * 1.04, asOf: "2026-09-04T05:30:00.000Z", volumeToday: 3_000_000 },
    ],
    baseline: {
      symbol: "HDFCBANK",
      price: last,
      seenAt: "2026-09-03T12:00:00.000Z",
      indexPrice: niftyLast,
    },
    actions: [],
  });
}

// ── 6. TCS — up 3.1%, but NIFTY is up 2.0%. Mostly the market, not TCS. ────
{
  const bars = makeBars(3800, 250, 0.011, 67);
  const last = bars[bars.length - 1].close;
  cases.push({
    symbol: "TCS",
    bars,
    quotes: [
      { source: "yahoo", price: last * 1.031, asOf: NOW, volumeToday: 2_400_000 },
      { source: "finnhub", price: last * 1.0309, asOf: NOW, volumeToday: 2_390_000 },
    ],
    baseline: {
      symbol: "TCS",
      price: last,
      // They looked at yesterday's close, before today's 2% market rally.
      seenAt: "2026-09-03T09:30:00.000Z",
      indexPrice: niftyLast,
    },
    actions: [],
  });
}

// ── 7. BAJFINANCE — one source, huge move. Bad-tick guard must hold. ────────
{
  const bars = makeBars(7200, 250, 0.014, 83);
  const last = bars[bars.length - 1].close;
  cases.push({
    symbol: "BAJFINANCE",
    bars,
    quotes: [
      { source: "yahoo", price: last * 1.11, asOf: NOW, volumeToday: 1_800_000 },
    ],
    baseline: {
      symbol: "BAJFINANCE",
      price: last,
      seenAt: "2026-09-03T09:30:00.000Z",
      indexPrice: niftyLast,
    },
    actions: [],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN THE PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

const contexts = new Map<string, SymbolContext>();
const baselines = new Map<string, Baseline>();
const statusLines: string[] = [];

for (const c of cases) {
  const stats = computeStats(c.symbol, c.bars, c.actions, niftyBars);
  const quote = reconcile(c.symbol, c.quotes, NOW);
  if (!quote) continue;

  statusLines.push(
    `  ${c.symbol.padEnd(12)} ${rupees(quote.price).padStart(12)}  ` +
      `[${quote.status}]${quote.note ? "  " + quote.note : ""}`
  );

  contexts.set(c.symbol, {
    quote,
    stats,
    bars: c.bars,
    actions: c.actions,
    // Shared, user-agnostic events. In production the WORKER computes
    // these once per symbol and stores them; every watcher reuses them.
    events: detectSymbolEvents(quote, stats, c.bars, c.actions, MARKET),
  });
  baselines.set(c.symbol, c.baseline);
}

const bar = (t: string) => `\n=== ${t} ${"=".repeat(Math.max(0, 52 - t.length))}\n`;

console.log(bar("DATA INTEGRITY"));
console.log(statusLines.join("\n"));

function show(label: string, ack: Set<string>) {
  const digest = buildDigest(contexts, baselines, ack, NOW, NIFTY_NOW);

  console.log(bar(label));
  console.log(
    `  ${digest.counts.high} need attention · ${digest.counts.watch} worth checking · ` +
      `${digest.counts.quiet} quiet\n`
  );

  if (digest.items.length === 0) {
    console.log("  Nothing meaningful has changed. You're caught up.\n");
  }

  for (const item of digest.items) {
    const tag =
      item.attention === "high" ? "HIGH " : item.attention === "watch" ? "WATCH" : "     ";
    console.log(`  [${tag}] ${item.headline}`);
    for (const b of item.bullets) console.log(`           · ${b}`);
    console.log(`           score ${item.score.toFixed(2)}\n`);
  }

  console.log(`  Quiet: ${digest.quiet.join(", ") || "none"}`);

  if (digest.suppressed.length) {
    console.log("\n  Deliberately silent (we'd rather say nothing than be wrong):");
    for (const s of digest.suppressed) console.log(`    ${s.symbol.padEnd(12)} ${s.reason}`);
  }
  return digest;
}

const first = show("FIRST VISIT — AWAY SINCE TUESDAY", new Set<string>());

// The user reads it. Write back: advance baselines, acknowledge every key.
const written = advanceBaselines(first, contexts, baselines, 60, NOW, NIFTY_NOW);
const acknowledged = new Set(written?.acknowledge ?? []);

show("SAME USER RETURNS TEN MINUTES LATER", acknowledged);

console.log(
  "\n  ^ Nothing repeats. We acknowledged every event on each card, not just\n" +
    "    the headline one, so the supporting events cannot resurface as news.\n"
);

// The two-second glance must NOT burn the reference point.
const glance = advanceBaselines(first, contexts, baselines, 3, NOW, NIFTY_NOW);
console.log(
  `  Two-second glance moves the baseline? ${glance === null ? "no (correct)" : "YES — BUG"}\n`
);
