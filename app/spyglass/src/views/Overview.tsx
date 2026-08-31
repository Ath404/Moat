import { LivePanel } from "../components/LivePanel";
import { HeroStage } from "../components/HeroStage";
import { SolanaMark, TheLine } from "../components/Chrome";
import { WaveHero } from "../components/WaveHero";
import { useVaultData } from "../data/useVaultData";
import { addr, bps, usd } from "../data/types";

/**
 * The overview.
 *
 * Leads with the claim, draws the line under it, then answers the two questions
 * a visitor actually has: who is this for, and why is it more than a slogan.
 * Both answers link into the surfaces that let you check them rather than
 * asking you to take them on trust.
 */

/** The three shapes of user this design is actually built around. */
const ROLES = [
  {
    who: "A desk running outside capital",
    problem: "Custody the money and carry the trust burden, or reveal the edge.",
    answer:
      "Depositors verify performance and execution quality without seeing one parameter. The funds never sit in an operator wallet.",
  },
  {
    who: "Someone renting out a strategy",
    problem: "Selling access to alpha usually means handing over the alpha.",
    answer:
      "The subscriber's capital never leaves their own vault. The keep signs intents; it cannot move funds on its own.",
  },
  {
    who: "A treasury with a mandate",
    problem: '"Rebalance us, but never more than $50k a day, only these assets."',
    answer:
      "That sentence is the policy account. The guardian can pause instantly and can never withdraw.",
  },
];

export function OverviewView({ onNav }: { onNav: (v: string) => void }) {
  const { vault, sorties, stats, hasKeep } = useVaultData();

  return (
    <>
      <WaveHero>
        <p className="opening-pill">
          <i className="dot" aria-hidden="true" />
          Devnet · vault {addr(vault.address, 4, 4)}
        </p>

        {/* The headline is a claim about the data, so it is derived from the
            data. If a fill ever did land under the floor, the page says so. */}
        {stats.belowFloor === 0 ? (
          <h1>
            Nothing has ever crossed <em>the line</em>.
          </h1>
        ) : (
          <h1>
            <em>{stats.belowFloor}</em> fills crossed the line.
          </h1>
        )}

        <p className="opening-sub">
          Put money in a vault. A sealed program trades it and never sees the keys. The chain
          checks every fill against its own oracle and refuses anything priced below the floor.
        </p>

        <div className="opening-cta">
          <button type="button" className="primary" onClick={() => onNav("app")}>
            Open the app <span aria-hidden="true">→</span>
          </button>
          <button type="button" className="ghost" onClick={() => onNav("console")}>
            Drive the vault
          </button>
        </div>

        <p className="opening-built">
          Built on <SolanaMark /> <b>Solana</b>
          <i className="badge-sep" aria-hidden="true" />
          {hasKeep ? "Sealed by" : "Designed for"} <b>MagicBlock TEE</b>
        </p>

        <div className="opening-stats">
          <div>
            <p className="v">{usd(stats.tvl, 0)}</p>
            <p className="k">Total value</p>
          </div>
          <div>
            <p className="v">{sorties.length}</p>
            <p className="k">Fills · {stats.plans} decisions</p>
          </div>
          <div>
            <p className="v">{bps(stats.median)}</p>
            <p className="k">Median execution</p>
          </div>
          <div>
            <p className="v hold">{stats.medianHeadroom.toFixed(0)} bps</p>
            <p className="k">Median headroom over floor</p>
          </div>
        </div>
      </WaveHero>

      <div className="page">
        <section className="hero-after">
          <HeroStage />
        </section>
      </div>

      <TheLine />

      <div className="page">
        <section className="section" id="roles">
          <div className="head">
            <div>
              <p className="label">Who it is for</p>
              <h2>Three people with the same problem</h2>
            </div>
            <p>
              Every one of them currently has to choose between custody and confidentiality. The
              vault is the answer to not choosing.
            </p>
          </div>
          <div className="cards">
            {ROLES.map((r) => (
              <div className="card" key={r.who}>
                <h3>{r.who}</h3>
                <p className="problem">{r.problem}</p>
                <p>{r.answer}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="section" id="mechanism">
          <div className="head">
            <div>
              <p className="label">The mechanism</p>
              <h2>Why a spending cap is not enough</h2>
            </div>
            <p>
              A compromised strategy engine that stays under your per-trade cap can still route the
              whole trade into its own pool at a price it chooses. The cap bounds the size, not the
              price.
            </p>
          </div>
          <div className="cards">
            <div className="card">
              <p className="k">What the chain does instead</p>
              <h3>It prices the trade itself</h3>
              <p>
                Before settling, the program reads Pyth, computes what an honest fill is worth, and
                refuses anything below <b>expected × (1 − max_slippage)</b>. The keep never gets to
                name the price.
              </p>
              <button type="button" className="cta" onClick={() => onNav("attack")}>
                Try to defeat it →
              </button>
            </div>
            <div className="card">
              <p className="k">What that buys the depositor</p>
              <h3>Three numbers per fill</h3>
              <p>
                Every sortie publishes the oracle-fair output, the floor demanded, and the amount
                received — enough to audit execution quality, and not enough to reconstruct why the
                trade happened.
              </p>
              <button type="button" className="cta" onClick={() => onNav("vault")}>
                See the fills →
              </button>
            </div>
            <div className="card">
              <p className="k">What the owner controls</p>
              <h3>A mandate that binds</h3>
              <p>
                Caps, allowlists, cooldowns and slippage live on-chain. Editing them bumps the policy
                version and voids every intent the keep has already signed.
              </p>
              <button type="button" className="cta" onClick={() => onNav("mandate")}>
                Write one →
              </button>
            </div>
          </div>
        </section>

        <section className="section" id="live">
          <div className="head">
            <div>
              <p className="label">Live</p>
              <h2>Connected to Solana, right now</h2>
            </div>
            <p>
              This section is not fixture data. It polls a public RPC for the current slot, pulls a
              live reference price, and will read any account you hand it.
            </p>
          </div>
          <LivePanel />
        </section>
      </div>
    </>
  );
}
