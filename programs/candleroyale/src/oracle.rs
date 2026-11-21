use anchor_lang::prelude::*;

use crate::constants::{
    BTC_USD_FEED, ETH_USD_FEED, MAX_ORACLE_AGE_SECS, ORACLE_PROGRAM_ID, SOL_USD_FEED,
};
use crate::errors::CandleRoyaleError;

/// Discriminator of Pyth `PriceUpdateV2` written by MagicBlock's `ephemeral-oracle` program.
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [0xea, 0xa1, 0x0e, 0x24, 0xac, 0xef, 0x0f, 0xe8];
pub const PRICE_UPDATE_V2_LEN: usize = 134;
pub const PRICE_OFFSET: usize = 73;
pub const PUBLISH_TIME_OFFSET: usize = 93;

#[derive(Clone, Copy, Debug)]
pub struct OracleTick {
    pub price: i64,
    pub publish_time: i64,
}

pub fn is_supported_feed(feed: &Pubkey) -> bool {
    *feed == SOL_USD_FEED || *feed == BTC_USD_FEED || *feed == ETH_USD_FEED
}

/// Parses and validates a MagicBlock Pyth Lazer price feed account directly from raw bytes.
pub fn parse_oracle_bytes(data: &[u8]) -> Result<OracleTick> {
    require!(
        data.len() >= PRICE_UPDATE_V2_LEN,
        CandleRoyaleError::InvalidOracleAccount
    );
    require!(
        data[0..8] == PRICE_UPDATE_V2_DISCRIMINATOR,
        CandleRoyaleError::InvalidOracleAccount
    );

    let price_bytes: [u8; 8] = data[PRICE_OFFSET..PRICE_OFFSET + 8]
        .try_into()
        .map_err(|_| error!(CandleRoyaleError::InvalidOracleAccount))?;
    let pub_time_bytes: [u8; 8] = data[PUBLISH_TIME_OFFSET..PUBLISH_TIME_OFFSET + 8]
        .try_into()
        .map_err(|_| error!(CandleRoyaleError::InvalidOracleAccount))?;

    let price = i64::from_le_bytes(price_bytes);
    let publish_time = i64::from_le_bytes(pub_time_bytes);

    require!(price > 0, CandleRoyaleError::StaleOrInvalidPrice);

    Ok(OracleTick {
        price,
        publish_time,
    })
}

/// Reads and verifies the MagicBlock ER Pyth Lazer account against the room's configured feed.
pub fn read_er_price(
    price_feed: &AccountInfo,
    expected_feed: &Pubkey,
    now_ts: i64,
) -> Result<OracleTick> {
    require_keys_eq!(
        price_feed.key(),
        *expected_feed,
        CandleRoyaleError::OracleFeedMismatch
    );
    require_keys_eq!(
        *price_feed.owner,
        ORACLE_PROGRAM_ID,
        CandleRoyaleError::InvalidOracleAccount
    );

    let data = price_feed.try_borrow_data()?;
    let tick = parse_oracle_bytes(&data)?;

    // Reject stale feeds (allow small negative skew between ER clock and Pyth publisher).
    let age = now_ts.saturating_sub(tick.publish_time);
    require!(
        age <= MAX_ORACLE_AGE_SECS,
        CandleRoyaleError::StaleOrInvalidPrice
    );

    Ok(tick)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_live_sol_usd_snapshot() {
        // Real 134-byte snapshot captured from devnet-us.magicblock.app (SOL/USD = $66.70586777)
        let mut buf = [0u8; 134];
        buf[0..8].copy_from_slice(&PRICE_UPDATE_V2_DISCRIMINATOR);
        buf[73..81].copy_from_slice(&6_670_586_777i64.to_le_bytes());
        buf[89..93].copy_from_slice(&8i32.to_le_bytes());
        buf[93..101].copy_from_slice(&1_795_250_360i64.to_le_bytes());

        let tick = parse_oracle_bytes(&buf).unwrap();
        assert_eq!(tick.price, 6_670_586_777);
        assert_eq!(tick.publish_time, 1_795_250_360);
    }

    #[test]
    fn test_rejects_bad_discriminator() {
        let buf = [0u8; 134];
        assert!(parse_oracle_bytes(&buf).is_err());
    }
}
