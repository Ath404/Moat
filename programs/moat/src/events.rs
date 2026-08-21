//! Events — the public surface the spyglass dashboard is built from.
//!
//! These are chosen to make performance auditable without making the strategy
//! reconstructible. Fills, sizes and the oracle price the vault checked against
//! are all public anyway (they are on-chain), so publishing them costs nothing
//! and lets anyone verify the vault honoured its own floor. What is deliberately
//! absent: anything about *why* a trade happened — thresholds, signals, the
//! rest of the plan. `vrf_commitment` is included so a holder of the VRF proof
//! can verify the split after the fact, and no one else learns anything from it.

use anchor_lang::prelude::*;

#[event]
pub struct VaultOpened {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub guardian: Pubkey,
}

#[event]
pub struct PolicyUpdated {
    pub vault: Pubkey,
    /// Every in-flight intent signed against the previous version is now dead.
    pub policy_version: u32,
    pub max_trade_notional: u64,
    pub max_daily_notional: u64,
    pub max_slippage_bps: u16,
    pub mint_count: u8,
    pub venue_count: u8,
}

#[event]
pub struct SignetRotated {
    pub vault: Pubkey,
    pub enclave_key: Pubkey,
    pub enclave_measurement: [u8; 32],
    pub expiry_slot: u64,
}

#[event]
pub struct SortieExecuted {
    pub vault: Pubkey,
    pub nonce: u64,
    pub policy_version: u32,
    pub mint_in: Pubkey,
    pub mint_out: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    /// What the intent demanded.
    pub min_amount_out: u64,
    /// What the oracle said was honest. `amount_out` against these two is the
    /// vault's realised execution quality, published without any strategy leak.
    pub oracle_expected_out: u64,
    pub notional_micro_usd: u64,
    pub sortie_index: u8,
    pub sortie_count: u8,
    pub vrf_commitment: [u8; 32],
    pub slot: u64,
}

#[event]
pub struct DrawbridgeMoved {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    /// True for a deposit, false for a withdrawal.
    pub inbound: bool,
}

#[event]
pub struct PauseToggled {
    pub vault: Pubkey,
    pub paused: bool,
    pub by: Pubkey,
}
