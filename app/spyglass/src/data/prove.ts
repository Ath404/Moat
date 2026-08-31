import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { build, type PolicyInput } from "./anchor";
import { accountsFor } from "./send";

/**
 * Refusals, proved by the chain rather than by this page.
 *
 * The attack simulator next to this one does its arithmetic in TypeScript. That
 * is useful for showing *why* a trade is refused, but as evidence it is circular
 * — a reimplementation of the rules agreeing with itself. So this module asks
 * the deployed program directly.
 *
 * Each probe assembles a real instruction, addressed to the real program id,
 * against the real vault account, and sends it to `simulateTransaction`. What
 * comes back is the program's own error code, its own message, and the file and
 * line in the Rust where the check fired. None of that is authored here.
 *
 * Three properties make this safe and honest to run on page load:
 *
 *   - **Nothing is signed and nothing settles.** Simulation is a dry run. The
 *     probes that are *supposed* to succeed change no state either.
 *   - **No wallet, no funds, no permission.** `sigVerify: false` means the
 *     signature slots are never checked, which is what lets the page ask "what
 *     if a stranger tried this" without holding a stranger's key.
 *   - **The controls are the point.** A panel where everything is refused
 *     proves only that the harness is broken. Two probes here are expected to
 *     be *accepted*, and they use the same code path as the ones that are not.
 *
 * The fee payer is always the vault owner: a real, funded devnet account.
 * Simulation still charges a fee against it on paper, and an unfunded payer is
 * rejected before the program is ever reached — which would report the wrong
 * refusal.
 */

/** A dry-run blockhash. `replaceRecentBlockhash` swaps it for a live one. */
const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111";

export interface Probe {
  id: string;
  /** Plain-language name for the thing being attempted. */
  title: string;
  /** What is being asked of the chain, in one sentence. */
  ask: string;
  /** What the design says should happen. */
  expects: "refused" | "accepted";
  /** Why this probe is worth running. */
  because: string;
  /** The signer in the authority slot: the real owner, or a key nobody holds. */
  as: "owner" | "stranger";
}

export interface ProbeOutcome extends Probe {
  /** What actually happened. `null` if the probe could not be run at all. */
  refused: boolean | null;
  /** Anchor error name, e.g. `InvalidPolicy`. */
  code: string | null;
  /** Anchor error number, e.g. 6039. */
  number: number | null;
  /** The program's own message for that code. */
  message: string | null;
  /** Where in the Rust the check fired, e.g. `programs/moat/src/state.rs:190`. */
  where: string | null;
  /** Raw `err` field from the RPC, verbatim. */
  err: string | null;
  units: number | null;
  logs: string[];
  /** Set when the probe itself failed (RPC down, rate limit). */
  broke: string | null;
}

/** The mandate the deployed vault actually runs, mirrored for the probes. */
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const BASE_POLICY: PolicyInput = {
  maxTradeNotionalUsd: 5_000,
  maxDailyNotionalUsd: 25_000,
  maxSlippageBps: 50,
  minCooldownSlots: 150,
  maxOracleStalenessSecs: 30,
  maxOracleConfBps: 100,
  maxQuoteDriftBps: 50,
  maxIntentLifetimeSlots: 300,
  mints: [
    {
      mint: USDC,
      symbol: "USDC",
      feedIdHex: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
      decimals: 6,
    },
    {
      mint: SOL,
      symbol: "SOL",
      feedIdHex: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
      decimals: 9,
    },
  ],
  venues: [{ name: "Jupiter", address: JUPITER }],
};

export const PROBES: Probe[] = [
  {
    id: "floor-off",
    title: "Switch the price floor off",
    ask: "set_policy with max_slippage_bps = 10000",
    expects: "refused",
    as: "owner",
    because:
      "At 10000 the tolerated fraction is the whole trade, the floor collapses to zero, " +
      "and the one bound that constrains price rather than size quietly stops existing. " +
      "The owner is the most privileged key there is, and it still cannot do this.",
  },
  {
    id: "floor-on",
    title: "The same mandate, floor left at 50 bps",
    ask: "set_policy with max_slippage_bps = 50",
    expects: "accepted",
    as: "owner",
    because:
      "The control for the probe above. One field differs between the two. If this one " +
      "is accepted, the refusal above is about that field and not about the harness.",
  },
  {
    id: "pause-stranger",
    title: "Pause the vault, as a stranger",
    ask: "set_paused(true), signed by a key generated in your browser",
    expects: "refused",
    as: "stranger",
    because: "Pausing stops the strategy. Only the owner or the guardian may do it.",
  },
  {
    id: "pause-owner",
    title: "Pause the vault, as the owner",
    ask: "set_paused(true), signed by the registered owner",
    expects: "accepted",
    as: "owner",
    because:
      "The second control. Same instruction, same accounts, different signer — so the " +
      "refusal above is about who asked, not about what was asked.",
  },
  {
    id: "resume-stranger",
    title: "Resume a paused vault, as a stranger",
    ask: "set_paused(false), signed by a key generated in your browser",
    expects: "refused",
    as: "stranger",
    because:
      "A different error from the pause attempt, on purpose. A guardian may stop the " +
      "vault but may not restart it; a watchtower that can do both is a second owner.",
  },
  {
    id: "keep-stranger",
    title: "Register your own enclave key",
    ask: "rotate_signet, signed by a key generated in your browser",
    expects: "refused",
    as: "stranger",
    because:
      "The registered key is the only one whose signature the vault will trade on. " +
      "Being able to replace it would be the whole system.",
  },
];

/** The instruction bytes for a probe. Real builders, not fixtures. */
function dataFor(id: string): Uint8Array {
  switch (id) {
    case "floor-off":
      return build.setPolicy({ ...BASE_POLICY, maxSlippageBps: 10_000 }).bytes;
    case "floor-on":
      return build.setPolicy(BASE_POLICY).bytes;
    case "pause-stranger":
    case "pause-owner":
      return build.setPaused(true).bytes;
    case "resume-stranger":
      return build.setPaused(false).bytes;
    case "keep-stranger":
      // A plausible registration: a real key, a zero measurement, a sane
      // validity window. If any of those were malformed the program would
      // refuse for that reason instead, and the probe would prove nothing.
      return build.rotateSignet(Keypair.generate().publicKey.toBase58(), "00".repeat(32), 100_000)
        .bytes;
    default:
      throw new Error(`unknown probe ${id}`);
  }
}

function keysFor(id: string, vault: string, owner: string, stranger: string) {
  const authority = PROBES.find((p) => p.id === id)?.as === "owner" ? owner : stranger;
  if (id.startsWith("pause") || id.startsWith("resume")) {
    return accountsFor("set_paused", { vault, owner: authority });
  }
  if (id === "keep-stranger") return accountsFor("rotate_signet", { vault, owner: authority });
  return accountsFor("set_policy", { vault, owner: authority });
}

interface SimValue {
  err: unknown;
  logs: string[] | null;
  unitsConsumed?: number;
}

async function simulate(
  endpoint: string,
  programId: string,
  feePayer: string,
  data: Uint8Array,
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]
): Promise<SimValue> {
  const tx = new Transaction().add(
    new TransactionInstruction({ programId: new PublicKey(programId), keys, data: Buffer.from(data) })
  );
  tx.feePayer = new PublicKey(feePayer);
  tx.recentBlockhash = PLACEHOLDER_BLOCKHASH;

  const raw = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [
        raw,
        {
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "confirmed",
          encoding: "base64",
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const json = (await res.json()) as { result?: { value: SimValue }; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  if (!json.result) throw new Error("no simulation result");
  return json.result.value;
}

/**
 * Anchor prints the code, the number, the message and the source location on
 * separate shapes of log line depending on whether the failure came from an
 * account constraint or from a `require!` in the handler. Read each separately
 * rather than trying to write one regex that covers both.
 */
function readAnchorError(logs: string[]) {
  const joined = logs.join("\n");
  const detail = joined.match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: ([^\n]*?)\.?\s*$/m);
  const thrown = joined.match(/AnchorError thrown in ([^\s:]+):(\d+)/);
  const account = joined.match(/AnchorError caused by account: (\w+)/);
  return {
    code: detail?.[1] ?? null,
    number: detail ? Number(detail[2]) : null,
    message: detail?.[3] ?? null,
    where: thrown
      ? `${thrown[1].replace(/\\/g, "/")}:${thrown[2]}`
      : account
        ? `account constraint on \`${account[1]}\``
        : null,
  };
}

export interface ProveContext {
  endpoint: string;
  programId: string;
  vault: string;
  owner: string;
}

export async function runProbe(probe: Probe, ctx: ProveContext): Promise<ProbeOutcome> {
  const blank: ProbeOutcome = {
    ...probe,
    refused: null,
    code: null,
    number: null,
    message: null,
    where: null,
    err: null,
    units: null,
    logs: [],
    broke: null,
  };

  try {
    // A fresh key per probe, so "a stranger" is demonstrably not a key this
    // page could have been handed in advance.
    const stranger = Keypair.generate().publicKey.toBase58();
    const value = await simulate(
      ctx.endpoint,
      ctx.programId,
      ctx.owner,
      dataFor(probe.id),
      keysFor(probe.id, ctx.vault, ctx.owner, stranger)
    );
    const logs = value.logs ?? [];
    const refused = value.err !== null && value.err !== undefined;

    // A transaction can fail before it ever reaches the program — an unfunded
    // fee payer, a bad blockhash, a malformed account list. Those come back
    // with an `err` and no program logs, and reporting them as "the vault
    // refused" would be this page claiming credit for its own broken harness.
    // If the program did not run, say so instead.
    const ranProgram = logs.some((l) => l.includes(ctx.programId));
    if (refused && !ranProgram) {
      return {
        ...blank,
        broke: `the transaction never reached the program — ${JSON.stringify(value.err)}`,
        err: JSON.stringify(value.err),
        logs,
      };
    }

    return {
      ...blank,
      refused,
      err: refused ? JSON.stringify(value.err) : null,
      units: value.unitsConsumed ?? null,
      logs,
      ...(refused ? readAnchorError(logs) : {}),
    };
  } catch (e) {
    return { ...blank, broke: String((e as Error)?.message ?? e) };
  }
}

/** Run every probe in order. Sequential: a public RPC rate-limits a burst. */
export async function runAllProbes(
  ctx: ProveContext,
  onEach: (o: ProbeOutcome) => void
): Promise<void> {
  for (const probe of PROBES) {
    onEach(await runProbe(probe, ctx));
  }
}
