import { useEffect, useState } from "react";
import { getReferencePrice } from "../data/live";
import { simulateAttack } from "../data/kernel";

/**
 * The attack.
 *
 * Most "TEE + DeFi" designs stop at "the enclave is secure, trust it". The
 * distinctive claim here is that the vault survives an enclave that is *not*
 * secure — so this page hands you the compromised enclave and asks you to drain
 * the vault with it.
 *
 * You get everything a real attacker would have: the signing key, control of the
 * nonce sequence, and free choice of the price you settle at. Every check passes
 * except one. That one is the product.
 *
 * The maths runs against a live SOL price so the dollar figure is a real market
 * number rather than a prop.
 */

const MAX_TRADE_USD = 5_000;
const MAX_SLIPPAGE_BPS = 50;

export function AttackView() {
  const [solPrice, setSolPrice] = useState<number | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [amountInUsd, setAmountInUsd] = useState(4_000);
  const [askedPct, setAskedPct] = useState(20);
  const [floorEnabled, setFloorEnabled] = useState(true);

  useEffect(() => {
    let alive = true;
    getReferencePrice()
      .then((p) => alive && setSolPrice(p.usd))
      .catch((e) => alive && setPriceError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  // Until the live price lands, fall back to a clearly-labelled placeholder
  // rather than rendering an empty panel.
  const price = solPrice ?? 100;

  const result = simulateAttack({
    amountInUsd,
    askedPct,
    floorEnabled,
    solPriceUsd: price,
    maxSlippageBps: MAX_SLIPPAGE_BPS,
    maxTradeNotionalUsd: MAX_TRADE_USD,
  });

  return (
    <div className="page">
      <section className="section" id="attack">
        <div className="head">
          <div>
            <p className="label">The mechanism</p>
            <h2>You own the enclave. Try to drain the vault.</h2>
          </div>
          <p>
            Assume the strategy engine is fully compromised: you hold its signing key, you control
            the nonce sequence, and you are on the other side of the trade. Everything below is the
            chain's response, computed here from a live SOL price.
          </p>
        </div>

        <div className="mandate">
          <div className="controls">
            <p className="k">SOL price</p>
            <p className="v sm" style={{ marginBottom: "1.2rem" }}>
              ${price.toFixed(2)}{" "}
              <i className="note" style={{ display: "inline" }}>
                {solPrice ? "live · Jupiter" : priceError ? "placeholder — live price unavailable" : "loading…"}
              </i>
            </p>

            <label className="field">
              <span>
                You spend <b>${amountInUsd.toLocaleString("en-US")}</b> of the vault's USDC
              </span>
              <input
                type="range"
                min={500}
                max={8000}
                step={100}
                value={amountInUsd}
                onChange={(e) => setAmountInUsd(Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span>
                You settle at <b>{askedPct}%</b> of the honest price
                <i> — an honest keep asks for 99.5%</i>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={askedPct}
                onChange={(e) => setAskedPct(Number(e.target.value))}
              />
            </label>

            <button
              type="button"
              className={`toggle ${floorEnabled ? "on" : ""}`}
              onClick={() => setFloorEnabled((v) => !v)}
              aria-pressed={floorEnabled}
            >
              <span className="dotbox" aria-hidden="true" />
              Oracle-derived floor {floorEnabled ? "enabled" : "disabled"}
            </button>
            <p className="note">
              Switch it off to see what every cap and allowlist is worth on its own. This is the one
              check most designs of this shape do not have.
            </p>
          </div>

          <div className="verdict">
            <div className={`banner ${result.executed ? "bad" : "good"}`}>
              {result.executed ? "TRANSACTION EXECUTES" : "TRANSACTION REJECTED"}
            </div>

            <ul className="checks" style={{ marginTop: "1.2rem" }}>
              {result.checks.map((c) => (
                <li key={c.label}>
                  <span className={c.pass ? "mark ok" : "mark miss"}>{c.pass ? "PASS" : "FAIL"}</span>
                  <span>
                    <b>{c.label}</b>
                    {c.pivotal && <em className="pivot"> — the one that matters</em>}
                    <br />
                    {c.detail}
                  </span>
                </li>
              ))}
            </ul>

            <div className="verdict-top" style={{ marginTop: "1.4rem" }}>
              <div>
                <p className="k">Honest output</p>
                <p className="v sm">{result.fairOut.toFixed(4)} SOL</p>
              </div>
              <div>
                <p className="k">Floor demanded</p>
                <p className="v sm">{result.floorOut.toFixed(4)} SOL</p>
              </div>
              <div>
                <p className="k">You extract</p>
                <p className={`v sm ${result.extractedUsd > 0 ? "miss" : ""}`}>
                  ${result.extractedUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </p>
              </div>
            </div>

            <p className="note" style={{ marginTop: "1.1rem" }}>
              {result.executed
                ? "Every bound the vault has is respected, and the money still leaves. Size caps constrain how much moves — not the price it moves at."
                : "The caps never fired. The floor did: the chain priced the trade itself and refused to settle below what the oracle says is honest."}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
