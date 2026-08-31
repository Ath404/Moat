import { useEffect, useMemo, useState } from "react";
import { FloorChart } from "../components/FloorChart";
import { ProvePanel } from "../components/ProvePanel";
import { RPC_URL, VAULT_ADDRESS } from "../data/config";
import { getSignatures, type VaultSignature } from "../data/live";
import { getTape, startTape, subscribeTape } from "../data/oracleTape";
import { addr } from "../data/types";
import { useVaultData } from "../data/useVaultData";

/**
 * The desk.
 *
 * Every other surface here explains the vault. This one operates it: one dense
 * screen where the price, the floor, the mandate and the vault's own state are
 * all live at once, and where you can size a trade and watch the policy decide.
 *
 * The ticket is the centrepiece and it is not a mock. It reads the deployed
 * vault's real caps, prices against the same Pyth account `execute_sortie`
 * consumes, and applies the checks in the order `moat-core` applies them. When
 * it says the vault would refuse, the reason is the first check that actually
 * failed — and the panel below it puts the same question to the chain directly.
 */

const SIZES = [250, 1_000, 4_000, 6_000];

/** Micro-USD, the unit the program counts notional in. */
const MICRO = 1_000_000n;

function Meter({ label, used, cap, unit }: { label: string; used: number; cap: number; unit?: string }) {
  const pct = cap === 0 ? 0 : Math.min(100, (used / cap) * 100);
  return (
    <div className="dmeter">
      <div className="dmeter-top">
        <span className="k">{label}</span>
        <span className="dmeter-val">
          {used.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          <i> / {cap.toLocaleString("en-US", { maximumFractionDigits: 0 })}{unit ? ` ${unit}` : ""}</i>
        </span>
      </div>
      <div className="dmeter-track">
        <div className={`dmeter-fill ${pct > 90 ? "hot" : ""}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function DeskView() {
  const { vault, policy, stats, snapshot } = useVaultData();
  const [, force] = useState(0);
  const [sizeUsd, setSizeUsd] = useState(4_000);
  const [activity, setActivity] = useState<VaultSignature[] | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    startTape();
    return subscribeTape(() => force((n) => n + 1));
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;
    const read = () =>
      getSignatures(VAULT_ADDRESS, RPC_URL, 12)
        .then((s) => alive && setActivity(s))
        .catch(() => alive && setActivity([]));
    read();
    const id = setInterval(read, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const tape = getTape();
  const last = tape[tape.length - 1];

  const slippageBps = policy.maxSlippageBps;
  const maxTradeUsd = Number(policy.maxTradeNotional / MICRO);
  const maxDailyUsd = Number(policy.maxDailyNotional / MICRO);
  const dayUsedUsd = Number(policy.dayNotional / MICRO);

  /**
   * The checks, in the order `moat-core::check_intent` runs them. Order is not
   * cosmetic: reporting "trade too large" when the oracle is stale would send an
   * operator looking in the wrong place.
   */
  const decision = useMemo(() => {
    if (!last) return null;
    const liveAge = Math.max(last.ageSecs, now - last.publishTime);
    const checks = [
      { label: "Vault not paused", pass: !vault.paused, detail: vault.paused ? "vault is paused" : "trading" },
      {
        label: "Oracle confidence",
        pass: last.confBps <= policy.maxOracleConfBps,
        detail: `±${last.confBps.toFixed(1)} bps ≤ ${policy.maxOracleConfBps}`,
      },
      {
        label: "Oracle freshness",
        pass: liveAge <= policy.maxOracleStalenessSecs,
        detail: `${liveAge}s old ≤ ${policy.maxOracleStalenessSecs}s`,
      },
      {
        label: "Per-trade cap",
        pass: sizeUsd <= maxTradeUsd,
        detail: `$${sizeUsd.toLocaleString("en-US")} ≤ $${maxTradeUsd.toLocaleString("en-US")}`,
      },
      {
        label: "Daily cap",
        pass: dayUsedUsd + sizeUsd <= maxDailyUsd,
        detail: `$${(dayUsedUsd + sizeUsd).toLocaleString("en-US")} ≤ $${maxDailyUsd.toLocaleString("en-US")}`,
      },
    ];
    const fair = sizeUsd / last.usd;
    return {
      checks,
      fair,
      floor: fair * (1 - slippageBps / 10_000),
      firstFail: checks.find((c) => !c.pass) ?? null,
      liveAge,
    };
  }, [last, now, sizeUsd, vault.paused, policy, maxTradeUsd, maxDailyUsd, dayUsedUsd, slippageBps]);

  return (
    <div className="page">
      <section className="desk">
        <div className="desk-head">
          <div>
            <p className="label">The desk</p>
            <h2>Size a trade. Watch the mandate decide.</h2>
          </div>
          <div className="desk-id">
            <a
              className="dchip"
              href={`https://explorer.solana.com/address/${VAULT_ADDRESS}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
            >
              vault {addr(VAULT_ADDRESS, 4, 4)} ↗
            </a>
            <span className={`dchip ${vault.paused ? "bad" : "ok"}`}>
              {vault.paused ? "paused" : "trading"}
            </span>
            <span className="dchip">policy v{vault.policyVersion}</span>
            <span className="dchip">nonce {vault.nextNonce}</span>
          </div>
        </div>

        <div className="desk-grid">
          <div className="desk-chart card-panel">
            <FloorChart slippageBps={slippageBps} stalenessSecs={policy.maxOracleStalenessSecs} />
          </div>

          <div className="ticket card-panel">
            <p className="k">Ticket</p>
            <p className="ticket-pair">
              USDC <span aria-hidden="true">→</span> SOL
            </p>

            <div className="ticket-sizes">
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
            </div>

            <input
              className="ticket-range"
              type="range"
              min={100}
              max={8_000}
              step={50}
              value={sizeUsd}
              onChange={(e) => setSizeUsd(Number(e.target.value))}
              aria-label="trade size in USD"
            />

            {decision && last ? (
              <>
                <div className="ticket-out">
                  <div>
                    <p className="k">Oracle-fair output</p>
                    <p className="num">{decision.fair.toFixed(4)} SOL</p>
                  </div>
                  <div>
                    <p className="k">Floor the chain demands</p>
                    <p className="num accent">{decision.floor.toFixed(4)} SOL</p>
                  </div>
                </div>

                <div className={`ticket-verdict ${decision.firstFail ? "no" : "yes"}`}>
                  {decision.firstFail ? "THE VAULT REFUSES" : "THE VAULT WOULD SIGN THIS"}
                </div>

                <ul className="ticket-checks">
                  {decision.checks.map((c) => (
                    <li key={c.label} className={c.pass ? "ok" : "no"}>
                      <span className="tick">{c.pass ? "✓" : "✕"}</span>
                      <span>
                        <b>{c.label}</b>
                        <em>{c.detail}</em>
                      </span>
                    </li>
                  ))}
                </ul>

                <p className="ticket-note">
                  {decision.firstFail
                    ? `First failing check: ${decision.firstFail.label}. The program stops at the first refusal.`
                    : `Priced at $${last.usd.toFixed(2)}, ${decision.liveAge}s old. A fill below the floor is rejected even if the keep signs it.`}
                </p>
              </>
            ) : (
              <p className="sub" style={{ marginTop: "1.2rem" }}>
                waiting for the first oracle sample…
              </p>
            )}
          </div>

          <div className="desk-meters card-panel">
            <p className="k">The mandate, live</p>
            <Meter label="This trade against the per-trade cap" used={sizeUsd} cap={maxTradeUsd} unit="USD" />
            <Meter label="Spent inside the rolling day" used={dayUsedUsd} cap={maxDailyUsd} unit="USD" />
            <div className="dmeter-facts">
              <div>
                <p className="k">Max slippage</p>
                <p className="v">{slippageBps} bps</p>
              </div>
              <div>
                <p className="k">Cooldown</p>
                <p className="v">{policy.minCooldownSlots.toLocaleString("en-US")} slots</p>
              </div>
              <div>
                <p className="k">Oracle age limit</p>
                <p className="v">{policy.maxOracleStalenessSecs}s</p>
              </div>
              <div>
                <p className="k">Conf limit</p>
                <p className="v">{policy.maxOracleConfBps} bps</p>
              </div>
              <div>
                <p className="k">Fills</p>
                <p className="v">{stats.plans} decisions</p>
              </div>
              <div>
                <p className="k">Below floor</p>
                <p className="v">{stats.belowFloor}</p>
              </div>
            </div>
          </div>

          <div className="desk-activity card-panel">
            <p className="k">On-chain activity</p>
            {activity === null ? (
              <p className="sub">reading the vault's signatures…</p>
            ) : activity.length === 0 ? (
              <p className="sub">no transactions on this account yet.</p>
            ) : (
              <ul className="acts">
                {activity.map((s) => (
                  <li key={s.signature}>
                    <a
                      href={`https://explorer.solana.com/tx/${s.signature}?cluster=devnet`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <code>{s.signature.slice(0, 10)}…</code>
                    </a>
                    <span className={s.err ? "act-bad" : "act-ok"}>{s.err ? "failed" : "ok"}</span>
                    <span className="act-slot">slot {s.slot.toLocaleString("en-US")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <ProvePanel owner={snapshot.source === "chain" ? vault.owner : ""} />
      </section>
    </div>
  );
}
