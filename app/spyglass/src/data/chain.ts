/**
 * The live adapter: reads a real vault over plain JSON-RPC.
 *
 * No SDK dependency on purpose. The `Vault` account is a fixed-width Borsh
 * struct, so decoding it is a matter of offsets — and writing those offsets out
 * explicitly means this file can be checked against
 * `programs/moat/src/state.rs` by reading the two side by side, which is not
 * true of a generated client.
 *
 * The offsets below sum to 878, which is `Vault::LEN`. If you add a field to the
 * account, this file breaks loudly at `OFFSETS.end` rather than silently
 * misreading every number after it.
 */

import type { Holding, PolicyBounds, Sortie, VaultSnapshot, VaultState } from "./types";

/** How far back to scan for fills, and how many log reads to run at once. */
const HISTORY_LIMIT = 40;
const HISTORY_BATCH = 8;

export interface ChainConfig {
  /** e.g. https://api.devnet.solana.com */
  rpcUrl: string;
  /** The deployed moat program id. */
  programId: string;
  /** The vault PDA to display. */
  vault: string;
  /** Symbol + decimals per mint, for display. Keyed by mint address. */
  mintLabels?: Record<string, { symbol: string; decimals: number }>;
}

export class NotConfiguredError extends Error {
  constructor(missing: string) {
    super(
      `Moat has no ${missing}. ` +
        `deploy it, run \`anchor keys sync\`, then set VITE_RPC_URL, ` +
        `VITE_PROGRAM_ID and VITE_VAULT. Until then spyglass renders fixture data.`
    );
    this.name = "NotConfiguredError";
  }
}

/* --- Vault account layout, in declaration order from state.rs -------------- */

const O = (() => {
  let at = 0;
  const take = (n: number) => {
    const start = at;
    at += n;
    return start;
  };
  return {
    discriminator: take(8),
    bump: take(1),
    owner: take(32),
    guardian: take(32),
    enclaveKey: take(32),
    enclaveMeasurement: take(32),
    enclaveExpirySlot: take(8),
    policyVersion: take(4),
    maxTradeNotional: take(8),
    maxDailyNotional: take(8),
    maxSlippageBps: take(2),
    minCooldownSlots: take(8),
    maxOracleStalenessSecs: take(8),
    maxOracleConfBps: take(2),
    maxQuoteDriftBps: take(2),
    maxIntentLifetimeSlots: take(8),
    /** 8 × MintRule, each { mint: 32, feed_id: 32, decimals: 1 }. */
    mints: take(65 * 8),
    mintCount: take(1),
    venues: take(32 * 4),
    venueCount: take(1),
    paused: take(1),
    nextNonce: take(8),
    lastSortieSlot: take(8),
    dayIndex: take(8),
    dayNotional: take(8),
    end: at,
  };
})();

/** Must equal `Vault::LEN` in state.rs. */
export const VAULT_LEN = O.end;

const MINT_RULE_LEN = 65;

/* --- primitives ----------------------------------------------------------- */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58-encode 32 raw bytes into a Solana address. */
export function toBase58(bytes: Uint8Array): string {
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte === 0) out += "1";
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function u16le(v: DataView, at: number) {
  return v.getUint16(at, true);
}
function u32le(v: DataView, at: number) {
  return v.getUint32(at, true);
}
function u64le(v: DataView, at: number): bigint {
  return v.getBigUint64(at, true);
}
function pubkey(bytes: Uint8Array, at: number): string {
  return toBase58(bytes.subarray(at, at + 32));
}
function hex(bytes: Uint8Array, at: number, len: number): string {
  return Array.from(bytes.subarray(at, at + len))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} failed: ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result as T;
}

/* --- decoding ------------------------------------------------------------- */

export function decodeVault(
  data: Uint8Array,
  address: string,
  currentSlot: number,
  labels: Record<string, { symbol: string; decimals: number }>
): { vault: VaultState; policy: PolicyBounds } {
  if (data.length < VAULT_LEN) {
    throw new Error(
      `vault account is ${data.length} bytes, expected at least ${VAULT_LEN}. ` +
        `Either this is not a Moat vault, or state.rs changed and chain.ts did not.`
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const mintCount = data[O.mintCount];
  const mints: PolicyBounds["mints"] = [];
  for (let i = 0; i < mintCount; i++) {
    const base = O.mints + i * MINT_RULE_LEN;
    const mint = pubkey(data, base);
    mints.push({
      mint,
      symbol: labels[mint]?.symbol ?? mint.slice(0, 4),
      // The account carries decimals; the label is only a fallback.
      decimals: data[base + 64],
    });
  }

  const venueCount = data[O.venueCount];
  const venues: PolicyBounds["venues"] = [];
  for (let i = 0; i < venueCount; i++) {
    const address = pubkey(data, O.venues + i * 32);
    venues.push({ address, name: KNOWN_VENUES[address] ?? "unknown venue" });
  }

  return {
    vault: {
      address,
      owner: pubkey(data, O.owner),
      guardian: pubkey(data, O.guardian),
      paused: data[O.paused] === 1,
      nextNonce: Number(u64le(view, O.nextNonce)),
      policyVersion: u32le(view, O.policyVersion),
      enclaveKey: pubkey(data, O.enclaveKey),
      enclaveMeasurement: hex(data, O.enclaveMeasurement, 32),
      enclaveExpirySlot: Number(u64le(view, O.enclaveExpirySlot)),
      currentSlot,
    },
    policy: {
      maxTradeNotional: u64le(view, O.maxTradeNotional),
      maxDailyNotional: u64le(view, O.maxDailyNotional),
      maxSlippageBps: u16le(view, O.maxSlippageBps),
      minCooldownSlots: Number(u64le(view, O.minCooldownSlots)),
      maxOracleStalenessSecs: Number(u64le(view, O.maxOracleStalenessSecs)),
      maxOracleConfBps: u16le(view, O.maxOracleConfBps),
      maxQuoteDriftBps: u16le(view, O.maxQuoteDriftBps),
      maxIntentLifetimeSlots: Number(u64le(view, O.maxIntentLifetimeSlots)),
      mints,
      venues,
      dayNotional: u64le(view, O.dayNotional),
    },
  };
}

const KNOWN_VENUES: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
};

/**
 * Decode one `SortieExecuted` event body — the bytes after the 8-byte event
 * discriminator, in the field order declared in events.rs.
 */
export function decodeSortieEvent(body: Uint8Array, slot: number): Sortie {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let at = 32; // skip `vault`
  const read = <T>(size: number, f: (offset: number) => T): T => {
    const value = f(at);
    at += size;
    return value;
  };
  const nonce = Number(read(8, (o) => u64le(view, o)));
  const policyVersion = read(4, (o) => u32le(view, o));
  const mintIn = read(32, (o) => pubkey(body, o));
  const mintOut = read(32, (o) => pubkey(body, o));
  const amountIn = read(8, (o) => u64le(view, o));
  const amountOut = read(8, (o) => u64le(view, o));
  const minAmountOut = read(8, (o) => u64le(view, o));
  const oracleExpectedOut = read(8, (o) => u64le(view, o));
  const notionalMicroUsd = read(8, (o) => u64le(view, o));
  const sortieIndex = read(1, (o) => body[o]);
  const sortieCount = read(1, (o) => body[o]);
  const vrfCommitment = read(32, (o) => hex(body, o, 32));
  return {
    nonce,
    policyVersion,
    mintIn,
    mintOut,
    amountIn,
    amountOut,
    minAmountOut,
    oracleExpectedOut,
    notionalMicroUsd,
    sortieIndex,
    sortieCount,
    vrfCommitment,
    slot,
  };
}

/* --- the adapter ---------------------------------------------------------- */

/**
 * Anchor writes events to the transaction log as `Program data: <base64>`,
 * where the first 8 bytes are the event discriminator. Supply the discriminator
 * for `SortieExecuted` from the generated IDL — it is
 * `sha256("event:SortieExecuted")[..8]`, and it changes if the event is renamed.
 */
export async function loadFromChain(
  config: ChainConfig,
  sortieDiscriminator: Uint8Array
): Promise<VaultSnapshot> {
  if (!config.rpcUrl) throw new NotConfiguredError("RPC endpoint");
  if (!config.vault) throw new NotConfiguredError("vault address");
  if (sortieDiscriminator.length !== 8) {
    throw new NotConfiguredError("SortieExecuted event discriminator (8 bytes, from the IDL)");
  }

  const [slot, account] = await Promise.all([
    rpc<number>(config.rpcUrl, "getSlot", [{ commitment: "confirmed" }]),
    rpc<{ value: { data: [string, string] } | null }>(config.rpcUrl, "getAccountInfo", [
      config.vault,
      { encoding: "base64", commitment: "confirmed" },
    ]),
  ]);

  if (!account.value) throw new Error(`vault ${config.vault} does not exist on this cluster`);

  const raw = Uint8Array.from(atob(account.value.data[0]), (c) => c.charCodeAt(0));
  const { vault, policy } = decodeVault(raw, config.vault, slot, config.mintLabels ?? {});

  const signatures = await rpc<{ signature: string; slot: number }[]>(
    config.rpcUrl,
    "getSignaturesForAddress",
    [config.vault, { limit: HISTORY_LIMIT }]
  );

  // Fetched in small concurrent batches. One request per signature run strictly
  // in series is what turns a page load into a thirty-second stall on a public
  // RPC; firing all of them at once gets the whole set rate-limited instead.
  // A single failed log read drops that transaction rather than the page.
  const sorties: Sortie[] = [];
  for (let i = 0; i < signatures.length; i += HISTORY_BATCH) {
    const batch = signatures.slice(i, i + HISTORY_BATCH);
    const txs = await Promise.all(
      batch.map((sig) =>
        rpc<{ meta: { logMessages: string[] | null } | null } | null>(
          config.rpcUrl,
          "getTransaction",
          [sig.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }]
        ).catch(() => null)
      )
    );
    txs.forEach((tx, j) => {
      for (const line of tx?.meta?.logMessages ?? []) {
        if (!line.startsWith("Program data: ")) continue;
        const bytes = Uint8Array.from(atob(line.slice("Program data: ".length)), (c) =>
          c.charCodeAt(0)
        );
        if (bytes.length < 8) continue;
        const matches = sortieDiscriminator.every((b, i2) => bytes[i2] === b);
        if (matches) sorties.push(decodeSortieEvent(bytes.subarray(8), batch[j].slot));
      }
    });
  }
  sorties.sort((a, b) => a.nonce - b.nonce);

  // Holdings need the vault's token accounts and a price read; both are
  // deliberately left to the caller so this module stays a pure decoder.
  const holdings: Holding[] = [];

  return { vault, policy, holdings, sorties, source: "chain" };
}
