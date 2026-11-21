use anchor_lang::prelude::*;

use crate::constants::ARENA_SEED;
use crate::errors::CandleRoyaleError;
use crate::oracle::read_er_price;
use crate::state::{Arena, ArenaStatus};

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct BeginRound<'info> {
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [ARENA_SEED, &room_id.to_le_bytes()],
        bump = arena.bump,
    )]
    pub arena: Account<'info, Arena>,

    /// CHECK: Verified inside read_er_price against ORACLE_PROGRAM_ID and arena.price_feed.
    pub price_feed: UncheckedAccount<'info>,
}

pub fn handle_begin_round(ctx: Context<BeginRound>, room_id: u64) -> Result<()> {
    let arena = &mut ctx.accounts.arena;
    require!(
        arena.status == ArenaStatus::Lobby,
        CandleRoyaleError::RoomNotInLobby
    );

    let signer_key = ctx.accounts.signer.key();
    let count = arena.player_count as usize;
    let is_authorized = signer_key == arena.creator
        || arena
            .players
            .iter()
            .take(count)
            .any(|s| s.wallet == signer_key || s.session_key == signer_key);
    require!(is_authorized, CandleRoyaleError::UnauthorizedSigner);

    let clock = Clock::get()?;
    let tick = read_er_price(
        &ctx.accounts.price_feed.to_account_info(),
        &arena.price_feed,
        clock.unix_timestamp,
    )?;

    arena.status = ArenaStatus::Live;
    arena.started_at = clock.unix_timestamp;
    arena.ends_at = clock
        .unix_timestamp
        .checked_add(arena.duration_secs)
        .ok_or(CandleRoyaleError::MathOverflow)?;
    arena.start_price = tick.price;
    arena.last_price = tick.price;

    emit!(RoundStarted {
        room_id,
        started_at: arena.started_at,
        ends_at: arena.ends_at,
        start_price: tick.price,
    });

    Ok(())
}

#[event]
pub struct RoundStarted {
    pub room_id: u64,
    pub started_at: i64,
    pub ends_at: i64,
    pub start_price: i64,
}
