import { useEffect, useMemo, useState } from "react";
import { loadFromChain } from "./chain";
import { PROGRAM_ID, RPC_URL, VAULT_ADDRESS } from "./config";
import { FIXTURE } from "./fixture";
import { addr, executionBps, floorBps, usdValue, type VaultSnapshot } from "./types";

/** Solana produces a slot roughly every 400ms. */
export const SLOTS_PER_DAY = 216_000;

/**
 * `sha256("event:SortieExecuted")[..8]`, from `programs/moat/src/events.rs`.
 * Precomputed for the same reason the instruction discriminators are: nothing
 * on this path should need async crypto. Recompute with:
 *
 *   node -e "console.log(require('crypto').createHash('sha256')
 *     .update('event:SortieExecuted').digest().subarray(0,8))"
 */
const SORTIE_EVENT = new Uint8Array([40, 36, 20, 247, 26, 53, 39, 16]);

/** Symbols for the mints the deployed policy holds. Display only. */
const MINT_LABELS: Record<string, { symbol: string; decimals: number }> = Object.fromEntries(
  FIXTURE.policy.mints.map((m) => [m.mint, { symbol: m.symbol, decimals: m.decimals }])
);

/** How often to re-read. The vault only changes when someone acts on it. */
const REFRESH_MS = 30_000;

/**
 * Everything the views derive from the snapshot.
 *
 * The snapshot starts as the fixture and is replaced by the live vault as soon
 * as the chain answers. That order matters: the dashboard renders immediately
 * with the right *shape*, and upgrades to the real thing a moment later, rather
 * than flashing a spinner over the whole page on every load.
 *
 * The two halves of a snapshot arrive with different guarantees, and the hook
 * keeps them honest separately:
 *
 *   - **The vault account** is a single read and is always real once it lands.
 *   - **The fill history** is a log scan. The deployed vault has not traded yet,
 *     so it legitimately comes back empty — and an empty dashboard is worse than
 *     an illustrated one. When there is no real history the fixture's fills are
 *     kept for the charts, and `historyIsLive` goes false so the page can say so
 *     rather than passing sample fills off as executions that happened.
 *
 * Derivations are shared because the overview and the vault dashboard quote the
 * same figures, and two independent derivations of "median execution" is how a
 * dashboard ends up contradicting itself.
 */
export function useVaultData() {
  const [snapshot, setSnapshot] = useState<VaultSnapshot>(FIXTURE);

  useEffect(() => {
    let alive = true;

    const read = async () => {
      try {
        const live = await loadFromChain(
          {
            rpcUrl: RPC_URL,
            programId: PROGRAM_ID,
            vault: VAULT_ADDRESS,
            mintLabels: MINT_LABELS,
          },
          SORTIE_EVENT
        );
        if (!alive) return;
        const historyIsLive = live.sorties.length > 0;
        setSnapshot({
          ...live,
          sorties: historyIsLive ? live.sorties : FIXTURE.sorties,
          holdings: live.holdings.length ? live.holdings : FIXTURE.holdings,
          historyIsLive,
        });
      } catch {
        // Leave whatever is on screen. The footer already states which parts
        // are illustrative, so a failed read degrades to an honest page rather
        // than to an error one.
      }
    };

    read();
    const id = setInterval(read, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const { vault, policy, holdings, sorties } = snapshot;

  const byMint = useMemo(() => {
    const map = new Map(policy.mints.map((m) => [m.mint, m]));
    return {
      decimalsFor: (mint: string) => map.get(mint)?.decimals ?? 9,
      symbolFor: (mint: string) => map.get(mint)?.symbol ?? addr(mint, 4, 0),
    };
  }, [policy.mints]);

  const stats = useMemo(() => {
    const tvl = holdings.reduce((sum, h) => sum + usdValue(h), 0n);
    const risky = holdings
      .filter((h) => h.symbol !== "USDC")
      .reduce((sum, h) => sum + usdValue(h), 0n);
    const volume = sorties.reduce((sum, s) => sum + s.notionalMicroUsd, 0n);
    const execs = sorties.map(executionBps).sort((a, b) => a - b);
    const headroom = sorties.map((s) => executionBps(s) - floorBps(s)).sort((a, b) => a - b);
    return {
      tvl,
      exposurePct: tvl === 0n ? 0 : Number((risky * 10_000n) / tvl) / 100,
      volume,
      median: execs.length ? execs[Math.floor(execs.length / 2)] : 0,
      medianHeadroom: headroom.length ? headroom[Math.floor(headroom.length / 2)] : 0,
      aboveFair: execs.filter((e) => e > 0).length,
      belowFloor: sorties.filter((s) => executionBps(s) < floorBps(s)).length,
      plans: new Set(sorties.map((s) => s.vrfCommitment)).size,
      dayUsedPct:
        policy.maxDailyNotional === 0n
          ? 0
          : Number((policy.dayNotional * 100n) / policy.maxDailyNotional),
    };
  }, [holdings, sorties, policy]);

  const enclaveDays = Math.max(0, (vault.enclaveExpirySlot - vault.currentSlot) / SLOTS_PER_DAY);

  /** Whether a keep is registered. All-zero means the vault cannot trade at all. */
  const hasKeep = !/^1+$/.test(vault.enclaveKey);

  return { snapshot, vault, policy, holdings, sorties, byMint, stats, enclaveDays, hasKeep };
}
