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

    /// L1: Join an open Lobby room, escrow entry fee in Vault PDA, and bind an ephemeral session key.
    pub fn join_room(ctx: Context<JoinRoom>, room_id: u64, session_key: Pubkey) -> Result<()> {
        instructions::join_room::handle_join_room(ctx, room_id, session_key)
    }

    /// L1: Cancel an unstarted solo Lobby room and refund the creator's entry fee.
    pub fn cancel_room(ctx: Context<CancelRoom>, room_id: u64) -> Result<()> {
        instructions::cancel_room::handle_cancel_room(ctx, room_id)
    }

    /// L1: Delegate the Arena PDA to a MagicBlock Ephemeral Rollup validator for sub-50ms gasless trading.
    pub fn start_and_delegate(ctx: Context<StartAndDelegate>, room_id: u64) -> Result<()> {
        instructions::start_and_delegate::handle_start_and_delegate(ctx, room_id)
    }

    /// ER: Lock the opening Pyth Lazer price and start the 60-second countdown inside MagicBlock ER.
    pub fn begin_round(ctx: Context<BeginRound>, room_id: u64) -> Result<()> {
        instructions::begin_round::handle_begin_round(ctx, room_id)
    }

    /// ER: Execute an instant, gasless position flip (LONG / FLAT / SHORT) signed by the player's Session Key.
    pub fn tap(ctx: Context<Tap>, room_id: u64, new_position: i8) -> Result<()> {
        instructions::tap::handle_tap(ctx, room_id, new_position)
    }

    /// ER: Close all open positions at the live Pyth Lazer closing price, crown the winner, and commit & undelegate back to L1.
    pub fn finish_round(ctx: Context<FinishRound>, room_id: u64) -> Result<()> {
        instructions::finish_round::handle_finish_round(ctx, room_id)
    }

    /// L1: Release the escrowed SOL prize pot from Vault PDA to the verified winning player's main wallet.
    pub fn claim_payout(ctx: Context<ClaimPayout>, room_id: u64) -> Result<()> {
        instructions::claim_payout::handle_claim_payout(ctx, room_id)
    }
}

#[cfg(test)]
mod layout_tests {
    use super::*;
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
            bump: 255,
        };
        let mut vault_bytes = Vec::new();
        vault.try_serialize(&mut vault_bytes).unwrap();
        assert_eq!(vault_bytes.len(), Vault::SPACE);
        assert_eq!(Vault::SPACE, 67);

        let arena = Arena {
            room_id: 1,
            creator: Pubkey::default(),
            price_feed: Pubkey::default(),
            entry_fee: 50_000_000,
            duration_secs: 60,
            max_players: 6,
            status: ArenaStatus::Lobby,
            started_at: 0,
            ends_at: 0,
            start_price: 0,
            last_price: 0,
            player_count: 1,
            winner_index: 255,
            players: [PlayerSeat::default(); 6],
            bump: 255,
        };
        let mut arena_bytes = Vec::new();
        arena.try_serialize(&mut arena_bytes).unwrap();
        assert_eq!(arena_bytes.len(), Arena::SPACE);
        assert_eq!(Arena::SPACE, 691);

        // Verify discriminators are non-zero 8-byte Anchor sighashes
        assert_eq!(Vault::DISCRIMINATOR.len(), 8);
        assert_eq!(Arena::DISCRIMINATOR.len(), 8);
    }
}
