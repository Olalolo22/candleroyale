use anchor_lang::prelude::*;

use ephemeral_rollups_sdk::access_control::structs::EphemeralPermission;

use crate::constants::{
    ARENA_LEVERAGE, MAX_PLAYERS, PNL_SCALE, POS_FLAT, POS_LONG, POS_SHORT, SEAT_PERMISSION_MEMBERS,
};
use crate::errors::CandleRoyaleError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ArenaStatus {
    Lobby,
    Live,
    Finished,
    Aborted,
}

impl Default for ArenaStatus {
    fn default() -> Self {
        ArenaStatus::Lobby
    }
}

/// L1 custody vault for a room. NEVER delegated — funds stay anchored on Solana L1.
#[account]
pub struct Vault {
    pub room_id: u64,
    pub creator: Pubkey,
    pub entry_fee: u64,
    pub total_pot: u64,
    pub claimed: bool,
    pub cancelled: bool,
    /// Bitmask of seats that have already claimed their payout/tie-split/abort-refund.
    pub claimed_mask: u8,
    pub bump: u8,
}

impl Vault {
    pub const SPACE: usize = 8  // discriminator
        + 8                     // room_id
        + 32                    // creator
        + 8                     // entry_fee
        + 8                     // total_pot
        + 1                     // claimed
        + 1                     // cancelled
        + 1                     // claimed_mask
        + 1;                    // bump
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug)]
pub struct PlayerSeat {
    /// Player's main Solana wallet (receives L1 payout on win).
    pub wallet: Pubkey,
    /// Ephemeral session key authorized ONLY to call `tap` / `begin_round` / `finish_round` in ER.
    pub session_key: Pubkey,
    /// -1 = SHORT, 0 = FLAT, 1 = LONG
    pub position: i8,
    /// Oracle price (1e8 scaled) at the moment the current position was opened.
    pub entry_price: i64,
    /// Realized cumulative PnL in 1e-6 units (10_000 = +1.00% after 20x arena leverage).
    pub realized_pnl: i64,
    /// Number of gasless ER taps executed by this player.
    pub tap_count: u32,
    /// Unix timestamp of the last tap.
    pub last_tap_ts: i64,
}

impl PlayerSeat {
    pub const SIZE: usize = 32 + 32 + 1 + 8 + 8 + 4 + 8; // 93 bytes
}

/// Live battle state. Delegated to MagicBlock ER for sub-50ms gasless trading,
/// then committed & undelegated back to Solana L1 when the timer completes (or aborts if stale).
#[account]
pub struct Arena {
    pub room_id: u64,
    pub creator: Pubkey,
    pub price_feed: Pubkey,
    pub entry_fee: u64,
    pub duration_secs: i64,
    pub max_players: u8,
    pub status: ArenaStatus,
    /// Unix timestamp when the room was created on L1 (governs stale-lobby abort escape hatch).
    pub created_at: i64,
    pub started_at: i64,
    pub ends_at: i64,
    pub start_price: i64,
    pub last_price: i64,
    pub player_count: u8,
    pub winner_index: u8,
    /// Bitmask of all seats tied for the highest final PnL (supports fair tie-splitting).
    pub winner_mask: u8,
    pub players: [PlayerSeat; MAX_PLAYERS],
    pub bump: u8,
}

impl Arena {
    pub const SPACE: usize = 8                           // discriminator
        + 8                                              // room_id
        + 32                                             // creator
        + 32                                             // price_feed
        + 8                                              // entry_fee
        + 8                                              // duration_secs
        + 1                                              // max_players
        + 1                                              // status
        + 8                                              // created_at
        + 8                                              // started_at
        + 8                                              // ends_at
        + 8                                              // start_price
        + 8                                              // last_price
        + 1                                              // player_count
        + 1                                              // winner_index
        + 1                                              // winner_mask
        + (PlayerSeat::SIZE * MAX_PLAYERS)               // players[6] = 558
        + 1;                                             // bump
}

/// Private per-seat position ("the dark pit"). Delegated to the MagicBlock Private ER (TEE)
/// at join time and sealed by an ephemeral permission on the player's first trade, so only
/// the player's wallet and session key can read it while the round runs. Banked PnL and tap
/// counts stay public in `Arena.players`; at settlement every open position is revealed into
/// `Arena.players[i].position / entry_price` and closed into `realized_pnl`.
#[account]
pub struct SeatPosition {
    pub room_id: u64,
    pub seat_index: u8,
    pub wallet: Pubkey,
    pub session_key: Pubkey,
    /// -1 = SHORT, 0 = FLAT, 1 = LONG
    pub position: i8,
    /// Oracle price (1e8 scaled) when the current position was opened.
    pub entry_price: i64,
    /// True once the ephemeral permission has been created (private) on the TEE ER.
    pub sealed: bool,
    pub bump: u8,
}

impl SeatPosition {
    pub const SPACE: usize = 8  // discriminator
        + 8                     // room_id
        + 1                     // seat_index
        + 32                    // wallet
        + 32                    // session_key
        + 1                     // position
        + 8                     // entry_price
        + 1                     // sealed
        + 1;                    // bump
}

/// Lamports a seat must carry onto the TEE ER to pay for its own ephemeral permission
/// (the seat PDA is the payer of `CreateEphemeralPermissionCpi` on its first trade).
pub fn seat_permission_rent() -> u64 {
    ephemeral_rollups_sdk::ephemeral_accounts::rent(
        EphemeralPermission::size_of(SEAT_PERMISSION_MEMBERS) as u32,
    )
}

/// Computes leveraged mark-to-market PnL delta in 1e-6 units (10_000 = +1.00%).
pub fn compute_pnl_delta(position: i8, entry_price: i64, current_price: i64) -> Result<i64> {
    if position == POS_FLAT || entry_price <= 0 {
        return Ok(0);
    }
    require!(
        position == POS_LONG || position == POS_SHORT,
        CandleRoyaleError::InvalidPosition
    );
    require!(current_price > 0, CandleRoyaleError::StaleOrInvalidPrice);

    let price_diff = (current_price as i128)
        .checked_sub(entry_price as i128)
        .ok_or(CandleRoyaleError::MathOverflow)?;
    let num = (position as i128)
        .checked_mul(ARENA_LEVERAGE)
        .and_then(|v| v.checked_mul(price_diff))
        .and_then(|v| v.checked_mul(PNL_SCALE))
        .ok_or(CandleRoyaleError::MathOverflow)?;
    let delta = num
        .checked_div(entry_price as i128)
        .ok_or(CandleRoyaleError::MathOverflow)?;

    i64::try_from(delta).map_err(|_| error!(CandleRoyaleError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pnl_long_gain() {
        let delta = compute_pnl_delta(POS_LONG, 10_000_000_000, 10_050_000_000).unwrap();
        assert_eq!(delta, 100_000);
    }

    #[test]
    fn test_pnl_short_gain() {
        let delta = compute_pnl_delta(POS_SHORT, 10_000_000_000, 9_975_000_000).unwrap();
        assert_eq!(delta, 50_000);
    }

    #[test]
    fn test_pnl_flat_zero() {
        let delta = compute_pnl_delta(POS_FLAT, 6_670_000_000, 7_000_000_000).unwrap();
        assert_eq!(delta, 0);
    }
}
