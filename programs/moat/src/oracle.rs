//! Reading Pyth, and binding a price account to the mint it is allowed to price.
//!
//! The feed-id check here is load-bearing. `execute_sortie` accepts price
//! accounts from an untrusted relayer, and the slippage floor is computed from
//! them — so without binding each mint to its feed id in policy, a relayer could
//! pass the feed for a cheaper asset and manufacture a floor the vault would
//! happily trade through. The account address is not enough on its own: Pyth's
//! pull oracle posts updates to ephemeral accounts, so the *id* is the identity.

use anchor_lang::prelude::*;
use moat_core::OracleQuote;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

use crate::errors::MoatError;
use crate::state::MintRule;

/// Turn a posted Pyth update into the kernel's quote shape.
///
/// Freshness and confidence are *not* checked here — they are policy, and policy
/// lives in `moat-core` so it can be tested without a validator. This function
/// only establishes that the numbers came from the right feed and are sane
/// enough to put in a `u64`.
pub fn read_quote(update: &Account<PriceUpdateV2>, rule: &MintRule) -> Result<OracleQuote> {
    // A partially-verified update has had only some of the Wormhole guardian
    // signatures checked. Cheap to post, and not something to price a vault off.
    require!(
        matches!(update.verification_level, VerificationLevel::Full),
        MoatError::OracleTooUncertain
    );

    let message = &update.price_message;
    require!(message.feed_id == rule.feed_id, MoatError::WrongPriceFeed);

    // Pyth prices are `i64` and may legitimately be negative for some
    // instruments. For a spot mint a non-positive price means something is
    // broken, and the kernel's maths assumes unsigned.
    require!(message.price > 0, MoatError::InvalidOraclePrice);

    Ok(OracleQuote {
        price: message.price as u64,
        conf: message.conf,
        expo: message.exponent,
        decimals: rule.decimals,
        publish_ts: message.publish_time,
    })
}
