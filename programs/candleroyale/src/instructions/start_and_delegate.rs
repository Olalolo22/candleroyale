use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::ARENA_SEED;
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

        let payer_key = ctx.accounts.payer.key();
        let count = arena_data.player_count as usize;
        let is_authorized = payer_key == arena_data.creator
            || arena_data
                .players
                .iter()
                .take(count)
                .any(|s| s.wallet == payer_key || s.session_key == payer_key);
        require!(is_authorized, CandleRoyaleError::UnauthorizedSigner);
    }

    let validator = ctx.remaining_accounts.first().map(|acc| acc.key());
    ctx.accounts.delegate_arena(
        &ctx.accounts.payer,
        &[ARENA_SEED, room_id_bytes.as_ref()],
        DelegateConfig {
            validator,
            ..Default::default()
        },
    )?;

    emit!(ArenaDelegated {
        room_id,
        arena: ctx.accounts.arena.key(),
        validator: validator.unwrap_or_default(),
    });

    Ok(())
}

#[event]
pub struct ArenaDelegated {
    pub room_id: u64,
    pub arena: Pubkey,
    pub validator: Pubkey,
}
