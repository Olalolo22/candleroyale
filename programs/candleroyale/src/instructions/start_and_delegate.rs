use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::{ARENA_SEED, PINNED_ER_VALIDATOR, SEAT_SEED};
use crate::errors::CandleRoyaleError;
use crate::state::{Arena, ArenaStatus};

#[delegate]
#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct StartAndDelegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Verified via PDA derivation and manual Arena deserialization prior to delegation CPI.
    /// Must be UncheckedAccount so Anchor does not attempt to re-serialize after DLP takes ownership.
    #[account(mut, del)]
    pub arena: UncheckedAccount<'info>,
}

pub fn handle_start_and_delegate(ctx: Context<StartAndDelegate>, room_id: u64) -> Result<()> {
    let room_id_bytes = room_id.to_le_bytes();
    let (expected_pda, _) =
        Pubkey::find_program_address(&[ARENA_SEED, room_id_bytes.as_ref()], &crate::ID);
    require_keys_eq!(
        ctx.accounts.arena.key(),
        expected_pda,
        CandleRoyaleError::InvalidArenaAccount
    );

    // Deserialize in a tight scope so the borrow drops before the delegation CPI.
    {
        require_keys_eq!(
            *ctx.accounts.arena.owner,
            crate::ID,
            CandleRoyaleError::InvalidArenaAccount
        );
        let mut data = ctx.accounts.arena.try_borrow_mut_data()?;
        let mut arena_data = Arena::try_deserialize(&mut &data[..])
            .map_err(|_| error!(CandleRoyaleError::InvalidArenaAccount))?;

        require!(
            arena_data.room_id == room_id,
            CandleRoyaleError::InvalidArenaAccount
        );
        require!(
            arena_data.status == ArenaStatus::Lobby,
            CandleRoyaleError::RoomNotInLobby
        );
        require!(
            arena_data.player_count >= 1,
            CandleRoyaleError::PlayerNotFound
        );

        // Only the room creator can lock the lobby and delegate the arena to ER.
        require_keys_eq!(
            ctx.accounts.payer.key(),
            arena_data.creator,
            CandleRoyaleError::UnauthorizedSigner
        );

        // Dark pit: every seated player's private position account must already sit on the
        // TEE ER. remaining_accounts = [seat_0, .., seat_{n-1}]. Without this check a player
        // could join without delegating their seat, and `finish_round` could never settle.
        let count = arena_data.player_count as usize;
        require!(
            ctx.remaining_accounts.len() == count,
            CandleRoyaleError::MissingSeatAccounts
        );
        for (idx, seat_info) in ctx.remaining_accounts.iter().enumerate() {
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
                ephemeral_rollups_sdk::id(),
                CandleRoyaleError::InvalidSeatAccount
            );
        }

        // Restart the stale-lobby clock at delegation. `abort_stale_room` measures from
        // `created_at`, so without this reset any room that waited longer than
        // STALE_LOBBY_TIMEOUT_SECS in the L1 lobby (normal while waiting for friends)
        // could be aborted by anyone the instant it reached the rollup.
        arena_data.created_at = Clock::get()?.unix_timestamp;
        arena_data
            .try_serialize(&mut &mut data[..])
            .map_err(|_| error!(CandleRoyaleError::InvalidArenaAccount))?;
    }

    // Always pin delegation to the protocol-enforced MagicBlock ER validator.
    ctx.accounts.delegate_arena(
        &ctx.accounts.payer,
        &[ARENA_SEED, room_id_bytes.as_ref()],
        DelegateConfig {
            validator: Some(PINNED_ER_VALIDATOR),
            ..Default::default()
        },
    )?;

    emit!(ArenaDelegated {
        room_id,
        arena: ctx.accounts.arena.key(),
        validator: PINNED_ER_VALIDATOR,
    });

    Ok(())
}

#[event]
pub struct ArenaDelegated {
    pub room_id: u64,
    pub arena: Pubkey,
    pub validator: Pubkey,
}
