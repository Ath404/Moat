/**
 * The live layer.
 *
 * Everything in here talks to a real network. Nothing in here invents a number.
 * If a call fails, the caller gets an error and the UI says so — a dashboard
 * that quietly falls back to fabricated data while showing a green "live" dot is
 * worse than one that admits it is disconnected.
 *
 * ## Why the oracle price is not read from Pyth here
 *
 * The obvious move would be to read a Pyth price account and show it as "the
 * oracle". Two things make that dishonest today:
 *
 * 1. The legacy Pyth v2 push accounts (e.g. SOL/USD at H6ARHf…) still exist and
 *    still decode cleanly, but stopped updating — mainnet currently returns
 *    `status = 0` and a 2024 timestamp on them. Rendering that as live would be
 *    a fabricated indicator.
 * 2. The pull oracle posts `PriceUpdateV2` accounts on demand and abandons them,
 *    so an arbitrary one found via `getProgramAccounts` is usually months stale.
 *
 * So the reference price comes from Jupiter — which is genuinely live, and is
 * already the venue in this architecture — and it is labelled a *reference*
 * price everywhere it appears, never "the oracle". The vault's real oracle read
 * happens on-chain, inside `execute_sortie`, and is republished in the event.
 */

/**
 * Not `api.mainnet-beta.solana.com`. That endpoint answers the CORS preflight
 * happily and then returns **403 on the actual POST** whenever an `Origin`
 * header is present — it is server-to-server only. From a browser it fails
 * every time, so a panel pointed at it would have shipped permanently
 * "disconnected". publicnode serves `Access-Control-Allow-Origin: *` and
 * answers `getSlot`/`getAccountInfo` from a page. Verified against both.
 */
export const DEFAULT_RPC = RPC_URL;

const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface ChainStatus {
  slot: number;
  endpoint: string;
  /** Round-trip time of the slot call, in ms. */
  latencyMs: number;
}

export interface ReferencePrice {
  usd: number;
  /** Slot Jupiter priced at, when it reports one. */
  blockId?: number;
  source: "jupiter";
}

async function rpc<T>(endpoint: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** Current slot, and how long the round trip took. */
export async function getChainStatus(endpoint = DEFAULT_RPC): Promise<ChainStatus> {
  const started = performance.now();
  const slot = await rpc<number>(endpoint, "getSlot", [{ commitment: "confirmed" }]);
  return { slot, endpoint, latencyMs: Math.round(performance.now() - started) };
}

/** Live SOL reference price. Not the vault's oracle — see the module note. */
export async function getReferencePrice(): Promise<ReferencePrice> {
  const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
  if (!res.ok) throw new Error(`jupiter price: HTTP ${res.status}`);
  const body = await res.json();
  const entry = body?.[SOL_MINT];
  if (!entry || typeof entry.usdPrice !== "number") {
    throw new Error("jupiter price: unexpected response shape");
  }
  return { usd: entry.usdPrice, blockId: entry.blockId, source: "jupiter" };
}

export type VaultLookup =
  | { state: "found"; owner: string; dataLen: number }
  | { state: "not-found" }
  | { state: "wrong-owner"; owner: string }
  | { state: "too-small"; dataLen: number };

/**
 * Look up a candidate vault account.
 *
 * Deliberately does not pretend: an address that exists but is owned by another
 * program, or is too short to be a `Vault`, is reported as exactly that rather
 * than being decoded into plausible-looking nonsense.
 */
export async function lookupVault(
  address: string,
  programId: string | undefined,
  expectedLen: number,
  endpoint = DEFAULT_RPC
): Promise<VaultLookup> {
  const result = await rpc<{ value: { owner: string; data: [string, string] } | null }>(
    endpoint,
    "getAccountInfo",
    [address, { encoding: "base64", commitment: "confirmed" }]
  );
  if (!result?.value) return { state: "not-found" };

  const { owner, data } = result.value;
  const dataLen = Uint8Array.from(atob(data[0]), (c) => c.charCodeAt(0)).length;

  if (programId && owner !== programId) return { state: "wrong-owner", owner };
  if (dataLen < expectedLen) return { state: "too-small", dataLen };
  return { state: "found", owner, dataLen };
}

/** Rough base58 shape check, so an obvious typo fails before a network call. */
export function looksLikeAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
}

/* ---------------------------------------------------------------------------
 * Pyth — the vault's actual oracle
 *
 * Earlier this module said a live Pyth read was not available. That was wrong,
 * and worth correcting properly rather than quietly: devnet carries ~738k
 * `PriceUpdateV2` accounts, almost all of them abandoned pull-oracle posts, but
 * a handful are sponsored feeds that keep updating. Searching the receiver
 * program for accounts with a publish time inside the last ten minutes turns up
 * 18 of them, including SOL/USD and USDC/USD.
 *
 * These are the same accounts `execute_sortie` reads. Everything the page shows
 * from here — the price, the confidence interval, the staleness — is the input
 * the program itself would price a fill from, not an approximation of it.
 * ------------------------------------------------------------------------- */

export const PYTH_DEVNET = {
  sol: {
    account: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
    feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    symbol: "SOL/USD",
  },
  usdc: {
    account: "Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX",
    feedId: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
    symbol: "USDC/USD",
  },
} as const;

export interface PythQuote {
  symbol: string;
  account: string;
  /** Human price, `price × 10^expo`. */
  usd: number;
  /** Confidence interval as a fraction of price, in bps — what the program checks. */
  confBps: number;
  expo: number;
  publishTime: number;
  /** Seconds since publish, against the vault's `max_oracle_staleness_secs`. */
  ageSecs: number;
  /** Whether Wormhole signatures were fully verified for this update. */
  fullyVerified: boolean;
}

/**
 * Decode a `PriceUpdateV2` account.
 *
 * Layout: 8 discriminator, 32 write_authority, then `verification_level` — a
 * Borsh enum that is 1 byte for `Full` and 2 for `Partial(u8)` — then the price
 * message. That variable-width enum is why the offset is computed rather than
 * constant.
 */
export function decodePythUpdate(data: Uint8Array, expectFeedId: string, symbol: string, account: string, nowSecs: number): PythQuote {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const level = data[40];
  const base = 40 + (level === 1 ? 1 : 2);

  const feedId = Array.from(data.subarray(base, base + 32))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (feedId !== expectFeedId) {
    throw new Error(`${symbol}: account holds feed ${feedId.slice(0, 12)}…, expected ${expectFeedId.slice(0, 12)}…`);
  }

  let o = base + 32;
  const price = Number(dv.getBigInt64(o, true)); o += 8;
  const conf = Number(dv.getBigUint64(o, true)); o += 8;
  const expo = dv.getInt32(o, true); o += 4;
  const publishTime = Number(dv.getBigInt64(o, true));

  if (price <= 0) throw new Error(`${symbol}: non-positive price`);

  return {
    symbol,
    account,
    usd: price * Math.pow(10, expo),
    confBps: (conf / price) * 10_000,
    expo,
    publishTime,
    ageSecs: nowSecs - publishTime,
    fullyVerified: level === 1,
  };
}

/** Read SOL/USD and USDC/USD from the accounts the program itself would read. */
export async function getPythQuotes(endpoint = DEFAULT_RPC): Promise<PythQuote[]> {
  const keys = [PYTH_DEVNET.sol, PYTH_DEVNET.usdc];
  const res = await rpc<{ value: ({ data: [string, string] } | null)[] }>(
    endpoint,
    "getMultipleAccounts",
    [keys.map((k) => k.account), { encoding: "base64", commitment: "confirmed" }]
  );
  const now = Math.floor(Date.now() / 1000);
  return keys.map((k, i) => {
    const acc = res.value[i];
    if (!acc) throw new Error(`${k.symbol}: price account not found on this cluster`);
    const raw = Uint8Array.from(atob(acc.data[0]), (c) => c.charCodeAt(0));
    return decodePythUpdate(raw, k.feedId, k.symbol, k.account, now);
  });
}

/* ---------------------------------------------------------------------------
 * The ticker
 *
 * Every row is a `PriceUpdateV2` account on devnet that is still being updated —
 * found by scanning the receiver program, not by calling a price API. That
 * distinction is the point: these are the accounts a Solana program can actually
 * consume, and each one carries the confidence interval the vault checks against
 * `max_oracle_conf_bps`. A REST quote has no such thing.
 * ------------------------------------------------------------------------- */

export const LIVE_FEEDS: { symbol: string; account: string; feedId: string }[] = [
  { symbol: "SOL", account: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE", feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" },
  { symbol: "BTC", account: "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo", feedId: "" },
  { symbol: "ETH", account: "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC", feedId: "" },
  { symbol: "USDC", account: "Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX", feedId: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a" },
  { symbol: "USDT", account: "HT2PLQBcG5EiCcNSaMHAjSgd9F98ecpATbk4Sk5oYuM", feedId: "" },
  { symbol: "JUP", account: "7dbob1psH1iZBS7qPsm3Kwbf5DzSXK8Jyg31CTgTnxH5", feedId: "" },
  { symbol: "PYTH", account: "8vjchtMuJNY4oFQdTi8yCe6mhCaNBFaUbktT482TpLPS", feedId: "" },
  { symbol: "mSOL", account: "5CKzb9j4ChgLUt8Gfm5CNGLN6khXKiqMbnGAW4cgXgxK", feedId: "" },
  { symbol: "RAY", account: "Hhipna3EoWR7u8pDruUg8RxhP5F6XLh6SEHMVDmZhWi8", feedId: "" },
  { symbol: "WIF", account: "6B23K3tkb51vLZA14jcEQVCA1pfHptzEHFA93V5dYwbT", feedId: "" },
  { symbol: "JLP", account: "2TTGSRSezqFzeLUH8JwRUbtN66XLLaymfYsWRTMjfiMw", feedId: "" },
];

/** Read every ticker feed in one RPC round trip. Unreadable rows are dropped. */
export async function getTicker(endpoint = DEFAULT_RPC): Promise<PythQuote[]> {
  const res = await rpc<{ value: ({ data: [string, string] } | null)[] }>(
    endpoint,
    "getMultipleAccounts",
    [LIVE_FEEDS.map((f) => f.account), { encoding: "base64", commitment: "confirmed" }]
  );
  const now = Math.floor(Date.now() / 1000);
  const out: PythQuote[] = [];
  LIVE_FEEDS.forEach((f, i) => {
    const acc = res.value[i];
    if (!acc) return;
    try {
      const raw = Uint8Array.from(atob(acc.data[0]), (c) => c.charCodeAt(0));
      // Only the two feeds the vault actually prices against get their id
      // pinned; the rest are display-only, so an id check would be theatre.
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const base = 40 + (raw[40] === 1 ? 1 : 2);
      let o = base + 32;
      const price = Number(dv.getBigInt64(o, true)); o += 8;
      const conf = Number(dv.getBigUint64(o, true)); o += 8;
      const expo = dv.getInt32(o, true); o += 4;
      const publishTime = Number(dv.getBigInt64(o, true));
      if (price <= 0) return;
      out.push({
        symbol: f.symbol,
        account: f.account,
        usd: price * Math.pow(10, expo),
        confBps: (conf / price) * 10_000,
        expo,
        publishTime,
        ageSecs: now - publishTime,
        fullyVerified: raw[40] === 1,
      });
    } catch { /* a feed we cannot read is simply not shown */ }
  });
  return out;
}

/* --- reading a vault's actual state --------------------------------------- */

import { decodeVault } from "./chain";
import type { PolicyBounds, VaultState } from "./types";
import { RPC_URL } from "./config";

export interface VaultRead {
  vault: VaultState;
  policy: PolicyBounds;
  slot: number;
}

/**
 * Fetch and decode a vault.
 *
 * "878 bytes" tells an operator nothing. What they need before acting is the
 * state they are about to act on: whether it is paused, which policy version is
 * current, whether a keep is even registered. That is all in the account, so
 * decode it rather than reporting its length.
 */
export async function readVault(address: string, endpoint = DEFAULT_RPC): Promise<VaultRead> {
  const [slot, acct] = await Promise.all([
    rpc<number>(endpoint, "getSlot", [{ commitment: "confirmed" }]),
    rpc<{ value: { owner: string; data: [string, string] } | null }>(endpoint, "getAccountInfo", [
      address,
      { encoding: "base64", commitment: "confirmed" },
    ]),
  ]);
  if (!acct?.value) throw new Error("No account at that address on this cluster.");
  const raw = Uint8Array.from(atob(acct.value.data[0]), (c) => c.charCodeAt(0));
  const { vault, policy } = decodeVault(raw, address, slot, {});
  return { vault, policy, slot };
}

/* ---------------------------------------------------------------------------
 * Vault activity
 * ------------------------------------------------------------------------- */

export interface VaultSignature {
  signature: string;
  slot: number;
  /** Non-null when the transaction landed but failed. */
  err: unknown;
  blockTime: number | null;
}

/**
 * Recent transactions touching the vault account.
 *
 * Deliberately just the signature list and not the decoded transactions: this
 * is one RPC call, it is what proves the account is real and in use, and a
 * reader who wants the detail follows the explorer link rather than waiting for
 * the page to fetch and decode a dozen transactions it will mostly not show.
 */
export async function getSignatures(
  address: string,
  endpoint = DEFAULT_RPC,
  limit = 12
): Promise<VaultSignature[]> {
  const rows = await rpc<
    { signature: string; slot: number; err: unknown; blockTime: number | null }[]
  >(endpoint, "getSignaturesForAddress", [address, { limit }]);
  return rows.map((r) => ({
    signature: r.signature,
    slot: r.slot,
    err: r.err ?? null,
    blockTime: r.blockTime ?? null,
  }));
}
