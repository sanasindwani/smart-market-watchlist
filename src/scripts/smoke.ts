/**
 * Smoke test for everything that does not need Postgres.
 *
 *     npm run smoke
 *
 * providers -> reconcile -> stats -> detect -> rank -> acknowledge.
 * If this passes, the only things left that can be broken are the database
 * wiring and the UI. Run it before every commit; it takes a second.
 */
import { SeedProvider } from "../data/providers.ts";
import { computeStats } from "../engine/stats.ts";
import { reconcile } from "../engine/integrity.ts";
import { detectSymbolEvents } from "../engine/detect.ts";
import { buildDigest, advanceBaselines, type SymbolContext } from "../engine/digest.ts";
import type { Baseline } from "../engine/types.ts";

const NOW = new Date().toISOString();
const p = new SeedProvider();
const symbols = ["ZOMATO", "RELIANCE", "INFY"];

const niftyBars = await p.bars("NIFTY", 250);
const contexts = new Map<string, SymbolContext>();
const baselines = new Map<string, Baseline>();

for (const s of symbols) {
  const bars = await p.bars(s, 250);
  const stats = computeStats(s, bars, [], niftyBars);
  const q = (await p.quote(s))!;
  const boosted = s === "ZOMATO" ? { ...q, price: q.price * 1.09, volumeToday: q.volumeToday * 20 } : q;
  const quote = reconcile(s, [boosted, { ...boosted, source: "b" }], NOW)!;
  contexts.set(s, { quote, stats, bars, actions: [], events: detectSymbolEvents(quote, stats, bars, [], undefined) });
  baselines.set(s, { symbol: s, price: stats.lastClose, seenAt: new Date(Date.parse(NOW) - 2 * 86400000).toISOString() });
}

const d = buildDigest(contexts, baselines, new Set(), NOW, undefined, 5);
console.log("items:", d.items.map(i => `${i.event.symbol}/${i.attention}`).join(" "));
console.log("quiet:", d.quiet.join(" ") || "none");
console.log("headline:", d.items[0]?.headline ?? "(none)");

const w = advanceBaselines(d, contexts, baselines, 60, NOW, undefined)!;
const second = buildDigest(contexts, w.baselines, new Set(w.acknowledge), NOW, undefined, 5);
console.log("after ack, items:", second.items.length, "(expect 0)");
console.log("glance blocked:", advanceBaselines(d, contexts, baselines, 3, NOW) === null);
