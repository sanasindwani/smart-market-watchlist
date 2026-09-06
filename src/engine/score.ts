/**
 * Turn a pile of events into a short, ranked, human-readable briefing.
 *
 * THE PRODUCT DECISION HERE
 * We are not building an alert firehose. If we surface 18 things, the
 * user reads none of them. The job is: pick the 5 that matter, say why
 * in one sentence each, and explicitly tell them the rest was quiet.
 * Restraint is the feature.
 */

import {
  CONFIG,
  type Attention,
  type RankedItem,
  type SymbolEvent,
} from "./types.ts";

/**
 * Score, de-duplicate and rank events for ONE user.
 *
 * @param events        Events on symbols this user watches, since their watermark.
 * @param acknowledged  dedupeKeys we have ALREADY shown this user.
 * @param nowISO        Injectable clock — never call Date.now() inside the
 *                      engine, or the demo and the tests become unrepeatable.
 */
export function rankForUser(
  events: SymbolEvent[],
  acknowledged: Set<string>,
  nowISO: string,
  limit = 5
): RankedItem[] {
  // 1. Novelty. If we told them about this yesterday, it is not news
  //    today. Diffing against ACKNOWLEDGED state rather than just
  //    elapsed time is what makes "come back later" feel intelligent
  //    instead of repetitive.
  const fresh = events.filter((e) => !acknowledged.has(e.dedupeKey));

  // 2. Collapse per symbol. If ZOMATO gapped AND spiked on volume AND
  //    broke its high, that is ONE story, not three rows. We keep the
  //    strongest event as the headline and let the others boost it.
  const bySymbol = new Map<string, SymbolEvent[]>();
  for (const e of fresh) {
    const list = bySymbol.get(e.symbol) ?? [];
    list.push(e);
    bySymbol.set(e.symbol, list);
  }

  const items: RankedItem[] = [];
  for (const [, group] of bySymbol) {
    const scored = group.map((e) => ({ e, s: scoreEvent(e, nowISO) }));
    scored.sort((a, b) => b.s - a.s);

    const lead = scored[0];
    // Corroborating events add value but with diminishing returns —
    // otherwise one noisy symbol dominates the whole briefing.
    const support = scored.slice(1).reduce((acc, x) => acc + x.s * 0.35, 0);
    const score = lead.s + support;

    items.push({
      event: lead.e,
      score,
      attention: bucket(score),
      headline: explain(lead.e, group),
      bullets: bullets(group),
      dedupeKeys: group.map((e) => e.dedupeKey),
    });
  }

  items.sort((a, b) => b.score - a.score);
  return items.slice(0, limit);
}

/**
 * Red / amber / green, from the same score that does the ranking.
 *
 * NOTE what we did NOT do: invent a 0-100 "change score" from weighted
 * percentages. Every weight in that design is an undefendable magic
 * number. Here there is exactly one number to defend — 2σ — and the
 * answer is that it flags roughly the top 5% of outcomes for that stock
 * over that window. Buckets are presentation; the statistic is the truth.
 */
export function bucket(score: number): Attention {
  if (score >= CONFIG.attention.high) return "high";
  if (score >= CONFIG.attention.watch) return "watch";
  return "normal";
}

/** Salience of a single event. Every term here is defensible out loud. */
export function scoreEvent(event: SymbolEvent, nowISO: string): number {
  const w = CONFIG.weights;
  let score = 0;

  switch (event.kind) {
    case "PRICE_MOVE":
    case "GAP":
      // Sigmas, not percent. The whole point.
      score =
        Math.abs(event.magnitude) *
        (event.kind === "GAP" ? w.gap + w.sigma : w.sigma);
      break;
    case "VOLUME_SPIKE":
      // log() so 20x volume doesn't drown out a genuine price break.
      score = Math.log(Math.max(event.magnitude, 1)) * w.volume;
      break;
    case "RANGE_BREAK":
      score = w.rangeBreak;
      break;
    case "LEVEL_CROSS":
      // The user asked for this personally. It outranks our cleverness.
      score = w.levelCross;
      break;
    case "CORPORATE_ACTION":
      score = w.corporateAction;
      break;
  }

  // Recency decay, halving roughly every 24h, so a briefing after a week
  // away leads with what happened yesterday, not last Tuesday.
  const ageHours = (Date.parse(nowISO) - Date.parse(event.at)) / 3_600_000;
  return score * Math.pow(0.5, Math.max(ageHours, 0) / 24);
}

/**
 * One plain sentence saying WHY this is on screen.
 *
 * This is not decoration. "RELIANCE +6.2%" is a number the user has to
 * interpret. "RELIANCE is up 6.2% since you last looked on Tuesday — a
 * 3.1 sigma move on 4x normal volume" is a finished thought. The
 * explanation is the product.
 */
export function explain(event: SymbolEvent, group: SymbolEvent[] = []): string {
  const d = event.detail;
  const extras: string[] = [];

  const vol = group.find((e) => e.kind === "VOLUME_SPIKE");
  if (vol && vol !== event) extras.push(`${vol.magnitude.toFixed(1)}x normal volume`);
  const brk = group.find((e) => e.kind === "RANGE_BREAK");
  if (brk && brk !== event) extras.push(`a new 52-week ${brk.detail.direction}`);

  const tail = extras.length ? ` on ${extras.join(" and ")}` : "";

  switch (event.kind) {
    case "PRICE_MOVE": {
      const pct = Number(d.pct);
      const dir = pct >= 0 ? "up" : "down";
      const adjusted = Number(d.wasAdjusted)
        ? " (adjusted for a split in between)"
        : "";
      // When we could compare against NIFTY, lead with the excess move —
      // that is the number that actually says "this stock, not the market".
      const relative = Number(d.relative)
        ? `, while NIFTY moved ${signed(Number(d.indexPct))} — an excess of ${signed(Number(d.excessPct))}`
        : "";
      return (
        `${event.symbol} is ${dir} ${Math.abs(pct).toFixed(1)}% since you last ` +
        `looked ${describeGap(Number(d.sessions))}${relative} — ` +
        `a ${Math.abs(Number(d.sigmas)).toFixed(1)}σ move against its own ` +
        `normal behaviour${tail}${adjusted}.`
      );
    }
    case "GAP": {
      const pct = Number(d.pct);
      const relative = Number(d.relative)
        ? ` against a market that moved ${signed(Number(d.indexPct))}`
        : "";
      return (
        `${event.symbol} ${pct >= 0 ? "jumped" : "fell"} ${Math.abs(pct).toFixed(1)}% ` +
        `in a single session${relative} (${Math.abs(Number(d.sigmas)).toFixed(1)}σ)${tail}.`
      );
    }
    case "VOLUME_SPIKE":
      return (
        `${event.symbol} traded ${event.magnitude.toFixed(1)}x its average volume ` +
        `without a matching price move — worth a look.`
      );
    case "RANGE_BREAK":
      return d.direction === "high"
        ? `${event.symbol} broke to a new 52-week high at ${rupees(Number(d.price))}${tail}.`
        : `${event.symbol} broke to a new 52-week low at ${rupees(Number(d.price))}${tail}.`;
    case "LEVEL_CROSS":
      return (
        `${event.symbol} crossed ${d.direction} your ${rupees(Number(d.level))} ` +
        `level, now at ${rupees(Number(d.price))}.`
      );
    case "CORPORATE_ACTION":
      return d.type === "split"
        ? `${event.symbol} split 1-for-${d.ratio} — prices below are adjusted, nothing was lost.`
        : `${event.symbol} went ex-dividend at ${rupees(Number(d.amount))} per share.`;
  }
}

/**
 * The evidence list under the headline. Signal, then interpretation.
 * Everything we assert here is traceable to a number we computed.
 */
export function bullets(group: SymbolEvent[]): string[] {
  const out: string[] = [];
  for (const e of group) {
    const d = e.detail;
    switch (e.kind) {
      case "PRICE_MOVE":
        out.push(
          `Price ${Number(d.pct) >= 0 ? "up" : "down"} ${Math.abs(Number(d.pct)).toFixed(1)}% over ${Number(d.sessions)} session(s)`
        );
        if (Number(d.relative)) {
          out.push(`NIFTY moved ${signed(Number(d.indexPct))} over the same window`);
        }
        break;
      case "GAP":
        out.push(`Single-session gap of ${signed(Number(d.pct))}`);
        break;
      case "VOLUME_SPIKE":
        out.push(`Volume ${e.magnitude.toFixed(1)}x its 30-day average`);
        break;
      case "RANGE_BREAK":
        out.push(`New 52-week ${d.direction} (previous ${rupees(Number(d.level))})`);
        break;
      case "LEVEL_CROSS":
        out.push(`Crossed your ${rupees(Number(d.level))} alert level`);
        break;
      case "CORPORATE_ACTION":
        out.push(
          d.type === "split"
            ? `1-for-${d.ratio} split — your reference price was restated`
            : `Ex-dividend ${rupees(Number(d.amount))} per share`
        );
        break;
    }
  }
  return out;
}

function describeGap(sessions: number): string {
  if (sessions <= 1) return "yesterday";
  if (sessions <= 5) return `${sessions} sessions ago`;
  if (sessions <= 25) return `about ${Math.round(sessions / 5)} weeks ago`;
  return `about ${Math.round(sessions / 21)} months ago`;
}

function signed(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/** Indian formatting, because this is an NSE product. */
export function rupees(n: number): string {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
