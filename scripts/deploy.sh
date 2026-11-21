#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="$HOME/.local/share/solana/solana-release/bin:$HOME/.local/bin:$PATH"
if [ -d "$HOME/.rustup" ]; then
  export RUSTUP_HOME="$HOME/.rustup"
fi

echo "==> 1. Running Rust unit tests..."
cargo test --manifest-path programs/candleroyale/Cargo.toml

echo "==> 2. Building SBF bytecode..."
cargo-build-sbf --manifest-path programs/candleroyale/Cargo.toml --sbf-out-dir target/deploy

DEPLOYER="$(solana-keygen pubkey ~/.config/solana/id.json)"
BALANCE="$(solana balance --url https://api.devnet.solana.com)"
echo "==> 3. Deployer: $DEPLOYER ($BALANCE)"

echo "==> 4. Deploying candleroyale.so to Solana Devnet..."
solana program deploy target/deploy/candleroyale.so \
  --program-id target/deploy/candleroyale-keypair.json \
  --url https://api.devnet.solana.com

echo "==> 5. Running live Solana Devnet <-> MagicBlock ER E2E test..."
npm run e2e:devnet
