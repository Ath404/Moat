//! The portcullis: the one instruction that can move vault funds into a trade.
//!
//! Ordering matters here and is not cosmetic:
//!
//! 1. decode the intent and bind it to *this* vault;
//! 2. prove the registered enclave signed exactly these bytes;
//! 3. bind the supplied token accounts and price feeds to the mints named in
//!    the intent, so the checks below cannot be run against the wrong market;
//! 4. re-derive every numeric bound in `moat-core`;
//! 5. snapshot balances, hand off to the venue, and re-check the balances.
//!
//! Step 4 already refuses anything that would break policy. Step 5 exists
//! because the venue is a program, not a promise: the floor is only meaningful
//! if the realised fill is measured afterwards.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_interface::{Mint, TokenAccount};
use moat_core::TradeIntent;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::errors::{deny, MoatError};
use crate::events::SortieExecuted;
use crate::oracle::read_quote;
use crate::signet::{verify_enclave_signature, INSTRUCTIONS_SYSVAR_ID};
use crate::state::{Vault, VAULT_SEED};

/// Note the `Box`es. A BPF stack frame is 4KB and `Vault` alone is 878 bytes;
/// deserialising it inline alongside two Pyth updates and two token accounts
/// overflows the frame by ~384 bytes, which `cargo-build-sbf` reports as
/// undefined behaviour rather than a hard error. Boxing moves the large
/// deserialised accounts to the heap. This is invisible on a host `cargo check`
/// — it only shows up in a real SBF build.
#[derive(Accounts)]
pub struct ExecuteSortie<'info> {
    #[account(mut, seeds = [VAULT_SEED, vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    /// Anyone may relay a sortie. Authority comes from the enclave signature and
    /// every bound is re-derived on-chain, so the relayer is untrusted by
    /// construction — which is what lets the keep sign a plan and go quiet
    /// instead of holding a hot key on a server that must stay reachable.
    pub relayer: Signer<'info>,

    /// The vault's canonical associated token accounts — pinned by derivation,
    /// not merely by ownership.
    ///
    /// `token::authority = vault` alone is not enough and the gap is fatal:
    /// anyone can create an SPL token account whose *owner field* is the vault
    /// PDA (`InitializeAccount3` needs the new account's keypair, never the
    /// vault's signature). A relayer could therefore hand us two empty accounts
    /// to measure while the route below drained the real one, and every
    /// post-condition would pass against a delta of zero.
    #[account(
        mut,
        associated_token::mint = mint_in,
        associated_token::authority = vault,
    )]
    pub vault_in: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = mint_out,
        associated_token::authority = vault,
    )]
    pub vault_out: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Checked against the intent in the handler. Present here so the two token
    /// accounts above can be pinned by ATA derivation.
    pub mint_in: Box<InterfaceAccount<'info, Mint>>,
    pub mint_out: Box<InterfaceAccount<'info, Mint>>,

    /// Pyth update for `mint_in`. Bound to the mint's feed id in `read_quote`.
    pub price_in: Box<Account<'info, PriceUpdateV2>>,
    /// Pyth update for `mint_out`.
    pub price_out: Box<Account<'info, PriceUpdateV2>>,

    /// CHECK: matched against `intent.venue`, which the kernel checks against
    /// the policy allowlist. Invoked, never read.
    pub venue: UncheckedAccount<'info>,

    /// CHECK: address-constrained; read only by the instruction-introspection
    /// helpers in `signet`.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// `intent_bytes` is the canonical encoding the enclave signed; `route_data` is
/// the venue's own instruction data (a Jupiter route, typically built by the
/// relayer from a quote). Remaining accounts are forwarded to the venue.
pub fn handle_execute_sortie<'info>(
    ctx: Context<'info, ExecuteSortie<'info>>,
    intent_bytes: Vec<u8>,
    route_data: Vec<u8>,
) -> Result<()> {
    let intent =
        TradeIntent::from_signing_bytes(&intent_bytes).map_err(|_| error!(MoatError::MalformedIntent))?;

    let vault_key = ctx.accounts.vault.key();
    require!(intent.vault == vault_key.to_bytes(), MoatError::WrongVault);
    require!(!route_data.is_empty(), MoatError::EmptyRoute);

    let clock = Clock::get()?;

    // --- 2. the signature ---------------------------------------------------
    let (enclave_key, enclave_expiry, owner, bump) = {
        let v = &ctx.accounts.vault;
        (v.enclave_key, v.enclave_expiry_slot, v.owner, v.bump)
    };
    require_keys_neq!(enclave_key, Pubkey::default(), MoatError::NoEnclaveRegistered);
    require!(clock.slot <= enclave_expiry, MoatError::EnclaveRegistrationExpired);

    // Verify against the *re-encoded* intent, not the caller's bytes. They are
    // identical for a well-formed caller, and re-encoding removes any question
    // of a second byte string that decodes to the same intent.
    verify_enclave_signature(
        &ctx.accounts.instructions.to_account_info(),
        &enclave_key,
        &intent.signing_bytes(),
    )?;

    // --- 3. bind accounts to the mints the intent names ---------------------
    require!(
        ctx.accounts.vault_in.mint.to_bytes() == intent.mint_in,
        MoatError::TokenAccountMintMismatch
    );
    require!(
        ctx.accounts.vault_out.mint.to_bytes() == intent.mint_out,
        MoatError::TokenAccountMintMismatch
    );
    require!(ctx.accounts.venue.key().to_bytes() == intent.venue, MoatError::VenueAccountMismatch);

    let (rule_in, rule_out, policy, runtime) = {
        let v = &ctx.accounts.vault;
        let rule_in = *v
            .rule_for(&Pubkey::new_from_array(intent.mint_in))
            .ok_or(MoatError::MintNotAllowed)?;
        let rule_out = *v
            .rule_for(&Pubkey::new_from_array(intent.mint_out))
            .ok_or(MoatError::MintNotAllowed)?;
        (rule_in, rule_out, v.core_policy(), v.core_runtime())
    };

    let live_in = read_quote(&ctx.accounts.price_in, &rule_in)?;
    let live_out = read_quote(&ctx.accounts.price_out, &rule_out)?;

    // --- 4. the kernel ------------------------------------------------------
    let approval = moat_core::check_intent(
        &intent,
        &policy,
        &runtime,
        clock.slot,
        clock.unix_timestamp,
        &live_in,
        &live_out,
    )
    .map_err(deny)?;

    // --- 5. execute, bracketed by balance checks ----------------------------
    let in_before = ctx.accounts.vault_in.amount;
    let out_before = ctx.accounts.vault_out.amount;
    let lamports_before = ctx.accounts.vault.to_account_info().lamports();

    // The vault PDA signs an instruction it does not itself construct. The
    // allowlist is what bounds that: `intent.venue` has been checked against
    // policy, so the owner has explicitly named every program allowed to be
    // invoked this way. The balance assertions below bound the damage to the
    // two token accounts we measure — they do not, and cannot, constrain what
    // an allowlisted program does with accounts we were not handed. Keep the
    // venue list short and keep it to programs you would deposit into.
    // Pinning the two measured accounts is necessary but not sufficient: the
    // vault may own *other* token accounts, and the route is free to name one as
    // its source. Since the PDA is promoted to signer below, such an account is
    // a second door into the vault that the balance bracket does not watch. The
    // only vault-owned token accounts allowed through are the two we measure.
    for acc in ctx.remaining_accounts.iter() {
        if *acc.owner != anchor_spl::token::ID && *acc.owner != anchor_spl::token_2022::ID {
            continue;
        }
        let data = acc.try_borrow_data()?;
        // SPL token accounts are exactly 165 bytes; a Token-2022 account is
        // longer and carries account-type 2 at offset 165. Mints are neither.
        let is_token_account = data.len() == 165 || (data.len() > 165 && data[165] == 2);
        if !is_token_account {
            continue;
        }
        if &data[32..64] == vault_key.as_ref() {
            let key = acc.key();
            require!(
                key == ctx.accounts.vault_in.key() || key == ctx.accounts.vault_out.key(),
                MoatError::UnexpectedVaultTokenAccount
            );
        }
    }

    let metas: Vec<AccountMeta> = ctx
        .remaining_accounts
        .iter()
        .map(|acc| AccountMeta {
            pubkey: acc.key(),
            is_signer: acc.is_signer || acc.key() == vault_key,
            is_writable: acc.is_writable,
        })
        .collect();

    let bump_seed = [bump];
    let signer_seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &bump_seed];

    let mut infos = ctx.remaining_accounts.to_vec();
    infos.push(ctx.accounts.vault.to_account_info());

    invoke_signed(
        &Instruction { program_id: ctx.accounts.venue.key(), accounts: metas, data: route_data },
        &infos,
        &[signer_seeds],
    )?;

    ctx.accounts.vault_in.reload()?;
    ctx.accounts.vault_out.reload()?;

    // Received at least what the intent demanded — and the intent's floor has
    // itself already been checked against the oracle, so this is the second of
    // two independent bounds on the fill price.
    let received = ctx
        .accounts
        .vault_out
        .amount
        .checked_sub(out_before)
        .ok_or(MoatError::OutputBelowMinimum)?;
    require!(received >= intent.min_amount_out, MoatError::OutputBelowMinimum);
    // A policy may legally set max_slippage_bps to its ceiling, which drives
    // floor_out — and therefore a well-formed min_amount_out — to zero. Without
    // this, a zero-output swap would satisfy the line above.
    require!(received > 0, MoatError::OutputBelowMinimum);

    // Spent *exactly* what was authorised, not merely no more.
    //
    // `<=` was the bug: a measured account the route never touched has a delta
    // of zero, which satisfies any upper bound. Equality forces the account we
    // priced, capped and floored to be the account the swap actually drained.
    // Jupiter exact-in routes consume the full input, so this costs nothing in
    // practice and a route that would underspend is one worth rejecting.
    let spent = in_before
        .checked_sub(ctx.accounts.vault_in.amount)
        .ok_or(MoatError::OverspentInput)?;
    require!(spent == intent.amount_in, MoatError::InputNotSpentExactly);

    // And did not quietly drain the PDA's lamports on the way through.
    require!(
        ctx.accounts.vault.to_account_info().lamports() >= lamports_before,
        MoatError::OverspentInput
    );

    ctx.accounts.vault.commit_runtime(approval.next);

    emit!(SortieExecuted {
        vault: vault_key,
        nonce: intent.nonce,
        policy_version: intent.policy_version,
        mint_in: Pubkey::new_from_array(intent.mint_in),
        mint_out: Pubkey::new_from_array(intent.mint_out),
        amount_in: spent,
        amount_out: received,
        min_amount_out: intent.min_amount_out,
        oracle_expected_out: approval.expected_out,
        notional_micro_usd: approval.notional_micro_usd,
        sortie_index: intent.sortie_index,
        sortie_count: intent.sortie_count,
        vrf_commitment: intent.vrf_commitment,
        slot: clock.slot,
    });

    Ok(())
}
