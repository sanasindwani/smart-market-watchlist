# Since you last looked

A market watchlist that answers one question: **what changed while you were away, and does it matter?**
Live Demo: https://smart-market-watchlist-skni.onrender.com
Sign in with `demo@watchlist.app` / `demo1234`


---

## The idea

Every watchlist shows you this:

```
RELIANCE   ₹1,573   +2.8%
INFY       ₹1,049   −49.9%
TCS        ₹5,004   +3.1%
```

That is a quote screen. It makes you do the work: scan twelve rows, remember what you paid attention to last time, and decide what matters.

This is what we show instead:

> **One thing needs your attention, and one more is worth a look.**
> *You last checked 2 days ago · NIFTY +2.0% today*
>
> **ZOMATO** — jumped 8.5% in a single session against a market that moved +2.0% (2.9σ) on 19.3× normal volume, and broke to a new 52-week high.
> · Volume 19.3× its 30-day average
> · NIFTY moved +2.3% over the same window
>
> **INFY** — split 1-for-2. Prices below are adjusted, nothing was lost.
>
> *6 other stocks were quiet.*
>
> **We stayed quiet on these, and here's why**
> `TATAMOTORS` sources differ by 3.06% — showing median, alerts paused
> `HDFCBANK` last updated 5h ago
> `TCS` moved +3.1% but NIFTY moved +2.0% — that is the market, not the stock
> `BAJFINANCE` single source — waiting for a second opinion before alerting

Every number on that screen is measured from **your** baseline, not from market open.

---

## What counts as "meaningful"

Not a fixed percentage. A 2% move in HDFCBANK is an event; 2% in a small-cap is a quiet Tuesday. Three corrections, applied in order:

**1. Normalise by the stock's own volatility.**

```
sigmas = ln(price_now / baseline_price) / (dailyVol × √sessions_elapsed)
```

The threshold auto-adapts per symbol with no hand-tuned config. The `√sessions` term also adapts to *how long you were away* — being gone a week should require a bigger move to be surprising than being gone an hour.

**2. Subtract the market.**

```
excess = ln(price/baseline) − β × ln(nifty/nifty_baseline)
sigmas = excess / (idioVol × √sessions)
```

A stock up 3% on a day NIFTY is up 2.9% has told you nothing. Up 3% while NIFTY is flat is a real event. Same headline number, opposite meaning. `β = 1` deliberately — estimating per-symbol beta on 90 days of data adds variance without adding accuracy at this horizon, and a bad estimate is worse than none.

**3. Compose, rank, and cut.**

```
score = |sigmas| × w_sigma
      + ln(volume_ratio) × w_volume
      + w_rangeBreak / w_gap / w_levelCross / w_corporateAction
      × 0.5^(age_hours / 24)          ← recency decay
```

Events on one symbol collapse into **one card** with diminishing returns on the supporting signals, so a single noisy stock cannot dominate the briefing. Then we show the top five and say plainly that the rest was quiet.

### Worked example — ZOMATO, from the seeded demo

| | |
|---|---|
| Baseline (2 days ago) | ₹238.50 |
| Now | ₹258.82 |
| Raw move | +8.5% |
| NIFTY over same window | +2.3% |
| Excess move | +6.2% |
| Volatility excl. market, 30d | 2.02% daily |
| Sessions elapsed | 2 |
| Expected move | 2.02% × √2 = 2.86% |
| **σ** | **6.2 / 2.86 = 2.9σ** |
| Volume | 19.3× average |
| **Score** | **6.60 → high attention** |

Threshold is 2σ. We chose it because it flags roughly the top 5% of outcomes for that specific stock over that specific window — a number we can defend, rather than a weight we picked.

**What we deliberately did not build:** a 0–100 "change score" from weighted percentages (40% price + 25% volume + …). Every weight in that design is an undefendable magic number, and squashing each signal onto a 0–100 scale requires inventing more of them. One statistic you can defend beats five weights you cannot. The red/amber/green labels in the UI are buckets of the score above — presentation, not a second scoring system.

---

## Architecture

```
         SHARED — computed once per symbol           PERSONAL — per user, cheap
         ────────────────────────────────            ─────────────────────────
  NSE ──> poll ──> reconcile ──> detect ──> events ──> filter to my symbols,
          worker   integrity     engine     table      since my watermark
                                                            │
                  nightly: volatility, avg volume,          ▼
                  52w range, split adjustment  ────>  score, rank, explain
                                                            │
                                                            ▼
                                                      five sentences
```

**The unit of work is the symbol, not the user.** The naive design polls the market API per user per symbol, so cost grows as (users × symbols) and you hit Yahoo's rate limit at roughly ten users. Ten thousand users watching two hundred distinct NSE names is **two hundred polls**, fanned out to subscribers.

The read path — `src/server/digestService.ts` — makes **zero** market-data calls. Open it and count. Everything expensive already happened, once, in the worker. What is left is six queries and some arithmetic.

The split is visible in two function signatures in `src/engine/detect.ts`:

```ts
detectSymbolEvents(quote, stats, bars, actions, market)   // once per symbol
detectBaselineMove(quote, baseline, stats, bars, actions, indexNow)  // per user
```

---

## Handling bad data

The brief asks how we handle stale, delayed or conflicting data. **Rule we never break: if we don't trust the number, we say nothing** — and we say *why*, on screen.

| Situation | Naive result | What we do |
|---|---|---|
| 1-for-2 split | "INFY −50%!" panic | Restate the stored baseline by the split ratio before comparing |
| Split in price history | Volatility inflated, real events hidden for weeks | `adjustHistory()` rewrites bars into today's share terms *before* measuring |
| One bad tick | Fake 6σ alert, trust gone | Require a second provider or a second poll to confirm |
| Two providers disagree | Show whichever we fetched first | Show median, mark `disputed`, **raise no events** |
| Stale / delayed quote | Render it like it's live | Show it with an age badge, raise no events, never write it into a baseline |
| Late/out-of-order write | Newer price silently overwritten | `shouldWrite()` rejects any write older than what is stored |
| Whole market moved | "TCS +3.1%!" | Subtract NIFTY; report the excess or stay silent |
| Worker retry | Duplicate events | `dedupeKey` is uniquely indexed; upserts never rewrite |
| Weekend / holiday | "3 days of volatility available" | `tradingDaysBetween()` counts real bars, not calendar days |

Every suppression appears in the UI as a line of plain English. Handling an edge case invisibly earns nothing.

---

## Two decisions we think are right and most builds miss

**We diff against acknowledged state, not just elapsed time.** If we told you about the ZOMATO breakout an hour ago, it is not news now. `Acknowledgement` records every event key we have shown you. Come back ten minutes later and you get *"Nothing meaningful has changed. You're caught up."*

Subtlety: we acknowledge **every** event on a card, not just the headline. ZOMATO gapped *and* spiked on volume *and* broke its high — one card, three keys. Acknowledge only the headline and the other two resurface tomorrow looking like fresh news.

**A glance does not burn your baseline.** If opening the app for two seconds resets the reference point the whole product measures from, the product is broken. The client reports how long you looked; the server refuses to move baselines for sessions under 20 seconds. We also never write a `stale` or `disputed` price into a baseline — that would bake a bad tick into your reference point permanently.

---

## Running it

Needs **Node 22.6+**. TypeScript is stripped natively, so there is no build step for the server.

**The engine alone — no database, no API key, no internet:**

```bash
npm run demo
```

That prints the full detection pipeline against seeded NSE data, including all five traps. Useful for reading the logic before touching infrastructure.

**The whole app:**

```bash
cp .env.example .env          # defaults work as-is with DATA_SOURCE=seed
npm install
npx prisma migrate dev --name init
npm run seed                  # creates demo@watchlist.app / demo1234

npm run dev:server            # :3000
npm run dev:client            # :5173
npm run dev:worker            # optional with seeded data
```

Set `DATA_SOURCE=live` for real Yahoo data. Add `FINNHUB_API_KEY` for a genuine second opinion.

**Deploy:** Railway or Render, two processes from one repo (`web` and `worker` in the `Procfile`) plus a Postgres add-on. Not Vercel — the poller is long-running, and serverless cron makes that awkward.

### The demo clock

`DEMO_MODE=true` puts a bar at the bottom of the UI: **+1 hour · +1 day · +3 days · Reset**.

"Come back later and see what changed" cannot be shown live in a three-minute review. Rather than describe it, we let the reviewer test it in one click.

---

## Layout

```
src/engine/       PURE FUNCTIONS. No DB, no network, no Date.now().
  types.ts          domain types + every tunable threshold in one CONFIG
  stats.ts          volatility, idiosyncratic volatility, split adjustment
  integrity.ts      reconcile providers, staleness, bad-tick guard
  detect.ts         ← the core. shared events + personal baseline move
  score.ts          rank, collapse per symbol, write the English sentence
  digest.ts         assemble the briefing; the baseline write-back rules
  demo.ts           runs all of the above on fake data

src/data/         providers behind one interface (yahoo | finnhub | seed)
src/worker/       poll loop, backfill, nightly stats. Knows nothing about users.
src/server/       auth, CRUD, the read path, the demo clock
client/           React. One screen that matters: the briefing.
```

Everything smart is a pure function, which means the brain of the product is testable and demonstrable with no Postgres and no API key, and the demo is deterministic because we inject the clock rather than calling `Date.now()`.

---

## What we chose not to build, and why

- **WebSockets.** Polling every 60s is well inside what this product needs. A live-tick feed would be a different product with a different failure surface.
- **Portfolio, P&L, holdings.** A different product. Tracking what you own is not the same as tracking what changed.
- **News and earnings signals.** We wanted them — they would be the strongest non-price input. There is no reliable free news feed for NSE, and a scoring term backed by data that might not be there on demo day is worse than no term at all.
- **Per-symbol beta estimation.** See above. β = 1 is a choice, not a shortcut.
- **A sensitivity settings page.** Users cannot tune what they cannot evaluate. If our defaults are wrong, a slider does not fix that.
- **Notifications, email, push.** Nothing here is time-critical enough to interrupt someone.
- **A charting library.** One sparkline with a marker at your last visit does the job. That marker is the only chart feature the product actually needs.
- **Microservices.** The domain is not large enough to justify the operational cost. A modular monolith with a clean worker/server split gets the same separation for none of the deployment pain.
- **An AI chat box.** Easy to add, demonstrates nothing. The intelligence should be in the system, not in a text field.

---

## Known limits

- Symbol universe is a hardcoded list of 20 NSE names. In production this would be a table refreshed nightly from the exchange bhavcopy.
- Finnhub's free tier has no NSE volume and no usable history, so it acts only as a price cross-check.
- The nightly stats job uses an interval check rather than a real cron trigger.
- Rank/reorder exists in the API but has no drag handle in the UI yet.
