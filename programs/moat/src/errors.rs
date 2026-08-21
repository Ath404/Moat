//! Errors, and the mapping from a [`moat_core::Denial`] onto one.
//!
//! Every denial keeps its own code. Collapsing them into one `Unauthorized`
//! saves a few lines and costs an operator an hour at 3am working out whether
//! the vault refused a trade because the oracle was stale or because someone is
//! replaying intents at it.

use anchor_lang::prelude::*;
use moat_core::Denial;

#[error_code]
pub enum MoatError {
    #[msg("vault is paused")]
    Paused,
    #[msg("intent was signed against a superseded policy version")]
    PolicyVersionMismatch,
    #[msg("nonce is not the next expected nonce")]
    NonceMismatch,
    #[msg("intent has expired")]
    IntentExpired,
    #[msg("intent validity window exceeds policy")]
    IntentLifetimeTooLong,
    #[msg("amount must be non-zero")]
    ZeroAmount,
    #[msg("input and output mint are the same")]
    SameMint,
    #[msg("sortie index outside the plan")]
    SortieOutOfRange,
    #[msg("mint is not on the vault allowlist")]
    MintNotAllowed,
    #[msg("venue is not on the vault allowlist")]
    VenueNotAllowed,
    #[msg("requested slippage exceeds policy")]
    SlippageAbovePolicy,
    #[msg("oracle price is stale")]
    OracleStale,
    #[msg("oracle confidence interval is too wide to price against")]
    OracleTooUncertain,
    #[msg("enclave quoted a price that disagrees with the live feed")]
    QuoteDrift,
    #[msg("oracle exponent or decimals changed since the intent was signed")]
    QuoteShapeMismatch,
    #[msg("trade exceeds the per-intent notional cap")]
    TradeTooLarge,
    #[msg("trade would exceed the rolling daily notional cap")]
    DailyCapExceeded,
    #[msg("cooldown has not elapsed")]
    CooldownActive,
    #[msg("min_amount_out is below the oracle-derived floor")]
    SlippageFloorBreached,
    #[msg("arithmetic overflow")]
    MathOverflow,

    // --- account / signature validation ---------------------------------
    #[msg("intent bytes are not a valid canonical TradeIntent")]
    MalformedIntent,
    #[msg("intent names a different vault")]
    WrongVault,
    #[msg("venue route data is empty")]
    EmptyRoute,
    #[msg("no Ed25519 instruction in this transaction signs this intent")]
    MissingEnclaveSignature,
    #[msg("Ed25519 instruction is malformed")]
    MalformedEd25519Instruction,
    #[msg("Ed25519 instruction does not sign this intent")]
    SignedMessageMismatch,
    #[msg("Ed25519 instruction was not signed by the registered enclave key")]
    WrongEnclaveKey,
    #[msg("enclave attestation registration has expired")]
    EnclaveRegistrationExpired,
    #[msg("no enclave key is registered")]
    NoEnclaveRegistered,
    #[msg("price account does not match the feed bound to this mint")]
    WrongPriceFeed,
    #[msg("oracle reported a non-positive price")]
    InvalidOraclePrice,
    #[msg("token account mint does not match the intent")]
    TokenAccountMintMismatch,
    #[msg("vault did not receive at least min_amount_out")]
    OutputBelowMinimum,
    #[msg("venue spent more than the intent authorised")]
    OverspentInput,
    #[msg("the input account was not debited by exactly amount_in")]
    InputNotSpentExactly,
    #[msg("route names a vault-owned token account that is not the measured input or output")]
    UnexpectedVaultTokenAccount,
    #[msg("venue account does not match the intent")]
    VenueAccountMismatch,
    #[msg("allowlist cannot be empty")]
    EmptyAllowlist,
    #[msg("allowlist exceeds the maximum length")]
    AllowlistTooLong,
    #[msg("policy parameters are inconsistent")]
    InvalidPolicy,
    #[msg("only the owner may perform this action")]
    NotOwner,
    #[msg("only the owner or guardian may perform this action")]
    NotGuardian,
    #[msg("vault must be paused before an emergency exit")]
    NotPaused,
}

impl From<Denial> for MoatError {
    fn from(d: Denial) -> Self {
        // The payloads are logged by the caller rather than encoded here:
        // Anchor error codes carry no data, and a log line is what an operator
        // actually reads.
        match d {
            Denial::Paused => MoatError::Paused,
            Denial::PolicyVersionMismatch { .. } => MoatError::PolicyVersionMismatch,
            Denial::NonceMismatch { .. } => MoatError::NonceMismatch,
            Denial::Expired { .. } => MoatError::IntentExpired,
            Denial::LifetimeTooLong => MoatError::IntentLifetimeTooLong,
            Denial::ZeroAmount => MoatError::ZeroAmount,
            Denial::SameMint => MoatError::SameMint,
            Denial::SortieOutOfRange => MoatError::SortieOutOfRange,
            Denial::MintNotAllowed => MoatError::MintNotAllowed,
            Denial::VenueNotAllowed => MoatError::VenueNotAllowed,
            Denial::SlippageAbovePolicy => MoatError::SlippageAbovePolicy,
            Denial::OracleStale => MoatError::OracleStale,
            Denial::OracleTooUncertain => MoatError::OracleTooUncertain,
            Denial::QuoteDrift => MoatError::QuoteDrift,
            Denial::QuoteShapeMismatch => MoatError::QuoteShapeMismatch,
            Denial::TradeTooLarge { .. } => MoatError::TradeTooLarge,
            Denial::DailyCapExceeded { .. } => MoatError::DailyCapExceeded,
            Denial::CooldownActive { .. } => MoatError::CooldownActive,
            Denial::SlippageFloorBreached { .. } => MoatError::SlippageFloorBreached,
            Denial::MathOverflow => MoatError::MathOverflow,
        }
    }
}

/// Log the detail a denial carries, then convert. Anchor error codes are bare
/// u32s, so the numbers that make a refusal diagnosable have to go to the log.
pub fn deny(d: Denial) -> Error {
    match d {
        Denial::PolicyVersionMismatch { expected, got } => {
            msg!("moat: policy version {} expected, intent carried {}", expected, got)
        }
        Denial::NonceMismatch { expected, got } => {
            msg!("moat: nonce {} expected, intent carried {}", expected, got)
        }
        Denial::Expired { slot, expiry } => msg!("moat: slot {} past expiry {}", slot, expiry),
        Denial::TradeTooLarge { notional, cap } => {
            msg!("moat: notional {} over cap {} (micro-USD)", notional, cap)
        }
        Denial::DailyCapExceeded { would_be, cap } => {
            msg!("moat: day total would reach {} over cap {} (micro-USD)", would_be, cap)
        }
        Denial::CooldownActive { earliest } => msg!("moat: cooldown until slot {}", earliest),
        Denial::SlippageFloorBreached { min_out, floor } => {
            msg!("moat: min_out {} below oracle floor {}", min_out, floor)
        }
        _ => {}
    }
    Error::from(MoatError::from(d))
}
