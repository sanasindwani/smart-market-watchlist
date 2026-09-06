import { useEffect, useState } from "react";
import { api, getToken, setToken } from "./api.ts";
import { Briefing } from "./components/Briefing.tsx";
import { Auth, SymbolDetail, Watchlist } from "./components/Screens.tsx";

type View = "briefing" | "watchlist" | { symbol: string };

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [view, setView] = useState<View>("briefing");
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    void api.health().then((h) => setDemo(h.demo)).catch(() => {});
  }, []);

  if (!authed) return <Auth onDone={() => setAuthed(true)} />;

  const open = (symbol: string) => setView({ symbol });

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">SL</div>
          <div>
            <div className="wordmark">Since last looked</div>
            <div className="brand-subtitle">Personal market intelligence</div>
          </div>
        </div>
        <nav aria-label="Primary navigation">
          <button
            aria-current={view === "briefing"}
            onClick={() => setView("briefing")}
          >
            Briefing
          </button>
          <button
            aria-current={view === "watchlist"}
            onClick={() => setView("watchlist")}
          >
            Watchlist
          </button>
          <button className="signout"
            onClick={() => {
              setToken(null);
              setAuthed(false);
            }}
          >
            Sign out
          </button>
        </nav>
      </header>

      {view === "briefing" && <Briefing onOpen={open} />}
      {view === "watchlist" && <Watchlist onOpen={open} />}
      {typeof view === "object" && (
        <SymbolDetail symbol={view.symbol} onBack={() => setView("briefing")} />
      )}

      {demo && <DemoBar />}
    </div>
  );
}

/**
 * Only rendered when the server has DEMO_MODE on.
 *
 * "Come back later and see what changed" cannot be demonstrated live in a
 * three-minute review, so we let the reviewer move time instead of waiting
 * for it. Handing someone the ability to test your core claim in one click
 * is worth more than describing it.
 */
function DemoBar() {
  const jump = async (minutes: number) => {
    await api.advanceClock(minutes);
    location.reload();
  };
  return (
    <div className="demobar">
      <span>Demo clock</span>
      <button onClick={() => void jump(60)}>+1 hour</button>
      <button onClick={() => void jump(60 * 24)}>+1 day</button>
      <button onClick={() => void jump(60 * 24 * 3)}>+3 days</button>
      <button
        onClick={async () => {
          await api.resetClock();
          location.reload();
        }}
      >
        Reset
      </button>
    </div>
  );
}
