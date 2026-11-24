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

    /// CHECK: Verified strictly against `arena.players[seat_index].wallet`.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
}

/// Computes exact lamport payout for a seat under single-winner, multi-way tie, or aborted-room refund.
pub fn compute_seat_payout(
    status: ArenaStatus,
    total_pot: u64,
    entry_fee: u64,
    winner_mask: u8,
    winner_index: u8,
    seat_index: u8,
    player_count: u8,
) -> Result<u64> {
    require!(seat_index < player_count, CandleRoyaleError::PlayerNotFound);

    match status {
        ArenaStatus::Aborted => Ok(entry_fee),
        ArenaStatus::Finished => {
            let bit = 1u8 << seat_index;
            require!(
                (winner_mask & bit) != 0,
                CandleRoyaleError::SeatNotWinner
            );
            let tie_count = winner_mask.count_ones() as u64;
            require!(tie_count > 0, CandleRoyaleError::PlayerNotFound);
            let base_share = total_pot / tie_count;
            let remainder = total_pot % tie_count;
            // Assign any 1–5 lamport integer-division dust to the lowest tied winner index.
            let extra = if seat_index == winner_index {
                remainder
            } else {
                0
            };
            base_share
                .checked_add(extra)
                .ok_or_else(|| error!(CandleRoyaleError::MathOverflow))
        }
        _ => err!(CandleRoyaleError::RoomNotFinished),
    }
}

pub fn handle_claim_payout(
    ctx: Context<ClaimPayout>,
    room_id: u64,
    seat_index: u8,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let arena = &ctx.accounts.arena;

    require!(!vault.cancelled, CandleRoyaleError::AlreadyClaimed);
    require!(
        arena.status == ArenaStatus::Finished || arena.status == ArenaStatus::Aborted,
        CandleRoyaleError::RoomNotFinished
    );
    require!(
        seat_index < arena.player_count,
        CandleRoyaleError::PlayerNotFound
    );

    let seat_bit = 1u8 << seat_index;
    require!(
        (vault.claimed_mask & seat_bit) == 0,
        CandleRoyaleError::AlreadyClaimed
    );

    let target_seat = arena.players[seat_index as usize];
    require_keys_eq!(
        ctx.accounts.recipient.key(),
        target_seat.wallet,
        CandleRoyaleError::WinnerMismatch
    );

    let payout = compute_seat_payout(
        arena.status,
        vault.total_pot,
        vault.entry_fee,
        arena.winner_mask,
        arena.winner_index,
        seat_index,
        arena.player_count,
    )?;

    // Mark claimed BEFORE moving lamports.
    vault.claimed_mask |= seat_bit;
    let required_mask: u8 = if arena.status == ArenaStatus::Aborted {
        ((1u16 << arena.player_count) - 1) as u8
    } else {
        arena.winner_mask
    };
    if (vault.claimed_mask & required_mask) == required_mask {
        vault.claimed = true;
    }

    if payout > 0 {
        let vault_info = vault.to_account_info();
        let recipient_info = ctx.accounts.recipient.to_account_info();
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(payout)
            .ok_or(CandleRoyaleError::MathOverflow)?;
        **recipient_info.try_borrow_mut_lamports()? = recipient_info
            .lamports()
            .checked_add(payout)
            .ok_or(CandleRoyaleError::MathOverflow)?;
    }

    emit!(PayoutClaimed {
        room_id,
        recipient: target_seat.wallet,
        seat_index,
        amount_lamports: payout,
        realized_pnl: target_seat.realized_pnl,
        is_refund: arena.status == ArenaStatus::Aborted,
    });

    Ok(())
}

#[event]
pub struct PayoutClaimed {
    pub room_id: u64,
    pub recipient: Pubkey,
    pub seat_index: u8,
    pub amount_lamports: u64,
    pub realized_pnl: i64,
    pub is_refund: bool,
}
