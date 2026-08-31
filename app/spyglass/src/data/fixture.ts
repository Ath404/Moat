/**
 * Deterministic demo data.
 *
 * The program is not deployed yet, so this is what spyglass renders by default.
 * It is generated from a fixed seed so the dashboard looks the same every load —
 * a demo that reshuffles on refresh is a demo nobody trusts.
 *
 * Every number here is one the chain would actually publish. Nothing is invented
 * that `SortieExecuted` does not carry. In particular there is no field anywhere
 * in this file describing *why* a trade happened, because no such field exists
 * on-chain either.
 */

import type { Holding, PolicyBounds, Sortie, VaultSnapshot, VaultState } from "./types";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/** Mulberry32 — small, fast, and fully deterministic from the seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `base × (1 + bps/10_000)`, in integer maths so the demo cannot drift. */
function applyBps(base: bigint, bpsValue: number): bigint {
  const scaled = BigInt(Math.round((10_000 + bpsValue) * 1_000));
  return (base * scaled) / 10_000_000n;
}

const SLIPPAGE_BPS = 50;
const START_SLOT = 302_411_000;

interface PlanSpec {
  side: "buy" | "sell";
  /** Micro-USD committed by the whole decision, before the split. */
  notionalMicroUsd: number;
  solPriceMicroUsd: number;
  legs: number;
}

/**
 * Eleven decisions over roughly six days. Sizes vary because the strategy sizes
 * by available capital; leg counts vary because the VRF picks them. Neither
 * pattern tells you anything about the thresholds that produced them, which is
 * the entire point.
 */
const PLANS: PlanSpec[] = [
  { side: "buy", notionalMicroUsd: 1_480_000_000, solPriceMicroUsd: 147_200_000, legs: 3 },
  { side: "buy", notionalMicroUsd: 920_000_000, solPriceMicroUsd: 145_900_000, legs: 4 },
  { side: "sell", notionalMicroUsd: 2_240_000_000, solPriceMicroUsd: 158_400_000, legs: 5 },
  { side: "buy", notionalMicroUsd: 3_100_000_000, solPriceMicroUsd: 143_050_000, legs: 4 },
  { side: "buy", notionalMicroUsd: 640_000_000, solPriceMicroUsd: 141_800_000, legs: 3 },
  { side: "sell", notionalMicroUsd: 4_460_000_000, solPriceMicroUsd: 162_750_000, legs: 5 },
  { side: "buy", notionalMicroUsd: 1_980_000_000, solPriceMicroUsd: 149_300_000, legs: 3 },
  { side: "sell", notionalMicroUsd: 2_750_000_000, solPriceMicroUsd: 166_100_000, legs: 4 },
  { side: "buy", notionalMicroUsd: 3_820_000_000, solPriceMicroUsd: 152_600_000, legs: 5 },
  { side: "buy", notionalMicroUsd: 1_120_000_000, solPriceMicroUsd: 150_450_000, legs: 3 },
  { side: "sell", notionalMicroUsd: 2_060_000_000, solPriceMicroUsd: 171_900_000, legs: 4 },
];

function buildSorties(): Sortie[] {
  const rand = rng(0x4d6f6174); // "Moat"
  const out: Sortie[] = [];
  let nonce = 0;
  let slot = START_SLOT;

  PLANS.forEach((plan, planIndex) => {
    // Split the decision into unequal legs, the way sortie::plan does.
    const weights = Array.from({ length: plan.legs }, () => 0.6 + rand() * 0.9);
    const weightSum = weights.reduce((a, b) => a + b, 0);
    // `>>> 0` matters: JS bitwise ops return a *signed* 32-bit int, so without it
    // this renders as a negative hex string ("-4fe246a…") which is not a hash.
    const commitment = `${((0x9e3779b9 ^ (planIndex * 2654435761)) >>> 0).toString(16).padStart(8, "0")}${"ab37c1d0".repeat(3)}`;

    weights.forEach((w, legIndex) => {
      const legMicroUsd = Math.round((plan.notionalMicroUsd * w) / weightSum);

      // Realised execution: usually a little worse than oracle-fair, sometimes
      // better. Never worse than the floor — the chain would have refused it.
      const roll = rand();
      const execBps =
        roll > 0.86
          ? +(1 + rand() * 5) // routed better than the oracle read
          : -(1.5 + rand() * 16);

      let amountIn: bigint;
      let oracleExpectedOut: bigint;

      if (plan.side === "buy") {
        // USDC in (6dp), SOL out (9dp)
        amountIn = BigInt(legMicroUsd); // micro-USD == USDC atoms at $1
        oracleExpectedOut =
          (BigInt(legMicroUsd) * 1_000_000_000n) / BigInt(plan.solPriceMicroUsd);
      } else {
        // SOL in (9dp), USDC out (6dp)
        amountIn =
          (BigInt(legMicroUsd) * 1_000_000_000n) / BigInt(plan.solPriceMicroUsd);
        oracleExpectedOut = BigInt(legMicroUsd);
      }

      out.push({
        nonce: nonce++,
        policyVersion: planIndex < 6 ? 1 : 2,
        mintIn: plan.side === "buy" ? USDC : SOL,
        mintOut: plan.side === "buy" ? SOL : USDC,
        amountIn,
        amountOut: applyBps(oracleExpectedOut, execBps),
        minAmountOut: applyBps(oracleExpectedOut, -SLIPPAGE_BPS),
        oracleExpectedOut,
        notionalMicroUsd: BigInt(legMicroUsd),
        sortieIndex: legIndex,
        sortieCount: plan.legs,
        vrfCommitment: commitment,
        slot,
      });

      // Legs are scattered inside the execution window, then the next decision
      // waits out the cooldown and then some.
      slot += 180 + Math.floor(rand() * 2_400);
    });

    slot += 30_000 + Math.floor(rand() * 90_000);
  });

  return out;
}

const SORTIES = buildSorties();
const LAST_SLOT = SORTIES[SORTIES.length - 1].slot;

const VAULT: VaultState = {
  address: "MoATvau1t7hK3xPz9qWdRfN2sYbE6cJmLtQ4vXgH8aZ",
  owner: "6Hy3wPnKdRv2sBqXtL9mZfC4jN8eVaG1uYrT5xQwDpKs",
  guardian: "Wtch7wR2mKpLvN4dXbQ9sYfE3jC6aHtG8uZrV1nMqBx",
  paused: false,
  nextNonce: SORTIES.length,
  policyVersion: 2,
  enclaveKey: "kEEp9dR4tWmXvB2nQsL7cYfH3jZaG6uE1pTrK5xNwVq",
  enclaveMeasurement:
    "7d3f9a1c04e8b62750fa19c3d8b04e6f2a5c9713be80df46a2c1509e7b3d64f8",
  enclaveExpirySlot: LAST_SLOT + 940_000,
  currentSlot: LAST_SLOT + 5_120,
};

const POLICY: PolicyBounds = {
  maxTradeNotional: 5_000_000_000n,
  maxDailyNotional: 25_000_000_000n,
  maxSlippageBps: SLIPPAGE_BPS,
  minCooldownSlots: 150,
  maxOracleStalenessSecs: 30,
  maxOracleConfBps: 100,
  maxQuoteDriftBps: 50,
  maxIntentLifetimeSlots: 300,
  mints: [
    { symbol: "USDC", mint: USDC, decimals: 6 },
    { symbol: "SOL", mint: SOL, decimals: 9 },
  ],
  venues: [{ name: "Jupiter", address: JUPITER }],
  dayNotional: 6_270_000_000n,
};

const HOLDINGS: Holding[] = [
  { symbol: "SOL", decimals: 9, amount: 84_412_900_000n, priceMicroUsd: 171_900_000n },
  { symbol: "USDC", decimals: 6, amount: 12_486_310_000n, priceMicroUsd: 1_000_000n },
];

export const FIXTURE: VaultSnapshot = {
  vault: VAULT,
  policy: POLICY,
  holdings: HOLDINGS,
  sorties: SORTIES,
  source: "fixture",
};
