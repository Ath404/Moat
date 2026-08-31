import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The sealed board.
 *
 * Eight strategy parameters, rendered as hex that never resolves. It is the one
 * piece of motion on this page that is allowed to be theatrical, because the
 * thing it depicts is genuinely unknowable: these values exist inside the
 * enclave and have never been published, so there is nothing truthful to
 * animate *towards*.
 *
 * That is also the argument against the obvious alternative — a fragment grid
 * that visibly reassembles. Fragments imply a whole that could be recovered
 * given enough columns. Nothing here is a fragment of anything the chain holds.
 *
 * Honest by construction: the characters come from a PRNG seeded per-cell, so
 * no real parameter is encoded here and none could be recovered from the
 * animation. Reduced-motion gets a still frame.
 */

const PARAMS = [
  "entry threshold",
  "exit threshold",
  "stop-loss",
  "position size",
  "max exposure",
  "slippage policy",
  "cooldown",
  "signal weights",
];

const HEX = "0123456789abcdef";
const WIDTH = 6;

/** Small deterministic PRNG so a cell's idle state is stable between frames. */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scramble(rand: () => number, len = WIDTH) {
  let s = "";
  for (let i = 0; i < len; i++) s += HEX[Math.floor(rand() * 16)];
  return s;
}

export function SealedBoard() {
  const reduced = useMemo(
    () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );
  const randRef = useRef(mulberry(0x5ea1ed));
  const [cells, setCells] = useState<string[]>(() =>
    PARAMS.map(() => scramble(randRef.current))
  );
  /** Which row is mid-flip, so one line churns harder than the rest. */
  const [hot, setHot] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const rand = randRef.current;
    const id = setInterval(() => {
      setCells((prev) =>
        prev.map((cur, i) => {
          // Every row jitters a little; the hot row is fully re-drawn.
          if (i === hot) return scramble(rand);
          if (rand() > 0.55) {
            const at = Math.floor(rand() * WIDTH);
            return cur.slice(0, at) + HEX[Math.floor(rand() * 16)] + cur.slice(at + 1);
          }
          return cur;
        })
      );
    }, 90);
    return () => clearInterval(id);
  }, [hot, reduced]);

  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setHot((h) => (h + 1) % PARAMS.length), 1400);
    return () => clearInterval(id);
  }, [reduced]);

  return (
    <div className="sealedboard">
      <div className="sb-head">
        <p className="k">Inside the keep</p>
        <p className="sb-count">
          <b>8</b> parameters · <b>0</b> published
        </p>
      </div>

      <div className="sb-grid">
        {PARAMS.map((name, i) => (
          <div className={`sb-row ${i === hot ? "hot" : ""}`} key={name}>
            <span className="sb-name">{name}</span>
            <span className="sb-val" aria-hidden="true">
              {cells[i].split("").map((ch, j) => (
                <i key={j}>{ch}</i>
              ))}
            </span>
          </div>
        ))}
      </div>

      <p className="sb-note">
        The strategy's numbers. None of them is on-chain, in an event, or on this page.
      </p>
    </div>
  );
}
