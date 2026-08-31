import { useEffect, useState } from "react";
import { getChainStatus, getPythQuotes, lookupVault, looksLikeAddress, type ChainStatus, type PythQuote, type VaultLookup } from "../data/live";
import { VAULT_LEN } from "../data/chain";
import { PROGRAM_ID, RPC_URL } from "../data/config";

/**
 * The live panel.
 *
 * This is the part of the page that is actually connected to something. It
 * polls a real Solana RPC for the current slot, pulls a real reference price,
 * and will look up any address you give it and tell you honestly what is there.
 *
 * It is deliberately blunt about the state of the world: the Moat program is not
 * deployed, so there is no vault to load, and the panel says so rather than
 * dressing up fixture data as a live feed.
 */

type Async<T> = { status: "loading" } | { status: "ok"; data: T } | { status: "error"; message: string };

function useAsync<T>(fn: () => Promise<T>, intervalMs?: number): Async<T> {
  const [state, setState] = useState<Async<T>>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    const run = () =>
      fn()
        .then((data) => alive && setState({ status: "ok", data }))
        .catch((e) => alive && setState({ status: "error", message: String(e?.message ?? e) }));
    run();
    if (!intervalMs) return () => { alive = false; };
    const id = setInterval(run, intervalMs);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);
  return state;
}

const RPC = RPC_URL;

/** Mirrors the deployed vault's `max_oracle_staleness_secs`. */
const STALENESS_LIMIT_SECS = 30;

export function LivePanel() {
  const chain = useAsync<ChainStatus>(() => getChainStatus(RPC), 10_000);
  const pyth = useAsync<PythQuote[]>(() => getPythQuotes(RPC), 15_000);

  const [address, setAddress] = useState("");
  const [lookup, setLookup] = useState<Async<VaultLookup> | null>(null);

  async function onLookup(e: React.FormEvent) {
    e.preventDefault();
    const value = address.trim();
    if (!looksLikeAddress(value)) {
      setLookup({ status: "error", message: "That is not a base58 Solana address." });
      return;
    }
    setLookup({ status: "loading" });
    try {
      const data = await lookupVault(value, PROGRAM_ID, VAULT_LEN, RPC);
      setLookup({ status: "ok", data });
    } catch (err: unknown) {
      setLookup({ status: "error", message: String((err as Error)?.message ?? err) });
    }
  }

  return (
    <div className="cards">
      <div className="card">
        <p className="k">Solana RPC</p>
        {chain.status === "loading" && <p className="v sm">connecting…</p>}
        {chain.status === "error" && (
          <>
            <p className="v sm miss">disconnected</p>
            <p className="note">{chain.message}</p>
          </>
        )}
        {chain.status === "ok" && (
          <>
            <p className="v sm">slot {chain.data.slot.toLocaleString("en-US")}</p>
            <p className="note">
              {new URL(chain.data.endpoint).host} · {chain.data.latencyMs} ms · refreshes every 10s
            </p>
          </>
        )}
      </div>

      <div className="card">
        <p className="k">Pyth — the vault's oracle</p>
        {pyth.status === "loading" && <p className="v sm">reading…</p>}
        {pyth.status === "error" && (
          <>
            <p className="v sm miss">unavailable</p>
            <p className="note">{pyth.message}</p>
          </>
        )}
        {pyth.status === "ok" && (
          <>
            {pyth.data.map((q) => {
              const stale = q.ageSecs > STALENESS_LIMIT_SECS;
              return (
                <p className="v sm" key={q.symbol} style={{ marginBottom: "0.3rem" }}>
                  {q.symbol.replace("/USD", "")} ${q.usd.toFixed(q.usd > 10 ? 2 : 4)}{" "}
                  <i className={`note ${stale ? "miss" : ""}`} style={{ display: "inline" }}>
                    ±{q.confBps.toFixed(1)}bps · {q.ageSecs}s old
                    {stale ? " · STALE" : ""}
                  </i>
                </p>
              );
            })}
            <p className="note">
              Read from the same <code>PriceUpdateV2</code> accounts <code>execute_sortie</code>{" "}
              consumes. The vault refuses any fill priced from a read older than{" "}
              {STALENESS_LIMIT_SECS}s.
            </p>
          </>
        )}
      </div>

      <div className="card">
        <p className="k">Look up a vault</p>
        <form onSubmit={onLookup} className="lookup">
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Vault PDA address"
            aria-label="Vault PDA address"
            spellCheck={false}
          />
          <button type="submit">Read</button>
        </form>
        {!lookup && (
          <p className="note">
            Reads the account and decodes it against <code>Vault::LEN</code> ({VAULT_LEN} bytes).
            {!PROGRAM_ID && " No VITE_PROGRAM_ID set, so the owner check is skipped."}
          </p>
        )}
        {lookup?.status === "loading" && <p className="note">reading…</p>}
        {lookup?.status === "error" && <p className="note miss">{lookup.message}</p>}
        {lookup?.status === "ok" && (
          <p className="note">
            {lookup.data.state === "not-found" && "No account at that address on this cluster."}
            {lookup.data.state === "wrong-owner" &&
              `Exists, but owned by ${lookup.data.owner.slice(0, 8)}… — not the Moat program.`}
            {lookup.data.state === "too-small" &&
              `Exists, but only ${lookup.data.dataLen} bytes — too small to be a Vault.`}
            {lookup.data.state === "found" &&
              `Vault account found: ${lookup.data.dataLen} bytes, owned by ${lookup.data.owner.slice(0, 8)}…`}
          </p>
        )}
      </div>
    </div>
  );
}
