use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::{ARENA_SEED, PINNED_ER_VALIDATOR};
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

    // Reject any caller attempt to substitute an unapproved or dead ER validator.
    if let Some(passed) = ctx.remaining_accounts.first() {
        require_keys_eq!(
            passed.key(),
            PINNED_ER_VALIDATOR,
            CandleRoyaleError::InvalidValidator
        );
    }

    // Deserialize in a tight scope so the immutable borrow drops before the delegation CPI.
    {
        require_keys_eq!(
            *ctx.accounts.arena.owner,
            crate::ID,
            CandleRoyaleError::InvalidArenaAccount
        );
        let data = ctx.accounts.arena.try_borrow_data()?;
        let arena_data = Arena::try_deserialize(&mut &data[..])
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
