import { useMemo, useState } from "react";
import { FIXTURE } from "../data/fixture";
import { REASON_LABEL, replay, type PolicyDraft, type RejectReason } from "../data/kernel";
import { executionBps, usd } from "../data/types";

/**
 * The mandate.
 *
 * This is the DAO-treasury case made operable: write the limits you would
 * actually impose, and watch the strategy's own history get judged against
 * them. The point it makes is the product's central one — policy binds the
 * strategy whether or not the strategy consents — and it makes it with
 * arithmetic instead of a paragraph.
 *
 * Every rejection here is one the on-chain program would have produced, from
 * the same figures, using the port of `policy.rs` in `data/kernel.ts`.
 */

const { policy, sorties } = FIXTURE;

const PRESETS: { name: string; blurb: string; draft: PolicyDraft }[] = [
  {
    name: "As deployed",
    blurb: "The policy this vault actually ran under.",
    draft: {
      maxTradeNotionalUsd: 5_000,
      maxDailyNotionalUsd: 25_000,
      maxSlippageBps: 50,
      minCooldownSlots: 150,
      allowedMints: policy.mints.map((m) => m.mint),
    },
  },
  {
    name: "Conservative treasury",
    blurb: "Small clips, tight execution, long gaps between trades.",
    draft: {
      maxTradeNotionalUsd: 600,
      maxDailyNotionalUsd: 4_000,
      maxSlippageBps: 10,
      minCooldownSlots: 3_000,
      allowedMints: policy.mints.map((m) => m.mint),
    },
  },
  {
    name: "Stables only",
    blurb: "A mandate that forbids the asset this strategy actually trades.",
    draft: {
      maxTradeNotionalUsd: 5_000,
      maxDailyNotionalUsd: 25_000,
      maxSlippageBps: 50,
      minCooldownSlots: 150,
      allowedMints: policy.mints.filter((m) => m.symbol === "USDC").map((m) => m.mint),
    },
  },
];

export function MandateView() {
  const [draft, setDraft] = useState<PolicyDraft>(PRESETS[0].draft);
  const result = useMemo(() => replay(sorties, draft), [draft]);

  const set = <K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const toggleMint = (mint: string) =>
    setDraft((d) => ({
      ...d,
      allowedMints: d.allowedMints.includes(mint)
        ? d.allowedMints.filter((m) => m !== mint)
        : [...d.allowedMints, mint],
    }));

  const pctAccepted = Math.round((result.acceptedCount / Math.max(sorties.length, 1)) * 100);
  const reasons = (Object.keys(result.byReason) as RejectReason[])
    .filter((r) => result.byReason[r] > 0)
    .sort((a, b) => result.byReason[b] - result.byReason[a]);

  return (
    <div className="page">
      <section className="section" id="mandate">
        <div className="head">
          <div>
            <p className="label">Mandate</p>
            <h2>Write the limits. See what they refuse.</h2>
          </div>
          <p>
            Edit the policy and this replays all {sorties.length} of the strategy's fills through it,
            in order, the way the chain would — a refused fill spends no daily budget and starts no
            cooldown, so refusals cascade.
          </p>
        </div>

        <div className="mandate">
          <div className="controls">
            <p className="k">Presets</p>
            <div className="presets">
              {PRESETS.map((p) => (
                <button key={p.name} type="button" onClick={() => setDraft(p.draft)} title={p.blurb}>
                  {p.name}
                </button>
              ))}
            </div>

            <label className="field">
              <span>
                Per-trade cap <b>${draft.maxTradeNotionalUsd.toLocaleString("en-US")}</b>
              </span>
              <input
                type="range"
                min={100}
                max={6000}
                step={100}
                value={draft.maxTradeNotionalUsd}
                onChange={(e) => set("maxTradeNotionalUsd", Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span>
                Daily cap <b>${draft.maxDailyNotionalUsd.toLocaleString("en-US")}</b>
              </span>
              <input
                type="range"
                min={1000}
                max={30000}
                step={500}
                value={draft.maxDailyNotionalUsd}
                onChange={(e) => set("maxDailyNotionalUsd", Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span>
                Max slippage <b>{draft.maxSlippageBps} bps</b>
              </span>
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                value={draft.maxSlippageBps}
                onChange={(e) => set("maxSlippageBps", Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span>
                Cooldown <b>{draft.minCooldownSlots.toLocaleString("en-US")} slots</b>
                <i> ≈{((draft.minCooldownSlots * 0.4) / 60).toFixed(1)} min</i>
              </span>
              <input
                type="range"
                min={0}
                max={6000}
                step={50}
                value={draft.minCooldownSlots}
                onChange={(e) => set("minCooldownSlots", Number(e.target.value))}
              />
            </label>

            <p className="k" style={{ marginTop: "1.4rem" }}>
              Allowed assets
            </p>
            <div className="presets">
              {policy.mints.map((m) => (
                <button
                  key={m.mint}
                  type="button"
                  className={draft.allowedMints.includes(m.mint) ? "on" : ""}
                  onClick={() => toggleMint(m.mint)}
                >
                  {m.symbol}
                </button>
              ))}
            </div>
            <p className="note">
              Venue is not replayable: <code>SortieExecuted</code> does not publish which program
              routed the fill, so this builder does not pretend to check it.
            </p>
          </div>

          <div className="verdict">
            <div className="verdict-top">
              <div>
                <p className="v">
                  {result.acceptedCount}
                  <span className="of">/{sorties.length}</span>
                </p>
                <p className="k">fills this mandate allows</p>
              </div>
              <div>
                <p className={`v ${result.rejectedCount > 0 ? "miss" : ""}`}>
                  {result.rejectedCount}
                </p>
                <p className="k">refused</p>
              </div>
              <div>
                <p className="v">{usd(result.refusedNotionalMicroUsd, 0)}</p>
                <p className="k">volume refused</p>
              </div>
            </div>

            <div className="ratio" role="img" aria-label={`${pctAccepted}% of fills allowed`}>
              <i style={{ width: `${pctAccepted}%` }} />
            </div>

            {reasons.length === 0 ? (
              <p className="note">
                This mandate would have permitted every fill the strategy made. Tighten it and the
                refusals appear below.
              </p>
            ) : (
              <ul className="reasons">
                {reasons.map((r) => (
                  <li key={r}>
                    <b>{result.byReason[r]}</b>
                    <span>{REASON_LABEL[r]}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="ticks" aria-hidden="true">
              {result.judged.map((j) => (
                <i
                  key={j.sortie.nonce}
                  className={j.accepted ? "tick ok" : "tick no"}
                  title={
                    j.accepted
                      ? `sortie ${j.sortie.nonce}: allowed (${executionBps(j.sortie).toFixed(1)} bps)`
                      : `sortie ${j.sortie.nonce}: ${j.reasons.map((r) => REASON_LABEL[r]).join(", ")}`
                  }
                />
              ))}
            </div>
            <p className="note">
              One mark per fill, oldest first. Coral marks are the ones your mandate refuses.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
