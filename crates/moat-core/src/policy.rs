//! The portcullis logic: every bound the chain re-derives before money moves.
//!
//! [`check_intent`] is the whole security argument of this project in one
//! function. It is deliberately written to be readable top to bottom, to take
//! all of its inputs as arguments (no ambient state, no clock, no globals), and
//! to return the *next* [`VaultRuntime`] rather than mutating anything — so the
//! Solana program's job reduces to "call this, store what it returns".
//!
//! ## What survives a fully compromised keep
//!
//! Assume the enclave is owned and the attacker can sign any intent they like.
//! They still cannot:
//!
//! * move more than `max_trade_notional` in one intent, or `max_daily_notional`
//!   in a rolling day — both measured in USD off the chain's own oracle read,
//!   not off anything the keep asserted;
//! * touch a mint or a venue outside the allowlists;
//! * replay, reorder or skip an intent — `nonce` is strictly sequential;
//! * outrun a policy change — any `set_policy` bumps `version` and strands every
//!   signed-but-unlanded intent;
//! * fire faster than `min_cooldown_slots`;
//! * and, the one that actually matters, **set `min_amount_out` low enough to
//!   donate the position to a sandwich**. The chain computes the honest output
//!   from live oracle prices and rejects anything under
//!   `expected * (1 - max_slippage_bps)`. See [`Denial::SlippageFloorBreached`].
//!
//! The residual authority of a compromised keep is therefore bounded to
//! "trade within your own risk limits, badly" — a P&L problem, not a custody one.

use crate::intent::{OracleQuote, Pubkey, TradeIntent};
use crate::{BPS, SLOTS_PER_DAY};

pub const MAX_ALLOWED_MINTS: usize = 8;
pub const MAX_ALLOWED_VENUES: usize = 4;

/// Owner-set constraints. Lives on-chain inside the vault account; only the
/// vault owner can change it, and changing it bumps [`Policy::version`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Bumped on every owner edit. An intent naming a stale version is refused,
    /// which is what makes "tighten my limits" take effect immediately rather
    /// than after the keep's in-flight queue drains.
    pub version: u32,
    /// Per-intent notional ceiling, in micro-USD (1e6 = $1).
    pub max_trade_notional: u64,
    /// Rolling-day notional ceiling, in micro-USD.
    pub max_daily_notional: u64,
    /// Hard ceiling on the slippage any intent may ask for.
    pub max_slippage_bps: u16,
    /// Minimum slots between two landed sorties.
    pub min_cooldown_slots: u64,
    /// Oldest oracle observation the chain will act on, in **seconds** — the
    /// unit Pyth publishes in. Every other duration here is in slots.
    pub max_oracle_staleness_secs: u64,
    /// Reject a feed whose confidence interval is wider than this fraction of
    /// its own price — the standard defence against acting during an outage or
    /// a thin, manipulable book.
    pub max_oracle_conf_bps: u16,
    /// How far the keep's quoted price may sit from the chain's live read before
    /// the intent is treated as stale or dishonest.
    pub max_quote_drift_bps: u16,
    /// Longest window an intent may stay valid. Caps how long a signed
    /// authorisation can be withheld and then fired at a moment of the holder's
    /// choosing.
    pub max_intent_lifetime_slots: u64,
    pub allowed_mints: [Pubkey; MAX_ALLOWED_MINTS],
    pub allowed_mint_count: u8,
    pub allowed_venues: [Pubkey; MAX_ALLOWED_VENUES],
    pub allowed_venue_count: u8,
    pub paused: bool,
}

/// The mutable counters the policy is enforced against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VaultRuntime {
    /// The only nonce the vault will accept next.
    pub next_nonce: u64,
    pub last_sortie_slot: u64,
    /// `slot / SLOTS_PER_DAY` at the time `day_notional` was last touched.
    pub day_index: u64,
    /// Micro-USD executed inside the current day window.
    pub day_notional: u64,
    /// Mirrors [`Policy::version`]; kept here so the check function needs only
    /// the runtime to reason about staleness.
    pub policy_version: u32,
}

/// What the chain learned by checking the intent, plus the counters to persist.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Approval {
    /// USD value of `amount_in` at the chain's live price, in micro-USD.
    pub notional_micro_usd: u64,
    /// Honest expected output at live prices, in `mint_out` atoms.
    pub expected_out: u64,
    /// The floor `min_amount_out` had to clear. The program re-uses this after
    /// the swap CPI as the post-condition on the realised balance delta.
    pub floor_out: u64,
    /// Store this over the old runtime once the swap succeeds.
    pub next: VaultRuntime,
}

/// Every way an intent can be refused. One variant per reason on purpose: a
/// single `Unauthorized` tells an operator nothing at 3am.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Denial {
    Paused,
    PolicyVersionMismatch { expected: u32, got: u32 },
    NonceMismatch { expected: u64, got: u64 },
    Expired { slot: u64, expiry: u64 },
    LifetimeTooLong,
    ZeroAmount,
    SameMint,
    SortieOutOfRange,
    MintNotAllowed,
    VenueNotAllowed,
    SlippageAbovePolicy,
    OracleStale,
    OracleTooUncertain,
    /// The keep's quoted price disagrees with the chain's live read.
    QuoteDrift,
    /// Quote and live read are not the same feed shape (expo/decimals moved).
    QuoteShapeMismatch,
    TradeTooLarge { notional: u64, cap: u64 },
    DailyCapExceeded { would_be: u64, cap: u64 },
    CooldownActive { earliest: u64 },
    /// `min_amount_out` sits below what live prices say is honest. This is the
    /// check that stops a compromised keep from routing the vault into a
    /// sandwich at an "authorised" price.
    SlippageFloorBreached { min_out: u64, floor: u64 },
    MathOverflow,
}

/// Re-derive every bound. Pure: same inputs, same answer, on-chain or in a test.
///
/// `live_in` / `live_out` are the chain's own oracle reads for `mint_in` and
/// `mint_out`. They are the authority; the intent's `quoted_*` fields are only
/// evidence about what the keep believed, and are checked *against* them.
/// `slot` is the chain's clock (expiry, cooldown, day window); `now_ts` is wall
/// time (oracle freshness only). They are separate parameters because they are
/// separate clocks — see [`OracleQuote::publish_ts`].
pub fn check_intent(
    intent: &TradeIntent,
    policy: &Policy,
    runtime: &VaultRuntime,
    slot: u64,
    now_ts: i64,
    live_in: &OracleQuote,
    live_out: &OracleQuote,
) -> Result<Approval, Denial> {
    // --- structural: cheap, and failing here means a malformed caller --------
    if policy.paused {
        return Err(Denial::Paused);
    }
    if intent.policy_version != policy.version || runtime.policy_version != policy.version {
        return Err(Denial::PolicyVersionMismatch {
            expected: policy.version,
            got: intent.policy_version,
        });
    }
    if intent.nonce != runtime.next_nonce {
        return Err(Denial::NonceMismatch { expected: runtime.next_nonce, got: intent.nonce });
    }
    if slot > intent.expiry_slot {
        return Err(Denial::Expired { slot, expiry: intent.expiry_slot });
    }
    let lifetime = intent.expiry_slot.checked_sub(slot).ok_or(Denial::MathOverflow)?;
    if lifetime > policy.max_intent_lifetime_slots {
        return Err(Denial::LifetimeTooLong);
    }
    if intent.amount_in == 0 {
        return Err(Denial::ZeroAmount);
    }
    if intent.mint_in == intent.mint_out {
        return Err(Denial::SameMint);
    }
    if intent.sortie_count == 0 || intent.sortie_index >= intent.sortie_count {
        return Err(Denial::SortieOutOfRange);
    }

    // --- allowlists ----------------------------------------------------------
    let mints = &policy.allowed_mints[..policy.allowed_mint_count as usize];
    if !mints.contains(&intent.mint_in) || !mints.contains(&intent.mint_out) {
        return Err(Denial::MintNotAllowed);
    }
    if !policy.allowed_venues[..policy.allowed_venue_count as usize].contains(&intent.venue) {
        return Err(Denial::VenueNotAllowed);
    }
    if intent.max_slippage_bps > policy.max_slippage_bps {
        return Err(Denial::SlippageAbovePolicy);
    }

    // --- oracle sanity, on the chain's own reads -----------------------------
    for feed in [live_in, live_out] {
        // A feed published in the future is as suspect as a stale one: it means
        // the clocks disagree, and every age check below is then meaningless.
        let age = now_ts.checked_sub(feed.publish_ts).ok_or(Denial::MathOverflow)?;
        if age < 0 || age as u64 > policy.max_oracle_staleness_secs {
            return Err(Denial::OracleStale);
        }
        if feed.price == 0 {
            return Err(Denial::OracleTooUncertain);
        }
        let conf_bps = (feed.conf as u128)
            .checked_mul(BPS as u128)
            .ok_or(Denial::MathOverflow)?
            .checked_div(feed.price as u128)
            .ok_or(Denial::MathOverflow)?;
        if conf_bps > policy.max_oracle_conf_bps as u128 {
            return Err(Denial::OracleTooUncertain);
        }
    }

    // The keep must have been looking at roughly the same market we are. This
    // catches both a keep replaying an old decision and a keep inventing prices
    // to justify a trade the live market would not.
    check_quote_agrees(&intent.quoted_in, live_in, policy.max_quote_drift_bps)?;
    check_quote_agrees(&intent.quoted_out, live_out, policy.max_quote_drift_bps)?;

    // --- size, in USD the chain computed itself ------------------------------
    let notional = usd_micro(intent.amount_in, live_in).ok_or(Denial::MathOverflow)?;
    let notional = u64::try_from(notional).map_err(|_| Denial::MathOverflow)?;
    if notional > policy.max_trade_notional {
        return Err(Denial::TradeTooLarge { notional, cap: policy.max_trade_notional });
    }

    let day_index = slot.checked_div(SLOTS_PER_DAY).ok_or(Denial::MathOverflow)?;
    let day_so_far = if day_index == runtime.day_index { runtime.day_notional } else { 0 };
    let would_be = day_so_far.checked_add(notional).ok_or(Denial::MathOverflow)?;
    if would_be > policy.max_daily_notional {
        return Err(Denial::DailyCapExceeded { would_be, cap: policy.max_daily_notional });
    }

    // --- pacing --------------------------------------------------------------
    // A vault that has never traded (last_sortie_slot == 0) is not held back.
    if runtime.last_sortie_slot != 0 {
        let earliest = runtime
            .last_sortie_slot
            .checked_add(policy.min_cooldown_slots)
            .ok_or(Denial::MathOverflow)?;
        if slot < earliest {
            return Err(Denial::CooldownActive { earliest });
        }
    }

    // --- the execution-price floor ------------------------------------------
    let expected_out = expected_out(intent.amount_in, live_in, live_out).ok_or(Denial::MathOverflow)?;
    let tolerated = BPS
        .checked_sub(intent.max_slippage_bps as u64)
        .ok_or(Denial::MathOverflow)?;
    let floor_out = (expected_out as u128)
        .checked_mul(tolerated as u128)
        .ok_or(Denial::MathOverflow)?
        .checked_div(BPS as u128)
        .ok_or(Denial::MathOverflow)?;
    let floor_out = u64::try_from(floor_out).map_err(|_| Denial::MathOverflow)?;
    if intent.min_amount_out < floor_out {
        return Err(Denial::SlippageFloorBreached { min_out: intent.min_amount_out, floor: floor_out });
    }

    Ok(Approval {
        notional_micro_usd: notional,
        expected_out,
        floor_out,
        next: VaultRuntime {
            next_nonce: runtime.next_nonce.checked_add(1).ok_or(Denial::MathOverflow)?,
            last_sortie_slot: slot,
            day_index,
            day_notional: would_be,
            policy_version: runtime.policy_version,
        },
    })
}

/// The keep's quote must be the same feed shape and within `max_drift_bps` of
/// the live price.
///
/// Requiring identical `expo`/`decimals` rather than normalising across them is
/// deliberate: a Pyth exponent change is rare, and treating it as an error the
/// owner must acknowledge is safer than silently rescaling a price by 10x.
fn check_quote_agrees(quoted: &OracleQuote, live: &OracleQuote, max_drift_bps: u16) -> Result<(), Denial> {
    if quoted.expo != live.expo || quoted.decimals != live.decimals {
        return Err(Denial::QuoteShapeMismatch);
    }
    if live.price == 0 {
        return Err(Denial::OracleTooUncertain);
    }
    let hi = quoted.price.max(live.price);
    let lo = quoted.price.min(live.price);
    let drift_bps = (hi.checked_sub(lo).ok_or(Denial::MathOverflow)? as u128)
        .checked_mul(BPS as u128)
        .ok_or(Denial::MathOverflow)?
        .checked_div(live.price as u128)
        .ok_or(Denial::MathOverflow)?;
    if drift_bps > max_drift_bps as u128 {
        return Err(Denial::QuoteDrift);
    }
    Ok(())
}

/// `10^n`, or `None` past `u128`'s range.
fn pow10(n: u32) -> Option<u128> {
    if n > 38 {
        return None;
    }
    10u128.checked_pow(n)
}

/// USD value of `amount` atoms, in micro-USD.
///
/// A Pyth quote prices one *whole* token at `price * 10^expo`, so one atom is
/// worth `price * 10^(expo - decimals)` and the micro-USD value of `amount`
/// atoms is `amount * price * 10^(expo - decimals + 6)`.
pub fn usd_micro(amount: u64, q: &OracleQuote) -> Option<u128> {
    let shift = (q.expo as i64)
        .checked_sub(q.decimals as i64)?
        .checked_add(6)?;
    let base = (amount as u128).checked_mul(q.price as u128)?;
    apply_shift(base, shift)
}

/// Honest output for `amount_in` at oracle prices, in `mint_out` atoms.
///
/// `out = amount_in * price_in * 10^((expo_in - dec_in) - (expo_out - dec_out)) / price_out`
///
/// The shift is applied to the numerator or the denominator depending on sign so
/// that no intermediate is truncated before the division — scaling to a fixed
/// "USD per atom" first would round tiny per-atom prices to zero.
pub fn expected_out(amount_in: u64, in_q: &OracleQuote, out_q: &OracleQuote) -> Option<u64> {
    if out_q.price == 0 {
        return None;
    }
    let shift_in = (in_q.expo as i64).checked_sub(in_q.decimals as i64)?;
    let shift_out = (out_q.expo as i64).checked_sub(out_q.decimals as i64)?;
    let shift = shift_in.checked_sub(shift_out)?;

    let base = (amount_in as u128).checked_mul(in_q.price as u128)?;
    let (num, den) = if shift >= 0 {
        (base.checked_mul(pow10(u32::try_from(shift).ok()?)?)?, out_q.price as u128)
    } else {
        (base, (out_q.price as u128).checked_mul(pow10(u32::try_from(-shift).ok()?)?)?)
    };
    u64::try_from(num.checked_div(den)?).ok()
}

fn apply_shift(base: u128, shift: i64) -> Option<u128> {
    if shift >= 0 {
        base.checked_mul(pow10(u32::try_from(shift).ok()?)?)
    } else {
        base.checked_div(pow10(u32::try_from(-shift).ok()?)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::Side;

    const USDC: Pubkey = [1u8; 32];
    const SOL: Pubkey = [2u8; 32];
    const BONK: Pubkey = [3u8; 32];
    const JUPITER: Pubkey = [9u8; 32];
    const RANDOM_AMM: Pubkey = [8u8; 32];

    /// $1.00, 6 decimals.
    fn usdc_feed(ts: i64) -> OracleQuote {
        OracleQuote { price: 100_000_000, conf: 20_000, expo: -8, decimals: 6, publish_ts: ts }
    }

    /// $150.00, 9 decimals.
    fn sol_feed(ts: i64) -> OracleQuote {
        OracleQuote { price: 15_000_000_000, conf: 3_000_000, expo: -8, decimals: 9, publish_ts: ts }
    }

    fn policy() -> Policy {
        let mut allowed_mints = [[0u8; 32]; MAX_ALLOWED_MINTS];
        allowed_mints[0] = USDC;
        allowed_mints[1] = SOL;
        let mut allowed_venues = [[0u8; 32]; MAX_ALLOWED_VENUES];
        allowed_venues[0] = JUPITER;
        Policy {
            version: 1,
            max_trade_notional: 5_000_000_000,   // $5,000
            max_daily_notional: 25_000_000_000,  // $25,000
            max_slippage_bps: 100,               // 1%
            min_cooldown_slots: 100,
            max_oracle_staleness_secs: 30,
            max_oracle_conf_bps: 100,
            max_quote_drift_bps: 50,
            max_intent_lifetime_slots: 300,
            allowed_mints,
            allowed_mint_count: 2,
            allowed_venues,
            allowed_venue_count: 1,
            paused: false,
        }
    }

    fn runtime() -> VaultRuntime {
        VaultRuntime {
            next_nonce: 7,
            last_sortie_slot: 900,
            day_index: 1_000_000 / SLOTS_PER_DAY,
            day_notional: 1_000_000_000, // $1,000 done today
            policy_version: 1,
        }
    }

    const NOW: u64 = 1_000_000;
    const NOW_TS: i64 = 1_770_000_000;

    /// Buy 1 SOL with 150 USDC, priced honestly, 1% slippage allowed.
    fn intent() -> TradeIntent {
        TradeIntent {
            vault: [7u8; 32],
            policy_version: 1,
            nonce: 7,
            expiry_slot: NOW + 120,
            side: Side::Buy,
            mint_in: USDC,
            mint_out: SOL,
            amount_in: 150_000_000,      // 150 USDC
            min_amount_out: 990_000_000, // 0.99 SOL — exactly the 1% floor
            max_slippage_bps: 100,
            venue: JUPITER,
            sortie_index: 0,
            sortie_count: 3,
            vrf_commitment: [0xAB; 32],
            quoted_in: usdc_feed(NOW_TS - 5),
            quoted_out: sol_feed(NOW_TS - 5),
        }
    }

    fn check(i: &TradeIntent) -> Result<Approval, Denial> {
        check_intent(i, &policy(), &runtime(), NOW, NOW_TS, &usdc_feed(NOW_TS - 2), &sol_feed(NOW_TS - 2))
    }

    // --- pricing maths -------------------------------------------------------

    #[test]
    fn usd_micro_is_exact_for_both_decimal_shapes() {
        // 150 USDC and 1 SOL are both $150 at these feeds.
        assert_eq!(usd_micro(150_000_000, &usdc_feed(0)).unwrap(), 150_000_000);
        assert_eq!(usd_micro(1_000_000_000, &sol_feed(0)).unwrap(), 150_000_000);
    }

    #[test]
    fn expected_out_is_exact_in_both_directions() {
        // 150 USDC -> 1 SOL
        assert_eq!(expected_out(150_000_000, &usdc_feed(0), &sol_feed(0)).unwrap(), 1_000_000_000);
        // 1 SOL -> 150 USDC
        assert_eq!(expected_out(1_000_000_000, &sol_feed(0), &usdc_feed(0)).unwrap(), 150_000_000);
    }

    #[test]
    fn expected_out_survives_a_huge_notional_without_overflowing() {
        // 1e15 USDC atoms ($1bn) must not wrap; it should simply price out.
        assert!(expected_out(1_000_000_000_000_000, &usdc_feed(0), &sol_feed(0)).is_some());
    }

    // --- happy path ----------------------------------------------------------

    #[test]
    fn approves_an_honest_intent_and_advances_the_counters() {
        let approval = check(&intent()).unwrap();
        assert_eq!(approval.notional_micro_usd, 150_000_000); // $150
        assert_eq!(approval.expected_out, 1_000_000_000);     // 1 SOL
        assert_eq!(approval.floor_out, 990_000_000);          // 0.99 SOL
        assert_eq!(approval.next.next_nonce, 8);
        assert_eq!(approval.next.last_sortie_slot, NOW);
        assert_eq!(approval.next.day_notional, 1_000_000_000 + 150_000_000);
    }

    // --- the headline property ----------------------------------------------

    #[test]
    fn a_compromised_keep_cannot_lowball_min_amount_out() {
        // The attacker owns the enclave and can sign anything. They ask for a
        // legitimate-looking $150 buy but set min_out to one lamport, intending
        // to take the other side of the fill. The chain prices the trade itself.
        let mut evil = intent();
        evil.min_amount_out = 1;
        assert_eq!(
            check(&evil),
            Err(Denial::SlippageFloorBreached { min_out: 1, floor: 990_000_000 })
        );

        // One atom under the floor is still refused; the boundary is not sloppy.
        let mut just_under = intent();
        just_under.min_amount_out = 989_999_999;
        assert!(matches!(check(&just_under), Err(Denial::SlippageFloorBreached { .. })));
    }

    #[test]
    fn a_keep_cannot_widen_its_own_slippage_budget() {
        let mut evil = intent();
        evil.max_slippage_bps = 5_000; // 50%
        evil.min_amount_out = 500_000_000;
        assert_eq!(check(&evil), Err(Denial::SlippageAbovePolicy));
    }

    #[test]
    fn a_keep_cannot_invent_a_price_to_justify_a_bad_fill() {
        // Claim SOL is $75 so that a 0.5 SOL fill looks honest.
        let mut evil = intent();
        evil.quoted_out = OracleQuote { price: 7_500_000_000, ..sol_feed(NOW_TS - 5) };
        evil.min_amount_out = 500_000_000;
        assert_eq!(check(&evil), Err(Denial::QuoteDrift));
    }

    // --- limits --------------------------------------------------------------

    #[test]
    fn rejects_a_trade_over_the_per_intent_cap() {
        let mut big = intent();
        big.amount_in = 6_000_000_000; // $6,000 > $5,000
        big.min_amount_out = 39_600_000_000;
        assert!(matches!(check(&big), Err(Denial::TradeTooLarge { cap: 5_000_000_000, .. })));
    }

    #[test]
    fn rejects_a_trade_that_would_breach_the_daily_cap() {
        let mut rt = runtime();
        rt.day_notional = 24_900_000_000; // $24,900 of $25,000 used
        let err = check_intent(&intent(), &policy(), &rt, NOW, NOW_TS, &usdc_feed(NOW_TS - 2), &sol_feed(NOW_TS - 2));
        assert!(matches!(err, Err(Denial::DailyCapExceeded { .. })));
    }

    #[test]
    fn the_daily_window_rolls_over() {
        let mut rt = runtime();
        rt.day_notional = 24_900_000_000;
        rt.day_index -= 1; // yesterday's spend
        let approval =
            check_intent(&intent(), &policy(), &rt, NOW, NOW_TS, &usdc_feed(NOW_TS - 2), &sol_feed(NOW_TS - 2)).unwrap();
        assert_eq!(approval.next.day_notional, 150_000_000, "counter should restart, not accumulate");
    }

    #[test]
    fn enforces_the_cooldown() {
        let mut rt = runtime();
        rt.last_sortie_slot = NOW - 10; // cooldown is 100 slots
        let err = check_intent(&intent(), &policy(), &rt, NOW, NOW_TS, &usdc_feed(NOW_TS - 2), &sol_feed(NOW_TS - 2));
        assert_eq!(err, Err(Denial::CooldownActive { earliest: NOW - 10 + 100 }));
    }

    #[test]
    fn a_fresh_vault_is_not_held_back_by_the_cooldown() {
        let mut rt = runtime();
        rt.last_sortie_slot = 0;
        assert!(check_intent(&intent(), &policy(), &rt, NOW, NOW_TS, &usdc_feed(NOW_TS - 2), &sol_feed(NOW_TS - 2)).is_ok());
    }

    // --- allowlists and structure -------------------------------------------

    #[test]
    fn rejects_an_unlisted_mint() {
        let mut i = intent();
        i.mint_out = BONK;
        assert_eq!(check(&i), Err(Denial::MintNotAllowed));
    }

    #[test]
    fn rejects_an_unlisted_venue() {
        let mut i = intent();
        i.venue = RANDOM_AMM;
        assert_eq!(check(&i), Err(Denial::VenueNotAllowed));
    }

    #[test]
    fn rejects_a_replayed_or_reordered_nonce() {
        let mut replay = intent();
        replay.nonce = 6; // already spent
        assert_eq!(check(&replay), Err(Denial::NonceMismatch { expected: 7, got: 6 }));

        let mut skip = intent();
        skip.nonce = 8; // jumping the queue
        assert_eq!(check(&skip), Err(Denial::NonceMismatch { expected: 7, got: 8 }));
    }

    #[test]
    fn a_policy_edit_strands_in_flight_intents() {
        let mut p = policy();
        p.version = 2; // owner tightened limits after the keep signed
        let mut rt = runtime();
        rt.policy_version = 2;
        let err = check_intent(&intent(), &p, &rt, NOW, NOW_TS, &usdc_feed(NOW_TS - 2), &sol_feed(NOW_TS - 2));
        assert_eq!(err, Err(Denial::PolicyVersionMismatch { expected: 2, got: 1 }));
    }

    #[test]
    fn rejects_expired_and_over_long_intents() {
        let mut expired = intent();
        expired.expiry_slot = NOW - 1;
        assert!(matches!(check(&expired), Err(Denial::Expired { .. })));

        let mut evergreen = intent();
        evergreen.expiry_slot = NOW + 100_000; // policy allows 300 slots
        assert_eq!(check(&evergreen), Err(Denial::LifetimeTooLong));
    }

    #[test]
    fn rejects_degenerate_intents() {
        let mut zero = intent();
        zero.amount_in = 0;
        assert_eq!(check(&zero), Err(Denial::ZeroAmount));

        let mut same = intent();
        same.mint_out = USDC;
        assert_eq!(check(&same), Err(Denial::SameMint));

        let mut bad_leg = intent();
        bad_leg.sortie_index = 3;
        bad_leg.sortie_count = 3;
        assert_eq!(check(&bad_leg), Err(Denial::SortieOutOfRange));
    }

    #[test]
    fn refuses_to_act_on_a_paused_vault() {
        let mut p = policy();
        p.paused = true;
        let err = check_intent(&intent(), &p, &runtime(), NOW, NOW_TS, &usdc_feed(NOW_TS - 2), &sol_feed(NOW_TS - 2));
        assert_eq!(err, Err(Denial::Paused));
    }

    // --- oracle hygiene ------------------------------------------------------

    #[test]
    fn refuses_to_act_on_a_stale_feed() {
        let stale = sol_feed(NOW_TS - 5_000);
        let mut i = intent();
        i.quoted_out = stale;
        let err = check_intent(&i, &policy(), &runtime(), NOW, NOW_TS, &usdc_feed(NOW_TS - 2), &stale);
        assert_eq!(err, Err(Denial::OracleStale));
    }

    #[test]
    fn refuses_a_feed_published_in_the_future() {
        // Clock disagreement between the chain and the publisher makes every
        // other age check meaningless, so it is refused rather than clamped.
        let ahead = sol_feed(NOW_TS + 600);
        let mut i = intent();
        i.quoted_out = ahead;
        let err = check_intent(&i, &policy(), &runtime(), NOW, NOW_TS, &usdc_feed(NOW_TS - 2), &ahead);
        assert_eq!(err, Err(Denial::OracleStale));
    }

    #[test]
    fn refuses_to_act_when_the_feed_is_uncertain() {
        // 5% confidence interval against a 1% policy ceiling: the market is not
        // in a state where an oracle-derived floor means anything.
        let wide = OracleQuote { conf: 750_000_000, ..sol_feed(NOW_TS - 2) };
        let mut i = intent();
        i.quoted_out = wide;
        let err = check_intent(&i, &policy(), &runtime(), NOW, NOW_TS, &usdc_feed(NOW_TS - 2), &wide);
        assert_eq!(err, Err(Denial::OracleTooUncertain));
    }

    #[test]
    fn refuses_a_quote_whose_shape_moved_under_it() {
        let mut i = intent();
        i.quoted_out = OracleQuote { expo: -9, ..sol_feed(NOW_TS - 5) };
        assert_eq!(check(&i), Err(Denial::QuoteShapeMismatch));
    }

    #[test]
    fn the_floor_tracks_the_live_market_not_the_signed_quote() {
        // SOL slipped to $149.70 while the intent was in flight: 20bps of real
        // movement, inside the 50bps drift tolerance, so this is not an attack
        // and QuoteDrift must not fire. But 150 USDC now buys ~1.002 SOL, so the
        // honest floor rises above the min_out the keep signed.
        let live = OracleQuote { price: 14_970_000_000, ..sol_feed(NOW_TS - 2) };
        let err = check_intent(&intent(), &policy(), &runtime(), NOW, NOW_TS, &usdc_feed(NOW_TS - 2), &live);
        assert_eq!(
            err,
            Err(Denial::SlippageFloorBreached { min_out: 990_000_000, floor: 991_983_967 }),
            "the floor must come from the live read, not from what the keep quoted"
        );

        // Same market, a min_out that clears the new floor: approved.
        let mut i = intent();
        i.min_amount_out = 992_000_000;
        assert!(check_intent(&i, &policy(), &runtime(), NOW, NOW_TS, &usdc_feed(NOW_TS - 2), &live).is_ok());
    }
}
