/**
 * Instruction building for the Moat program.
 *
 * Real Anchor encoding, done by hand, and — more to the point — encoding that
 * reports what it wrote. Every builder returns the bytes *and* a field-by-field
 * breakdown, so the console can show a user what they are about to sign instead
 * of a hex wall. A wallet dialog over an opaque blob asks for trust it has not
 * earned.
 *
 * Discriminators are `sha256("global:<snake_case_name>")[..8]`, precomputed so
 * nothing here needs async crypto. Recompute with:
 *
 *   node -e "console.log(require('crypto').createHash('sha256')
 *     .update('global:deposit').digest().subarray(0,8))"
 */

export const DISCRIMINATOR = {
  open_vault: [181, 248, 228, 67, 6, 175, 37, 167],
  set_policy: [40, 133, 12, 157, 235, 202, 2, 132],
  rotate_signet: [157, 83, 125, 239, 25, 18, 234, 44],
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  set_paused: [91, 60, 125, 192, 176, 225, 166, 218],
  execute_sortie: [14, 123, 173, 212, 13, 237, 159, 212],
} as const;

export type Ix = keyof typeof DISCRIMINATOR;

export interface Field {
  label: string;
  type: string;
  hex: string;
  /** Rendered value, where a raw number would not mean anything to a reader. */
  value?: string;
}

export interface Encoded {
  bytes: Uint8Array;
  fields: Field[];
}

export function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes as ArrayLike<number> & Iterable<number>)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* --- base58 --------------------------------------------------------------- */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function fromBase58(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`not base58: "${ch}"`);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch === "1") bytes.push(0);
    else break;
  }
  return Uint8Array.from(bytes.reverse());
}

export function pubkeyBytes(address: string): Uint8Array {
  const raw = fromBase58(address.trim());
  if (raw.length !== 32) throw new Error(`address decodes to ${raw.length} bytes, expected 32`);
  return raw;
}

function hexBytes(hex: string, expect: number): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length !== expect * 2 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error(`expected ${expect} bytes of hex, got ${clean.length / 2}`);
  }
  return Uint8Array.from(clean.match(/../g)!.map((b) => parseInt(b, 16)));
}

/* --- a Borsh writer that records what it wrote ---------------------------- */

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const usdToMicro = (n: number) => BigInt(Math.round(n * 1e6));

class W {
  private parts: number[] = [];
  readonly fields: Field[] = [];

  private raw(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i] & 0xff);
  }

  /** Write something and record it as one labelled field. */
  private span(label: string, type: string, value: string | undefined, write: () => void) {
    const from = this.parts.length;
    write();
    this.fields.push({ label, type, value, hex: toHex(this.parts.slice(from)) });
    return this;
  }

  private u64raw(v: bigint) {
    let x = v;
    const out: number[] = [];
    for (let i = 0; i < 8; i++) {
      out.push(Number(x & 0xffn));
      x >>= 8n;
    }
    this.raw(out);
  }

  disc(ix: Ix) {
    return this.span("discriminator", `sha256("global:${ix}")[..8]`, ix, () =>
      this.raw(DISCRIMINATOR[ix])
    );
  }
  pubkey(label: string, address: string) {
    return this.span(label, "Pubkey", `${address.slice(0, 8)}…`, () =>
      this.raw(pubkeyBytes(address))
    );
  }
  hex32(label: string, hex: string) {
    return this.span(label, "[u8; 32]", `${hex.replace(/^0x/, "").slice(0, 12)}…`, () =>
      this.raw(hexBytes(hex, 32))
    );
  }
  u64(label: string, v: bigint, value?: string) {
    return this.span(label, "u64", value ?? v.toLocaleString("en-US"), () => this.u64raw(v));
  }
  u32(label: string, v: number, value?: string) {
    return this.span(label, "u32", value ?? String(v), () =>
      this.raw([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff])
    );
  }
  u16(label: string, v: number, value?: string) {
    return this.span(label, "u16", value ?? String(v), () => this.raw([v & 0xff, (v >> 8) & 0xff]));
  }
  u8(label: string, v: number, value?: string) {
    return this.span(label, "u8", value ?? String(v), () => this.raw([v & 0xff]));
  }
  bool(label: string, v: boolean) {
    return this.span(label, "bool", String(v), () => this.raw([v ? 1 : 0]));
  }

  finish(): Encoded {
    return { bytes: Uint8Array.from(this.parts), fields: this.fields };
  }
}

/* --- policy --------------------------------------------------------------- */

export interface MintRuleInput {
  mint: string;
  symbol: string;
  /** 32-byte Pyth feed id, hex. */
  feedIdHex: string;
  decimals: number;
}

export interface PolicyInput {
  maxTradeNotionalUsd: number;
  maxDailyNotionalUsd: number;
  maxSlippageBps: number;
  minCooldownSlots: number;
  maxOracleStalenessSecs: number;
  maxOracleConfBps: number;
  maxQuoteDriftBps: number;
  maxIntentLifetimeSlots: number;
  mints: MintRuleInput[];
  venues: { name: string; address: string }[];
}

function writePolicy(w: W, p: PolicyInput) {
  w.u64("max_trade_notional", usdToMicro(p.maxTradeNotionalUsd), `${usd(p.maxTradeNotionalUsd)} (micro-USD)`);
  w.u64("max_daily_notional", usdToMicro(p.maxDailyNotionalUsd), `${usd(p.maxDailyNotionalUsd)} (micro-USD)`);
  w.u16("max_slippage_bps", p.maxSlippageBps, `${p.maxSlippageBps} bps`);
  w.u64("min_cooldown_slots", BigInt(p.minCooldownSlots), `${p.minCooldownSlots} slots ≈ ${((p.minCooldownSlots * 0.4) / 60).toFixed(1)} min`);
  w.u64("max_oracle_staleness_secs", BigInt(p.maxOracleStalenessSecs), `${p.maxOracleStalenessSecs}s`);
  w.u16("max_oracle_conf_bps", p.maxOracleConfBps);
  w.u16("max_quote_drift_bps", p.maxQuoteDriftBps);
  w.u64("max_intent_lifetime_slots", BigInt(p.maxIntentLifetimeSlots));
  // Borsh Vec<T> is a u32 length followed by the elements.
  w.u32("mints.len", p.mints.length);
  p.mints.forEach((m, i) => {
    w.pubkey(`mints[${i}].mint`, m.mint);
    w.hex32(`mints[${i}].feed_id`, m.feedIdHex);
    w.u8(`mints[${i}].decimals`, m.decimals, `${m.symbol}, ${m.decimals}dp`);
  });
  w.u32("venues.len", p.venues.length);
  p.venues.forEach((v, i) => w.pubkey(`venues[${i}]`, v.address));
}

export const build = {
  openVault: (guardian: string, policy: PolicyInput): Encoded => {
    const w = new W().disc("open_vault").pubkey("guardian", guardian);
    writePolicy(w, policy);
    return w.finish();
  },
  setPolicy: (policy: PolicyInput): Encoded => {
    const w = new W().disc("set_policy");
    writePolicy(w, policy);
    return w.finish();
  },
  rotateSignet: (enclaveKey: string, measurementHex: string, validForSlots: number): Encoded =>
    new W()
      .disc("rotate_signet")
      .pubkey("enclave_key", enclaveKey)
      .hex32("measurement", measurementHex)
      .u64("valid_for_slots", BigInt(validForSlots), `${validForSlots} slots ≈ ${(validForSlots * 0.4 / 86400).toFixed(1)} days`)
      .finish(),
  deposit: (atoms: bigint, human: string): Encoded =>
    new W().disc("deposit").u64("amount", atoms, `${human} tokens`).finish(),
  withdraw: (atoms: bigint, human: string): Encoded =>
    new W().disc("withdraw").u64("amount", atoms, `${human} tokens`).finish(),
  setPaused: (paused: boolean): Encoded =>
    new W().disc("set_paused").bool("paused", paused).finish(),
};

/** Accounts each instruction expects, in `#[derive(Accounts)]` order. */
export const ACCOUNTS: Record<string, { name: string; role: string; note: string }[]> = {
  open_vault: [
    { name: "vault", role: "writable", note: 'PDA, seeds ["vault", owner] · init' },
    { name: "owner", role: "signer · writable", note: "pays rent" },
    { name: "system_program", role: "readonly", note: "1111…1111" },
  ],
  set_policy: [
    { name: "vault", role: "writable", note: "PDA" },
    { name: "owner", role: "signer", note: "must equal vault.owner" },
  ],
  rotate_signet: [
    { name: "vault", role: "writable", note: "PDA" },
    { name: "owner", role: "signer", note: "must equal vault.owner" },
  ],
  deposit: [
    { name: "vault", role: "readonly", note: "PDA" },
    { name: "owner", role: "signer · writable", note: "owner-only by design" },
    { name: "from", role: "writable", note: "owner's token account" },
    { name: "vault_token", role: "writable", note: "vault's token account" },
    { name: "mint", role: "readonly", note: "SPL mint" },
    { name: "token_program", role: "readonly", note: "Token or Token-2022" },
  ],
  withdraw: [
    { name: "vault", role: "readonly", note: "PDA" },
    { name: "owner", role: "signer · writable", note: "permitted even while paused" },
    { name: "vault_token", role: "writable", note: "vault's token account" },
    { name: "to", role: "writable", note: "destination" },
    { name: "mint", role: "readonly", note: "SPL mint" },
    { name: "token_program", role: "readonly", note: "Token or Token-2022" },
  ],
  set_paused: [
    { name: "vault", role: "writable", note: "PDA" },
    { name: "authority", role: "signer", note: "owner, or guardian to pause only" },
  ],
};
