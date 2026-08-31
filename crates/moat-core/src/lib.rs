//! # moat-core
//!
//! The policy kernel that stands between a private strategy and the vault's money.
//!
//! Everything here is pure, allocation-free and dependency-free so that it can run
//! unchanged in three places that must agree bit-for-bit:
//!
//! * inside the **keep** (the TEE), which builds and signs a [`TradeIntent`];
//! * inside the **moat** Solana program, which re-derives every bound before it
//!   lets a lamport move;
//! * inside tests, which is the only place any of it is cheap to falsify.
//!
//! The design premise is that the enclave is *useful* but not *trusted*. A fully
//! compromised keep still cannot move more than [`Policy::max_trade_notional`] per
//! intent, cannot exceed the rolling daily cap, cannot trade an unlisted mint,
//! cannot route to an unlisted venue, cannot replay, and — the one most designs
//! miss — cannot set `min_amount_out` low enough to hand the position to a
//! sandwich. The chain recomputes the acceptable output from its own oracle read
//! and rejects anything below the floor. See [`policy::check_intent`].

#![cfg_attr(not(test), no_std)]
#![deny(clippy::arithmetic_side_effects)]
#![cfg_attr(test, allow(clippy::arithmetic_side_effects))]

pub mod intent;
pub mod policy;
pub mod sortie;

pub use intent::{OracleQuote, Pubkey, Side, TradeIntent};
pub use policy::{
    check_intent, Approval, Denial, Policy, VaultRuntime, MAX_ALLOWED_MINTS, MAX_ALLOWED_VENUES,
};
pub use sortie::{Leg, Plan, SortieConfig, SortieError, MAX_LEGS};

/// Basis points denominator. One bps = 1/10_000.
pub const BPS: u64 = 10_000;

/// Solana produces a slot roughly every 400ms, so a "day" for the rolling
/// volume window is 216_000 slots. This is deliberately a slot count and not a
/// unix timestamp: `Clock::slot` cannot be nudged by a validator the way
/// `unix_timestamp` can, and the cap only needs to be approximately a day.
pub const SLOTS_PER_DAY: u64 = 216_000;
