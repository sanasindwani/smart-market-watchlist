import { useEffect, useState } from "react";
import {
  api,
  ago,
  rupees,
  setToken,
  type Detail,
  type Listing,
  type WatchRow,
} from "../api.ts";

/* ── watchlist ────────────────────────────────────────────────────────── */

export function Watchlist({ onOpen }: { onOpen: (symbol: string) => void }) {
  const [rows, setRows] = useState<WatchRow[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Listing[]>([]);
  const [busy, setBusy] = useState(false);

  const load = () => api.watchlist().then(setRows);
  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (query.trim().length < 1) return setHits([]);
    const t = setTimeout(() => void api.searchSymbols(query).then(setHits), 150);
    return () => clearTimeout(t);
  }, [query]);

  async function add(symbol: string) {
    setBusy(true);
    setQuery("");
    setHits([]);
    // First time anyone adds this symbol the server backfills 250 sessions,
    // so this one can take a moment. Every later user gets it instantly.
    await api.add(symbol).catch(() => {});
    await load();
    setBusy(false);
  }

  return (
    <>
      <div className="section-kicker"><span className="live-dot" /> COVERAGE</div>
      <h1 className="lede">Your watchlist</h1>
      <p className="lede-meta">
        {rows.length} {rows.length === 1 ? "stock" : "stocks"} · NIFTY is tracked
        automatically as the benchmark
      </p>

      <div className="search-wrap" style={{ marginBottom: hits.length ? 0 : "1.5rem" }}>
        <input
          type="text"
          value={query}
          placeholder="Add a stock — try INFY or Reliance"
          onChange={(e) => setQuery(e.target.value)}
          disabled={busy}
          aria-label="Search stocks to add"
        />
        {hits.length > 0 && (
          <div className="suggestions">
            {hits.map((h) => (
              <button key={h.symbol} onClick={() => void add(h.symbol)}>
                {h.name}
                <span className="sym">{h.symbol}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {rows.map((r) => (
        <div className="row" key={r.symbol}>
          <div className="row-name">
            <button
              onClick={() => onOpen(r.symbol)}
              style={{ background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer" }}
            >
              {r.name}
            </button>
            <span>
              <i className="dot" data-status={r.quote?.status ?? "unconfirmed"} />
              {r.symbol}
              {r.quote && r.quote.status !== "ok" && ` — ${r.quote.note ?? r.quote.status}`}
            </span>
          </div>
          <div className="row-quote"><div className="num">{r.quote ? rupees(r.quote.price) : "—"}</div><small>{r.quote ? `Updated ${ago(r.quote.asOf)}` : "Awaiting quote"}</small></div>
          <button
            className="remove"
            onClick={async () => {
              await api.remove(r.symbol);
              await load();
            }}
            aria-label={`Remove ${r.symbol}`}
          >
            Remove
          </button>
        </div>
      ))}

      {rows.length === 0 && (
        <div className="empty">
          <p>Nothing here yet.</p>
          <p className="lede-meta">
            Add three or four stocks you actually care about. The briefing gets
            better the longer you stay away.
          </p>
        </div>
      )}
    </>
  );
}

/* ── symbol detail ────────────────────────────────────────────────────── */

export function SymbolDetail({
  symbol,
  onBack,
}: {
  symbol: string;
  onBack: () => void;
}) {
  const [d, setDetail] = useState<Detail | null>(null);
  const [level, setLevel] = useState("");

  useEffect(() => {
    void api.detail(symbol).then(setDetail);
  }, [symbol]);

  if (!d) return <p className="lede-meta">Loading {symbol}…</p>;

  return (
    <>
      <button className="btn ghost back-button" onClick={onBack} style={{ marginBottom: "1.5rem" }}>
        ← Back to briefing
      </button>

      <div className="detail-head">
        <div><span className="section-kicker">{d.symbol} · {d.sector ?? "EQUITY"}</span><h2>{d.name}</h2></div>
        <span className="detail-price">{d.quote ? rupees(d.quote.price) : "—"}</span>
      </div>
      <p className="lede-meta">
        {d.quote && ` · updated ${ago(d.quote.asOf)}`}
        {d.quote?.status !== "ok" && d.quote?.note && ` · ${d.quote.note}`}
      </p>

      <Sparkline
        bars={d.bars}
        baselinePrice={d.baseline?.price}
        baselineDate={d.baseline?.seenAt}
      />

      {d.stat && (
        <div className="stats">
          <div>
            <span>Daily volatility</span>
            {(d.stat.dailyVol * 100).toFixed(2)}%
          </div>
          <div>
            <span>Excl. market</span>
            {(d.stat.idioVol * 100).toFixed(2)}%
          </div>
          <div>
            <span>52-week high</span>
            {rupees(d.stat.high52w)}
          </div>
          <div>
            <span>52-week low</span>
            {rupees(d.stat.low52w)}
          </div>
          <div>
            <span>Avg volume</span>
            {(d.stat.avgVolume / 1e6).toFixed(1)}M
          </div>
        </div>
      )}

      <h3 style={{ fontWeight: 400, fontSize: "1.05rem" }}>Alert me when it crosses</h3>
      <div style={{ display: "flex", gap: "0.5rem", margin: "0.5rem 0 2rem" }}>
        <input
          type="number"
          value={level}
          placeholder={d.quote ? String(Math.round(d.quote.price * 1.05)) : "0"}
          onChange={(e) => setLevel(e.target.value)}
          aria-label="Price level"
        />
        <button
          className="btn"
          disabled={!level}
          onClick={async () => {
            const value = Number(level);
            const dir = d.quote && value > d.quote.price ? "above" : "below";
            await api.addAlert(d.symbol, value, dir);
            setLevel("");
            void api.detail(symbol).then(setDetail);
          }}
        >
          Set level
        </button>
      </div>
      {d.levels.length > 0 && (
        <p className="lede-meta">
          Watching for: {d.levels.map((l) => `${l.direction} ${rupees(l.value)}`).join(", ")}
        </p>
      )}

      <h3 style={{ fontWeight: 400, fontSize: "1.05rem", marginTop: "2rem" }}>
        What happened
      </h3>
      <ul className="timeline">
        {d.events.map((e) => (
          <li key={e.id}>
            <time>{new Date(e.at).toLocaleString("en-IN")}</time>
            {describe(e.kind, e.magnitude)}
          </li>
        ))}
        {d.events.length === 0 && (
          <li style={{ color: "var(--ink-soft)" }}>
            Nothing notable in the last two weeks.
          </li>
        )}
      </ul>
    </>
  );
}

function describe(kind: string, magnitude: number): string {
  switch (kind) {
    case "GAP":
      return `Single-session move of ${magnitude.toFixed(1)}σ`;
    case "PRICE_MOVE":
      return `Moved ${magnitude.toFixed(1)}σ since a baseline`;
    case "VOLUME_SPIKE":
      return `Volume ${magnitude.toFixed(1)}× its average`;
    case "RANGE_BREAK":
      return magnitude > 0 ? "New 52-week high" : "New 52-week low";
    case "CORPORATE_ACTION":
      return `Corporate action (ratio ${magnitude})`;
    case "LEVEL_CROSS":
      return "Crossed your alert level";
    default:
      return kind;
  }
}

/* ── sparkline ────────────────────────────────────────────────────────── */

/**
 * 90 days of closes with a dashed marker where the user last looked.
 * That marker is the point of the chart — it turns an abstract line into
 * "here is where you were, here is where it went".
 */
export function Sparkline({
  bars,
  baselinePrice,
  baselineDate,
}: {
  bars: { date: string; close: number }[];
  baselinePrice?: number;
  baselineDate?: string;
}) {
  if (bars.length < 2) return null;

  const W = 640;
  const H = 90;
  const closes = bars.map((b) => b.close);
  const lo = Math.min(...closes, baselinePrice ?? Infinity);
  const hi = Math.max(...closes, baselinePrice ?? -Infinity);
  const span = hi - lo || 1;

  const x = (i: number) => (i / (bars.length - 1)) * W;
  const y = (v: number) => H - ((v - lo) / span) * H;

  const path = bars.map((b, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(b.close).toFixed(1)}`).join("");

  const markerIndex = baselineDate
    ? bars.findIndex((b) => b.date >= baselineDate.slice(0, 10))
    : -1;

  return (
    <svg
      className="spark"
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      role="img"
      aria-label="Price over the last 90 sessions"
    >
      <path d={path} />
      {markerIndex > 0 && (
        <>
          <line className="marker" x1={x(markerIndex)} y1="0" x2={x(markerIndex)} y2={H} />
          <circle cx={x(markerIndex)} cy={y(bars[markerIndex].close)} r="2.5" />
        </>
      )}
      <circle cx={W} cy={y(closes[closes.length - 1])} r="2.5" />
    </svg>
  );
}

/* ── auth ─────────────────────────────────────────────────────────────── */

export function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      const fn = mode === "login" ? api.login : api.register;
      const { token } = await fn(email, password);
      setToken(token);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="auth">
      <h1>What changed while you were away</h1>
      <p>
        A watchlist that tells you what moved since <em>you</em> last looked —
        not since the market opened.
      </p>

      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
      </div>

      <button className="btn" onClick={() => void submit()} style={{ width: "100%" }}>
        {mode === "login" ? "Sign in" : "Create account"}
      </button>

      {error && <p className="error">{error}</p>}

      <p className="hint">
        {mode === "login" ? (
          <>
            No account?{" "}
            <button
              className="remove"
              onClick={() => setMode("register")}
              style={{ textDecoration: "underline" }}
            >
              Create one
            </button>
            <br />
            <br />
            Reviewing this? Sign in with
            <br />
            demo@watchlist.app / demo1234
          </>
        ) : (
          <>
            Already have one?{" "}
            <button
              className="remove"
              onClick={() => setMode("login")}
              style={{ textDecoration: "underline" }}
            >
              Sign in
            </button>
          </>
        )}
      </p>
    </div>
  );
}
