use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod constants;
pub mod errors;
pub mod oracle;
pub mod state;

declare_id!("3fgXDqKzQiQQUSfbPXnyuonqJi8BMbeGf9vnxxH9bEtN");

#[ephemeral]
#[program]
pub mod candleroyale {
    use super::*;

    /// Health-check stub replaced by full room lifecycle in Commit 2.
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping<'info> {
    pub payer: Signer<'info>,
}
