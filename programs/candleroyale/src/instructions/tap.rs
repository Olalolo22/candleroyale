use anchor_lang::prelude::*;

use crate::constants::{ARENA_SEED, POS_FLAT, POS_LONG, POS_SHORT};
use crate::errors::CandleRoyaleError;
use crate::oracle::read_er_price;
use crate::state::{compute_pnl_delta, Arena, ArenaStatus};

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct Tap<'info> {
    /// Either the player's ephemeral session_key (0-popup gasless ER signing) or their wallet.
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

pub fn handle_tap(ctx: Context<Tap>, room_id: u64, new_position: i8) -> Result<()> {
    require!(
        new_position == POS_SHORT || new_position == POS_FLAT || new_position == POS_LONG,
        CandleRoyaleError::InvalidPosition
    );

    let arena = &mut ctx.accounts.arena;
    let signer_key = ctx.accounts.signer.key();
    let count = arena.player_count as usize;

    // Prioritize session_key lookup before wallet lookup (and join_room guarantees disjointness).
    let seat_idx = arena
        .players
        .iter()
        .take(count)
        .position(|s| s.session_key == signer_key)
        .or_else(|| {
            arena
                .players
                .iter()
                .take(count)
                .position(|s| s.wallet == signer_key)
        })
        .ok_or(CandleRoyaleError::UnauthorizedSigner)?;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let tick = read_er_price(
        &ctx.accounts.price_feed.to_account_info(),
        &arena.price_feed,
        now,
    )?;

    // Seamless UX: first tap inside ER automatically opens the countdown if not started yet.
    if arena.status == ArenaStatus::Lobby {
        arena.status = ArenaStatus::Live;
        arena.started_at = now;
        arena.ends_at = now
            .checked_add(arena.duration_secs)
            .ok_or(CandleRoyaleError::MathOverflow)?;
        arena.start_price = tick.price;
    }

    require!(
        arena.status == ArenaStatus::Live,
        CandleRoyaleError::RoomNotLive
    );
    require!(now <= arena.ends_at, CandleRoyaleError::RoundExpired);

    let seat = &mut arena.players[seat_idx];
    // Reject no-op trades (e.g., FLAT -> FLAT) so tap counts cannot be spammed.
    require!(
        new_position != seat.position,
        CandleRoyaleError::NoOpPositionChange
    );

    let delta = compute_pnl_delta(seat.position, seat.entry_price, tick.price)?;
    seat.realized_pnl = seat
        .realized_pnl
        .checked_add(delta)
        .ok_or(CandleRoyaleError::MathOverflow)?;

    seat.position = new_position;
    seat.entry_price = if new_position == POS_FLAT {
        0
    } else {
        tick.price
    };
    seat.tap_count = seat.tap_count.saturating_add(1);
    seat.last_tap_ts = now;

    let player_wallet = seat.wallet;
    let realized_pnl = seat.realized_pnl;
    let tap_count = seat.tap_count;

    arena.last_price = tick.price;

    emit!(TapExecuted {
        room_id,
        player: player_wallet,
        position: new_position,
        price: tick.price,
        pnl_delta: delta,
        realized_pnl,
        tap_count,
    });

    Ok(())
}

#[event]
pub struct TapExecuted {
    pub room_id: u64,
    pub player: Pubkey,
    pub position: i8,
    pub price: i64,
    pub pnl_delta: i64,
    pub realized_pnl: i64,
    pub tap_count: u32,
}
