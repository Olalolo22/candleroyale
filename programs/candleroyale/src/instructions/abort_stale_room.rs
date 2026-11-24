use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::constants::{ARENA_SEED, STALE_LOBBY_TIMEOUT_SECS};
use crate::errors::CandleRoyaleError;
use crate::state::{Arena, ArenaStatus};

#[commit]
#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct AbortStaleRoom<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [ARENA_SEED, &room_id.to_le_bytes()],
        bump = arena.bump,
    )]
    pub arena: Account<'info, Arena>,
}

/// Permissionless escape hatch on ER: if a delegated room stays in `Lobby` without starting
/// past `created_at + STALE_LOBBY_TIMEOUT_SECS`, anyone can abort it, undelegate back to L1,
/// and unlock full per-seat `entry_fee` refunds via `claim_payout`.
pub fn handle_abort_stale_room(ctx: Context<AbortStaleRoom>, room_id: u64) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    {
        let arena = &mut ctx.accounts.arena;
        require!(
            arena.status == ArenaStatus::Lobby,
            CandleRoyaleError::RoomNotInLobby
        );
        let timeout_at = arena
            .created_at
            .checked_add(STALE_LOBBY_TIMEOUT_SECS)
            .ok_or(CandleRoyaleError::MathOverflow)?;
        require!(now >= timeout_at, CandleRoyaleError::StaleTimeoutNotReached);

        arena.status = ArenaStatus::Aborted;
        arena.winner_mask = 0;
    }

    ctx.accounts.arena.exit(&crate::ID)?;

    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.arena.to_account_info()])
    .build_and_invoke()?;

    emit!(RoomAborted {
        room_id,
        aborted_at: now,
    });

    Ok(())
}

#[event]
pub struct RoomAborted {
    pub room_id: u64,
    pub aborted_at: i64,
}
