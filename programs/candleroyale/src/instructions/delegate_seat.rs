use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::{PINNED_ER_VALIDATOR, SEAT_SEED};
use crate::errors::CandleRoyaleError;
use crate::state::SeatPosition;

/// L1: Delegate a player's private seat account to the pinned MagicBlock Private ER (TEE).
/// Sent in the same transaction as `create_room` / `join_room`, so a seat can never be
/// left undelegated (and `start_and_delegate` re-checks every seat before the room starts).
#[delegate]
#[derive(Accounts)]
#[instruction(room_id: u64, seat_index: u8)]
pub struct DelegateSeat<'info> {
    /// The seat's own wallet.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Verified via PDA derivation and manual SeatPosition deserialization prior to the
    /// delegation CPI. UncheckedAccount so Anchor does not re-serialize after DLP takes ownership.
    #[account(mut, del)]
    pub seat: UncheckedAccount<'info>,
}

pub fn handle_delegate_seat(ctx: Context<DelegateSeat>, room_id: u64, seat_index: u8) -> Result<()> {
    let room_id_bytes = room_id.to_le_bytes();
    let seat_index_bytes = seat_index.to_le_bytes();
    let (expected_pda, _) = Pubkey::find_program_address(
        &[SEAT_SEED, room_id_bytes.as_ref(), seat_index_bytes.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(
        ctx.accounts.seat.key(),
        expected_pda,
        CandleRoyaleError::InvalidSeatAccount
    );

    {
        require_keys_eq!(
            *ctx.accounts.seat.owner,
            crate::ID,
            CandleRoyaleError::InvalidSeatAccount
        );
        let data = ctx.accounts.seat.try_borrow_data()?;
        let seat = SeatPosition::try_deserialize(&mut &data[..])
            .map_err(|_| error!(CandleRoyaleError::InvalidSeatAccount))?;
        require!(
            seat.room_id == room_id && seat.seat_index == seat_index,
            CandleRoyaleError::InvalidSeatAccount
        );
        require_keys_eq!(
            ctx.accounts.payer.key(),
            seat.wallet,
            CandleRoyaleError::UnauthorizedSigner
        );
    }

    ctx.accounts.delegate_seat(
        &ctx.accounts.payer,
        &[SEAT_SEED, room_id_bytes.as_ref(), seat_index_bytes.as_ref()],
        DelegateConfig {
            validator: Some(PINNED_ER_VALIDATOR),
            ..Default::default()
        },
    )?;

    emit!(SeatDelegated {
        room_id,
        seat_index,
        seat: ctx.accounts.seat.key(),
    });

    Ok(())
}

#[event]
pub struct SeatDelegated {
    pub room_id: u64,
    pub seat_index: u8,
    pub seat: Pubkey,
}
