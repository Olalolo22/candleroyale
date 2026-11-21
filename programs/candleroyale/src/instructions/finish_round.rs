use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::constants::{ARENA_SEED, POS_FLAT};
use crate::errors::CandleRoyaleError;
use crate::oracle::read_er_price;
use crate::state::{compute_pnl_delta, Arena, ArenaStatus};

#[commit]
#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct FinishRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [ARENA_SEED, &room_id.to_le_bytes()],
        bump = arena.bump,
    )]
    pub arena: Account<'info, Arena>,

    /// CHECK: Verified inside read_er_price against ORACLE_PROGRAM_ID and arena.price_feed.
    pub price_feed: UncheckedAccount<'info>,
}

pub fn handle_finish_round(ctx: Context<FinishRound>, room_id: u64) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let (winner_wallet, winner_pnl, final_price, winner_idx) = {
        let arena = &mut ctx.accounts.arena;
        require!(
            arena.status == ArenaStatus::Live,
            CandleRoyaleError::RoomNotLive
        );
        require!(now >= arena.ends_at, CandleRoyaleError::RoundStillActive);

        let tick = read_er_price(
            &ctx.accounts.price_feed.to_account_info(),
            &arena.price_feed,
            now,
        )?;

        let count = arena.player_count as usize;
        let mut best_idx: usize = 0;
        let mut best_pnl: i64 = i64::MIN;
        let mut best_taps: u32 = 0;

        for idx in 0..count {
            let seat = &mut arena.players[idx];
            let delta = compute_pnl_delta(seat.position, seat.entry_price, tick.price)?;
            seat.realized_pnl = seat
                .realized_pnl
                .checked_add(delta)
                .ok_or(CandleRoyaleError::MathOverflow)?;
            seat.position = POS_FLAT;
            seat.entry_price = 0;

            if idx == 0
                || seat.realized_pnl > best_pnl
                || (seat.realized_pnl == best_pnl && seat.tap_count > best_taps)
            {
                best_idx = idx;
                best_pnl = seat.realized_pnl;
                best_taps = seat.tap_count;
            }
        }

        arena.status = ArenaStatus::Finished;
        arena.last_price = tick.price;
        arena.winner_index = best_idx as u8;

        (
            arena.players[best_idx].wallet,
            best_pnl,
            tick.price,
            best_idx as u8,
        )
    };

    // Flush mutated Arena bytes BEFORE commit_and_undelegate so ER snapshots the final state.
    ctx.accounts.arena.exit(&crate::ID)?;

    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.arena.to_account_info()])
    .build_and_invoke()?;

    emit!(RoundFinished {
        room_id,
        winner: winner_wallet,
        winner_index: winner_idx,
        winner_pnl,
        final_price,
    });

    Ok(())
}

#[event]
pub struct RoundFinished {
    pub room_id: u64,
    pub winner: Pubkey,
    pub winner_index: u8,
    pub winner_pnl: i64,
    pub final_price: i64,
}
