import { IntegrityStrip } from "../components/IntegrityStrip";
import { SortieLog } from "../components/SortieLog";
import { useVaultData } from "../data/useVaultData";
import { addr, tokens, usd, usdValue } from "../data/types";

/**
 * The vault dashboard: everything the chain publishes about one vault, and
 * nothing it does not.
 */

/**
 * Parameters the keep holds and the chain never sees. Listed by name because
 * their *existence* is public — they are in the README — while every value is
 * not. The bar widths are arbitrary and encode nothing; they stand in for a
 * number, they do not hint at one.
 */
const SEALED: [string, number][] = [
  ["entry threshold", 64],
  ["exit threshold", 46],
  ["stop-loss", 78],
  ["position size", 34],
  ["max exposure", 56],
  ["slippage policy", 27],
  ["cooldown", 44],
  ["signal weights", 88],
];

export function VaultView() {
  const { vault, policy, holdings, sorties, byMint, stats, enclaveDays } = useVaultData();

  return (
    <div className="page">
        <section className="section" id="integrity">
          <div className="head">
            <div>
              <p className="label">Execution integrity</p>
              <h2>Every fill, against the price the chain read</h2>
            </div>
            <p>
              The floor is recomputed on-chain from Pyth on every sortie, so a compromised strategy
              engine cannot lower it to hand the position to a sandwich.
            </p>
          </div>
          <IntegrityStrip sorties={sorties} {...byMint} />
        </section>

        <section className="section" id="holdings">
          <div className="head">
            <div>
              <p className="label">Outworks</p>
              <h2>What the vault holds</h2>
            </div>
            <p>Balances and totals, read from the vault PDA and its token accounts.</p>
          </div>
          <div className="cards">
            <div className="card">
              <p className="k">Exposure</p>
              <p className="v">{stats.exposurePct.toFixed(1)}%</p>
              <p className="note">non-stable share of the book</p>
            </div>
            <div className="card">
              <p className="k">Volume traded</p>
              <p className="v">{usd(stats.volume, 0)}</p>
              <p className="note">across {stats.plans} decisions</p>
            </div>
            <div className="card">
              <p className="k">Beat the oracle</p>
              <p className="v up">
                {stats.aboveFair}/{sorties.length}
              </p>
              <p className="note">fills better than the chain's own price</p>
            </div>
            {holdings.map((h) => (
              <div className="card" key={h.symbol}>
                <p className="k">{h.symbol}</p>
                <p className="v sm">
                  {tokens(h.amount, h.decimals, 3)} {h.symbol}
                </p>
                <p className="note">
                  {usd(usdValue(h), 0)} at {usd(h.priceMicroUsd, 2)}
                </p>
              </div>
            ))}
            <div className="card">
              <p className="k">Policy</p>
              <p className="v sm">
                v{vault.policyVersion} · nonce {vault.nextNonce}
              </p>
              <p className="note">every edit voids the keep's signed queue</p>
            </div>
          </div>
        </section>

        <section className="section" id="limits">
          <div className="head">
            <div>
              <p className="label">The moat</p>
              <h2>Limits the program enforces</h2>
            </div>
            <p>
              Public, because they live on-chain — and binding on the strategy engine whether or not
              it is honest.
            </p>
          </div>
          <div className="cards">
            <div className="card">
              <p className="k">Per-trade cap</p>
              <p className="v sm">{usd(policy.maxTradeNotional, 0)}</p>
            </div>
            <div className="card">
              <p className="k">Daily cap</p>
              <p className="v sm">{usd(policy.maxDailyNotional, 0)}</p>
              <div className="meter">
                <i style={{ width: `${Math.min(stats.dayUsedPct, 100)}%` }} />
              </div>
              <p className="note">{usd(policy.dayNotional, 0)} used today</p>
            </div>
            <div className="card">
              <p className="k">Max slippage</p>
              <p className="v sm">{policy.maxSlippageBps} bps</p>
              <p className="note">this is the line in the chart above</p>
            </div>
            <div className="card">
              <p className="k">Cooldown</p>
              <p className="v sm">{policy.minCooldownSlots} slots</p>
              <p className="note">
                ≈{((policy.minCooldownSlots * 0.4) / 60).toFixed(1)} min between fills
              </p>
            </div>
            <div className="card">
              <p className="k">Oracle staleness</p>
              <p className="v sm">{policy.maxOracleStalenessSecs}s</p>
              <p className="note">max age of a usable Pyth read</p>
            </div>
            <div className="card">
              <p className="k">Allowed</p>
              <p className="v sm">{policy.mints.map((m) => m.symbol).join(" · ")}</p>
              <p className="note">venues: {policy.venues.map((v) => v.name).join(" · ")}</p>
            </div>
          </div>
        </section>

        <section className="section" id="sorties">
          <div className="head">
            <div>
              <p className="label">Sorties</p>
              <h2>What each fill was checked against</h2>
            </div>
            <p>
              One decision becomes several legs at sizes and times chosen by a VRF, so the vault does
              not trade to a rhythm anyone can read.
            </p>
          </div>
          <SortieLog sorties={sorties} policy={policy} {...byMint} />
        </section>

        <section className="section" id="keep">
          <div className="head">
            <div>
              <p className="label">The keep</p>
              <h2>What is sealed, and how you know</h2>
            </div>
            <p>
              The vault acts only on intents signed by the registered enclave key, and refuses
              everything once that registration lapses.
            </p>
          </div>
          <div className="keep">
            <div className="card">
              <p className="k">Published</p>
              <h3>Anyone can check these</h3>
              <p className="hash">
                signing key <b>{vault.enclaveKey}</b>
              </p>
              <p className="hash">
                code measurement <b>{vault.enclaveMeasurement}</b>
              </p>
              <p className="hash">
                expires at slot {vault.enclaveExpirySlot.toLocaleString("en-US")} ·{" "}
                {enclaveDays.toFixed(1)} days left
              </p>
              <p className="hash">
                guardian <b>{addr(vault.guardian, 6, 6)}</b> — may pause, may not withdraw
              </p>
            </div>
            <div className="card sealed">
              <p className="k">Never published</p>
              <h3>These exist. Nobody has seen one.</h3>
              <p>Not the chain, not the operator, not this page.</p>
              <ul className="sealedlist">
                {SEALED.map(([name, width]) => (
                  <li key={name}>
                    <span className="bar" style={{ width: `${width}px` }} aria-hidden="true" />
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
    </div>
  );
}
