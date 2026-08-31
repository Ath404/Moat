//! The keep: the private half.
//!
//! This is the code intended to run inside the TEE. It holds the only copy of
//! the strategy in the clear, evaluates it against market data, splits the
//! resulting decision into sorties using a VRF output, and signs each leg with
//! the enclave key the vault has registered.
//!
//! It deliberately shares [`moat_core`] with the on-chain program rather than
//! reimplementing the bounds. The keep must produce intents the moat will
//! *accept*; the cheapest way to guarantee that is for both sides to run the
//! same function. [`tests::a_signed_plan_is_accepted_by_the_vault_policy`] is
//! the test that keeps the two honest.
//!
//! ## What this file must never do
//!
//! Log, serialise or return a [`Strategy`] field. The entire value of the vault
//! is that these numbers exist in exactly one place. Note there is no `Debug`
//! derive on [`Strategy`] — that is not an oversight, it is the point: a derived
//! `Debug` is how a strategy ends up in a panic message, and a panic message
//! inside a TEE still reaches the operator's terminal.

use ed25519_dalek::{Signature, Signer, SigningKey};
use moat_core::{
    check_intent, sortie, OracleQuote, Policy, Pubkey, Side, SortieConfig, TradeIntent, VaultRuntime,
    BPS,
};

/// The private parameters. Encrypted at rest; decrypted only inside the enclave.
///
/// Not `Debug`, not `Clone`, not serialisable. See the module note.
pub struct Strategy {
    /// Buy below this price, in micro-USD per whole token.
    pub entry_price_micro_usd: u64,
    /// Take profit above this price.
    pub exit_price_micro_usd: u64,
    /// Cut below this price.
    pub stop_loss_micro_usd: u64,
    /// Fraction of available capital to commit per entry.
    pub position_size_bps: u16,
    /// Ceiling on the position as a fraction of total portfolio value.
    pub max_exposure_bps: u16,
    /// Slippage to request. Must sit under the vault's own policy ceiling or
    /// the moat will refuse the intent.
    pub max_slippage_bps: u16,
    /// How the decision is broken up and scattered.
    pub sortie: SortieConfig,
}

/// Everything the keep is told about the outside world. All of it is public
/// information — the privacy is in the parameters above, not in these.
#[derive(Clone, Copy, Debug)]
pub struct Market {
    /// Price feed for the funding asset (`mint_in` on a buy).
    pub base: OracleQuote,
    /// Price feed for the traded asset (`mint_out` on a buy).
    pub quote: OracleQuote,
    /// Spendable balance of the funding asset, in atoms.
    pub available_base: u64,
    /// Current holding of the traded asset, in atoms.
    pub position_quote: u64,
    /// Total portfolio value in micro-USD, used for the exposure test.
    pub portfolio_micro_usd: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Spend `amount_in` atoms of the base asset on the quote asset.
    Buy { amount_in: u64 },
    /// Sell `amount_in` atoms of the quote asset back to base.
    Sell { amount_in: u64 },
    Hold,
}

/// Evaluate the strategy. The one function whose inputs are public and whose
/// logic is not.
pub fn evaluate(strategy: &Strategy, market: &Market) -> Decision {
    let Some(price) = whole_token_price_micro_usd(&market.quote) else {
        // No price, no decision. Refusing to act on an unreadable feed is the
        // same call the chain makes, for the same reason.
        return Decision::Hold;
    };

    // Exits first. A stop that only gets checked after the entry branch is a
    // stop that does not fire on the bar that matters.
    if market.position_quote > 0
        && (price >= strategy.exit_price_micro_usd || price <= strategy.stop_loss_micro_usd)
    {
        return Decision::Sell { amount_in: market.position_quote };
    }

    if price < strategy.entry_price_micro_usd {
        let exposure_micro_usd = moat_core::policy::usd_micro(market.position_quote, &market.quote)
            .and_then(|v| u64::try_from(v).ok())
            .unwrap_or(u64::MAX);
        let exposure_bps = if market.portfolio_micro_usd == 0 {
            BPS
        } else {
            (exposure_micro_usd as u128)
                .saturating_mul(BPS as u128)
                .checked_div(market.portfolio_micro_usd as u128)
                .unwrap_or(BPS as u128) as u64
        };
        if exposure_bps >= strategy.max_exposure_bps as u64 {
            return Decision::Hold;
        }

        let amount_in = (market.available_base as u128)
            .saturating_mul(strategy.position_size_bps as u128)
            .checked_div(BPS as u128)
            .and_then(|v| u64::try_from(v).ok())
            .unwrap_or(0);
        if amount_in == 0 {
            return Decision::Hold;
        }
        return Decision::Buy { amount_in };
    }

    Decision::Hold
}

/// The chain-facing context the keep needs to address an intent correctly. All
/// of it is readable from the vault account.
#[derive(Clone, Copy, Debug)]
pub struct VaultContext {
    pub vault: Pubkey,
    pub policy_version: u32,
    /// The vault's `next_nonce`. Legs are numbered from here.
    pub next_nonce: u64,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub venue: Pubkey,
    pub current_slot: u64,
    /// How long each signed leg stays valid. Must not exceed the vault's
    /// `max_intent_lifetime_slots`.
    pub intent_lifetime_slots: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanError {
    NothingToDo,
    Sortie(sortie::SortieError),
    /// Oracle maths overflowed, or a feed priced at zero.
    Unpriceable,
}

/// A signed leg, ready to hand to an untrusted relayer.
#[derive(Clone)]
pub struct SignedIntent {
    pub intent: TradeIntent,
    pub signature: Signature,
    /// Slot the relayer should hold this back until. Advisory: the chain
    /// enforces pacing through `min_cooldown_slots`, not through this.
    pub release_slot: u64,
}

impl SignedIntent {
    /// The bytes the Ed25519 instruction must carry.
    pub fn message(&self) -> [u8; TradeIntent::SIGNING_LEN] {
        self.intent.signing_bytes()
    }
}

/// Split a decision into sorties and sign each one.
///
/// `vrf_seed` must be a VRF output. Everything about the split — how many legs,
/// their sizes, their release slots — is derived from it, so it is reproducible
/// by anyone holding the proof and predictable by no one before it exists.
pub fn plan_and_sign(
    decision: Decision,
    market: &Market,
    strategy: &Strategy,
    ctx: &VaultContext,
    vrf_seed: &[u8; 32],
    signing_key: &SigningKey,
) -> Result<Vec<SignedIntent>, PlanError> {
    let (side, amount_in, mint_in, mint_out, quote_in, quote_out) = match decision {
        Decision::Hold => return Err(PlanError::NothingToDo),
        Decision::Buy { amount_in } => (
            Side::Buy,
            amount_in,
            ctx.base_mint,
            ctx.quote_mint,
            market.base,
            market.quote,
        ),
        Decision::Sell { amount_in } => (
            Side::Sell,
            amount_in,
            ctx.quote_mint,
            ctx.base_mint,
            market.quote,
            market.base,
        ),
    };

    let plan =
        sortie::plan(vrf_seed, amount_in, ctx.current_slot, &strategy.sortie).map_err(PlanError::Sortie)?;

    let mut signed = Vec::with_capacity(plan.count as usize);
    for (index, leg) in plan.legs().iter().enumerate() {
        // Compute the floor exactly the way the chain will, then ask for it.
        // Asking for anything lower is free money for a sandwich; asking for
        // anything higher just fails more often for no gain.
        let expected =
            moat_core::policy::expected_out(leg.amount, &quote_in, &quote_out).ok_or(PlanError::Unpriceable)?;
        let min_amount_out = (expected as u128)
            .checked_mul(BPS.checked_sub(strategy.max_slippage_bps as u64).ok_or(PlanError::Unpriceable)? as u128)
            .and_then(|v| v.checked_div(BPS as u128))
            .and_then(|v| u64::try_from(v).ok())
            .ok_or(PlanError::Unpriceable)?;

        let intent = TradeIntent {
            vault: ctx.vault,
            policy_version: ctx.policy_version,
            nonce: ctx.next_nonce.checked_add(index as u64).ok_or(PlanError::Unpriceable)?,
            expiry_slot: leg
                .release_slot
                .checked_add(ctx.intent_lifetime_slots)
                .ok_or(PlanError::Unpriceable)?,
            side,
            mint_in,
            mint_out,
            amount_in: leg.amount,
            min_amount_out,
            max_slippage_bps: strategy.max_slippage_bps,
            venue: ctx.venue,
            sortie_index: index as u8,
            sortie_count: plan.count,
            vrf_commitment: *vrf_seed,
            quoted_in: quote_in,
            quoted_out: quote_out,
        };

        let signature = signing_key.sign(&intent.signing_bytes());
        signed.push(SignedIntent { intent, signature, release_slot: leg.release_slot });
    }
    Ok(signed)
}

/// Rehearsal: would the vault accept this intent right now?
///
/// The keep runs its own output through the chain's checker before releasing it.
/// An intent the moat would refuse is a wasted transaction and a public signal
/// that something is misconfigured — both worth catching in here instead.
pub fn would_be_accepted(
    intent: &TradeIntent,
    policy: &Policy,
    runtime: &VaultRuntime,
    slot: u64,
    now_ts: i64,
    live_in: &OracleQuote,
    live_out: &OracleQuote,
) -> bool {
    check_intent(intent, policy, runtime, slot, now_ts, live_in, live_out).is_ok()
}

/// Price of one whole token in micro-USD, or `None` if the feed cannot be
/// priced.
///
/// The zero guards are load-bearing. Without them a dead feed reports a price of
/// zero, zero is below every entry threshold, and the strategy reads an oracle
/// outage as the buying opportunity of a lifetime. The chain would refuse the
/// resulting intents, so this is not a loss-of-funds bug — it is worse in a
/// different way: the keep would burn its nonce sequence and publish a very
/// legible signal about what it does when a feed drops.
fn whole_token_price_micro_usd(q: &OracleQuote) -> Option<u64> {
    if q.price == 0 {
        return None;
    }
    let one_token = 10u64.checked_pow(q.decimals as u32)?;
    let micro = u64::try_from(moat_core::policy::usd_micro(one_token, q)?).ok()?;
    // A token whose whole-unit price rounds to zero micro-USD is likewise not
    // something these thresholds can say anything useful about.
    (micro > 0).then_some(micro)
}

#[cfg(test)]
mod tests {
    use super::*;
    use moat_core::{MAX_ALLOWED_MINTS, MAX_ALLOWED_VENUES};

    const USDC: Pubkey = [1u8; 32];
    const SOL: Pubkey = [2u8; 32];
    const JUPITER: Pubkey = [9u8; 32];
    const NOW_SLOT: u64 = 1_000_000;
    const NOW_TS: i64 = 1_770_000_000;

    fn usdc_feed(ts: i64) -> OracleQuote {
        OracleQuote { price: 100_000_000, conf: 20_000, expo: -8, decimals: 6, publish_ts: ts }
    }

    /// $150.00 SOL by default.
    fn sol_feed_at(price: u64, ts: i64) -> OracleQuote {
        OracleQuote { price, conf: 3_000_000, expo: -8, decimals: 9, publish_ts: ts }
    }

    fn strategy() -> Strategy {
        Strategy {
            entry_price_micro_usd: 150_000_000,  // $150
            exit_price_micro_usd: 175_000_000,   // $175
            stop_loss_micro_usd: 138_000_000,    // $138
            position_size_bps: 1_000,            // 10% of available capital
            max_exposure_bps: 3_000,             // 30% of portfolio
            max_slippage_bps: 50,
            sortie: SortieConfig::default(),
        }
    }

    fn market(price: u64, position: u64) -> Market {
        Market {
            base: usdc_feed(NOW_TS - 2),
            quote: sol_feed_at(price, NOW_TS - 2),
            available_base: 10_000_000_000, // 10,000 USDC
            position_quote: position,
            portfolio_micro_usd: 25_000_000_000, // $25,000
        }
    }

    #[test]
    fn prices_a_whole_token_correctly() {
        assert_eq!(whole_token_price_micro_usd(&sol_feed_at(15_000_000_000, 0)).unwrap(), 150_000_000);
        assert_eq!(whole_token_price_micro_usd(&usdc_feed(0)).unwrap(), 1_000_000);
    }

    #[test]
    fn buys_below_the_entry_threshold() {
        // SOL at $147, entry is $150: 10% of 10,000 USDC.
        let d = evaluate(&strategy(), &market(14_700_000_000, 0));
        assert_eq!(d, Decision::Buy { amount_in: 1_000_000_000 });
    }

    #[test]
    fn holds_at_or_above_the_entry_threshold() {
        assert_eq!(evaluate(&strategy(), &market(15_000_000_000, 0)), Decision::Hold);
        assert_eq!(evaluate(&strategy(), &market(16_000_000_000, 0)), Decision::Hold);
    }

    #[test]
    fn takes_profit_above_the_exit() {
        // $180 with 5 SOL held.
        let d = evaluate(&strategy(), &market(18_000_000_000, 5_000_000_000));
        assert_eq!(d, Decision::Sell { amount_in: 5_000_000_000 });
    }

    #[test]
    fn the_stop_fires_even_though_the_price_also_looks_like_an_entry() {
        // $130 is below the $138 stop *and* below the $150 entry. Ordering the
        // exit branch first is what makes this a stop rather than an add.
        let d = evaluate(&strategy(), &market(13_000_000_000, 5_000_000_000));
        assert_eq!(d, Decision::Sell { amount_in: 5_000_000_000 });
    }

    #[test]
    fn refuses_to_add_past_the_exposure_ceiling() {
        // 60 SOL at $147 is ~$8,820 of a $25,000 portfolio: over the 30% cap.
        let d = evaluate(&strategy(), &market(14_700_000_000, 60_000_000_000));
        assert_eq!(d, Decision::Hold);
    }

    #[test]
    fn holds_on_an_unreadable_feed() {
        let mut m = market(14_700_000_000, 0);
        m.quote.price = 0;
        assert_eq!(evaluate(&strategy(), &m), Decision::Hold);
    }

    // --- planning and signing ------------------------------------------------

    fn ctx() -> VaultContext {
        VaultContext {
            vault: [7u8; 32],
            policy_version: 1,
            next_nonce: 7,
            base_mint: USDC,
            quote_mint: SOL,
            venue: JUPITER,
            current_slot: NOW_SLOT,
            intent_lifetime_slots: 250,
        }
    }

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[42u8; 32])
    }

    fn policy() -> Policy {
        let mut allowed_mints = [[0u8; 32]; MAX_ALLOWED_MINTS];
        allowed_mints[0] = USDC;
        allowed_mints[1] = SOL;
        let mut allowed_venues = [[0u8; 32]; MAX_ALLOWED_VENUES];
        allowed_venues[0] = JUPITER;
        Policy {
            version: 1,
            max_trade_notional: 5_000_000_000,
            max_daily_notional: 25_000_000_000,
            max_slippage_bps: 100,
            min_cooldown_slots: 0,
            max_oracle_staleness_secs: 30,
            max_oracle_conf_bps: 100,
            max_quote_drift_bps: 50,
            max_intent_lifetime_slots: 4_000,
            allowed_mints,
            allowed_mint_count: 2,
            allowed_venues,
            allowed_venue_count: 1,
            paused: false,
        }
    }

    #[test]
    fn a_plan_conserves_the_decision_and_numbers_its_legs() {
        let m = market(14_700_000_000, 0);
        let d = evaluate(&strategy(), &m);
        let legs = plan_and_sign(d, &m, &strategy(), &ctx(), &[5u8; 32], &key()).unwrap();

        let total: u64 = legs.iter().map(|l| l.intent.amount_in).sum();
        assert_eq!(total, 1_000_000_000, "legs must add up to the decision");
        for (i, leg) in legs.iter().enumerate() {
            assert_eq!(leg.intent.nonce, 7 + i as u64, "nonces must be consecutive from next_nonce");
            assert_eq!(leg.intent.sortie_index, i as u8);
            assert_eq!(leg.intent.sortie_count, legs.len() as u8);
            assert_eq!(leg.intent.vrf_commitment, [5u8; 32]);
        }
    }

    #[test]
    fn a_sell_inverts_the_mints() {
        let m = market(18_000_000_000, 5_000_000_000);
        let d = evaluate(&strategy(), &m);
        let legs = plan_and_sign(d, &m, &strategy(), &ctx(), &[6u8; 32], &key()).unwrap();
        assert_eq!(legs[0].intent.mint_in, SOL);
        assert_eq!(legs[0].intent.mint_out, USDC);
        assert_eq!(legs[0].intent.side, Side::Sell);
    }

    #[test]
    fn signatures_verify_against_the_enclave_key() {
        use ed25519_dalek::Verifier;
        let m = market(14_700_000_000, 0);
        let d = evaluate(&strategy(), &m);
        let legs = plan_and_sign(d, &m, &strategy(), &ctx(), &[5u8; 32], &key()).unwrap();
        let verifying = key().verifying_key();
        for leg in &legs {
            assert!(verifying.verify(&leg.message(), &leg.signature).is_ok());
        }
    }

    /// The test that keeps the two halves of the system honest.
    #[test]
    fn a_signed_plan_is_accepted_by_the_vault_policy() {
        let m = market(14_700_000_000, 0);
        let d = evaluate(&strategy(), &m);
        let legs = plan_and_sign(d, &m, &strategy(), &ctx(), &[5u8; 32], &key()).unwrap();

        // Walk the legs the way the chain would: one at a time, each against the
        // runtime the previous one left behind.
        let policy = policy();
        let mut runtime = VaultRuntime {
            next_nonce: 7,
            last_sortie_slot: 0,
            day_index: NOW_SLOT / moat_core::SLOTS_PER_DAY,
            day_notional: 0,
            policy_version: 1,
        };
        for leg in &legs {
            let approval = check_intent(
                &leg.intent,
                &policy,
                &runtime,
                leg.release_slot,
                NOW_TS,
                &m.base,
                &m.quote,
            )
            .unwrap_or_else(|d| panic!("the moat refused an intent its own keep produced: {d:?}"));
            runtime = approval.next;
        }
        assert_eq!(runtime.next_nonce, 7 + legs.len() as u64);
    }

    #[test]
    fn the_keep_asks_for_exactly_the_floor_the_chain_computes() {
        // Not below it (free money for a sandwich) and not above it (needless
        // failures). Equality is the correct answer.
        let m = market(14_700_000_000, 0);
        let d = evaluate(&strategy(), &m);
        let legs = plan_and_sign(d, &m, &strategy(), &ctx(), &[5u8; 32], &key()).unwrap();
        let policy = policy();
        let runtime = VaultRuntime {
            next_nonce: 7,
            last_sortie_slot: 0,
            day_index: NOW_SLOT / moat_core::SLOTS_PER_DAY,
            day_notional: 0,
            policy_version: 1,
        };
        let approval =
            check_intent(&legs[0].intent, &policy, &runtime, NOW_SLOT, NOW_TS, &m.base, &m.quote).unwrap();
        assert_eq!(legs[0].intent.min_amount_out, approval.floor_out);
    }

    #[test]
    fn holding_produces_nothing_to_sign() {
        let m = market(16_000_000_000, 0);
        let err = plan_and_sign(Decision::Hold, &m, &strategy(), &ctx(), &[5u8; 32], &key());
        assert!(matches!(err, Err(PlanError::NothingToDo)));
    }
}
