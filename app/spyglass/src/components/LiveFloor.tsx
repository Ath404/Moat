import { useEffect, useState } from "react";
import { getPythQuotes, PYTH_DEVNET, type PythQuote } from "../data/live";
import { RPC_URL } from "../data/config";

/**
 * The hero visual: the mechanism, running on live data.
 *
 * A diagram of how the floor works would be a picture. This is the floor —
 * computed right now, from the Pyth account the deployed program reads, using
 * the deployed vault's own `max_slippage_bps`. Every number moves when the
 * market does.
 *
 * It also renders the two gates the program applies before it will price
 * anything at all: the confidence interval against `max_oracle_conf_bps`, and
 * the age against `max_oracle_staleness_secs`. When a feed drifts outside
 * either, the vault stops trading — and this panel says so rather than
 * continuing to quote a number the chain would refuse to use.
 */

const RPC = RPC_URL;

/** Mirrors the deployed vault's policy. */
const MAX_SLIPPAGE_BPS = 50;
const MAX_CONF_BPS = 100;
const MAX_STALENESS_SECS = 30;

const SIZES = [500, 1_000, 4_000];

export function LiveFloor() {
  const [quotes, setQuotes] = useState<PythQuote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizeUsd, setSizeUsd] = useState(4_000);
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000));

  // Poll every 15s, but re-render the age every second. The number is real
  // either way — a read does not get fresher between polls.
  useEffect(() => {
    const id = setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;
    const read = () =>
      getPythQuotes(RPC)
        .then((q) => alive && (setQuotes(q), setError(null)))
        .catch((e) => alive && setError(String(e?.message ?? e)));
    read();
    const id = setInterval(read, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const sol = quotes?.find((q) => q.symbol.startsWith("SOL"));

  if (error && !sol) {
    return (
      <div className="floorcard">
        <p className="k">Oracle</p>
        <p className="sub miss">{error}</p>
      </div>
    );
  }
  if (!sol) {
    return (
      <div className="floorcard">
        <p className="k">Oracle</p>
        <p className="sub">reading the price account…</p>
      </div>
    );
  }

  const fair = sizeUsd / sol.usd;
  const floor = fair * (1 - MAX_SLIPPAGE_BPS / 10_000);
  const liveAge = Math.max(sol.ageSecs, nowSecs - sol.publishTime);
  const confOk = sol.confBps <= MAX_CONF_BPS;
  const freshOk = liveAge <= MAX_STALENESS_SECS;
  const wouldPrice = confOk && freshOk;

  return (
    <div className="floorcard">
      <div className="floorhead">
        <div>
          <p className="k">Pyth · SOL/USD · live</p>
          <p className="bigpx">
            {sol.usd.toFixed(2)}
            <span className="cur">USD</span>
          </p>
        </div>
        <div className="gates">
          <span className={confOk ? "gate ok" : "gate bad"}>
            ±{sol.confBps.toFixed(1)} bps <em>≤ {MAX_CONF_BPS}</em>
          </span>
          <span className={freshOk ? "gate ok" : "gate bad"}>
            {liveAge}s old <em>≤ {MAX_STALENESS_SECS}s</em>
          </span>
        </div>
      </div>

      <div className="sizerow">
        {SIZES.map((s) => (
          <button
            key={s}
            type="button"
            className={s === sizeUsd ? "on" : ""}
            onClick={() => setSizeUsd(s)}
          >
            ${s.toLocaleString("en-US")}
          </button>
        ))}
        <span className="sub">buy, right now</span>
      </div>

      <div className="floorcalc">
        <div>
          <p className="k">Honest output</p>
          <p className="num">{fair.toFixed(4)} SOL</p>
        </div>
        <div className="arrow" aria-hidden="true">
          × (1 − {MAX_SLIPPAGE_BPS}bps)
        </div>
        <div>
          <p className="k">Floor the vault demands</p>
          <p className="num accent">{floor.toFixed(4)} SOL</p>
        </div>
      </div>

      <p className="floornote">
        {wouldPrice ? (
          <>
            Even a hacked strategy engine can't settle below <b>{floor.toFixed(4)} SOL</b>. The
            chain reads the price itself, from <code>{PYTH_DEVNET.sol.account.slice(0, 8)}…</code>.
          </>
        ) : (
          <>
            The vault <b>won't trade right now</b>.{" "}
            {!confOk && `Confidence ±${sol.confBps.toFixed(1)}bps is over the ${MAX_CONF_BPS}bps limit.`}{" "}
            {!freshOk && `This price is ${liveAge}s old, over the ${MAX_STALENESS_SECS}s limit.`}
          </>
        )}
      </p>
    </div>
  );
}
