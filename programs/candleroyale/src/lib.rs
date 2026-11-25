use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod oracle;
pub mod state;

use instructions::*;

declare_id!("3fgXDqKzQiQQUSfbPXnyuonqJi8BMbeGf9vnxxH9bEtN");

#[ephemeral]
#[program]
pub mod candleroyale {
    use super::*;

    /// L1: Create a new CandleRoyale battle room, escrow entry fee in Vault PDA, and register creator seat + session key.
    pub fn create_room(
        ctx: Context<CreateRoom>,
        room_id: u64,
        entry_fee: u64,
        duration_secs: i64,
        max_players: u8,
        price_feed: Pubkey,
        session_key: Pubkey,
    ) -> Result<()> {
        instructions::create_room::handle_create_room(
            ctx,
            room_id,
            entry_fee,
            duration_secs,
            max_players,
            price_feed,
            session_key,
        )
    }

    /// L1: Join an open Lobby room, escrow entry fee in Vault PDA, and bind a unique ephemeral session key.
    pub fn join_room(ctx: Context<JoinRoom>, room_id: u64, session_key: Pubkey) -> Result<()> {
        instructions::join_room::handle_join_room(ctx, room_id, session_key)
    }

    /// L1: Cancel an unstarted solo Lobby room and refund the creator's entry fee.
    pub fn cancel_room(ctx: Context<CancelRoom>, room_id: u64) -> Result<()> {
        instructions::cancel_room::handle_cancel_room(ctx, room_id)
    }

    /// L1: Creator delegates the Arena PDA to the pinned MagicBlock ER validator for sub-50ms gasless trading.
    pub fn start_and_delegate(ctx: Context<StartAndDelegate>, room_id: u64) -> Result<()> {
        instructions::start_and_delegate::handle_start_and_delegate(ctx, room_id)
    }

    /// ER: Lock the opening Pyth Lazer price and start the countdown inside MagicBlock ER.
    pub fn begin_round(ctx: Context<BeginRound>, room_id: u64) -> Result<()> {
        instructions::begin_round::handle_begin_round(ctx, room_id)
    }

    /// ER: Execute an instant, gasless position flip (LONG / FLAT / SHORT) signed by the player's Session Key.
    pub fn tap(ctx: Context<Tap>, room_id: u64, new_position: i8) -> Result<()> {
        instructions::tap::handle_tap(ctx, room_id, new_position)
    }

    /// ER: Close all open positions deterministically (3s oracle grace window or frozen last_price), compute tie mask, and commit & undelegate back to L1.
    pub fn finish_round(ctx: Context<FinishRound>, room_id: u64) -> Result<()> {
        instructions::finish_round::handle_finish_round(ctx, room_id)
    }

    /// ER: Permissionless escape hatch to undelegate a stale delegated Lobby room after STALE_LOBBY_TIMEOUT_SECS and unlock L1 refunds.
    pub fn abort_stale_room(ctx: Context<AbortStaleRoom>, room_id: u64) -> Result<()> {
        instructions::abort_stale_room::handle_abort_stale_room(ctx, room_id)
    }

    /// L1: Escape hatch when the creator never starts a joined room: any seated player can abort after L1_LOBBY_TIMEOUT_SECS, unlocking per-seat entry refunds.
    pub fn abort_stale_lobby(ctx: Context<AbortStaleLobby>, room_id: u64) -> Result<()> {
        instructions::abort_stale_lobby::handle_abort_stale_lobby(ctx, room_id)
    }

    /// L1: Release single-winner pot, equal tie-split share, or aborted-room entry refund from Vault PDA to `arena.players[seat_index].wallet`.
    pub fn claim_payout(ctx: Context<ClaimPayout>, room_id: u64, seat_index: u8) -> Result<()> {
        instructions::claim_payout::handle_claim_payout(ctx, room_id, seat_index)
    }
}

#[cfg(test)]
mod layout_tests {
    use super::*;
    use crate::instructions::claim_payout::compute_seat_payout;
    use crate::instructions::finish_round::resolve_closing_price;
    use crate::state::{Arena, ArenaStatus, PlayerSeat, Vault};
    use anchor_lang::Discriminator;

    #[test]
    fn test_vault_and_arena_exact_byte_sizes() {
        let vault = Vault {
            room_id: 1,
            creator: Pubkey::default(),
            entry_fee: 50_000_000,
            total_pot: 100_000_000,
            claimed: false,
            cancelled: false,
            claimed_mask: 0,
            bump: 255,
        };
        let mut vault_bytes = Vec::new();
        vault.try_serialize(&mut vault_bytes).unwrap();
        assert_eq!(vault_bytes.len(), Vault::SPACE);
        assert_eq!(Vault::SPACE, 68);

        let arena = Arena {
            room_id: 1,
            creator: Pubkey::default(),
            price_feed: Pubkey::default(),
            entry_fee: 50_000_000,
            duration_secs: 60,
            max_players: 6,
            status: ArenaStatus::Lobby,
            created_at: 1_795_000_000,
            started_at: 0,
            ends_at: 0,
            start_price: 0,
            last_price: 0,
            player_count: 1,
            winner_index: 255,
            winner_mask: 0,
            players: [PlayerSeat::default(); 6],
            bump: 255,
        };
        let mut arena_bytes = Vec::new();
        arena.try_serialize(&mut arena_bytes).unwrap();
        assert_eq!(arena_bytes.len(), Arena::SPACE);
        assert_eq!(Arena::SPACE, 700);

        assert_eq!(Vault::DISCRIMINATOR.len(), 8);
        assert_eq!(Arena::DISCRIMINATOR.len(), 8);
    }

    #[test]
    fn test_closing_price_grace_window_blocks_free_option() {
        let ends_at = 1_000;
        let frozen_last = 7_000_000_000;
        let fresh_live = 7_050_000_000;

        // Within 3s grace window with timely publish_time -> uses live oracle price
        assert_eq!(
            resolve_closing_price(1_002, ends_at, frozen_last, Some((fresh_live, 1_002))).unwrap(),
            fresh_live
        );
        // Past 3s grace window -> ignores late price and freezes at last_price
        assert_eq!(
            resolve_closing_price(1_010, ends_at, frozen_last, Some((fresh_live, 1_010))).unwrap(),
            frozen_last
        );
        // Oracle published past grace deadline -> freezes at last_price
        assert_eq!(
            resolve_closing_price(1_003, ends_at, frozen_last, Some((fresh_live, 1_005))).unwrap(),
            frozen_last
        );
    }

    #[test]
    fn test_tie_split_and_abort_refund_math() {
        // 3-way tie on 100 lamports: seat 0 gets 34 (base 33 + 1 dust), seats 1 & 2 get 33
        let mask = 0b0000_0111;
        assert_eq!(
            compute_seat_payout(ArenaStatus::Finished, 100, 33, mask, 0, 0, 3).unwrap(),
            34
        );
        assert_eq!(
            compute_seat_payout(ArenaStatus::Finished, 100, 33, mask, 0, 1, 3).unwrap(),
            33
        );
        assert_eq!(
            compute_seat_payout(ArenaStatus::Finished, 100, 33, mask, 0, 2, 3).unwrap(),
            33
        );
        // Non-winner cannot claim
        assert!(compute_seat_payout(ArenaStatus::Finished, 100, 50, 0b01, 0, 1, 2).is_err());
        // Aborted room refunds exact entry_fee to every seated player
        assert_eq!(
            compute_seat_payout(ArenaStatus::Aborted, 100, 50, 0, 255, 1, 2).unwrap(),
            50
        );
    }
}
