# Moat

A non-custodial Solana vault that holds the funds and enforces the limits, while a
TEE holds the trading strategy and signs trade intents.

**The keep decides. The moat permits.**

Nothing the enclave produces is trusted. Every intent it signs is re-checked against
owner-set policy — using the chain's own oracle read — before a lamport moves. The
owner's withdrawal path never touches the enclave at all.

---

## The problem

If you run a proprietary strategy for other people's money, you pick one of two bad options:

- **Custody it.** You hold client funds in an operator wallet. Now you carry the trust
  burden, the regulatory surface, and the headline risk.
- **Reveal it.** You publish the strategy on-chain so it can be verified. Now anyone can
  copy your edge, and it decays.

Nobody wants either. The usual escape is "trust our TEE" — which just moves the trust,
it doesn't remove it.

## What is actually different here

Most designs that combine a TEE with DeFi stop at *the enclave is secure, so trust what
it signs*. That is a single point of failure wearing a hardware badge.

Moat assumes the enclave is compromised and asks what survives. The answer turns on one
check that these designs generally do not have:

> Before settling, the program reads Pyth itself, computes what an honest fill is worth,
> and **refuses anything below `expected × (1 − max_slippage)`**.

Why that specific check matters. Spending caps sound like they bound the damage, but they
only bound the *size* of a trade, not the *price*. A compromised keep that stays under
your $5,000 per-trade cap can still route the entire trade into a pool it controls and
settle at any price it likes. Every cap and allowlist passes. The money leaves anyway.

With the oracle floor, that attack is closed: the keep never gets to name the price. Its
residual authority is reduced to *trade within your own risk limits, badly* — a P&L
problem, not a custody one.

The second half is a verification property that falls out of the same design. Every fill
publishes three numbers — the oracle-fair output, the floor demanded, and the amount
received. That is enough for a depositor to audit execution quality precisely, and not
enough to reconstruct why any trade happened.

You can operate both claims rather than take them on faith: the web app has a page that
hands you a compromised enclave and asks you to drain the vault with it.

## Who it is for

| | Today they must | With Moat |
|---|---|---|
| A desk trading outside capital | Custody client funds, or publish the edge | Depositors verify performance and execution quality without seeing one parameter |
| Someone renting out a strategy | Hand over the alpha to sell access to it | Subscriber capital never leaves the subscriber's own vault |
| A treasury with a mandate | Trust a manager and reconcile after the fact | "Never more than $50k a day, only these assets, pausable instantly" *is* the policy account |

---

## Architecture

```
      owner
        │  deposit · withdraw · set mandate · rotate keep · pause
        ▼
┌─────────────────────────────────┐        ┌──────────────────────────────┐
│  moat program        TRUSTED    │        │  keep  (TEE)    UNTRUSTED    │
│  ─────────────────────────────  │        │  ──────────────────────────  │
│  vault PDA holds the SPL tokens │◄───────│  strategy, in the clear:     │
│  policy: caps, allowlists,      │ signed │  entry / exit / stop / size  │
│    slippage, cooldown           │ intent │  VRF → leg split + timing    │
│  nonce + rolling counters       │  275 B │                              │
│                                 │ Ed25519│  cannot move funds           │
│  re-derives EVERY bound before  │        │  may be fully compromised    │
│  it will sign the CPI           │        └──────────────────────────────┘
└───────┬──────────────────▲──────┘
        │                  │ price read (the program does this itself,
        │ CPI, PDA-signed  │ not the keep)
        ▼                  │
   ┌──────────┐       ┌────┴─────┐
   │ Jupiter  │       │   Pyth   │
   └──────────┘       └──────────┘
```

The trust boundary is the arrow labelled *signed intent*. Everything to its right can be
owned by an attacker without the vault losing custody.

### One trade, end to end

1. The keep evaluates the private strategy against oracle prices. Decision: buy $4,000 of SOL.
2. `sortie::plan` splits it into 3–5 legs of unequal size at unequal times, seeded by a VRF,
   so the vault doesn't trade to a readable rhythm.
3. Each leg becomes a `TradeIntent` — 275 bytes, fixed-width, domain-separated — signed
   with the enclave key.
4. A relayer (untrusted, could be anyone) submits one: an Ed25519 instruction plus
   `execute_sortie`.
5. The program verifies the signature by instruction introspection, then re-derives
   **every** bound: nonce, policy version, expiry, caps, allowlists, oracle staleness and
   confidence, and the price floor.
6. It CPIs into Jupiter, signing as the vault PDA.
7. Post-conditions: received ≥ `min_amount_out`, spent **exactly** `amount_in`, PDA
   lamports intact.
8. `SortieExecuted` publishes the three numbers the dashboard verifies.

### What survives a fully compromised keep

| Attack | What stops it |
|---|---|
| Move more than the per-trade cap | `max_trade_notional`, in USD from the chain's own oracle read |
| Grind the vault down over a day | `max_daily_notional` (see *Known issues* — currently a tumbling window) |
| Trade an asset you never approved | Mint allowlist, each mint bound to a specific Pyth feed id |
| Route through an unapproved program | Venue allowlist |
| Replay, reorder or skip a leg | Strictly sequential nonce |
| Outrun a limit you just tightened | `set_policy` bumps `policy_version`, stranding every signed intent |
| Substitute the accounts being measured | `vault_in`/`vault_out` pinned by ATA derivation; any other vault-owned token account in the route is rejected |
| **Settle at a price it chooses** | **The oracle-derived floor** |

And the property that makes it non-custodial: **the owner can always withdraw, including
while paused.** No cap, no cooldown, no enclave involvement.

---

## Repository layout

```
crates/moat-core/     the policy kernel — zero dependencies, its own workspace
  intent.rs             canonical 275-byte signed encoding
  policy.rs             check_intent(): every bound the chain re-derives
  sortie.rs             VRF → leg split and timing
programs/moat/        the Anchor program (Anchor 1.1.2)
  portcullis.rs         execute_sortie — the only path that moves funds
  signet.rs             Ed25519 instruction introspection
  drawbridge.rs         deposit / withdraw / pause
  oracle.rs             Pyth read, bound to the mint's feed id
  state.rs              878-byte Vault account
keep/                 the TEE half: strategy eval, VRF planning, intent signing
app/spyglass/         the web app
```

`moat-core` is deliberately dependency-free and lives in its own Cargo workspace, so the
security-critical arithmetic can be tested with a plain `cargo test` — no Solana toolchain,
no network. The same crate is used by the program and by the keep, so both sides of the
trust boundary run identical maths by construction.

## Build and test

```bash
# the kernel — no toolchain, no network, no validator
cd crates/moat-core && cargo test          # 39 tests

# the enclave half
cd keep && cargo test                      # 13 tests

# the program
cargo check -p moat
cargo test -p moat --lib                   # 8 tests

# the real target — run this before trusting any change to an Accounts struct
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cargo-build-sbf --manifest-path programs/moat/Cargo.toml

# the web app
cd app/spyglass && npm install && npm run dev
```

The SBF build is not a formality. It caught a defect the host check cannot see:
`ExecuteSortie::try_accounts` overflowed the 4 KB BPF stack frame by ~384 bytes, because
`Vault` is 878 bytes and was being deserialised inline alongside two Pyth updates and two
token accounts. That is undefined behaviour at runtime, not a warning.

## The web app

`app/spyglass` — Vite + React, no Solana SDK dependency. Five surfaces:

- **Overview** — the claim, and who it is for.
- **Console** — connect a wallet, point at a vault, and build any instruction. Every action
  encodes real Anchor data and renders the bytes before anything is signed.
- **Vault** — the dashboard. Every fill plotted against the price the chain read, with each
  row expanding into its checks re-derived in the browser.
- **Mandate** — write a policy and replay the strategy's whole history through it, in order,
  the way the chain would. Refusals cascade, because a refused fill spends no daily budget.
- **Attack** — you hold the compromised enclave. Try to drain the vault. Toggle the oracle
  floor off to see what the caps are worth on their own.

The account decoder reads the `Vault` account from byte offsets written out in declaration
order; they sum to 878, which independently confirms `Vault::LEN`.

---

## Status

**Verified by running it:** `moat-core` 39 tests, `keep` 13 tests, `programs/moat` 8 tests
and a clean SBF build (306 KB `moat.so`), zero warnings across all three.

**Not verified:** the program has never been deployed and no transaction has ever executed
against it. There are no integration tests against a validator. The Jupiter CPI and the
Pyth read compile but have never seen a real transaction.

**Out of scope by choice:** TDX quote verification happens off-chain — `rotate_signet`
records the measurement the owner approved so it is auditable, but the owner checks the
quote. On-chain verification is real work (certificate chain parsing inside a compute
budget), not a line of code.

### Known issues

Found by an adversarial audit of this code, and outstanding:

- **The daily cap window is tumbling, not rolling.** `day_index = slot / SLOTS_PER_DAY`
  resets at fixed boundaries, so the full cap is spendable just before one and again just
  after — an effective 2× over a 24-hour period that straddles a boundary. Size the cap
  accordingly, or implement the rolling window.
- **`MintRule.decimals` is owner-declared and never checked against the SPL mint.** Every
  notional and every slippage floor derives from it, so a 6-vs-9 typo moves every bound by
  1000×. Fix: require the `Mint` account in `set_policy` and compare.
- **`expected_out` truncates toward zero**, so for an output mint coarse enough that the
  honest output rounds to 0, the floor is vacuous. Not reachable for SOL/USDC.

One critical bug has already been found and fixed: `vault_in`/`vault_out` were pinned only
by `token::authority`, and creating a token account owned by the vault PDA is
permissionless — so a relayer could hand the program two empty accounts to measure while
the route drained the real one. Every post-condition passed against a delta of zero. Now
pinned by ATA derivation, with `spent == amount_in` exactly and a scan that rejects any
other vault-owned token account in the route.

### Not done

Integration tests against a validator, deployment, and on-chain VRF verification —
`vrf_commitment` is carried and published, but the chain does not yet check that the leg
split matches a real VRF output, so the unpredictability currently rests on the keep's
honesty.

## License

MIT
