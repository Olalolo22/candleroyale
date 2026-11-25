use anchor_lang::prelude::*;

pub const VAULT_SEED: &[u8] = b"vault";
pub const ARENA_SEED: &[u8] = b"arena";

/// Maximum players per CandleRoyale room.
pub const MAX_PLAYERS: usize = 6;

/// Allowed round duration bounds (seconds).
pub const MIN_DURATION_SECS: i64 = 15;
pub const MAX_DURATION_SECS: i64 = 180;

/// Arcade leverage multiplier applied to price deltas (20x makes 60s sprints dramatic).
pub const ARENA_LEVERAGE: i128 = 20;

/// PnL fixed-point scale: 1_000_000 = +100.00%, 10_000 = +1.00%, 100 = +0.01%.
pub const PNL_SCALE: i128 = 1_000_000;

/// Position directions.
pub const POS_SHORT: i8 = -1;
pub const POS_FLAT: i8 = 0;
pub const POS_LONG: i8 = 1;

/// Unset winner sentinel.
pub const NO_WINNER: u8 = u8::MAX;

/// Pinned MagicBlock US Devnet Ephemeral Rollup validator enforced on-chain in `start_and_delegate`.
pub const PINNED_ER_VALIDATOR: Pubkey = pubkey!("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd");

/// MagicBlock Real-Time Pricing Oracle program (Pyth Lazer on ER).
pub const ORACLE_PROGRAM_ID: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");

/// MagicBlock Pyth Lazer SOL/USD feed on Devnet ER.
pub const SOL_USD_FEED: Pubkey = pubkey!("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
/// MagicBlock Pyth Lazer BTC/USD feed on Devnet ER.
pub const BTC_USD_FEED: Pubkey = pubkey!("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr");
/// MagicBlock Pyth Lazer ETH/USD feed on Devnet ER.
pub const ETH_USD_FEED: Pubkey = pubkey!("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG");

/// Tight maximum acceptable oracle age (seconds) for 20x leveraged micro-trading.
pub const MAX_ORACLE_AGE_SECS: i64 = 10;

/// Post-expiry grace window (seconds) during which `finish_round` may close open positions at live oracle price.
/// After `ends_at + SETTLE_GRACE_SECS`, settlement deterministically closes at `arena.last_price` to eliminate timing attacks.
pub const SETTLE_GRACE_SECS: i64 = 3;

/// Seconds a delegated Lobby room can sit idle without starting before anyone can call `abort_stale_room` to undelegate and refund.
pub const STALE_LOBBY_TIMEOUT_SECS: i64 = 180;

/// Seconds an undelegated (L1) Lobby room with 2+ players can wait for its creator to start it
/// before any seated player can call `abort_stale_lobby` to unlock per-seat refunds.
/// Without this, joiners' stakes were locked forever if the creator went offline:
/// only the creator can start, and `cancel_room` only works while the creator is alone.
pub const L1_LOBBY_TIMEOUT_SECS: i64 = 900;
