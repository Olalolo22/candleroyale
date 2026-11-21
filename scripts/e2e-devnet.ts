import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  buildBeginRoundIx,
  buildClaimPayoutIx,
  buildCreateRoomIx,
  buildFinishRoundIx,
  buildJoinRoomIx,
  buildStartAndDelegateIx,
  buildTapIx,
  decodeArena,
  decodeOracleTick,
  decodeVault,
  findArenaPda,
  findVaultPda,
  formatPnlPct,
} from "../sdk/codec";
import {
  CANDLEROYALE_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  ER_RPC_URL,
  ER_VALIDATOR_PUBKEY,
  MARKET_FEEDS,
  POS_FLAT,
  POS_LONG,
  POS_SHORT,
  SOLANA_L1_RPC,
} from "../sdk/constants";

function loadWallet(): Keypair {
  const walletPath =
    process.env.SOLANA_WALLET ||
    path.join(os.homedir(), ".config", "solana", "id.json");
  const raw = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function confirmHttp(
  conn: Connection,
  sig: string,
  pollMs: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await conn.getSignatureStatuses([sig]);
    const st = res.value[0];
    if (st) {
      if (st.err) {
        const txDetails = await conn
          .getTransaction(sig, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
          .catch(() => null);
        const logs = txDetails?.meta?.logMessages?.join("\n  ") ?? "";
        throw new Error(
          `Tx ${sig} failed: ${JSON.stringify(st.err)}${logs ? `\nLogs:\n  ${logs}` : ""}`
        );
      }
      if (
        st.confirmationStatus === "confirmed" ||
        st.confirmationStatus === "finalized"
      ) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out confirming tx ${sig}`);
}

async function sendL1Tx(
  l1Conn: Connection,
  tx: Transaction,
  signers: Keypair[]
): Promise<string> {
  const { blockhash } = await l1Conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await l1Conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await confirmHttp(l1Conn, sig, 600, 45_000);
  return sig;
}

async function sendErTx(
  erConn: Connection,
  tx: Transaction,
  signers: Keypair[]
): Promise<{ sig: string; ms: number }> {
  const { blockhash } = await erConn.getLatestBlockhash("confirmed");
  const t0 = Date.now();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await erConn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
  await confirmHttp(erConn, sig, 30, 20_000);
  return { sig, ms: Date.now() - t0 };
}

async function waitForOwner(
  conn: Connection,
  pubkey: PublicKey,
  expectedOwner: PublicKey,
  timeoutSec = 45
): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const info = await conn.getAccountInfo(pubkey, "confirmed");
    if (info && info.owner.equals(expectedOwner)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  const l1 = new Connection(SOLANA_L1_RPC, "confirmed");
  const er = new Connection(ER_RPC_URL, "confirmed");

  const playerA = loadWallet();
  const playerB = Keypair.generate();
  const sessionA = Keypair.generate();
  const sessionB = Keypair.generate();

  const balA = await l1.getBalance(playerA.publicKey);
  console.log(`Program ID: ${CANDLEROYALE_PROGRAM_ID.toBase58()}`);
  console.log(`L1 RPC:     ${SOLANA_L1_RPC}`);
  console.log(
    `ER RPC:     ${ER_RPC_URL} (validator ${ER_VALIDATOR_PUBKEY.toBase58()})`
  );
  console.log(
    `Player A:   ${playerA.publicKey.toBase58()} (${(balA / LAMPORTS_PER_SOL).toFixed(4)} SOL)`
  );
  console.log(`Player B:   ${playerB.publicKey.toBase58()}`);
  console.log(`Session A:  ${sessionA.publicKey.toBase58()} (ephemeral, 0 SOL)`);
  console.log(`Session B:  ${sessionB.publicKey.toBase58()} (ephemeral, 0 SOL)`);

  if (balA < 0.08 * LAMPORTS_PER_SOL) {
    throw new Error(
      `Need at least 0.08 Devnet SOL on ${playerA.publicKey.toBase58()} to fund Player B and run E2E.`
    );
  }

  // Fund Player B with 0.03 SOL for entry_fee (0.01) + tx fees
  console.log("\n[1/8] Funding Player B on Devnet L1...");
  const fundSig = await sendL1Tx(
    l1,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: playerA.publicKey,
        toPubkey: playerB.publicKey,
        lamports: 30_000_000,
      })
    ),
    [playerA]
  );
  console.log(`  fund B tx:      https://explorer.solana.com/tx/${fundSig}?cluster=devnet`);

  const roomId = BigInt(Date.now());
  const entryFee = 10_000_000n; // 0.01 SOL
  const durationSecs = 18; // Short E2E sprint
  const priceFeed = MARKET_FEEDS.SOL.address;
  const [vaultPda] = findVaultPda(roomId);
  const [arenaPda] = findArenaPda(roomId);

  console.log(
    `\n[2/8] L1 create_room (roomId=${roomId}, pot=0.01 SOL, SOL/USD)...`
  );
  const createSig = await sendL1Tx(
    l1,
    new Transaction().add(
      buildCreateRoomIx({
        creator: playerA.publicKey,
        roomId,
        entryFeeLamports: entryFee,
        durationSecs,
        maxPlayers: 2,
        priceFeed,
        sessionKey: sessionA.publicKey,
      })
    ),
    [playerA]
  );
  console.log(
    `  create_room tx: https://explorer.solana.com/tx/${createSig}?cluster=devnet`
  );

  console.log(
    "\n[3/8] L1 join_room (Player B escrows 0.01 SOL -> 0.02 SOL pot)..."
  );
  const joinSig = await sendL1Tx(
    l1,
    new Transaction().add(
      buildJoinRoomIx({
        player: playerB.publicKey,
        roomId,
        sessionKey: sessionB.publicKey,
      })
    ),
    [playerB]
  );
  console.log(
    `  join_room tx:   https://explorer.solana.com/tx/${joinSig}?cluster=devnet`
  );

  console.log("\n[4/8] L1 start_and_delegate (Arena PDA -> MagicBlock ER)...");
  const delSig = await sendL1Tx(
    l1,
    new Transaction().add(
      buildStartAndDelegateIx({
        payer: playerA.publicKey,
        roomId,
        validator: ER_VALIDATOR_PUBKEY,
      })
    ),
    [playerA]
  );
  console.log(
    `  delegate tx:    https://explorer.solana.com/tx/${delSig}?cluster=devnet`
  );

  const delegated = await waitForOwner(l1, arenaPda, DELEGATION_PROGRAM_ID, 30);
  if (!delegated) throw new Error("Arena PDA did not delegate to DLP in time");
  console.log("  Confirmed on L1: Arena owner == DELEGATION_PROGRAM_ID");
  await new Promise((r) => setTimeout(r, 2500));

  console.log(
    "\n[5/8] ER begin_round (signed by ephemeral Session Key A, 0 wallet popups, 0 gas)..."
  );
  const beginRes = await sendErTx(
    er,
    new Transaction().add(
      buildBeginRoundIx({
        signer: sessionA.publicKey,
        roomId,
        priceFeed,
      })
    ),
    [sessionA]
  );
  console.log(`  begin_round ER tx (${beginRes.ms}ms): ${beginRes.sig}`);

  console.log(
    "\n[6/8] ER gasless Session-Key trading sprint (LONG / SHORT / FLAT on live Pyth Lazer)..."
  );
  const moves: Array<{
    label: string;
    signer: Keypair;
    pos: -1 | 0 | 1;
    waitMs: number;
  }> = [
    { label: "A -> LONG ", signer: sessionA, pos: POS_LONG, waitMs: 3000 },
    { label: "B -> SHORT", signer: sessionB, pos: POS_SHORT, waitMs: 4000 },
    { label: "A -> SHORT", signer: sessionA, pos: POS_SHORT, waitMs: 4000 },
    { label: "B -> LONG ", signer: sessionB, pos: POS_LONG, waitMs: 4000 },
    { label: "A -> FLAT ", signer: sessionA, pos: POS_FLAT, waitMs: 4000 },
  ];

  for (const m of moves) {
    const res = await sendErTx(
      er,
      new Transaction().add(
        buildTapIx({
          signer: m.signer.publicKey,
          roomId,
          newPosition: m.pos,
          priceFeed,
        })
      ),
      [m.signer]
    );
    const feedInfo = await er.getAccountInfo(priceFeed);
    const tick = feedInfo ? decodeOracleTick(feedInfo.data) : null;
    console.log(
      `  tap ${m.label} | ${String(res.ms).padStart(4)}ms | SOL=$${tick ? tick.priceUsd.toFixed(4) : "?"} | sig=${res.sig}`
    );
    await new Promise((r) => setTimeout(r, m.waitMs));
  }

  // Wait until round ends_at passes on ER clock
  const erArenaInfo = await er.getAccountInfo(arenaPda);
  if (erArenaInfo) {
    const arenaState = decodeArena(erArenaInfo.data);
    const remainingMs = Number(arenaState.endsAt) * 1000 - Date.now() + 2500;
    if (remainingMs > 0) {
      console.log(
        `  Waiting ${(remainingMs / 1000).toFixed(1)}s for round timer expiry...`
      );
      await new Promise((r) => setTimeout(r, remainingMs));
    }
  }

  console.log(
    "\n[7/8] ER finish_round (close all positions, crown winner, commit & undelegate to L1)..."
  );
  const finishRes = await sendErTx(
    er,
    new Transaction().add(
      buildFinishRoundIx({
        payer: sessionA.publicKey,
        roomId,
        priceFeed,
      })
    ),
    [sessionA]
  );
  console.log(`  finish_round ER tx (${finishRes.ms}ms): ${finishRes.sig}`);

  console.log(
    "  Waiting for MagicBlock ER commit & ownership return on Solana L1..."
  );
  const returned = await waitForOwner(
    l1,
    arenaPda,
    CANDLEROYALE_PROGRAM_ID,
    45
  );
  if (!returned)
    throw new Error("Arena ownership did not return to program on L1");

  const finalArenaInfo = await l1.getAccountInfo(arenaPda, "confirmed");
  if (!finalArenaInfo) throw new Error("Arena account missing on L1");
  const finalArena = decodeArena(finalArenaInfo.data);
  const winnerSeat = finalArena.players[finalArena.winnerIndex];

  console.log("  Committed L1 Final Standings:");
  finalArena.players.forEach((p, idx) => {
    const crown = idx === finalArena.winnerIndex ? " [WINNER]" : "";
    console.log(
      `    Seat ${idx}: ${p.wallet.toBase58()} | PnL=${formatPnlPct(p.realizedPnl)} | taps=${p.tapCount}${crown}`
    );
  });

  console.log(
    "\n[8/8] L1 claim_payout (releasing 0.02 SOL pot from L1 Vault to winner wallet)..."
  );
  const preWinnerBal = await l1.getBalance(winnerSeat.wallet);
  const claimSig = await sendL1Tx(
    l1,
    new Transaction().add(
      buildClaimPayoutIx({
        payer: playerA.publicKey,
        roomId,
        winner: winnerSeat.wallet,
      })
    ),
    [playerA]
  );
  const postWinnerBal = await l1.getBalance(winnerSeat.wallet);
  const vaultInfo = await l1.getAccountInfo(vaultPda, "confirmed");
  const vault = vaultInfo ? decodeVault(vaultInfo.data) : null;

  console.log(
    `  claim_payout tx: https://explorer.solana.com/tx/${claimSig}?cluster=devnet`
  );
  console.log(
    `  Vault PDA:       https://explorer.solana.com/address/${vaultPda.toBase58()}?cluster=devnet`
  );
  console.log(
    `  Arena PDA:       https://explorer.solana.com/address/${arenaPda.toBase58()}?cluster=devnet`
  );
  console.log(
    `  Winner balance delta: +${((postWinnerBal - preWinnerBal) / LAMPORTS_PER_SOL).toFixed(5)} SOL (vault.claimed=${vault?.claimed})`
  );
  console.log("\nFULL SOLANA L1 <-> MAGICBLOCK ER E2E VERIFIED!");
}

main().catch((err) => {
  console.error("\nE2E failed:", err);
  process.exit(1);
});
