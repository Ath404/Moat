//! The drawbridge: the only way value crosses the perimeter.
//!
//! The rule that makes this vault non-custodial is here, and it is one line
//! long: **the owner can always withdraw, including while paused.** No policy
//! limit, no cooldown, no enclave involvement. Everything else in this program
//! constrains what the *strategy* may do; nothing constrains the owner's exit.
//! A vault that can trade while its owner cannot leave is a custodian with
//! extra steps.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::MoatError;
use crate::events::{DrawbridgeMoved, PauseToggled};
use crate::state::{Vault, VAULT_SEED};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(seeds = [VAULT_SEED, vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    /// Owner-only. A third party depositing into a vault whose owner may
    /// withdraw everything is making a gift, not an investment — better to
    /// refuse it than to imply otherwise.
    #[account(mut, address = vault.owner @ MoatError::NotOwner)]
    pub owner: Signer<'info>,

    #[account(mut, token::authority = owner, token::mint = mint)]
    pub from: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::authority = vault, token::mint = mint)]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, MoatError::ZeroAmount);

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.from.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault_token.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    emit!(DrawbridgeMoved {
        vault: ctx.accounts.vault.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        inbound: true,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(seeds = [VAULT_SEED, vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    #[account(mut, address = vault.owner @ MoatError::NotOwner)]
    pub owner: Signer<'info>,

    #[account(mut, token::authority = vault, token::mint = mint)]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub to: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Deliberately unconditional: no cap, no cooldown, and it works while paused.
/// Pausing stops the strategy, not the owner.
pub fn handle_withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, MoatError::ZeroAmount);

    let owner = ctx.accounts.vault.owner;
    let bump = [ctx.accounts.vault.bump];
    let signer_seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &bump];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    emit!(DrawbridgeMoved {
        vault: ctx.accounts.vault.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        inbound: false,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut, seeds = [VAULT_SEED, vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,
}

/// Anyone holding the guardian key may pause; only the owner may unpause.
///
/// The asymmetry is the whole value of a guardian. A watchtower that can stop a
/// misbehaving keep is useful; one that can also restart it is a second owner.
pub fn handle_set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let signer = ctx.accounts.authority.key();

    if paused {
        require!(signer == vault.owner || signer == vault.guardian, MoatError::NotGuardian);
    } else {
        require!(signer == vault.owner, MoatError::NotOwner);
    }

    vault.paused = paused;
    emit!(PauseToggled { vault: vault.key(), paused, by: signer });
    Ok(())
}
