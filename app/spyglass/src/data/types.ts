/**
 * The public surface of a Moat vault.
 *
 * These types mirror `programs/moat/src/events.rs` and the `Vault` account in
 * `programs/moat/src/state.rs`. If a field is not in that file, it does not
 * belong here — the whole point of the dashboard is that it cannot show more
 * than the chain publishes.
 */

/** Mirrors the `SortieExecuted` event. One leg of one strategy decision. */
export interface Sortie {
  nonce: number;
  policyVersion: number;
  mintIn: string;
  mintOut: string;
  /** Atoms of `mintIn` actually spent. */
  amountIn: bigint;
  /** Atoms of `mintOut` actually received. */
  amountOut: bigint;
  /** The floor the intent demanded. The chain checked this against Pyth. */
  minAmountOut: bigint;
  /** What the chain's own oracle read said an honest fill was worth. */
  oracleExpectedOut: bigint;
  /** Trade size in micro-USD, priced by the chain. */
  notionalMicroUsd: bigint;
  sortieIndex: number;
  sortieCount: number;
  /** Commitment to the VRF output that produced this split. */
  vrfCommitment: string;
  slot: number;
}

/** The subset of the `Vault` account a viewer can read. */
export interface VaultState {
  address: string;
  owner: string;
  guardian: string;
  paused: boolean;
  nextNonce: number;
  policyVersion: number;
  /** Ed25519 key the keep signs with. Zero means no keep is registered. */
  enclaveKey: string;
  /** Expected TDX measurement of the keep image. */
  enclaveMeasurement: string;
  enclaveExpirySlot: number;
  currentSlot: number;
}

/** Owner-set bounds. Public by construction — they live on-chain. */
export interface PolicyBounds {
  maxTradeNotional: bigint;
  maxDailyNotional: bigint;
  maxSlippageBps: number;
  minCooldownSlots: number;
  maxOracleStalenessSecs: number;
  maxOracleConfBps: number;
  maxQuoteDriftBps: number;
  maxIntentLifetimeSlots: number;
  mints: { symbol: string; mint: string; decimals: number }[];
  venues: { name: string; address: string }[];
  /** Micro-USD spent inside the current rolling day. */
  dayNotional: bigint;
}

export interface Holding {
  symbol: string;
  decimals: number;
  /** Atoms held by the vault. */
  amount: bigint;
  /** Micro-USD per whole token, at the last oracle read. */
  priceMicroUsd: bigint;
}

export interface VaultSnapshot {
  vault: VaultState;
  policy: PolicyBounds;
  holdings: Holding[];
  sorties: Sortie[];
  /** Where this data came from. Shown in the UI — never imply live data isn't. */
  source: "fixture" | "chain";
  /**
   * Whether `sorties` and `holdings` are this vault's own history.
   *
   * Separate from `source` because the two arrive separately: the vault account
   * is one read, its fill history is a log scan that legitimately comes back
   * empty for a vault that has not traded yet. When it does, the dashboard keeps
   * the sample fills so the charts have something to draw — and this flag is
   * what stops the page from presenting them as real.
   */
  historyIsLive?: boolean;
}

/* ---------------------------------------------------------------------------
 * Derived measures
 *
 * Both are expressed in basis points relative to the oracle-fair output, so a
 * $200 fill and a $5,000 fill land on the same axis. That comparability is the
 * only reason the integrity strip works.
 * ------------------------------------------------------------------------- */

function ratioBps(value: bigint, reference: bigint): number {
  if (reference === 0n) return 0;
  return Number(((value - reference) * 1_000_000n) / reference) / 100;
}

/** How the realised fill compares to what the oracle said was fair. */
export function executionBps(s: Sortie): number {
  return ratioBps(s.amountOut, s.oracleExpectedOut);
}

/**
 * Where the vault's refusal threshold sat for this fill, on the same axis.
 * Always negative: the floor is `oracle-fair × (1 − max_slippage)`.
 */
export function floorBps(s: Sortie): number {
  return ratioBps(s.minAmountOut, s.oracleExpectedOut);
}

/* ---------------------------------------------------------------------------
 * Formatting
 * ------------------------------------------------------------------------- */

export function tokens(atoms: bigint, decimals: number, places = 4): string {
  const unit = 10n ** BigInt(decimals);
  const whole = atoms / unit;
  const frac = atoms % unit;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, places);
  return `${whole.toLocaleString("en-US")}${places > 0 ? "." + fracStr : ""}`;
}

export function usd(microUsd: bigint, places = 2): string {
  const dollars = Number(microUsd) / 1e6;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

export function bps(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)} bps`;
}

/** Truncate a base58 address the way a block explorer does. */
export function addr(a: string, lead = 4, tail = 4): string {
  if (a.length <= lead + tail + 1) return a;
  return `${a.slice(0, lead)}…${a.slice(-tail)}`;
}

export function usdValue(h: Holding): bigint {
  const unit = 10n ** BigInt(h.decimals);
  return (h.amount * h.priceMicroUsd) / unit;
}

/* ---------------------------------------------------------------------------
 * Verification
 *
 * The page's whole claim is "check this yourself", so it has to actually do the
 * checking rather than assert a conclusion. Everything below is re-derived in
 * the browser from figures the chain published — the event's own numbers and
 * the vault's own policy — using the same arithmetic as
 * `crates/moat-core/src/policy.rs`. No input here is privileged.
 * ------------------------------------------------------------------------- */

export interface Check {
  label: string;
  /** The arithmetic, shown so the reader can follow it rather than trust it. */
  detail: string;
  pass: boolean;
}

export function verifySortie(
  s: Sortie,
  policy: PolicyBounds,
  decimalsFor: (mint: string) => number,
  symbolFor: (mint: string) => string
): Check[] {
  const out = decimalsFor(s.mintOut);
  // The same computation the program runs: oracle-fair × (1 − max_slippage).
  const oracleFloor =
    (s.oracleExpectedOut * BigInt(10_000 - policy.maxSlippageBps)) / 10_000n;
  const allowed = new Set(policy.mints.map((m) => m.mint));

  return [
    {
      label: "Fill cleared the floor the intent demanded",
      detail: `received ${tokens(s.amountOut, out, 4)} ≥ min_amount_out ${tokens(s.minAmountOut, out, 4)}`,
      pass: s.amountOut >= s.minAmountOut,
    },
    {
      label: "That floor was no lower than the oracle permits",
      detail: `${tokens(s.minAmountOut, out, 4)} ≥ ${tokens(oracleFloor, out, 4)}  ( ${tokens(s.oracleExpectedOut, out, 4)} × (1 − ${policy.maxSlippageBps}bps) )`,
      pass: s.minAmountOut >= oracleFloor,
    },
    {
      label: "Notional inside the per-trade cap",
      detail: `${usd(s.notionalMicroUsd, 0)} ≤ ${usd(policy.maxTradeNotional, 0)}`,
      pass: s.notionalMicroUsd <= policy.maxTradeNotional,
    },
    {
      label: "Both mints on the allowlist",
      detail: `${symbolFor(s.mintIn)} → ${symbolFor(s.mintOut)}`,
      pass: allowed.has(s.mintIn) && allowed.has(s.mintOut),
    },
    {
      label: "Leg belongs to a well-formed plan",
      detail: `leg ${s.sortieIndex + 1} of ${s.sortieCount}, vrf ${s.vrfCommitment.slice(0, 12)}…`,
      pass: s.sortieCount > 0 && s.sortieIndex < s.sortieCount,
    },
  ];
}
