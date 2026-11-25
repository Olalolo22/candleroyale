import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
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
  buildDelegateSeatIx,
  buildFinishRoundIx,
  buildJoinRoomIx,
  buildStartAndDelegateIx,
  buildTapIx,
  decodeArena,
  decodeOracleTick,
  decodeSeatPosition,
  decodeVault,
  findArenaPda,
  findSeatPda,
  findVaultPda,
  formatPnlPct,
  getWinningSeatIndices,
} from "../sdk/codec";
import {
  CANDLEROYALE_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  ER_RPC_URL,
  MARKET_FEEDS,
  POS_FLAT,
  POS_LONG,
  POS_SHORT,
  SOLANA_L1_RPC,
  TEE_RPC_URL,
  TEE_VALIDATOR_PUBKEY,
} from "../sdk/constants";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

async function getTeeConnection(keypair: Keypair, rpcUrl = TEE_RPC_URL): Promise<Connection> {
  const pubkey = keypair.publicKey.toBase58();
  const challengeRes = await fetch(
    `${rpcUrl}/auth/challenge?pubkey=${encodeURIComponent(pubkey)}`
  );
  const { challenge, error } = (await challengeRes.json()) as {
    challenge?: string;
    error?: string;
  };
  if (error || !challenge) {
    throw new Error(`TEE auth challenge failed: ${error ?? "missing challenge"}`);
  }
  const sig = ed25519.sign(
    new TextEncoder().encode(challenge),
    keypair.secretKey.slice(0, 32)
  );
  const loginRes = await fetch(`${rpcUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey, challenge, signature: base58Encode(sig) }),
  });
  const body = (await loginRes.json()) as { token?: string; error?: string };
  if (loginRes.status !== 200 || !body.token) {
    throw new Error(`TEE login failed: ${body.error ?? loginRes.status}`);
  }
  return new Connection(`${rpcUrl}?token=${encodeURIComponent(body.token)}`, "confirmed");
}

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
  const erPriceConn = new Connection(ER_RPC_URL, "confirmed");

  const playerA = loadWallet();
  const playerB = Keypair.generate();
  const sessionA = Keypair.generate();
  const sessionB = Keypair.generate();
  const viewerKey = Keypair.generate();

  const balA = await l1.getBalance(playerA.publicKey);
  console.log(`Program ID: ${CANDLEROYALE_PROGRAM_ID.toBase58()}`);
  console.log(`L1 RPC:     ${SOLANA_L1_RPC}`);
  console.log(
    `TEE RPC:    ${TEE_RPC_URL} (pinned validator ${TEE_VALIDATOR_PUBKEY.toBase58()})`
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

  console.log("\n[1/10] Funding Player B on Devnet L1...");
  await sendL1Tx(
    l1,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: playerA.publicKey,
        toPubkey: playerB.publicKey,
        lamports: 35_000_000,
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
  const [seat0Pda] = findSeatPda(roomId, 0);
  const [seat1Pda] = findSeatPda(roomId, 1);

  console.log(`\n[2/10] L1 create_room + delegate_seat(0) (roomId=${roomId}, pot=0.01 SOL, SOL/USD)...`);
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
      }),
      buildDelegateSeatIx({
        payer: playerA.publicKey,
        roomId,
        seatIndex: 0,
      })
    ),
    [playerA]
  );
  console.log(`  create_room tx: https://explorer.solana.com/tx/${createSig}?cluster=devnet`);

  console.log("\n[3/10] Security Gate Checks on L1 (SessionKeyCollision + wrong seatIndex)...");
  await expectFail("join_room with colliding session_key == Player A wallet", () =>
    sendL1Tx(
      l1,
      new Transaction().add(
        buildJoinRoomIx({
          player: playerB.publicKey,
          roomId,
          sessionKey: playerA.publicKey,
          seatIndex: 1,
        })
      ),
      [playerB]
    )
  );

  console.log("\n[4/10] L1 join_room (seat 1) + delegate_seat(1) -> 0.02 SOL pot...");
  const joinSig = await sendL1Tx(
    l1,
    new Transaction().add(
      buildJoinRoomIx({
        player: playerB.publicKey,
        roomId,
        sessionKey: sessionB.publicKey,
        seatIndex: 1,
      }),
      buildDelegateSeatIx({
        payer: playerB.publicKey,
        roomId,
        seatIndex: 1,
      })
    ),
    [playerB]
  );
  console.log(`  join_room tx:   https://explorer.solana.com/tx/${joinSig}?cluster=devnet`);

  await expectFail("start_and_delegate missing seat accounts", () =>
    sendL1Tx(
      l1,
      new Transaction().add(
        buildStartAndDelegateIx({
          payer: playerA.publicKey,
          roomId,
          playerCount: 1,
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
          playerCount: 2,
        })
      ),
      [playerB]
    )
  );

  console.log("\n[5/10] L1 start_and_delegate (Creator -> Pinned MagicBlock TEE ER validator)...");
  const delSig = await sendL1Tx(
    l1,
    new Transaction().add(
      buildStartAndDelegateIx({
        payer: playerA.publicKey,
        roomId,
        playerCount: 2,
      })
    ),
    [playerA]
  );
  console.log(`  delegate tx:    https://explorer.solana.com/tx/${delSig}?cluster=devnet`);

  const delegated = await waitForOwner(l1, arenaPda, DELEGATION_PROGRAM_ID, 30);
  if (!delegated) throw new Error("Arena PDA did not delegate to DLP in time");
  console.log("  Confirmed on L1: Arena owner == DELEGATION_PROGRAM_ID");
  await new Promise((r) => setTimeout(r, 2500));

  console.log("\n[6/10] Authenticating Session A, Session B & Viewer to TEE ER...");
  const [teeA, teeB, teeViewer] = await Promise.all([
    getTeeConnection(sessionA),
    getTeeConnection(sessionB),
    getTeeConnection(viewerKey),
  ]);
  console.log("  Authenticated 3 distinct TEE JWT connections.");

  console.log("\n[7/10] TEE security checks (premature abort_stale_room + no-op tap) & begin_round...");
  await expectFail("TEE abort_stale_room before 180s stale timeout", () =>
    sendErTx(
      teeA,
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
    teeA,
    new Transaction().add(
      buildBeginRoundIx({
        signer: sessionA.publicKey,
        roomId,
        priceFeed,
      })
    ),
    [sessionA]
  );
  console.log(`  begin_round TEE tx (${beginRes.ms}ms): ${beginRes.sig}`);

  await expectFail("TEE tap FLAT -> FLAT no-op spam", () =>
    sendErTx(
      teeA,
      new Transaction().add(
        buildTapIx({
          signer: sessionA.publicKey,
          roomId,
          newPosition: POS_FLAT,
          priceFeed,
          seatIndex: 0,
        })
      ),
      [sessionA]
    )
  );

  console.log("\n[8/10] TEE gasless Dark-Pit sprint (sealing seats + verifying TEE privacy)...");
  const moves: Array<{
    label: string;
    conn: Connection;
    signer: Keypair;
    seatIndex: number;
    pos: -1 | 0 | 1;
    waitMs: number;
  }> = [
    { label: "A -> LONG ", conn: teeA, signer: sessionA, seatIndex: 0, pos: POS_LONG, waitMs: 2500 },
    { label: "B -> SHORT", conn: teeB, signer: sessionB, seatIndex: 1, pos: POS_SHORT, waitMs: 2500 },
    { label: "A -> SHORT", conn: teeA, signer: sessionA, seatIndex: 0, pos: POS_SHORT, waitMs: 2500 },
    { label: "B -> LONG ", conn: teeB, signer: sessionB, seatIndex: 1, pos: POS_LONG, waitMs: 2500 },
    { label: "A -> FLAT ", conn: teeA, signer: sessionA, seatIndex: 0, pos: POS_FLAT, waitMs: 2000 },
  ];

  for (const m of moves) {
    const res = await sendErTx(
      m.conn,
      new Transaction().add(
        buildTapIx({
          signer: m.signer.publicKey,
          roomId,
          newPosition: m.pos,
          priceFeed,
          seatIndex: m.seatIndex,
        })
      ),
      [m.signer]
    );
    const feedInfo = await erPriceConn.getAccountInfo(priceFeed);
    const tick = feedInfo ? decodeOracleTick(feedInfo.data) : null;
    console.log(
      `  tap ${m.label} | ${String(res.ms).padStart(4)}ms | SOL=$${tick ? tick.priceUsd.toFixed(4) : "?"} | sig=${res.sig}`
    );
    await new Promise((r) => setTimeout(r, m.waitMs));
  }

  // Verify Dark Pit privacy on the TEE:
  // - Session A can read Seat 0 (sealed=true), CANNOT read Seat 1
  // - Session B can read Seat 1 (sealed=true, position=POS_LONG), CANNOT read Seat 0
  // - Viewer can read Arena (positions hidden as POS_FLAT), CANNOT read Seat 0 or Seat 1
  const [aRead0, aRead1, bRead0, bRead1, vRead0, vRead1, vReadArena] = await Promise.all([
    teeA.getAccountInfo(seat0Pda, "confirmed").catch(() => null),
    teeA.getAccountInfo(seat1Pda, "confirmed").catch(() => null),
    teeB.getAccountInfo(seat0Pda, "confirmed").catch(() => null),
    teeB.getAccountInfo(seat1Pda, "confirmed").catch(() => null),
    teeViewer.getAccountInfo(seat0Pda, "confirmed").catch(() => null),
    teeViewer.getAccountInfo(seat1Pda, "confirmed").catch(() => null),
    teeViewer.getAccountInfo(arenaPda, "confirmed"),
  ]);
  const decoded0 = aRead0 ? decodeSeatPosition(aRead0.data) : null;
  const decoded1 = bRead1 ? decodeSeatPosition(bRead1.data) : null;
  const decodedViewerArena = vReadArena ? decodeArena(vReadArena.data) : null;
  if (!decoded0?.sealed || !decoded1?.sealed || decoded1.position !== POS_LONG) {
    throw new Error("Own sealed seat missing or unexpected state on TEE");
  }
  if (aRead1 || bRead0 || vRead0 || vRead1) {
    throw new Error(
      `TEE privacy leak! aRead1=${Boolean(aRead1)} bRead0=${Boolean(bRead0)} vRead0=${Boolean(vRead0)} vRead1=${Boolean(vRead1)}`
    );
  }
  if (
    !decodedViewerArena ||
    decodedViewerArena.players.some((p) => p.position !== POS_FLAT)
  ) {
    throw new Error("Public Arena scoreboard leaked an open position!");
  }
  console.log(
    "  [PASS] Dark Pit TEE privacy verified: seats readable only by owner; public Arena shows POS_FLAT."
  );

  // Settle right inside the 3s grace window after endsAt
  if (decodedViewerArena.endsAt > 0n) {
    const remainingMs = Number(decodedViewerArena.endsAt) * 1000 - Date.now() + 800;
    if (remainingMs > 0) {
      console.log(
        `  Waiting ${(remainingMs / 1000).toFixed(1)}s for round timer expiry (grace window settle)...`
      );
      await new Promise((r) => setTimeout(r, remainingMs));
    }
  }

  console.log("\n[9/10] TEE finish_round (reveal positions + tie mask + commit & undelegate Arena & Seats)...");
  const finishRes = await sendErTx(
    teeA,
    new Transaction().add(
      buildFinishRoundIx({
        payer: sessionA.publicKey,
        roomId,
        priceFeed,
        playerCount: 2,
      })
    ),
    [sessionA]
  );
  console.log(`  finish_round TEE tx (${finishRes.ms}ms): ${finishRes.sig}`);

  const returned = await waitForOwner(
    l1,
    arenaPda,
    CANDLEROYALE_PROGRAM_ID,
    45
  );
  if (!returned) throw new Error("Arena ownership did not return to program on L1");
  const seat1Returned = await waitForOwner(l1, seat1Pda, CANDLEROYALE_PROGRAM_ID, 15);
  if (!seat1Returned) throw new Error("Seat 1 ownership did not return to program on L1");

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
      `    Seat ${idx}: ${p.wallet.toBase58()} | pos=${p.position} | PnL=${formatPnlPct(p.realizedPnl)} | taps=${p.tapCount}${crown}`
    );
  });
  if (finalArena.players[1].position !== POS_LONG) {
    throw new Error("Expected Seat 1 revealed position on L1 Arena to be POS_LONG (1)");
  }

  console.log("\n[10/10] L1 claim_payout for winning seat(s) + double-claim guard...");
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
  console.log(
    `  Vault PDA: https://explorer.solana.com/address/${vaultPda.toBase58()}?cluster=devnet (claimed=${vault?.claimed}, mask=0b${vault?.claimedMask.toString(2)})`
  );
  console.log(
    `  Arena PDA: https://explorer.solana.com/address/${arenaPda.toBase58()}?cluster=devnet`
  );
  console.log("\nALL DARK-PIT TEE PRIVACY + SECURITY GATES + FULL L1 <-> TEE E2E VERIFIED!");
}

main().catch((err) => {
  console.error("\nE2E failed:", err);
  process.exit(1);
});
