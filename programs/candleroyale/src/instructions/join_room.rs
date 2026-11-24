use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::{ARENA_SEED, POS_FLAT, VAULT_SEED};
use crate::errors::CandleRoyaleError;
use crate::state::{Arena, ArenaStatus, PlayerSeat, Vault};

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct JoinRoom<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, &room_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [ARENA_SEED, &room_id.to_le_bytes()],
        bump = arena.bump,
    )]
    pub arena: Account<'info, Arena>,

    pub system_program: Program<'info, System>,
}

pub fn handle_join_room(
    ctx: Context<JoinRoom>,
    room_id: u64,
    session_key: Pubkey,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let arena = &mut ctx.accounts.arena;

    require!(
        arena.status == ArenaStatus::Lobby && !vault.cancelled,
        CandleRoyaleError::RoomNotInLobby
    );
    require!(
        arena.player_count < arena.max_players,
        CandleRoyaleError::RoomFull
    );
    require!(
        session_key != Pubkey::default(),
        CandleRoyaleError::SessionKeyCollision
    );

    let player_key = ctx.accounts.player.key();
    let count = arena.player_count as usize;
    // Enforce complete disjointness across wallets and session keys for all seats.
    for seat in arena.players.iter().take(count) {
        require!(seat.wallet != player_key, CandleRoyaleError::AlreadyJoined);
        require!(
            seat.session_key != player_key,
            CandleRoyaleError::SessionKeyCollision
        );
        require!(
            seat.wallet != session_key,
            CandleRoyaleError::SessionKeyCollision
        );
        require!(
            seat.session_key != session_key,
            CandleRoyaleError::SessionKeyCollision
        );
    }

    let entry_fee = vault.entry_fee;
    if entry_fee > 0 {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.player.to_account_info(),
                to: vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, entry_fee)?;
        vault.total_pot = vault
            .total_pot
            .checked_add(entry_fee)
            .ok_or(CandleRoyaleError::MathOverflow)?;
    }

    arena.players[count] = PlayerSeat {
        wallet: player_key,
        session_key,
        position: POS_FLAT,
        entry_price: 0,
        realized_pnl: 0,
        tap_count: 0,
        last_tap_ts: 0,
    };
    arena.player_count = arena
        .player_count
        .checked_add(1)
        .ok_or(CandleRoyaleError::MathOverflow)?;

    emit!(PlayerJoined {
        room_id,
        player: player_key,
        session_key,
        seat_index: count as u8,
        total_pot: vault.total_pot,
    });

    Ok(())
}

#[event]
pub struct PlayerJoined {
    pub room_id: u64,
    pub player: Pubkey,
    pub session_key: Pubkey,
    pub seat_index: u8,
    pub total_pot: u64,
}
