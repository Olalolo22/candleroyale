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
  buildAbortStaleRoomIx,
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
  getWinningSeatIndices,
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

async function expectFail(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [PASS] Security check rejected (${label}): ${msg.slice(0, 95)}`);
    return;
  }
  throw new Error(`Security check FAILED — ${label} should have been rejected!`);
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
    `ER RPC:     ${ER_RPC_URL} (pinned validator ${ER_VALIDATOR_PUBKEY.toBase58()})`
  );
  console.log(
    `Player A:   ${playerA.publicKey.toBase58()} (${(balA / LAMPORTS_PER_SOL).toFixed(4)} SOL)`
  );
  console.log(`Player B:   ${playerB.publicKey.toBase58()}`);

  if (balA < 0.08 * LAMPORTS_PER_SOL) {
    throw new Error(
      `Need at least 0.08 Devnet SOL on ${playerA.publicKey.toBase58()}.`
    );
  }

  console.log("\n[1/9] Funding Player B on Devnet L1...");
  await sendL1Tx(
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

  const roomId = BigInt(Date.now());
  const entryFee = 10_000_000n; // 0.01 SOL
  const durationSecs = 22;
  const priceFeed = MARKET_FEEDS.SOL.address;
  const [vaultPda] = findVaultPda(roomId);
  const [arenaPda] = findArenaPda(roomId);

  console.log(`\n[2/9] L1 create_room (roomId=${roomId}, pot=0.01 SOL, SOL/USD)...`);
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
  console.log(`  create_room tx: https://explorer.solana.com/tx/${createSig}?cluster=devnet`);

  console.log("\n[3/9] Security Gate Checks on L1 (SessionKeyCollision + InvalidValidator)...");
  await expectFail("join_room with colliding session_key == Player A wallet", () =>
    sendL1Tx(
      l1,
      new Transaction().add(
        buildJoinRoomIx({
          player: playerB.publicKey,
          roomId,
          sessionKey: playerA.publicKey,
        })
      ),
      [playerB]
    )
  );

  console.log("\n[4/9] L1 join_room (Player B with unique Session Key B -> 0.02 SOL pot)...");
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
  console.log(`  join_room tx:   https://explorer.solana.com/tx/${joinSig}?cluster=devnet`);

  // Verify non-creator & rogue validator both rejected on L1
  await expectFail("start_and_delegate with rogue ER validator", () =>
    sendL1Tx(
      l1,
      new Transaction().add(
        buildStartAndDelegateIx({
          payer: playerA.publicKey,
          roomId,
          validator: Keypair.generate().publicKey,
        })
      ),
      [playerA]
    )
  );
  await expectFail("start_and_delegate called by non-creator Player B", () =>
    sendL1Tx(
      l1,
      new Transaction().add(
        buildStartAndDelegateIx({
          payer: playerB.publicKey,
          roomId,
          validator: ER_VALIDATOR_PUBKEY,
        })
      ),
      [playerB]
    )
  );

  console.log("\n[5/9] L1 start_and_delegate (Creator -> Pinned MagicBlock ER validator)...");
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
  console.log(`  delegate tx:    https://explorer.solana.com/tx/${delSig}?cluster=devnet`);

  const delegated = await waitForOwner(l1, arenaPda, DELEGATION_PROGRAM_ID, 30);
  if (!delegated) throw new Error("Arena PDA did not delegate to DLP in time");
  console.log("  Confirmed on L1: Arena owner == DELEGATION_PROGRAM_ID");
  await new Promise((r) => setTimeout(r, 2500));

  console.log("\n[6/9] ER security checks (premature abort_stale_room + no-op tap spam) & begin_round...");
  await expectFail("ER abort_stale_room before 180s stale timeout", () =>
    sendErTx(
      er,
      new Transaction().add(
        buildAbortStaleRoomIx({
          payer: sessionA.publicKey,
          roomId,
        })
      ),
      [sessionA]
    )
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

  await expectFail("ER tap FLAT -> FLAT no-op spam", () =>
    sendErTx(
      er,
      new Transaction().add(
        buildTapIx({
          signer: sessionA.publicKey,
          roomId,
          newPosition: POS_FLAT,
          priceFeed,
        })
      ),
      [sessionA]
    )
  );

  console.log("\n[7/9] ER gasless Session-Key trading sprint (10s oracle freshness enforced)...");
  const moves: Array<{
    label: string;
    signer: Keypair;
    pos: -1 | 0 | 1;
    waitMs: number;
  }> = [
    { label: "A -> LONG ", signer: sessionA, pos: POS_LONG, waitMs: 3000 },
    { label: "B -> SHORT", signer: sessionB, pos: POS_SHORT, waitMs: 3000 },
    { label: "A -> SHORT", signer: sessionA, pos: POS_SHORT, waitMs: 3000 },
    { label: "B -> LONG ", signer: sessionB, pos: POS_LONG, waitMs: 3000 },
    { label: "A -> FLAT ", signer: sessionA, pos: POS_FLAT, waitMs: 2500 },
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

  // Settle right inside the 3s grace window after endsAt
  const erArenaInfo = await er.getAccountInfo(arenaPda);
  if (erArenaInfo) {
    const arenaState = decodeArena(erArenaInfo.data);
    const remainingMs = Number(arenaState.endsAt) * 1000 - Date.now() + 800;
    if (remainingMs > 0) {
      console.log(
        `  Waiting ${(remainingMs / 1000).toFixed(1)}s for round timer expiry (grace window settle)...`
      );
      await new Promise((r) => setTimeout(r, remainingMs));
    }
  }

  console.log("\n[8/9] ER finish_round (deterministic close + tie mask + commit & undelegate)...");
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

  const returned = await waitForOwner(
    l1,
    arenaPda,
    CANDLEROYALE_PROGRAM_ID,
    45
  );
  if (!returned) throw new Error("Arena ownership did not return to program on L1");

  const finalArenaInfo = await l1.getAccountInfo(arenaPda, "confirmed");
  if (!finalArenaInfo) throw new Error("Arena account missing on L1");
  const finalArena = decodeArena(finalArenaInfo.data);
  const winners = getWinningSeatIndices(finalArena);

  console.log(
    `  Committed L1 Final Standings (winnerMask=0b${finalArena.winnerMask.toString(2)}):`
  );
  finalArena.players.forEach((p, idx) => {
    const crown = winners.includes(idx) ? " [WINNER]" : "";
    console.log(
      `    Seat ${idx}: ${p.wallet.toBase58()} | PnL=${formatPnlPct(p.realizedPnl)} | taps=${p.tapCount}${crown}`
    );
  });

  console.log("\n[9/9] L1 claim_payout for winning seat(s) + double-claim guard...");
  for (const seatIdx of winners) {
    const recipient = finalArena.players[seatIdx].wallet;
    const preBal = await l1.getBalance(recipient);
    const claimSig = await sendL1Tx(
      l1,
      new Transaction().add(
        buildClaimPayoutIx({
          payer: playerA.publicKey,
          roomId,
          seatIndex: seatIdx,
          recipient,
        })
      ),
      [playerA]
    );
    const postBal = await l1.getBalance(recipient);
    console.log(
      `  claim_payout seat ${seatIdx}: https://explorer.solana.com/tx/${claimSig}?cluster=devnet (+${((postBal - preBal) / LAMPORTS_PER_SOL).toFixed(5)} SOL)`
    );
  }

  await expectFail("duplicate claim_payout on already-paid winning seat", () =>
    sendL1Tx(
      l1,
      new Transaction().add(
        buildClaimPayoutIx({
          payer: playerA.publicKey,
          roomId,
          seatIndex: winners[0],
          recipient: finalArena.players[winners[0]].wallet,
        })
      ),
      [playerA]
    )
  );

  const vaultInfo = await l1.getAccountInfo(vaultPda, "confirmed");
  const vault = vaultInfo ? decodeVault(vaultInfo.data) : null;
  console.log(`  Vault PDA: https://explorer.solana.com/address/${vaultPda.toBase58()}?cluster=devnet (claimed=${vault?.claimed}, mask=0b${vault?.claimedMask.toString(2)})`);
  console.log(`  Arena PDA: https://explorer.solana.com/address/${arenaPda.toBase58()}?cluster=devnet`);
  console.log("\nALL SECURITY GATES + FULL L1 <-> MAGICBLOCK ER E2E VERIFIED!");
}

main().catch((err) => {
  console.error("\nE2E failed:", err);
  process.exit(1);
});
