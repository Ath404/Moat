/**
 * The policy kernel, in the browser.
 *
 * This is a faithful port of the checks in `crates/moat-core/src/policy.rs`, and
 * it exists so the page can *run* the argument rather than describe it:
 *
 * - `replay()` walks a fill history through a policy you edit, the way the chain
 *   would have, and tells you which fills that policy would have refused.
 * - `simulateAttack()` puts you in the position of a compromised strategy engine
 *   and shows what the chain does about it.
 *
 * Both operate on figures the chain publishes. Neither has privileged inputs.
 *
 * Where this deliberately mirrors a known wart: the daily cap uses the same
 * *tumbling* slot bucket the Rust does (`slot / SLOTS_PER_DAY`), not a rolling
 * window. That is a real finding against the current program, recorded in the
 * README, and the replay would be lying if it modelled the fix rather than the
 * code.
 */

import type { Sortie } from "./types";

/** Matches `moat_core::SLOTS_PER_DAY`. ~400ms slots. */
export const SLOTS_PER_DAY = 216_000;

export interface PolicyDraft {
  /** Dollars, not micro-USD — this one is edited by a human. */
  maxTradeNotionalUsd: number;
  maxDailyNotionalUsd: number;
  maxSlippageBps: number;
  minCooldownSlots: number;
  /** Mint addresses on the allowlist. */
  allowedMints: string[];
}

export type RejectReason =
  | "mint-not-allowed"
  | "over-trade-cap"
  | "over-daily-cap"
  | "cooldown"
  | "below-oracle-floor";

export const REASON_LABEL: Record<RejectReason, string> = {
  "mint-not-allowed": "Mint not on the allowlist",
  "over-trade-cap": "Over the per-trade cap",
  "over-daily-cap": "Over the daily cap",
  cooldown: "Inside the cooldown",
  "below-oracle-floor": "Fill was below the oracle floor this policy sets",
};

export interface Judged {
  sortie: Sortie;
  accepted: boolean;
  reasons: RejectReason[];
}

export interface ReplayResult {
  judged: Judged[];
  acceptedCount: number;
  rejectedCount: number;
  /** How many fills each reason was responsible for. */
  byReason: Record<RejectReason, number>;
  /** Micro-USD of volume the policy would have refused. */
  refusedNotionalMicroUsd: bigint;
}

const usdToMicro = (usd: number): bigint => BigInt(Math.round(usd * 1e6));

/**
 * Walk the history the way the chain would.
 *
 * Sequential on purpose: a rejected fill consumes no daily budget and does not
 * start a cooldown, so rejections cascade. Judging each fill independently
 * would overstate how much a tighter policy refuses.
 */
export function replay(sorties: Sortie[], draft: PolicyDraft): ReplayResult {
  const tradeCap = usdToMicro(draft.maxTradeNotionalUsd);
  const dailyCap = usdToMicro(draft.maxDailyNotionalUsd);
  const allowed = new Set(draft.allowedMints);

  let lastAcceptedSlot = 0;
  let dayIndex = -1;
  let dayNotional = 0n;

  const byReason: Record<RejectReason, number> = {
    "mint-not-allowed": 0,
    "over-trade-cap": 0,
    "over-daily-cap": 0,
    cooldown: 0,
    "below-oracle-floor": 0,
  };
  let refusedNotionalMicroUsd = 0n;

  const ordered = [...sorties].sort((a, b) => a.slot - b.slot);

  const judged: Judged[] = ordered.map((s) => {
    const reasons: RejectReason[] = [];

    if (!allowed.has(s.mintIn) || !allowed.has(s.mintOut)) {
      reasons.push("mint-not-allowed");
    }
    if (s.notionalMicroUsd > tradeCap) {
      reasons.push("over-trade-cap");
    }

    // Same tumbling bucket the program uses today.
    const bucket = Math.floor(s.slot / SLOTS_PER_DAY);
    const spentThisDay = bucket === dayIndex ? dayNotional : 0n;
    if (spentThisDay + s.notionalMicroUsd > dailyCap) {
      reasons.push("over-daily-cap");
    }

    if (lastAcceptedSlot !== 0 && s.slot < lastAcceptedSlot + draft.minCooldownSlots) {
      reasons.push("cooldown");
    }

    // The floor this policy would have demanded, from the oracle figure the
    // chain published for this fill.
    const floor =
      (s.oracleExpectedOut * BigInt(10_000 - draft.maxSlippageBps)) / 10_000n;
    if (s.amountOut < floor) {
      reasons.push("below-oracle-floor");
    }

    const accepted = reasons.length === 0;
    if (accepted) {
      lastAcceptedSlot = s.slot;
      dayIndex = bucket;
      dayNotional = spentThisDay + s.notionalMicroUsd;
    } else {
      reasons.forEach((r) => (byReason[r] += 1));
      refusedNotionalMicroUsd += s.notionalMicroUsd;
    }

    return { sortie: s, accepted, reasons };
  });

  const acceptedCount = judged.filter((j) => j.accepted).length;
  return {
    judged,
    acceptedCount,
    rejectedCount: judged.length - acceptedCount,
    byReason,
    refusedNotionalMicroUsd,
  };
}

/* ---------------------------------------------------------------------------
 * The attack
 * ------------------------------------------------------------------------- */

export interface AttackParams {
  /** USDC the compromised keep tries to spend. */
  amountInUsd: number;
  /**
   * What the keep asks for as `min_amount_out`, as a percentage of the honest
   * output. An honest keep asks for ~99.5%. An attacker asks for as little as
   * it can get away with.
   */
  askedPct: number;
  /** Turn the oracle-derived floor off, to show what it is actually doing. */
  floorEnabled: boolean;
  /** Live SOL price, so the sum is grounded in a real market. */
  solPriceUsd: number;
  maxSlippageBps: number;
  maxTradeNotionalUsd: number;
}

export interface AttackCheck {
  label: string;
  detail: string;
  pass: boolean;
  /** True for the check that is the whole point. */
  pivotal?: boolean;
}

export interface AttackResult {
  checks: AttackCheck[];
  executed: boolean;
  /** SOL the trade should have produced at the oracle price. */
  fairOut: number;
  /** The floor the chain demands, in SOL. */
  floorOut: number;
  /** SOL the vault actually receives if this executes. */
  receivedOut: number;
  /** Dollars the attacker walks away with. Zero if the chain refuses. */
  extractedUsd: number;
}

export function simulateAttack(p: AttackParams): AttackResult {
  const fairOut = p.solPriceUsd > 0 ? p.amountInUsd / p.solPriceUsd : 0;
  const floorOut = fairOut * (1 - p.maxSlippageBps / 10_000);
  // The attacker gets exactly what it asked for — it controls the other side.
  const receivedOut = fairOut * (p.askedPct / 100);

  const checks: AttackCheck[] = [
    {
      label: "Signed by the registered enclave key",
      detail: "the attacker owns the keep, so this passes",
      pass: true,
    },
    {
      label: "Nonce is the next expected",
      detail: "sequential, and the attacker controls the sequence",
      pass: true,
    },
    {
      label: "Mint and venue on the allowlist",
      detail: "USDC → SOL through Jupiter",
      pass: true,
    },
    {
      label: "Inside the per-trade cap",
      detail: `$${p.amountInUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })} ≤ $${p.maxTradeNotionalUsd.toLocaleString("en-US")}`,
      pass: p.amountInUsd <= p.maxTradeNotionalUsd,
    },
  ];

  if (p.floorEnabled) {
    checks.push({
      label: "min_amount_out ≥ oracle-derived floor",
      detail: `${receivedOut.toFixed(4)} SOL ≥ ${floorOut.toFixed(4)} SOL  ( ${fairOut.toFixed(4)} × (1 − ${p.maxSlippageBps}bps) )`,
      pass: receivedOut >= floorOut,
      pivotal: true,
    });
  } else {
    checks.push({
      label: "min_amount_out ≥ oracle-derived floor",
      detail: "check disabled — the chain accepts whatever price the keep names",
      pass: true,
      pivotal: true,
    });
  }

  const executed = checks.every((c) => c.pass);
  const extractedUsd = executed ? Math.max(0, (fairOut - receivedOut) * p.solPriceUsd) : 0;

  return { checks, executed, fairOut, floorOut, receivedOut, extractedUsd };
}
