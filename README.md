# CandleRoyale

**60-second PvP micro-trading battle royale on Solana & MagicBlock Ephemeral Rollups.**

2–6 players escrow real SOL into a Solana L1 vault, delegate the battleground into a **MagicBlock Ephemeral Rollup**, and race for 60 seconds flipping **20× LONG / FLAT / SHORT** against live **Pyth Lazer** feeds with **zero gas** and **zero wallet popups** via scoped in-browser Session Keys. When the clock hits zero, MagicBlock commits and undelegates the verified winner back to Solana L1 to unlock the entire pot.

Built for **MagicBlock Solana Blitz v10 — Theme: Entertainment Finance**.

---

## Why MagicBlock Is Load-Bearing

A 60-second tap-trading battle is impossible on base Solana L1:

| Requirement | Base Solana L1 | CandleRoyale on MagicBlock |
|---|---|---|
| Rapid position flips (`LONG / FLAT / SHORT`) | ~400ms slots + fee every tap | **Sub-50ms ER execution, 0 gas** |
| Wallet UX during 60s sprint | Phantom popup every click | **Scoped Session Key** bound once at `join_room` |
| Price feed freshness | ~400ms base updates | **Live Pyth Lazer on ER** (~50–200ms ticks) |
| Funds security | Single-layer | **L1 Vault PDA never delegated**; only `Arena` PDA enters ER |

Remove MagicBlock Ephemeral Rollups, Session Keys, or the ER Pyth Lazer feed and the product breaks.

---

## Architecture

```mermaid
flowchart LR
    subgraph L1["Solana Devnet (L1 Custody & Settlement)"]
        V["Vault PDA\n(NEVER Delegated · Holds SOL Pot)"]
        A1["Arena PDA\n(Lobby → Delegated → Finished)"]
        W["Winner Main Wallet"]
    end

    subgraph ER["MagicBlock US Devnet ER (devnet-us.magicblock.app)"]
        A2["Delegated Arena PDA\n(10–50ms · 0 Gas)"]
        PYTH["Pyth Lazer Oracle\nSOL / BTC / ETH"]
        SK["Scoped Session Keys\n(0 Wallet Popups)"]
    end

    A1 -->|"1. create_room / join_room\n(SOL → Vault)"| V
    A1 -->|"2. start_and_delegate"| A2
    SK -->|"3. begin_round & tap(LONG/FLAT/SHORT)"| A2
    PYTH -->|"Live 20× Mark-to-Market"| A2
    A2 -->|"4. finish_round\n(commit_and_undelegate)"| A1
    A1 -->|"5. claim_payout"| W
    V -->|"Release SOL Pot"| W
```

---

## On-Chain Endpoints & Program

| Resource | Value |
|---|---|
| **Program ID (Devnet)** | `3fgXDqKzQiQQUSfbPXnyuonqJi8BMbeGf9vnxxH9bEtN` |
| **MagicBlock ER RPC** | `https://devnet-us.magicblock.app` |
| **ER Validator (US Devnet)** | `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` |
| **Delegation Program** | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| **Pyth Lazer Oracle Program** | `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd` |
| **SOL/USD ER Feed** | `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` |
| **BTC/USD ER Feed** | `71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr` |
| **ETH/USD ER Feed** | `5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG` |

---

## Verified Live On-Chain Proof (Solana Devnet ↔ MagicBlock ER)

Every step of a real 2-player SOL match was executed end-to-end via `npm run e2e:devnet` on Solana Devnet and MagicBlock US Devnet ER (`devnet-us.magicblock.app`):

| Step | Layer | Signer | Proof / Latency |
|---|---|---|---|
| **Program Deploy** | Solana L1 | Deployer | [`3XqgNYHt...s45r9`](https://explorer.solana.com/tx/3XqgNYHtV2G9bd6pZs5zLSbH55jewtC3HECkWrgCuCTMJWZ1aAwvZdekCASCn7ymvfDPNGegZGQHtvrsrR3s45r9?cluster=devnet) (`3fgXDqKzQiQQUSfbPXnyuonqJi8BMbeGf9vnxxH9bEtN`) |
| **`create_room`** (0.01 SOL) | Solana L1 | Player A | [`3T3BJ2ed...95KBdo`](https://explorer.solana.com/tx/3T3BJ2eddSFvg6M6gsU4wGuDQozkRtjYhoiSctHipWu7a2m9pkyGfGQXhSnAu6P4fd3oHTvqocRhqUK9KW95KBdo?cluster=devnet) |
| **`join_room`** (0.01 SOL) | Solana L1 | Player B | [`4ycAB58X...qLsN6`](https://explorer.solana.com/tx/4ycAB58XsJNikib8oyEFfDLfhHUwrZWkNGHZiyL1i7tWJuu7GEWpBAtQ5QZ93GrNyiEXSEWnf41Fhonq1h3qLsN6?cluster=devnet) (pot = 0.02 SOL) |
| **`start_and_delegate`** | Solana L1 → ER | Player A | [`3ZiUNs43...wiYugz`](https://explorer.solana.com/tx/3ZiUNs43KXpPDLRBjJsNx2WCnQ2FchkEff5L8s8YQmUaUW7gh9rjszQg6iFrUHu8zLfJAQkuvueD8djC3fwiYugz?cluster=devnet) (`owner == DELeGGv...`) |
| **`begin_round`** | MagicBlock ER | 0-SOL Session Key A | `253ms` · 0 gas · `5qCNxP1cDoxEYA2DHm9jmvsNmJJRkH5g1VJDhftEvj1pw1Mv7nXcZoJsfXafMxCHvno7tfGVc91dLpsCPYe5j7Lu` |
| **5× `tap(LONG/SHORT/FLAT)`** | MagicBlock ER | 0-SOL Session Keys A & B | `149–168ms` HTTP RTT · 0 gas · Live Pyth Lazer SOL/USD (`$70.1347 → $70.1121`) |
| **`finish_round`** (`commit_and_undelegate`) | MagicBlock ER → L1 | 0-SOL Session Key A | `148ms` · 0 gas · `3FNzusD1Z8zjjXNeeL3GVkQNiLnTTyQxp9Z9nZMBKAz8BR4Gn1gKZFf8VnsJRhR8GRvPe9mV1gxv22q4n6XBkYJ1` |
| **`claim_payout`** (`+0.02000 SOL`) | Solana L1 | Permissionless → Winner | [`zc3sMsGx...cCULD`](https://explorer.solana.com/tx/zc3sMsGx2CXeZGPX7wUgTh857MtyAeBXVEUu5efe8cPAWoV4k2Z7Ye7ax6NCLW8SSjt4iaQigqajqFh1C3cCULD?cluster=devnet) (Winner `+0.58%` vs `-1.06%`) |
| **Verified Room PDAs** | Solana L1 | — | [Vault PDA (`46uQ7G...`)](https://explorer.solana.com/address/46uQ7G2qmMdYk6R4XAQkEeZaPaWjmyvxnhoJMGHMzyC8?cluster=devnet) · [Arena PDA (`8eimpF...`)](https://explorer.solana.com/address/8eimpFWPQ3oD2cBYgci7bzURmtmNyhQzdesX6PoD5kz4?cluster=devnet) |

---

## Program Instructions

| Instruction | Layer | Signer | Purpose |
|---|---|---|---|
| `create_room` | Solana L1 | Creator Wallet | Initializes `Vault` + `Arena` PDAs, escrows creator's SOL, binds Seat 0 `session_key` |
| `join_room` | Solana L1 | Joiner Wallet | Escrows entry SOL into `Vault` PDA, binds joiner's `session_key` |
| `cancel_room` | Solana L1 | Creator Wallet | Refunds solo creator if nobody else joined |
| `start_and_delegate` | Solana L1 | Seated Player | Delegates `Arena` PDA to pinned MagicBlock ER validator |
| `begin_round` | MagicBlock ER | Session Key | Locks live Pyth Lazer opening price & starts countdown (0 gas) |
| `tap` | MagicBlock ER | Session Key | Marks previous position to market at 20× leverage & flips `LONG / FLAT / SHORT` (0 gas, 0 popups) |
| `finish_round` | MagicBlock ER | Session Key / Player | Marks all seats to market at expiry, crowns winner, and calls `MagicIntentBundleBuilder::commit_and_undelegate` |
| `claim_payout` | Solana L1 | Permissionless | Verifies `Arena` returned to L1 as `Finished` and transfers `Vault` SOL pot strictly to winner's main wallet |

---

## Quickstart

### 1. Build & Test the On-Chain Program
```bash
cargo test --manifest-path programs/candleroyale/Cargo.toml
cargo-build-sbf --manifest-path programs/candleroyale/Cargo.toml --sbf-out-dir target/deploy
```

### 2. Deploy to Solana Devnet & Run Live L1 ↔ ER E2E Verification
```bash
# Ensure deployer wallet has ~3.5 Devnet SOL
solana program deploy target/deploy/candleroyale.so \
  --program-id target/deploy/candleroyale-keypair.json \
  --url https://api.devnet.solana.com

# Verify codec + live Pyth Lazer ER feeds
npm install
npm run test:codec

# Run full 2-player Devnet + MagicBlock ER lifecycle test
npm run e2e:devnet
```

### 3. Run the Web Arena
```bash
cd app
npm install
npm run dev
```
Open `http://localhost:3000`. Use **Phantom** in Window 1 and **Solflare** (or the built-in **Devnet Burner Keypair**) in Window 2 for live 2-tab PvP on Devnet.
