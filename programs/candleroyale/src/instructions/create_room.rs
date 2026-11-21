use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::{
    ARENA_SEED, MAX_DURATION_SECS, MAX_PLAYERS, MIN_DURATION_SECS, NO_WINNER, POS_FLAT, VAULT_SEED,
};
use crate::errors::CandleRoyaleError;
use crate::oracle::is_supported_feed;
use crate::state::{Arena, ArenaStatus, PlayerSeat, Vault};

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct CreateRoom<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        init,
        payer = creator,
        space = Vault::SPACE,
        seeds = [VAULT_SEED, &room_id.to_le_bytes()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = creator,
        space = Arena::SPACE,
        seeds = [ARENA_SEED, &room_id.to_le_bytes()],
        bump,
    )]
    pub arena: Account<'info, Arena>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_room(
    ctx: Context<CreateRoom>,
    room_id: u64,
    entry_fee: u64,
    duration_secs: i64,
    max_players: u8,
    price_feed: Pubkey,
    session_key: Pubkey,
) -> Result<()> {
    require!(
        (MIN_DURATION_SECS..=MAX_DURATION_SECS).contains(&duration_secs),
        CandleRoyaleError::InvalidDuration
    );
    require!(
        max_players >= 1 && (max_players as usize) <= MAX_PLAYERS,
        CandleRoyaleError::InvalidMaxPlayers
    );
    require!(
        is_supported_feed(&price_feed),
        CandleRoyaleError::UnsupportedPriceFeed
    );

    if entry_fee > 0 {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.creator.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, entry_fee)?;
    }

    let vault = &mut ctx.accounts.vault;
    vault.room_id = room_id;
    vault.creator = ctx.accounts.creator.key();
    vault.entry_fee = entry_fee;
    vault.total_pot = entry_fee;
    vault.claimed = false;
    vault.cancelled = false;
    vault.bump = ctx.bumps.vault;

    let arena = &mut ctx.accounts.arena;
    arena.room_id = room_id;
    arena.creator = ctx.accounts.creator.key();
    arena.price_feed = price_feed;
    arena.entry_fee = entry_fee;
    arena.duration_secs = duration_secs;
    arena.max_players = max_players;
    arena.status = ArenaStatus::Lobby;
    arena.started_at = 0;
    arena.ends_at = 0;
    arena.start_price = 0;
    arena.last_price = 0;
    arena.player_count = 1;
    arena.winner_index = NO_WINNER;
    arena.players = [PlayerSeat::default(); MAX_PLAYERS];
    arena.players[0] = PlayerSeat {
        wallet: ctx.accounts.creator.key(),
        session_key,
        position: POS_FLAT,
        entry_price: 0,
        realized_pnl: 0,
        tap_count: 0,
        last_tap_ts: 0,
    };
    arena.bump = ctx.bumps.arena;

    emit!(RoomCreated {
        room_id,
        creator: ctx.accounts.creator.key(),
        price_feed,
        entry_fee,
        duration_secs,
        max_players,
    });

    Ok(())
}

#[event]
pub struct RoomCreated {
    pub room_id: u64,
    pub creator: Pubkey,
    pub price_feed: Pubkey,
    pub entry_fee: u64,
    pub duration_secs: i64,
    pub max_players: u8,
}
