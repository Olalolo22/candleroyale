use anchor_lang::prelude::*;

#[error_code]
pub enum CandleRoyaleError {
    #[msg("Room duration must be between 15 and 180 seconds")]
    InvalidDuration,
    #[msg("Max players must be between 1 and 6")]
    InvalidMaxPlayers,
    #[msg("Unsupported MagicBlock Pyth Lazer price feed")]
    UnsupportedPriceFeed,
    #[msg("Room is not in Lobby state")]
    RoomNotInLobby,
    #[msg("Room is not Live")]
    RoomNotLive,
    #[msg("Room has not finished or been aborted yet")]
    RoomNotFinished,
    #[msg("Room is already full")]
    RoomFull,
    #[msg("Player already joined this room")]
    AlreadyJoined,
    #[msg("Signer is not an authorized wallet or session key for this seat")]
    UnauthorizedSigner,
    #[msg("Player seat not found in room")]
    PlayerNotFound,
    #[msg("Position must be -1 (SHORT), 0 (FLAT), or 1 (LONG)")]
    InvalidPosition,
    #[msg("Round timer has already expired")]
    RoundExpired,
    #[msg("Round timer has not ended yet")]
    RoundStillActive,
    #[msg("Invalid oracle account owner or layout")]
    InvalidOracleAccount,
    #[msg("Oracle price feed does not match room configuration")]
    OracleFeedMismatch,
    #[msg("Oracle price is non-positive or stale")]
    StaleOrInvalidPrice,
    #[msg("Payout or refund for this seat has already been claimed")]
    AlreadyClaimed,
    #[msg("Recipient account does not match seat wallet")]
    WinnerMismatch,
    #[msg("Math overflow during PnL or payout calculation")]
    MathOverflow,
    #[msg("Room cannot be cancelled once other players have joined")]
    CannotCancelWithOthers,
    #[msg("Invalid arena account data")]
    InvalidArenaAccount,
    #[msg("Validator must match the pinned MagicBlock ER validator")]
    InvalidValidator,
    #[msg("Position is already set to the requested direction")]
    NoOpPositionChange,
    #[msg("Session key cannot be default or collide with an existing wallet or session key")]
    SessionKeyCollision,
    #[msg("Stale lobby timeout has not elapsed yet")]
    StaleTimeoutNotReached,
    #[msg("Seat is not eligible for payout in this round")]
    SeatNotWinner,
}
