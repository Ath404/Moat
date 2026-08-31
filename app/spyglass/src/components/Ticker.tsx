import { useEffect, useState } from "react";
import { getTicker, type PythQuote } from "../data/live";
import { RPC_URL } from "../data/config";

/**
 * The ticker.
 *
 * Every row is a Pyth `PriceUpdateV2` account on devnet, read directly. The
 * confidence interval is shown next to each price because that is the number the
 * vault actually gates on — `max_oracle_conf_bps` — and because a price without
 * one is an assertion rather than a measurement. A REST quote cannot show it.
 *
 * Renders nothing at all until the first read succeeds. A ticker with invented
 * numbers in it would undo the entire point of the page.
 */

const RPC = RPC_URL;

export function Ticker() {
  const [rows, setRows] = useState<PythQuote[] | null>(null);

  useEffect(() => {
    let alive = true;
    const read = () =>
      getTicker(RPC)
        .then((r) => alive && r.length > 0 && setRows(r))
        .catch(() => undefined); // stay silent rather than show a broken strip
    read();
    const id = setInterval(read, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!rows) return null;

  // Duplicated so the marquee can loop without a visible seam.
  const lane = [...rows, ...rows];

  return (
    <div className="tickerwrap" aria-hidden="true">
      <div className="ticker">
        {lane.map((q, i) => (
          <span className="tick-item" key={`${q.symbol}-${i}`}>
            <b>{q.symbol}</b>
            <span className="px">
              {q.usd < 0.01 ? q.usd.toFixed(6) : q.usd < 10 ? q.usd.toFixed(4) : q.usd.toFixed(2)}
            </span>
            <i>±{q.confBps.toFixed(1)}bps</i>
          </span>
        ))}
      </div>
    </div>
  );
}
