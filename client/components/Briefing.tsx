import { useEffect, useRef, useState } from "react";
import { api, ago, rupees, type Digest } from "../api.ts";

/**
 * THE BRIEFING. The only screen that has to be beautiful.
 *
 * Note what is NOT here: no table of every holding, no percentage grid, no
 * sparkline wall. If the user has to scan, we have failed. They get a
 * sentence, the evidence behind it, and an explicit statement that we
 * looked at the rest and it was quiet.
 */
export function Briefing({ onOpen }: { onOpen: (symbol: string) => void }) {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opened = useRef(Date.now());

  useEffect(() => {
    api.digest().then(setDigest).catch((e) => setError(e.message));
  }, []);

  /**
   * Mark the briefing read when they leave, and tell the server HOW LONG
   * they looked. The server refuses to move the baseline for a glance, so
   * flicking the app open for two seconds cannot wipe the reference point
   * the entire product is measured from.
   */
  useEffect(() => {
    const flush = () => {
      const seconds = (Date.now() - opened.current) / 1000;
      if (seconds >= 5) void api.markRead(seconds).catch(() => {});
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!digest) return <p className="lede-meta">Reading the market…</p>;

  const { items, quiet, suppressed, counts, lastCheckedAt, index } = digest;
  const total = items.length + quiet.length;

  if (total === 0) {
    return (
      <div className="empty">
        <p>Your watchlist is empty.</p>
        <p className="lede-meta">
          Add a few stocks and come back tomorrow — that is when this becomes
          useful.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="section-kicker"><span className="live-dot" /> MARKET BRIEFING <span className="kicker-date">{new Date(digest.generatedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</span></div>
      <div className="briefing-intro">
        <div>
          <h1 className="lede">{lede(counts.high, counts.watch, total)}</h1>
          <p className="lede-meta">
            {lastCheckedAt
              ? `You last checked ${ago(lastCheckedAt, Date.parse(digest.generatedAt))}`
              : "First visit — we'll start tracking from here"}
          </p>
        </div>
        {index && <div className="market-tile"><span>NIFTY 50</span><strong>{index.changePct == null ? "—" : `${index.changePct >= 0 ? "+" : ""}${index.changePct.toFixed(2)}%`}</strong><small>Market benchmark · today</small></div>}
      </div>

      {items.map((item) => (
        <article
          key={item.event.symbol}
          className="item"
          data-attention={item.attention}
        >
          <div className="rail" aria-hidden="true" />
          <div>
            <div className="item-head">
              <button
                className="ticker"
                onClick={() => onOpen(item.event.symbol)}
                style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
              >
                {item.event.symbol}
              </button>
              <span className={`signal signal-${item.attention}`}>{attentionWord(item.attention)}</span>
            </div>
            <p className="headline">{item.headline}</p>
            <ul className="evidence">
              {item.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        </article>
      ))}

      {quiet.length > 0 && (
        <div className="quiet">
          {items.length === 0
            ? "Nothing on your list moved in a way worth reading about."
            : `${quiet.length} other ${quiet.length === 1 ? "stock was" : "stocks were"} quiet.`}
          <div className="tickers">{quiet.join("  ")}</div>
        </div>
      )}

      {suppressed.length > 0 && (
        <section className="suppressed">
          <h3>We stayed quiet on these, and here's why</h3>
          <dl>
            {suppressed.map((s) => (
              <div key={s.symbol} style={{ display: "contents" }}>
                <dt>{s.symbol}</dt>
                <dd style={{ margin: 0 }}>{s.reason}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </>
  );
}

/**
 * The lede. Written, not templated — the sentence changes shape with the
 * news rather than filling the same slots with different numbers.
 */
function lede(high: number, watch: number, total: number): string {
  if (high === 0 && watch === 0) {
    return `Nothing on your ${total} needs you today.`;
  }
  if (high === 0) {
    return watch === 1
      ? "One thing is worth a look."
      : `${watch} things are worth a look.`;
  }
  const head =
    high === 1 ? "One thing needs your attention" : `${high} things need your attention`;
  return watch > 0 ? `${head}, and ${watch} more worth a look.` : `${head}.`;
}

function attentionWord(a: "high" | "watch" | "normal"): string {
  return a === "high" ? "needs attention" : a === "watch" ? "worth a look" : "";
}

export { rupees };
