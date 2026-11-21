use anchor_lang::prelude::*;

use crate::constants::{ARENA_SEED, VAULT_SEED};
use crate::errors::CandleRoyaleError;
use crate::state::{Arena, ArenaStatus, Vault};

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct ClaimPayout<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, &room_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    /// Anchor enforces arena.owner == crate::ID, proving ER undelegation settled on L1.
    #[account(
        seeds = [ARENA_SEED, &room_id.to_le_bytes()],
        bump = arena.bump,
    )]
    pub arena: Account<'info, Arena>,

    /// CHECK: Verified strictly against arena.players[arena.winner_index].wallet.
    #[account(mut)]
    pub winner: UncheckedAccount<'info>,
}

pub fn handle_claim_payout(ctx: Context<ClaimPayout>, room_id: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let arena = &ctx.accounts.arena;

    require!(
        arena.status == ArenaStatus::Finished,
        CandleRoyaleError::RoomNotFinished
    );
    require!(
        !vault.claimed && !vault.cancelled,
        CandleRoyaleError::AlreadyClaimed
    );
    require!(
        (arena.winner_index as usize) < (arena.player_count as usize),
        CandleRoyaleError::PlayerNotFound
    );

    let winning_seat = arena.players[arena.winner_index as usize];
    require_keys_eq!(
        ctx.accounts.winner.key(),
        winning_seat.wallet,
        CandleRoyaleError::WinnerMismatch
    );

    let payout = vault.total_pot;
    vault.claimed = true;

    if payout > 0 {
        let vault_info = vault.to_account_info();
        let winner_info = ctx.accounts.winner.to_account_info();
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(payout)
            .ok_or(CandleRoyaleError::MathOverflow)?;
        **winner_info.try_borrow_mut_lamports()? = winner_info
            .lamports()
            .checked_add(payout)
            .ok_or(CandleRoyaleError::MathOverflow)?;
    }

    emit!(PayoutClaimed {
        room_id,
        winner: winning_seat.wallet,
        amount_lamports: payout,
        winner_pnl: winning_seat.realized_pnl,
    });

    Ok(())
}

#[event]
pub struct PayoutClaimed {
    pub room_id: u64,
    pub winner: Pubkey,
    pub amount_lamports: u64,
    pub winner_pnl: i64,
}
