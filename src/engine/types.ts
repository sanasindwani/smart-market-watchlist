/**
 * Core domain types.
 *
 * READ THIS FIRST. Everything in the engine folder is a PURE FUNCTION:
 * data in, data out, no database, no network, no clock. That is deliberate.
 * Any teammate can run and test the "smart" part of the product without
 * setting up Postgres or getting an API key:
 *
 *     npm run demo        (needs Node 22.6+, no install step at all)
 */

/** One day of price history for one symbol. Straight from the data provider. */
export type Bar = {
  date: string; // "2026-09-03" (IST trading date)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** A live-ish quote from ONE provider. We always keep the source attached. */
export type SourceQuote = {
  source: string; // "yahoo" | "finnhub"
  price: number;
  asOf: string; // ISO timestamp the PROVIDER says this price is from
  volumeToday: number;
};

/**
 * The result of reconciling several providers into one number we are
 * willing to show a user. `status` is the important part — we never
 * silently pretend a bad or old number is live.
 */
export type QuoteStatus = "ok" | "stale" | "disputed" | "unconfirmed";

export type ReconciledQuote = {
  symbol: string;
  price: number;
  asOf: string;
  volumeToday: number;
  sources: string[];
  status: QuoteStatus;
  /** Human-readable reason, shown in the UI as a badge. */
  note?: string;
};

/**
 * Slow-moving per-symbol statistics. Computed once a night by a job,
 * NOT on every page load. This is what makes "meaningful" per-symbol
 * instead of one global percentage threshold.
 */
export type SymbolStats = {
  symbol: string;
  /** Daily realised volatility (stdev of log returns) over ~30 sessions. */
  dailyVol: number;
  /**
   * Volatility of the stock's return AFTER removing the market's move.
   * This is the denominator we actually want: it asks "how surprising is
   * this move once I account for the whole market moving?"
   */
  idioVol: number;
  avgVolume: number;
  high52w: number;
  low52w: number;
  lastClose: number;
};

/** A split or dividend. Without this, a 1:2 split looks like a -50% crash. */
export type CorporateAction = {
  symbol: string;
  date: string;
  type: "split" | "dividend";
  /** For a split: shares after / shares before (a 1:2 split = 2). */
  ratio?: number;
  /** For a dividend: rupees per share. */
  amount?: number;
};

/**
 * What this user last actually saw for this symbol, and when.
 * This is the heart of the product: the baseline is PER USER,
 * not "since market open".
 */
export type Baseline = {
  symbol: string;
  price: number;
  seenAt: string; // ISO
  /**
   * The NIFTY level at that same moment. Lets us answer "did this stock
   * move, or did the whole market move?" without any extra storage cost.
   * Optional: if absent we fall back to plain volatility-scaled sigma.
   */
  indexPrice?: number;
};

export type EventKind =
  | "PRICE_MOVE" // moved far relative to its own normal volatility
  | "VOLUME_SPIKE" // unusual participation
  | "RANGE_BREAK" // new 52-week high or low
  | "GAP" // large single-session jump, not slow drift
  | "LEVEL_CROSS" // crossed a price level the user set themselves
  | "CORPORATE_ACTION"; // split / dividend

/**
 * A detected event. NOTE: events are per-SYMBOL, not per-user (except
 * PRICE_MOVE, which is the one genuinely personal signal). We compute
 * the shared ones once and every watcher of that symbol reuses them.
 * That single decision is what stops the system doing (users x symbols) work.
 */
export type SymbolEvent = {
  symbol: string;
  kind: EventKind;
  at: string; // ISO
  /** Signed size of the thing, in whatever unit makes sense for the kind. */
  magnitude: number;
  /** Everything needed to write the explanation sentence later. */
  detail: Record<string, number | string>;
  /**
   * Stable key. If the ingest worker retries, we must not create the
   * same event twice. Unique index on this column in Postgres.
   */
  dedupeKey: string;
};

/** How loudly a card presents itself. Buckets of the same salience score. */
export type Attention = "high" | "watch" | "normal";

/** An event after we have scored it for ONE particular user. */
export type RankedItem = {
  /** The strongest event in the group — drives the headline. */
  event: SymbolEvent;
  score: number;
  attention: Attention;
  headline: string;
  /** The supporting one-liners shown under the headline. */
  bullets: string[];
  /**
   * EVERY dedupeKey folded into this card, not just the headline one.
   * When the user sees this card we must acknowledge all of them, or
   * the supporting events resurface tomorrow as if they were new.
   */
  dedupeKeys: string[];
};

/** Why we deliberately said nothing about a symbol. Shown as a footnote. */
export type Suppression = {
  symbol: string;
  reason: string;
};

/** The finished briefing for one user at one moment. */
export type Digest = {
  generatedAt: string;
  lastCheckedAt: string | null;
  items: RankedItem[];
  quiet: string[];
  /** Restraint made visible. Handling an edge case invisibly earns nothing. */
  suppressed: Suppression[];
  counts: { high: number; watch: number; quiet: number };
};

/**
 * Thresholds live in one place so they are easy to defend and tune.
 *
 * TEAM DECISION: `moveSigma` is the most arguable number in the project.
 * 2σ flags roughly the top 5% of outcomes for that specific stock over
 * that specific elapsed window. Be ready to say that out loud.
 */
export const CONFIG = {
  /** Flag a price move once it exceeds this many standard deviations. */
  moveSigma: 2,
  /** Flag volume above this multiple of the 30-day average. */
  volumeMultiple: 2.5,
  /** A single-session gap this large is its own event, separate from drift. */
  gapSigma: 2,
  /** Two providers disagreeing by more than this fraction = disputed. */
  disputeTolerance: 0.005, // 0.5%
  /** A quote older than this many minutes is shown as stale. */
  staleAfterMinutes: 20,
  /**
   * Sensitivity to the market itself. beta = 1 for v1, deliberately.
   * Estimating per-symbol beta on 90 days of data adds variance without
   * adding accuracy at this horizon — a bad estimate is worse than none.
   */
  beta: 1,
  /**
   * A glance shorter than this does not burn the user's reference point.
   * If a two-second look wipes their baseline, the product is broken.
   */
  minSessionSecondsToResetBaseline: 20,
  /** Score thresholds for the red / amber / green buckets. */
  attention: { high: 2.5, watch: 1.2 },
  /** Weights for the final ranking. */
  weights: {
    sigma: 1.0,
    volume: 0.6,
    rangeBreak: 1.2,
    gap: 0.8,
    levelCross: 2.0,
    corporateAction: 1.5,
  },
};
