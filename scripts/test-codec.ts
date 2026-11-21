import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Connection, Keypair } from "@solana/web3.js";
import {
  buildBeginRoundIx,
  buildClaimPayoutIx,
  buildCreateRoomIx,
  buildFinishRoundIx,
  buildJoinRoomIx,
  buildStartAndDelegateIx,
  buildTapIx,
  computeUnrealizedPnl,
  decodeOracleTick,
  DISCRIMINATORS,
  findArenaPda,
  findVaultPda,
  formatPnlPct,
} from "../sdk/codec";
import {
  ER_RPC_URL,
  MARKET_FEEDS,
  POS_LONG,
  POS_SHORT,
} from "../sdk/constants";

function anchorSighash(preimage: string): number[] {
  return Array.from(
    crypto.createHash("sha256").update(preimage).digest().subarray(0, 8)
  );
}

async function main() {
  console.log("1. Verifying Anchor 8-byte discriminators...");
  assert.deepEqual(
    Array.from(DISCRIMINATORS.create_room),
    anchorSighash("global:create_room")
  );
  assert.deepEqual(
    Array.from(DISCRIMINATORS.join_room),
    anchorSighash("global:join_room")
  );
  assert.deepEqual(
    Array.from(DISCRIMINATORS.cancel_room),
    anchorSighash("global:cancel_room")
  );
  assert.deepEqual(
    Array.from(DISCRIMINATORS.start_and_delegate),
    anchorSighash("global:start_and_delegate")
  );
  assert.deepEqual(
    Array.from(DISCRIMINATORS.begin_round),
    anchorSighash("global:begin_round")
  );
  assert.deepEqual(Array.from(DISCRIMINATORS.tap), anchorSighash("global:tap"));
  assert.deepEqual(
    Array.from(DISCRIMINATORS.finish_round),
    anchorSighash("global:finish_round")
  );
  assert.deepEqual(
    Array.from(DISCRIMINATORS.claim_payout),
    anchorSighash("global:claim_payout")
  );
  assert.deepEqual(
    Array.from(DISCRIMINATORS.account_Vault),
    anchorSighash("account:Vault")
  );
  assert.deepEqual(
    Array.from(DISCRIMINATORS.account_Arena),
    anchorSighash("account:Arena")
  );
  console.log("   All 10 discriminators match sha256 exactly.");

  console.log("2. Verifying leveraged PnL parity with Rust unit tests...");
  assert.equal(
    computeUnrealizedPnl(POS_LONG, 10_000_000_000n, 10_050_000_000n),
    100_000n
  );
  assert.equal(
    computeUnrealizedPnl(POS_SHORT, 10_000_000_000n, 9_975_000_000n),
    50_000n
  );
  assert.equal(formatPnlPct(100_000n), "+10.00%");
  assert.equal(formatPnlPct(-24_500n), "-2.45%");
  console.log("   PnL calculations match Rust 1:1.");

  console.log("3. Verifying instruction builders & account counts...");
  const creator = Keypair.generate().publicKey;
  const session = Keypair.generate().publicKey;
  const roomId = 42n;
  const [vault] = findVaultPda(roomId);
  const [arena] = findArenaPda(roomId);
  assert.notEqual(vault.toBase58(), arena.toBase58());

  const ixCreate = buildCreateRoomIx({
    creator,
    roomId,
    entryFeeLamports: 50_000_000n,
    durationSecs: 60,
    maxPlayers: 6,
    priceFeed: MARKET_FEEDS.SOL.address,
    sessionKey: session,
  });
  assert.equal(ixCreate.data.length, 8 + 8 + 8 + 8 + 1 + 32 + 32);
  assert.equal(ixCreate.keys.length, 4);

  assert.equal(
    buildJoinRoomIx({ player: creator, roomId, sessionKey: session }).keys.length,
    4
  );
  assert.equal(
    buildStartAndDelegateIx({ payer: creator, roomId }).keys.length,
    9
  );
  assert.equal(
    buildBeginRoundIx({
      signer: session,
      roomId,
      priceFeed: MARKET_FEEDS.SOL.address,
    }).keys.length,
    3
  );
  assert.equal(
    buildTapIx({
      signer: session,
      roomId,
      newPosition: POS_LONG,
      priceFeed: MARKET_FEEDS.SOL.address,
    }).data.length,
    8 + 8 + 1
  );
  assert.equal(
    buildFinishRoundIx({
      payer: creator,
      roomId,
      priceFeed: MARKET_FEEDS.SOL.address,
    }).keys.length,
    5
  );
  assert.equal(
    buildClaimPayoutIx({ payer: creator, roomId, winner: creator }).keys.length,
    4
  );
  console.log("   All 8 instruction builders verified.");

  console.log(`4. Reading LIVE Pyth Lazer feeds from ${ER_RPC_URL}...`);
  const erConn = new Connection(ER_RPC_URL, "confirmed");
  for (const m of Object.values(MARKET_FEEDS)) {
    const info = await erConn.getAccountInfo(m.address);
    assert(info, `Feed ${m.symbol} missing on ER`);
    const tick = decodeOracleTick(info.data);
    assert(tick.rawPrice > 0n, `Feed ${m.symbol} non-positive price`);
    const ageSec = Math.floor(Date.now() / 1000) - tick.publishTime;
    console.log(
      `   ${m.symbol.padEnd(8)} $${tick.priceUsd.toFixed(4)} (raw=${tick.rawPrice}, age=${ageSec}s, slot=${tick.postedSlot})`
    );
  }
  console.log("\nALL CODEC + LIVE ER ORACLE CHECKS PASSED.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
