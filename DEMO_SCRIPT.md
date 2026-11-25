# CandleRoyale — 60-Second Blitz v10 Demo Recording Script

> **Golden rule:** Zero intro slides, zero logo animations, zero simulated data. Start directly on the live app. One person, one window: your three rivals are **practice bots**, and each one is a real seat with its own wallet, its own stake in the vault, and its own session key trading against the same live price.

## Pre-Recording Setup (2 minutes before hitting Record)
1. One browser window, Phantom on **Devnet** with **>= 0.1 SOL** (you fund your stake plus three bot stakes in a single approval).
2. Open the live deployed CandleRoyale app. Turn sound on.
3. Lobby ticket: Market **SOL**, Stake **0.01 SOL**, Round **30s** or **60s**, Players **4**.
4. Optional: a tab on `https://explorer.solana.com/?cluster=devnet` for the payout proof.

---

## Beat-by-Beat Script (~65 seconds)

### 0:00–0:08 — Hook + L1 Custody
* **Action:** Click **Create room and stake 0.01 SOL**, approve Phantom once.
* **Voiceover:** *"CandleRoyale is a 60-second PvP trading battle on Solana. Everyone stakes real SOL into a vault on Solana, then trades one live price at 20x. Best score takes the pot."*

### 0:08–0:18 — Rivals Take Their Seats + MagicBlock Delegation
* **Action:** Click **Add 3 practice bots**, approve once. Watch three trader badges fill the standings: Momentum, Contrarian, Scalper. The pot reads `0.04 SOL`.
* **Action:** Click **Start room**. The phase rail moves from `Fill seats` to `Ready`.
* **Voiceover:** *"Each rival is a real funded seat with its own stake in the vault. The SOL never leaves Solana. Only the scoreboard moves into MagicBlock's Ephemeral Rollup, so every trade is gasless and instant."*

### 0:18–0:44 — Rapid-Fire Round (0 Popups, 0 Gas)
* **Action:** Tap **Long (`W`)**, **Short (`S`)** and **Flat (`Space`)** as the candles move. The bots trade on their own; the standings reshuffle live. Point at the **On-chain log**: your taps and every bot tap land as real ER transactions in ~60–130ms with no fee.
* **Voiceover:** *"No wallet popups, no gas. Every tap, mine and theirs, is a real MagicBlock ER transaction signed by a session key, marked to market on MagicBlock's live Pyth Lazer feed. That's impossible at Solana's 400ms block time."*

### 0:44–0:58 — Auto-Settle + L1 Payout Proof
* **Action:** At `0.0` the room **settles itself** within the 3-second grace window. The winner reveal appears.
* **Action:** Click **Claim** (if you won) or **Pay out the winner**, then open the **Solana Explorer** link in the On-chain log.
* **Voiceover:** *"At zero, MagicBlock commits the final scores and hands the room back to Solana, which unlocks the vault and pays the pot straight to the winner, verifiable on Explorer."*

### 0:58–1:05 — Close
* **Action (after recording, off-camera):** Click **Return bot SOL to me** to sweep the bots' stakes and any winnings back to your wallet.
* **Voiceover:** *"Real SOL custody on Solana, zero-gas real-time PvP on MagicBlock. That's CandleRoyale."*

---

## Real Player-vs-Player Variant
Send the room's **Invite link** to a friend, or open it yourself on a second device or an incognito window with the **Devnet burner** (fund it from the faucet first). Any seat a human doesn't take can still be filled with practice bots.
