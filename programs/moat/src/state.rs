//! On-chain vault state, and the projection into [`moat_core`].
//!
//! The split is deliberate. Account validation — is this the right price feed
//! for this mint, is this signer the owner — belongs here, where Anchor and the
//! runtime can help. Numeric policy belongs in `moat-core`, where it can be
//! tested exhaustively without a validator. [`Vault::core_policy`] is the seam.

use anchor_lang::prelude::*;
use moat_core::{Policy as CorePolicy, VaultRuntime, MAX_ALLOWED_MINTS, MAX_ALLOWED_VENUES};

pub const VAULT_SEED: &[u8] = b"vault";

/// A mint the vault may hold, bound to the oracle feed that prices it.
///
/// The binding is the point. Without it a relayer could hand `execute_sortie`
/// the price account for some other asset and the slippage floor would be
/// computed off the wrong market — the cheapest possible way to defeat the one
/// check that actually constrains a compromised keep.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub struct MintRule {
    pub mint: Pubkey,
    /// Pyth feed id (the 32-byte id, not the price account address — the
    /// account address rotates, the feed id does not).
    pub feed_id: [u8; 32],
    pub decimals: u8,
}

impl MintRule {
    pub const LEN: usize = 32 + 32 + 1;
}

#[account]
pub struct Vault {
    pub bump: u8,
    /// May withdraw, set policy, rotate the enclave key, pause.
    pub owner: Pubkey,
    /// May pause, and nothing else. Lets a watchtower hold a kill-switch
    /// without holding the funds.
    pub guardian: Pubkey,

    // --- signet: the attested enclave ------------------------------------
    /// Ed25519 key the keep signs intents with. Set only by the owner, only
    /// after checking the attestation off-chain (see `signet.rs`).
    pub enclave_key: Pubkey,
    /// Expected TDX measurement of the keep image. Stored so the value the
    /// owner approved is auditable on-chain even though the quote itself is
    /// verified off-chain.
    pub enclave_measurement: [u8; 32],
    /// Registration expiry. Forces periodic re-attestation: a key that was
    /// attested six months ago proves nothing about the enclave today.
    pub enclave_expiry_slot: u64,

    // --- policy ------------------------------------------------------------
    pub policy_version: u32,
    pub max_trade_notional: u64,
    pub max_daily_notional: u64,
    pub max_slippage_bps: u16,
    pub min_cooldown_slots: u64,
    pub max_oracle_staleness_secs: u64,
    pub max_oracle_conf_bps: u16,
    pub max_quote_drift_bps: u16,
    pub max_intent_lifetime_slots: u64,
    pub mints: [MintRule; MAX_ALLOWED_MINTS],
    pub mint_count: u8,
    pub venues: [Pubkey; MAX_ALLOWED_VENUES],
    pub venue_count: u8,
    pub paused: bool,

    // --- runtime counters ---------------------------------------------------
    pub next_nonce: u64,
    pub last_sortie_slot: u64,
    pub day_index: u64,
    pub day_notional: u64,
}

impl Vault {
    /// Account size. Written out term by term rather than derived so that a
    /// field added without a migration is a visible diff here.
    pub const LEN: usize = 8   // anchor discriminator
        + 1                    // bump
        + 32                   // owner
        + 32                   // guardian
        + 32                   // enclave_key
        + 32                   // enclave_measurement
        + 8                    // enclave_expiry_slot
        + 4                    // policy_version
        + 8                    // max_trade_notional
        + 8                    // max_daily_notional
        + 2                    // max_slippage_bps
        + 8                    // min_cooldown_slots
        + 8                    // max_oracle_staleness_secs
        + 2                    // max_oracle_conf_bps
        + 2                    // max_quote_drift_bps
        + 8                    // max_intent_lifetime_slots
        + MintRule::LEN * MAX_ALLOWED_MINTS
        + 1                    // mint_count
        + 32 * MAX_ALLOWED_VENUES
        + 1                    // venue_count
        + 1                    // paused
        + 8                    // next_nonce
        + 8                    // last_sortie_slot
        + 8                    // day_index
        + 8; // day_notional

    pub fn signer_seeds<'a>(&'a self, owner: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
        [VAULT_SEED, owner.as_ref(), bump]
    }

    pub fn rule_for(&self, mint: &Pubkey) -> Option<&MintRule> {
        self.mints[..self.mint_count as usize].iter().find(|r| r.mint == *mint)
    }

    /// Project on-chain state into the pure policy the kernel checks against.
    pub fn core_policy(&self) -> CorePolicy {
        let mut allowed_mints = [[0u8; 32]; MAX_ALLOWED_MINTS];
        for (slot, rule) in allowed_mints.iter_mut().zip(self.mints.iter()) {
            *slot = rule.mint.to_bytes();
        }
        let mut allowed_venues = [[0u8; 32]; MAX_ALLOWED_VENUES];
        for (slot, venue) in allowed_venues.iter_mut().zip(self.venues.iter()) {
            *slot = venue.to_bytes();
        }
        CorePolicy {
            version: self.policy_version,
            max_trade_notional: self.max_trade_notional,
            max_daily_notional: self.max_daily_notional,
            max_slippage_bps: self.max_slippage_bps,
            min_cooldown_slots: self.min_cooldown_slots,
            max_oracle_staleness_secs: self.max_oracle_staleness_secs,
            max_oracle_conf_bps: self.max_oracle_conf_bps,
            max_quote_drift_bps: self.max_quote_drift_bps,
            max_intent_lifetime_slots: self.max_intent_lifetime_slots,
            allowed_mints,
            allowed_mint_count: self.mint_count,
            allowed_venues,
            allowed_venue_count: self.venue_count,
            paused: self.paused,
        }
    }

    pub fn core_runtime(&self) -> VaultRuntime {
        VaultRuntime {
            next_nonce: self.next_nonce,
            last_sortie_slot: self.last_sortie_slot,
            day_index: self.day_index,
            day_notional: self.day_notional,
            policy_version: self.policy_version,
        }
    }

    /// Persist the counters the kernel returned. Called only after the swap has
    /// landed and its post-conditions have held.
    pub fn commit_runtime(&mut self, next: VaultRuntime) {
        self.next_nonce = next.next_nonce;
        self.last_sortie_slot = next.last_sortie_slot;
        self.day_index = next.day_index;
        self.day_notional = next.day_notional;
    }
}

/// Owner-supplied policy. Same shape as the stored fields; kept separate so the
/// instruction argument can grow a validation pass of its own.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PolicyParams {
    pub max_trade_notional: u64,
    pub max_daily_notional: u64,
    pub max_slippage_bps: u16,
    pub min_cooldown_slots: u64,
    pub max_oracle_staleness_secs: u64,
    pub max_oracle_conf_bps: u16,
    pub max_quote_drift_bps: u16,
    pub max_intent_lifetime_slots: u64,
    pub mints: Vec<MintRule>,
    pub venues: Vec<Pubkey>,
}

impl PolicyParams {
    /// Reject a policy that is nonsense before it is ever enforced. A vault
    /// whose limits are wrong in the owner's favour is a vault with no limits.
    pub fn validate(&self) -> Result<()> {
        require!(!self.mints.is_empty(), crate::errors::MoatError::EmptyAllowlist);
        require!(!self.venues.is_empty(), crate::errors::MoatError::EmptyAllowlist);
        require!(self.mints.len() <= MAX_ALLOWED_MINTS, crate::errors::MoatError::AllowlistTooLong);
        require!(self.venues.len() <= MAX_ALLOWED_VENUES, crate::errors::MoatError::AllowlistTooLong);
        // Strictly less than 10_000. At exactly 10_000 the tolerated fraction is
        // zero, `floor_out` collapses to zero, and the oracle floor — the one
        // bound that constrains a compromised keep's *price* rather than its
        // size — silently stops existing. The same shape disables the oracle
        // confidence and quote-drift checks at their maxima.
        require!(self.max_slippage_bps < 10_000, crate::errors::MoatError::InvalidPolicy);
        require!(self.max_oracle_conf_bps < 10_000, crate::errors::MoatError::InvalidPolicy);
        require!(self.max_quote_drift_bps < 10_000, crate::errors::MoatError::InvalidPolicy);
        require!(self.max_trade_notional > 0, crate::errors::MoatError::InvalidPolicy);
        require!(
            self.max_daily_notional >= self.max_trade_notional,
            crate::errors::MoatError::InvalidPolicy
        );
        require!(self.max_intent_lifetime_slots > 0, crate::errors::MoatError::InvalidPolicy);
        // Duplicate mints would make `rule_for` ambiguous about which feed
        // prices an asset.
        for (i, rule) in self.mints.iter().enumerate() {
            require!(
                !self.mints[..i].iter().any(|other| other.mint == rule.mint),
                crate::errors::MoatError::InvalidPolicy
            );
        }
        Ok(())
    }

    /// Write into the vault and bump the generation, stranding every intent the
    /// keep signed under the old rules.
    pub fn apply_to(&self, vault: &mut Vault) -> Result<()> {
        self.validate()?;
        vault.max_trade_notional = self.max_trade_notional;
        vault.max_daily_notional = self.max_daily_notional;
        vault.max_slippage_bps = self.max_slippage_bps;
        vault.min_cooldown_slots = self.min_cooldown_slots;
        vault.max_oracle_staleness_secs = self.max_oracle_staleness_secs;
        vault.max_oracle_conf_bps = self.max_oracle_conf_bps;
        vault.max_quote_drift_bps = self.max_quote_drift_bps;
        vault.max_intent_lifetime_slots = self.max_intent_lifetime_slots;

        vault.mints = [MintRule::default(); MAX_ALLOWED_MINTS];
        for (dst, src) in vault.mints.iter_mut().zip(self.mints.iter()) {
            *dst = *src;
        }
        vault.mint_count = self.mints.len() as u8;

        vault.venues = [Pubkey::default(); MAX_ALLOWED_VENUES];
        for (dst, src) in vault.venues.iter_mut().zip(self.venues.iter()) {
            *dst = *src;
        }
        vault.venue_count = self.venues.len() as u8;

        vault.policy_version = vault
            .policy_version
            .checked_add(1)
            .ok_or(crate::errors::MoatError::MathOverflow)?;
        Ok(())
    }
}
