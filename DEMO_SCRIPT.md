# CandleRoyale — 60-Second Blitz v10 Demo Recording Script

> **Golden rule:** Zero intro slides, zero logo animations, zero simulated data. Start directly on the live app with two side-by-side browser windows.

## Pre-Recording Setup (2 minutes before hitting Record)
1. Open **Window Left** (Player A — Phantom on Devnet with >= 0.1 SOL) and **Window Right** (Player B — Solflare or built-in Devnet Burner with >= 0.1 SOL).
2. Both windows open to the live deployed CandleRoyale app on Solana Devnet.
3. Have a tab ready on `https://explorer.solana.com/?cluster=devnet` (or click the live Explorer links directly from the app).
4. Set Duration to **30s**, Stake to **0.05 SOL**, Market to **SOL/USD**, Seats to **2P**.

---

## Beat-by-Beat Script (65 seconds total)

### 0:00–0:08 — Hook + L1 Custody
* **Action (Window Left):** Click **Create room and stake 0.05 SOL** and approve Phantom once.
* **Voiceover:** *"CandleRoyale is a 60-second PvP micro-trading battle on Solana. Players escrow real SOL into a Solana L1 vault, bind a scoped Session Key in one signature, and battle at 20x leverage on live Pyth Lazer feeds."*

### 0:08–0:18 — Player B Joins + MagicBlock Delegation
* **Action (Window Right):** In **Rooms** (Open tab) click **Join** -> click **Join for 0.05 SOL** (pot jumps to `0.1 SOL`).
* **Action (Window Left):** Click **Start room**. Watch the phase rail move from `Fill seats` -> `Ready`.
* **Voiceover:** *"The SOL vault never leaves Solana L1. Only the Arena PDA delegates into MagicBlock's Ephemeral Rollup so every trade runs gasless at sub-50ms speed."*

### 0:18–0:44 — Uncut Rapid-Fire PvP Sprint (0 Popups, 0 Gas)
* **Action (Both Windows):** Rapidly tap **LONG (`W`)**, **SHORT (`S`)**, and **FLAT (`Space`)** in both windows as the live Pyth Lazer SOL/USD candles move. Point cursor at the **On-chain log** showing real ER signatures landing in ~30–90ms with `0 SOL` gas and zero wallet popups.
* **Voiceover:** *"Notice zero Phantom popups and zero gas fees — every single tap is a real on-chain MagicBlock ER transaction signed by each player's ephemeral Session Key and marked to market against MagicBlock's live Pyth Lazer SOL feed. Impossible on 400ms L1."*

### 0:44–0:58 — Commit & Undelegate + L1 Payout Proof
* **Action (When clock hits 0.0s):** Click **Settle the room**. Watch ownership return to L1 and the winner reveal appear.
* **Action:** Click **Claim 0.1 SOL** and click the **Solana Explorer** tx link in the On-chain log.
* **Voiceover:** *"When the timer hits zero, MagicBlock commits the final PnL and undelegates the Arena back to Solana L1 — unlocking the L1 Vault to pay the full 0.10 SOL pot straight to the winner's wallet, verifiable on Solana Explorer."*

### 0:58–1:05 — Close
* **Voiceover:** *"Real SOL custody on L1, zero-gas sub-50ms PvP execution on MagicBlock ER, live Pyth Lazer feeds. That's CandleRoyale."*
