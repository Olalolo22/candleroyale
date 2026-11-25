use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::constants::{ARENA_SEED, SEAT_SEED, SETTLE_GRACE_SECS};
use crate::errors::CandleRoyaleError;
use crate::oracle::read_er_price;
use crate::state::{compute_pnl_delta, Arena, ArenaStatus, SeatPosition};

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

    /// CHECK: Verified inside read_er_price when within the post-expiry grace window.
    pub price_feed: UncheckedAccount<'info>,
}

/// Selects the deterministic closing price:
/// - Within `ends_at..=ends_at + SETTLE_GRACE_SECS` (and oracle publish_time within grace): live oracle tick.
/// - Past the grace window: frozen `last_price` so delayed callers cannot shop for a favorable close price.
pub fn resolve_closing_price(
    now: i64,
    ends_at: i64,
    last_price: i64,
    oracle_tick: Option<(i64, i64)>,
) -> Result<i64> {
    let grace_deadline = ends_at
        .checked_add(SETTLE_GRACE_SECS)
        .ok_or(CandleRoyaleError::MathOverflow)?;

    if now <= grace_deadline {
        if let Some((price, publish_time)) = oracle_tick {
            if price > 0 && publish_time <= grace_deadline {
                return Ok(price);
            }
        }
    }

    require!(last_price > 0, CandleRoyaleError::StaleOrInvalidPrice);
    Ok(last_price)
}

pub fn handle_finish_round<'info>(
    ctx: Context<'_, '_, 'info, 'info, FinishRound<'info>>,
    room_id: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let (winner_wallet, winner_pnl, final_price, first_winner_idx, winner_mask) = {
        let arena = &mut ctx.accounts.arena;
        require!(
            arena.status == ArenaStatus::Live,
            CandleRoyaleError::RoomNotLive
        );
        require!(now >= arena.ends_at, CandleRoyaleError::RoundStillActive);

        let grace_deadline = arena
            .ends_at
            .checked_add(SETTLE_GRACE_SECS)
            .ok_or(CandleRoyaleError::MathOverflow)?;

        let oracle_tick = if now <= grace_deadline {
            let t = read_er_price(
                &ctx.accounts.price_feed.to_account_info(),
                &arena.price_feed,
                now,
            )?;
            Some((t.price, t.publish_time))
        } else {
            None
        };

        let closing_price =
            resolve_closing_price(now, arena.ends_at, arena.last_price, oracle_tick)?;

        let count = arena.player_count as usize;
        let mut best_pnl: i64 = i64::MIN;

        // The reveal: remaining_accounts = [seat_0, .., seat_{n-1}] (the sealed positions).
        // Each open position closes at the closing price into realized_pnl, and the position
        // held at the buzzer is written into the public scoreboard so everyone can see it.
        require!(
            ctx.remaining_accounts.len() == count,
            CandleRoyaleError::MissingSeatAccounts
        );
        let room_id_bytes = room_id.to_le_bytes();
        for idx in 0..count {
            let seat_info = &ctx.remaining_accounts[idx];
            let (seat_pda, _) = Pubkey::find_program_address(
                &[SEAT_SEED, room_id_bytes.as_ref(), &(idx as u8).to_le_bytes()],
                &crate::ID,
            );
            require_keys_eq!(
                seat_info.key(),
                seat_pda,
                CandleRoyaleError::InvalidSeatAccount
            );
            require_keys_eq!(
                *seat_info.owner,
                crate::ID,
                CandleRoyaleError::InvalidSeatAccount
            );
            let sealed = {
                let data = seat_info.try_borrow_data()?;
                SeatPosition::try_deserialize(&mut &data[..])
                    .map_err(|_| error!(CandleRoyaleError::InvalidSeatAccount))?
            };
            require!(
                sealed.room_id == room_id && sealed.seat_index as usize == idx,
                CandleRoyaleError::InvalidSeatAccount
            );

            let seat = &mut arena.players[idx];
            let delta = compute_pnl_delta(sealed.position, sealed.entry_price, closing_price)?;
            seat.realized_pnl = seat
                .realized_pnl
                .checked_add(delta)
                .ok_or(CandleRoyaleError::MathOverflow)?;
            // Revealed: the position (and its entry) held at the buzzer, now closed.
            seat.position = sealed.position;
            seat.entry_price = sealed.entry_price;

            if idx == 0 || seat.realized_pnl > best_pnl {
                best_pnl = seat.realized_pnl;
            }
        }

        // Build exact tie bitmask across all seats tied at best_pnl (no tap-count or seat-0 bias).
        let mut mask: u8 = 0;
        let mut first_idx: usize = 0;
        let mut found_first = false;
        for idx in 0..count {
            if arena.players[idx].realized_pnl == best_pnl {
                mask |= 1u8 << idx;
                if !found_first {
                    first_idx = idx;
                    found_first = true;
                }
            }
        }

        arena.status = ArenaStatus::Finished;
        arena.last_price = closing_price;
        arena.winner_index = first_idx as u8;
        arena.winner_mask = mask;

        (
            arena.players[first_idx].wallet,
            best_pnl,
            closing_price,
            first_idx as u8,
            mask,
        )
    };

    // Flush mutated Arena bytes BEFORE commit_and_undelegate so ER snapshots the final state.
    ctx.accounts.arena.exit(&crate::ID)?;

    // Commit & undelegate the scoreboard and every sealed seat back to Solana L1.
    let mut to_undelegate: Vec<AccountInfo> = Vec::with_capacity(1 + ctx.remaining_accounts.len());
    to_undelegate.push(ctx.accounts.arena.to_account_info());
    to_undelegate.extend(ctx.remaining_accounts.iter().cloned());

    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&to_undelegate)
    .build_and_invoke()?;

    emit!(RoundFinished {
        room_id,
        winner: winner_wallet,
        winner_index: first_winner_idx,
        winner_mask,
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
    pub winner_mask: u8,
    pub winner_pnl: i64,
    pub final_price: i64,
}
