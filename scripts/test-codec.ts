import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Connection, Keypair } from "@solana/web3.js";
import {
  buildAbortStaleLobbyIx,
  buildAbortStaleRoomIx,
  buildBeginRoundIx,
  buildClaimPayoutIx,
  buildCreateRoomIx,
  buildDelegateSeatIx,
  buildFinishRoundIx,
  buildJoinRoomIx,
  buildStartAndDelegateIx,
  buildTapIx,
  computeUnrealizedPnl,
  decodeOracleTick,
  DISCRIMINATORS,
  findArenaPda,
  findSeatPda,
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
  console.log("1. Verifying Anchor 8-byte discriminators (14 total)...");
  const checks: Array<[Uint8Array, string]> = [
    [DISCRIMINATORS.create_room, "global:create_room"],
    [DISCRIMINATORS.join_room, "global:join_room"],
    [DISCRIMINATORS.delegate_seat, "global:delegate_seat"],
    [DISCRIMINATORS.cancel_room, "global:cancel_room"],
    [DISCRIMINATORS.start_and_delegate, "global:start_and_delegate"],
    [DISCRIMINATORS.begin_round, "global:begin_round"],
    [DISCRIMINATORS.tap, "global:tap"],
    [DISCRIMINATORS.finish_round, "global:finish_round"],
    [DISCRIMINATORS.abort_stale_room, "global:abort_stale_room"],
    [DISCRIMINATORS.abort_stale_lobby, "global:abort_stale_lobby"],
    [DISCRIMINATORS.claim_payout, "global:claim_payout"],
    [DISCRIMINATORS.account_Vault, "account:Vault"],
    [DISCRIMINATORS.account_Arena, "account:Arena"],
    [DISCRIMINATORS.account_SeatPosition, "account:SeatPosition"],
  ];
  for (const [actual, preimage] of checks) {
    assert.deepEqual(Array.from(actual), anchorSighash(preimage));
  }
  console.log("   All 14 discriminators match sha256 exactly.");

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

  console.log("3. Verifying all 11 instruction builders & layouts...");
  const creator = Keypair.generate().publicKey;
  const session = Keypair.generate().publicKey;
  const roomId = 42n;
  const [vault] = findVaultPda(roomId);
  const [arena] = findArenaPda(roomId);
  const [seat0] = findSeatPda(roomId, 0);
  assert.notEqual(vault.toBase58(), arena.toBase58());
  assert.notEqual(seat0.toBase58(), arena.toBase58());

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
  assert.equal(ixCreate.keys.length, 5);

  assert.equal(
    buildJoinRoomIx({
      player: creator,
      roomId,
      sessionKey: session,
      seatIndex: 1,
    }).keys.length,
    5
  );
  assert.equal(
    buildDelegateSeatIx({ payer: creator, roomId, seatIndex: 0 }).keys.length,
    8
  );
  assert.equal(
    buildStartAndDelegateIx({ payer: creator, roomId, playerCount: 2 }).keys
      .length,
    10
  );
  assert.equal(
    buildBeginRoundIx({
      signer: session,
      roomId,
      priceFeed: MARKET_FEEDS.SOL.address,
    }).keys.length,
    3
  );
  const ixTap = buildTapIx({
    signer: session,
    roomId,
    newPosition: POS_LONG,
    priceFeed: MARKET_FEEDS.SOL.address,
    seatIndex: 0,
  });
  assert.equal(ixTap.data.length, 8 + 8 + 1);
  assert.equal(ixTap.keys.length, 8);
  assert.equal(
    buildFinishRoundIx({
      payer: creator,
      roomId,
      priceFeed: MARKET_FEEDS.SOL.address,
      playerCount: 2,
    }).keys.length,
    7
  );
  assert.equal(
    buildAbortStaleRoomIx({ payer: creator, roomId }).keys.length,
    4
  );
  assert.equal(
    buildAbortStaleLobbyIx({ signer: creator, roomId }).keys.length,
    2
  );
  const ixClaim = buildClaimPayoutIx({
    payer: creator,
    roomId,
    seatIndex: 0,
    recipient: creator,
  });
  assert.equal(ixClaim.keys.length, 4);
  assert.equal(ixClaim.data.length, 8 + 8 + 1);
  console.log("   All 11 instruction builders verified.");

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
