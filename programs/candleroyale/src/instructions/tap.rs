use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::CreateEphemeralPermissionCpi;
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, Member, PERMISSION_SEED, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

use crate::constants::{ARENA_SEED, POS_FLAT, POS_LONG, POS_SHORT, SEAT_SEED};
use crate::errors::CandleRoyaleError;
use crate::oracle::read_er_price;
use crate::state::{compute_pnl_delta, Arena, ArenaStatus, SeatPosition};

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct Tap<'info> {
    /// Either the player's ephemeral session_key (0-popup gasless ER signing) or their wallet.
    pub signer: Signer<'info>,

    /// Public scoreboard: banked PnL and tap counts only. Positions never touch it mid-round.
    #[account(
        mut,
        seeds = [ARENA_SEED, &room_id.to_le_bytes()],
        bump = arena.bump,
    )]
    pub arena: Account<'info, Arena>,

    /// The signer's private position (sealed on the TEE ER).
    #[account(
        mut,
        seeds = [SEAT_SEED, &room_id.to_le_bytes(), &seat.seat_index.to_le_bytes()],
        bump = seat.bump,
    )]
    pub seat: Account<'info, SeatPosition>,

    /// CHECK: Verified inside read_er_price against ORACLE_PROGRAM_ID and arena.price_feed.
    pub price_feed: UncheckedAccount<'info>,

    /// CHECK: The seat's ephemeral permission PDA, owned by the Permission Program.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, seat.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,

    /// CHECK: MagicBlock Permission Program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,

    /// CHECK: Ephemeral rent vault, verified by the magic program
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,

    /// CHECK: MagicBlock Magic Program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

pub fn handle_tap(ctx: Context<Tap>, room_id: u64, new_position: i8) -> Result<()> {
    require!(
        new_position == POS_SHORT || new_position == POS_FLAT || new_position == POS_LONG,
        CandleRoyaleError::InvalidPosition
    );

    let signer_key = ctx.accounts.signer.key();
    let seat_idx = ctx.accounts.seat.seat_index as usize;
    {
        let arena = &ctx.accounts.arena;
        let seat = &ctx.accounts.seat;
        require!(
            seat.room_id == room_id && seat_idx < arena.player_count as usize,
            CandleRoyaleError::InvalidSeatAccount
        );
        require_keys_eq!(
            arena.players[seat_idx].wallet,
            seat.wallet,
            CandleRoyaleError::InvalidSeatAccount
        );
        require!(
            signer_key == seat.session_key || signer_key == seat.wallet,
            CandleRoyaleError::UnauthorizedSigner
        );
    }

    // Seal the seat before any position is ever written to it: the first trade creates a
    // private ephemeral permission whose only members are this player's wallet and session
    // key. The seat PDA pays the rent it was pre-funded with at join time.
    if !ctx.accounts.seat.sealed {
        if ctx.accounts.permission.lamports() == 0 {
            let seat_index_bytes = ctx.accounts.seat.seat_index.to_le_bytes();
            let room_id_bytes = room_id.to_le_bytes();
            let bump = [ctx.accounts.seat.bump];
            let signer_seeds: [&[u8]; 4] = [
                SEAT_SEED,
                room_id_bytes.as_ref(),
                seat_index_bytes.as_ref(),
                bump.as_ref(),
            ];
            let flags = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;
            CreateEphemeralPermissionCpi {
                payer: ctx.accounts.seat.to_account_info(),
                permissioned_account: ctx.accounts.seat.to_account_info(),
                permission: ctx.accounts.permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                args: EphemeralMembersArgs {
                    is_private: true,
                    members: vec![
                        Member {
                            flags,
                            pubkey: ctx.accounts.seat.wallet,
                        },
                        Member {
                            flags,
                            pubkey: ctx.accounts.seat.session_key,
                        },
                    ],
                },
            }
            .invoke_signed(&[&signer_seeds])?;
        }
        ctx.accounts.seat.sealed = true;
    }

    let arena = &mut ctx.accounts.arena;
    let seat = &mut ctx.accounts.seat;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let tick = read_er_price(
        &ctx.accounts.price_feed.to_account_info(),
        &arena.price_feed,
        now,
    )?;

    // Seamless UX: first tap inside ER automatically opens the countdown if not started yet.
    if arena.status == ArenaStatus::Lobby {
        arena.status = ArenaStatus::Live;
        arena.started_at = now;
        arena.ends_at = now
            .checked_add(arena.duration_secs)
            .ok_or(CandleRoyaleError::MathOverflow)?;
        arena.start_price = tick.price;
    }

    require!(
        arena.status == ArenaStatus::Live,
        CandleRoyaleError::RoomNotLive
    );
    require!(now <= arena.ends_at, CandleRoyaleError::RoundExpired);

    // Reject no-op trades (e.g., FLAT -> FLAT) so tap counts cannot be spammed.
    require!(
        new_position != seat.position,
        CandleRoyaleError::NoOpPositionChange
    );

    // Bank the PnL of the position being closed (public), then open the new one (private).
    let delta = compute_pnl_delta(seat.position, seat.entry_price, tick.price)?;
    seat.position = new_position;
    seat.entry_price = if new_position == POS_FLAT {
        0
    } else {
        tick.price
    };

    let public_seat = &mut arena.players[seat_idx];
    public_seat.realized_pnl = public_seat
        .realized_pnl
        .checked_add(delta)
        .ok_or(CandleRoyaleError::MathOverflow)?;
    public_seat.tap_count = public_seat.tap_count.saturating_add(1);
    public_seat.last_tap_ts = now;
    // Positions stay out of the public scoreboard until settlement reveals them.
    public_seat.position = POS_FLAT;
    public_seat.entry_price = 0;

    let player_wallet = public_seat.wallet;
    let realized_pnl = public_seat.realized_pnl;
    let tap_count = public_seat.tap_count;

    arena.last_price = tick.price;

    // The event carries only public facts (no direction, no entry price).
    emit!(TapExecuted {
        room_id,
        player: player_wallet,
        realized_pnl,
        tap_count,
    });

    Ok(())
}

#[event]
pub struct TapExecuted {
    pub room_id: u64,
    pub player: Pubkey,
    pub realized_pnl: i64,
    pub tap_count: u32,
}
