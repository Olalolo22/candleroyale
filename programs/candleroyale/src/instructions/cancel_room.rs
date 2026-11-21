use anchor_lang::prelude::*;

use crate::constants::{ARENA_SEED, VAULT_SEED};
use crate::errors::CandleRoyaleError;
use crate::state::{Arena, ArenaStatus, Vault};

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct CancelRoom<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, &room_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [ARENA_SEED, &room_id.to_le_bytes()],
        bump = arena.bump,
    )]
    pub arena: Account<'info, Arena>,
}

pub fn handle_cancel_room(ctx: Context<CancelRoom>, room_id: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let arena = &mut ctx.accounts.arena;

    require_keys_eq!(
        ctx.accounts.creator.key(),
        vault.creator,
        CandleRoyaleError::UnauthorizedSigner
    );
    require!(
        arena.status == ArenaStatus::Lobby && !vault.cancelled && !vault.claimed,
        CandleRoyaleError::RoomNotInLobby
    );
    require!(
        arena.player_count == 1,
        CandleRoyaleError::CannotCancelWithOthers
    );

    let refund = vault.total_pot;
    vault.total_pot = 0;
    vault.cancelled = true;
    arena.status = ArenaStatus::Finished;

    if refund > 0 {
        let vault_info = vault.to_account_info();
        let creator_info = ctx.accounts.creator.to_account_info();
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(refund)
            .ok_or(CandleRoyaleError::MathOverflow)?;
        **creator_info.try_borrow_mut_lamports()? = creator_info
            .lamports()
            .checked_add(refund)
            .ok_or(CandleRoyaleError::MathOverflow)?;
    }

    emit!(RoomCancelled {
        room_id,
        creator: ctx.accounts.creator.key(),
        refund,
    });

    Ok(())
}

#[event]
pub struct RoomCancelled {
    pub room_id: u64,
    pub creator: Pubkey,
    pub refund: u64,
}
