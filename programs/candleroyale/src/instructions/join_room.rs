use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::{ARENA_SEED, POS_FLAT, SEAT_SEED, VAULT_SEED};
use crate::errors::CandleRoyaleError;
use crate::state::{seat_permission_rent, Arena, ArenaStatus, PlayerSeat, SeatPosition, Vault};

#[derive(Accounts)]
#[instruction(room_id: u64, session_key: Pubkey, seat_index: u8)]
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

    /// The joiner's private position account. `seat_index` must equal the next free seat
    /// (checked in the handler). Delegated to the TEE ER by `delegate_seat` in the same tx.
    #[account(
        init,
        payer = player,
        space = SeatPosition::SPACE,
        seeds = [SEAT_SEED, &room_id.to_le_bytes(), &seat_index.to_le_bytes()],
        bump,
    )]
    pub seat: Account<'info, SeatPosition>,

    pub system_program: Program<'info, System>,
}

pub fn handle_join_room(
    ctx: Context<JoinRoom>,
    room_id: u64,
    session_key: Pubkey,
    seat_index: u8,
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
    require!(
        seat_index as usize == count,
        CandleRoyaleError::InvalidSeatAccount
    );
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

    let seat = &mut ctx.accounts.seat;
    seat.room_id = room_id;
    seat.seat_index = seat_index;
    seat.wallet = player_key;
    seat.session_key = session_key;
    seat.position = POS_FLAT;
    seat.entry_price = 0;
    seat.sealed = false;
    seat.bump = ctx.bumps.seat;

    // Pre-fund the seat so it can pay its own ephemeral permission rent on the TEE ER.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.player.to_account_info(),
                to: ctx.accounts.seat.to_account_info(),
            },
        ),
        seat_permission_rent(),
    )?;

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
