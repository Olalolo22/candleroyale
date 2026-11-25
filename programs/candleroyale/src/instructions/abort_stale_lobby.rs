use anchor_lang::prelude::*;

use crate::constants::{ARENA_SEED, L1_LOBBY_TIMEOUT_SECS};
use crate::errors::CandleRoyaleError;
use crate::state::{Arena, ArenaStatus};

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct AbortStaleLobby<'info> {
    /// Any seated player's main wallet.
    pub signer: Signer<'info>,

    /// `Account<Arena>` enforces owner == crate::ID, so this only runs while the room
    /// is still on L1 (never delegated). Delegated rooms use `abort_stale_room` on ER.
    #[account(
        mut,
        seeds = [ARENA_SEED, &room_id.to_le_bytes()],
        bump = arena.bump,
    )]
    pub arena: Account<'info, Arena>,
}

/// L1 escape hatch: if the creator never starts a room that others have joined,
/// any seated player can abort it after L1_LOBBY_TIMEOUT_SECS. Every seat then
/// reclaims exactly its entry fee through `claim_payout`.
pub fn handle_abort_stale_lobby(ctx: Context<AbortStaleLobby>, room_id: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let arena = &mut ctx.accounts.arena;

    // `cancel_room` moves the arena to Finished, so Lobby also implies "not cancelled".
    require!(
        arena.status == ArenaStatus::Lobby,
        CandleRoyaleError::RoomNotInLobby
    );
    // A creator alone in the room should use `cancel_room` instead.
    require!(
        arena.player_count >= 2,
        CandleRoyaleError::PlayerNotFound
    );

    let signer_key = ctx.accounts.signer.key();
    let is_seated = arena
        .players
        .iter()
        .take(arena.player_count as usize)
        .any(|s| s.wallet == signer_key);
    require!(is_seated, CandleRoyaleError::UnauthorizedSigner);

    let timeout_at = arena
        .created_at
        .checked_add(L1_LOBBY_TIMEOUT_SECS)
        .ok_or(CandleRoyaleError::MathOverflow)?;
    require!(now >= timeout_at, CandleRoyaleError::StaleTimeoutNotReached);

    arena.status = ArenaStatus::Aborted;
    arena.winner_mask = 0;

    emit!(LobbyAborted {
        room_id,
        aborted_by: signer_key,
        aborted_at: now,
    });

    Ok(())
}

#[event]
pub struct LobbyAborted {
    pub room_id: u64,
    pub aborted_by: Pubkey,
    pub aborted_at: i64,
}
