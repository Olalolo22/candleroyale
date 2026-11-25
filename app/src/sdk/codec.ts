import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ARENA_ACCOUNT_SIZE,
  ARENA_LEVERAGE,
  ARENA_SEED,
  CANDLEROYALE_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  PERMISSION_PROGRAM_ID,
  PERMISSION_SEED,
  SEAT_ACCOUNT_SIZE,
  SEAT_SEED,
  DELEGATE_BUFFER_TAG,
  DELEGATION_METADATA_TAG,
  DELEGATION_PROGRAM_ID,
  DELEGATION_RECORD_TAG,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  MAX_PLAYERS,
  PNL_SCALE,
  POS_FLAT,
  PositionDir,
  VAULT_ACCOUNT_SIZE,
  VAULT_SEED,
} from "./constants";

// Precomputed Anchor 8-byte sighashes: sha256("global:<ix>")[0..8] & sha256("account:<Name>")[0..8]
export const DISCRIMINATORS = {
  create_room: new Uint8Array([130, 166, 32, 2, 247, 120, 178, 53]),
  join_room: new Uint8Array([95, 232, 188, 81, 124, 130, 78, 139]),
  delegate_seat: new Uint8Array([53, 85, 50, 81, 161, 68, 71, 212]),
  cancel_room: new Uint8Array([91, 107, 215, 178, 200, 224, 241, 237]),
  start_and_delegate: new Uint8Array([139, 194, 95, 32, 34, 32, 178, 251]),
  begin_round: new Uint8Array([209, 88, 27, 188, 15, 243, 202, 186]),
  tap: new Uint8Array([31, 254, 225, 122, 3, 186, 67, 245]),
  finish_round: new Uint8Array([23, 104, 163, 186, 110, 225, 11, 242]),
  abort_stale_room: new Uint8Array([48, 114, 196, 20, 83, 157, 76, 137]),
  abort_stale_lobby: new Uint8Array([47, 115, 74, 102, 217, 105, 230, 93]),
  claim_payout: new Uint8Array([127, 240, 132, 62, 227, 198, 146, 133]),
  account_Vault: new Uint8Array([211, 8, 232, 43, 2, 152, 117, 119]),
  account_Arena: new Uint8Array([243, 215, 44, 44, 231, 211, 232, 168]),
  account_SeatPosition: new Uint8Array([76, 145, 123, 146, 35, 205, 12, 0]),
} as const;

export const PRICE_UPDATE_V2_DISCRIMINATOR = new Uint8Array([
  0xea, 0xa1, 0x0e, 0x24, 0xac, 0xef, 0x0f, 0xe8,
]);

export type ArenaStatus = "Lobby" | "Live" | "Finished" | "Aborted";

export interface VaultAccount {
  roomId: bigint;
  creator: PublicKey;
  entryFee: bigint;
  totalPot: bigint;
  claimed: boolean;
  cancelled: boolean;
  claimedMask: number;
  bump: number;
}

export interface PlayerSeat {
  wallet: PublicKey;
  sessionKey: PublicKey;
  position: PositionDir;
  entryPrice: bigint;
  realizedPnl: bigint;
  tapCount: number;
  lastTapTs: bigint;
}

export interface ArenaAccount {
  roomId: bigint;
  creator: PublicKey;
  priceFeed: PublicKey;
  entryFee: bigint;
  durationSecs: bigint;
  maxPlayers: number;
  status: ArenaStatus;
  createdAt: bigint;
  startedAt: bigint;
  endsAt: bigint;
  startPrice: bigint;
  lastPrice: bigint;
  playerCount: number;
  winnerIndex: number;
  winnerMask: number;
  players: PlayerSeat[];
  bump: number;
}

export interface OracleTick {
  rawPrice: bigint;
  priceUsd: number;
  publishTime: number;
  postedSlot: bigint;
}

// ─── Binary helpers (browser-safe) ──────────────────────────────────────────

export function u64ToLeBytes(value: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─── PDA derivations ─────────────────────────────────────────────────────────

export function findVaultPda(
  roomId: bigint | number,
  programId = CANDLEROYALE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, u64ToLeBytes(roomId)],
    programId
  );
}

export function findArenaPda(
  roomId: bigint | number,
  programId = CANDLEROYALE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ARENA_SEED, u64ToLeBytes(roomId)],
    programId
  );
}

export function findSeatPda(
  roomId: bigint | number,
  seatIndex: number,
  programId = CANDLEROYALE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEAT_SEED, u64ToLeBytes(roomId), Uint8Array.of(seatIndex & 0xff)],
    programId
  );
}

export function findSeatPdas(
  roomId: bigint | number,
  playerCount: number,
  programId = CANDLEROYALE_PROGRAM_ID
): PublicKey[] {
  return Array.from(
    { length: playerCount },
    (_, i) => findSeatPda(roomId, i, programId)[0]
  );
}

export function findPermissionPda(account: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PERMISSION_SEED, account.toBytes()],
    PERMISSION_PROGRAM_ID
  )[0];
}

export interface SealedSeat {
  roomId: bigint;
  seatIndex: number;
  wallet: PublicKey;
  sessionKey: PublicKey;
  position: PositionDir;
  entryPrice: bigint;
  sealed: boolean;
}

/** Decode a private SeatPosition account (only readable by its own player on the TEE). */
export function decodeSeatPosition(data: Uint8Array): SealedSeat | null {
  if (data.length < SEAT_ACCOUNT_SIZE) return null;
  const disc = DISCRIMINATORS.account_SeatPosition;
  for (let i = 0; i < 8; i++) if (data[i] !== disc[i]) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const roomId = view.getBigUint64(o, true); o += 8;
  const seatIndex = view.getUint8(o); o += 1;
  const wallet = new PublicKey(data.slice(o, o + 32)); o += 32;
  const sessionKey = new PublicKey(data.slice(o, o + 32)); o += 32;
  const position = view.getInt8(o) as PositionDir; o += 1;
  const entryPrice = view.getBigInt64(o, true); o += 8;
  const sealed = view.getUint8(o) === 1;
  return { roomId, seatIndex, wallet, sessionKey, position, entryPrice, sealed };
}

export function findDelegationPdas(
  arenaPda: PublicKey,
  programId = CANDLEROYALE_PROGRAM_ID
) {
  const [bufferArena] = PublicKey.findProgramAddressSync(
    [DELEGATE_BUFFER_TAG, arenaPda.toBytes()],
    programId
  );
  const [delegationRecordArena] = PublicKey.findProgramAddressSync(
    [DELEGATION_RECORD_TAG, arenaPda.toBytes()],
    DELEGATION_PROGRAM_ID
  );
  const [delegationMetadataArena] = PublicKey.findProgramAddressSync(
    [DELEGATION_METADATA_TAG, arenaPda.toBytes()],
    DELEGATION_PROGRAM_ID
  );
  return { bufferArena, delegationRecordArena, delegationMetadataArena };
}

// ─── Account Decoders (100% byte-exact with Rust state.rs & oracle.rs) ───────

export function decodeVault(raw: Uint8Array): VaultAccount {
  if (
    raw.length < VAULT_ACCOUNT_SIZE ||
    !bytesEqual(raw.subarray(0, 8), DISCRIMINATORS.account_Vault)
  ) {
    throw new Error("Invalid Vault account data or discriminator");
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let o = 8;
  const roomId = view.getBigUint64(o, true);
  o += 8;
  const creator = new PublicKey(raw.subarray(o, o + 32));
  o += 32;
  const entryFee = view.getBigUint64(o, true);
  o += 8;
  const totalPot = view.getBigUint64(o, true);
  o += 8;
  const claimed = raw[o++] === 1;
  const cancelled = raw[o++] === 1;
  const claimedMask = raw[o++];
  const bump = raw[o++];
  return {
    roomId,
    creator,
    entryFee,
    totalPot,
    claimed,
    cancelled,
    claimedMask,
    bump,
  };
}

export function decodeArena(raw: Uint8Array): ArenaAccount {
  if (
    raw.length < ARENA_ACCOUNT_SIZE ||
    !bytesEqual(raw.subarray(0, 8), DISCRIMINATORS.account_Arena)
  ) {
    throw new Error("Invalid Arena account data or discriminator");
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let o = 8;
  const roomId = view.getBigUint64(o, true);
  o += 8;
  const creator = new PublicKey(raw.subarray(o, o + 32));
  o += 32;
  const priceFeed = new PublicKey(raw.subarray(o, o + 32));
  o += 32;
  const entryFee = view.getBigUint64(o, true);
  o += 8;
  const durationSecs = view.getBigInt64(o, true);
  o += 8;
  const maxPlayers = raw[o++];
  const statusByte = raw[o++];
  const status: ArenaStatus =
    statusByte === 0
      ? "Lobby"
      : statusByte === 1
        ? "Live"
        : statusByte === 2
          ? "Finished"
          : "Aborted";
  const createdAt = view.getBigInt64(o, true);
  o += 8;
  const startedAt = view.getBigInt64(o, true);
  o += 8;
  const endsAt = view.getBigInt64(o, true);
  o += 8;
  const startPrice = view.getBigInt64(o, true);
  o += 8;
  const lastPrice = view.getBigInt64(o, true);
  o += 8;
  const playerCount = raw[o++];
  const winnerIndex = raw[o++];
  const winnerMask = raw[o++];

  const players: PlayerSeat[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const wallet = new PublicKey(raw.subarray(o, o + 32));
    o += 32;
    const sessionKey = new PublicKey(raw.subarray(o, o + 32));
    o += 32;
    const position = view.getInt8(o) as PositionDir;
    o += 1;
    const entryPrice = view.getBigInt64(o, true);
    o += 8;
    const realizedPnl = view.getBigInt64(o, true);
    o += 8;
    const tapCount = view.getUint32(o, true);
    o += 4;
    const lastTapTs = view.getBigInt64(o, true);
    o += 8;
    if (i < playerCount) {
      players.push({
        wallet,
        sessionKey,
        position,
        entryPrice,
        realizedPnl,
        tapCount,
        lastTapTs,
      });
    }
  }
  const bump = raw[o++];

  return {
    roomId,
    creator,
    priceFeed,
    entryFee,
    durationSecs,
    maxPlayers,
    status,
    createdAt,
    startedAt,
    endsAt,
    startPrice,
    lastPrice,
    playerCount,
    winnerIndex,
    winnerMask,
    players,
    bump,
  };
}

export function decodeOracleTick(raw: Uint8Array): OracleTick {
  if (
    raw.length < 134 ||
    !bytesEqual(raw.subarray(0, 8), PRICE_UPDATE_V2_DISCRIMINATOR)
  ) {
    throw new Error("Invalid MagicBlock Pyth Lazer PriceUpdateV2 account");
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const rawPrice = view.getBigInt64(73, true);
  const exp = view.getInt32(89, true);
  const publishTime = Number(view.getBigInt64(93, true));
  const postedSlot = view.getBigUint64(125, true);
  const absExp = Math.abs(exp || 8);
  const priceUsd = Number(rawPrice) / Math.pow(10, absExp);
  return { rawPrice, priceUsd, publishTime, postedSlot };
}

// ─── PnL & Payout Helpers ───────────────────────────────────────────────────

export function computeUnrealizedPnl(
  position: PositionDir,
  entryPrice: bigint,
  currentPrice: bigint
): bigint {
  if (position === POS_FLAT || entryPrice <= 0n || currentPrice <= 0n) {
    return 0n;
  }
  const diff = currentPrice - entryPrice;
  return (
    (BigInt(position) * BigInt(ARENA_LEVERAGE) * diff * BigInt(PNL_SCALE)) /
    entryPrice
  );
}

export function totalSeatPnl(seat: PlayerSeat, liveRawPrice: bigint): bigint {
  return (
    seat.realizedPnl +
    computeUnrealizedPnl(seat.position, seat.entryPrice, liveRawPrice)
  );
}

/** Formats 1e-6 PnL units as percentage string (10_000 => "+1.00%"). */
export function formatPnlPct(pnlMicro: bigint): string {
  const pct = Number(pnlMicro) / 10_000;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

export function getWinningSeatIndices(arena: ArenaAccount): number[] {
  const winners: number[] = [];
  for (let i = 0; i < arena.playerCount; i++) {
    if ((arena.winnerMask & (1 << i)) !== 0) {
      winners.push(i);
    }
  }
  return winners;
}

export function isSeatClaimed(vault: VaultAccount, seatIndex: number): boolean {
  return (vault.claimedMask & (1 << seatIndex)) !== 0;
}

// ─── Instruction Builders ───────────────────────────────────────────────────

export function buildCreateRoomIx(params: {
  creator: PublicKey;
  roomId: bigint;
  entryFeeLamports: bigint;
  durationSecs: number;
  maxPlayers: number;
  priceFeed: PublicKey;
  sessionKey: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? CANDLEROYALE_PROGRAM_ID;
  const [vault] = findVaultPda(params.roomId, programId);
  const [arena] = findArenaPda(params.roomId, programId);
  const [seat] = findSeatPda(params.roomId, 0, programId);

  const args = new Uint8Array(8 + 8 + 8 + 1 + 32 + 32);
  const view = new DataView(args.buffer);
  view.setBigUint64(0, params.roomId, true);
  view.setBigUint64(8, params.entryFeeLamports, true);
  view.setBigInt64(16, BigInt(params.durationSecs), true);
  view.setUint8(24, params.maxPlayers);
  args.set(params.priceFeed.toBytes(), 25);
  args.set(params.sessionKey.toBytes(), 57);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.creator, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: arena, isSigner: false, isWritable: true },
      { pubkey: seat, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(DISCRIMINATORS.create_room, args)),
  });
}

export function buildJoinRoomIx(params: {
  player: PublicKey;
  roomId: bigint;
  sessionKey: PublicKey;
  /** The next free seat (= current player count). */
  seatIndex: number;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? CANDLEROYALE_PROGRAM_ID;
  const [vault] = findVaultPda(params.roomId, programId);
  const [arena] = findArenaPda(params.roomId, programId);
  const [seat] = findSeatPda(params.roomId, params.seatIndex, programId);

  const data = concatBytes(
    DISCRIMINATORS.join_room,
    u64ToLeBytes(params.roomId),
    params.sessionKey.toBytes(),
    Uint8Array.of(params.seatIndex & 0xff)
  );

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.player, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: arena, isSigner: false, isWritable: true },
      { pubkey: seat, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export function buildCancelRoomIx(params: {
  creator: PublicKey;
  roomId: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? CANDLEROYALE_PROGRAM_ID;
  const [vault] = findVaultPda(params.roomId, programId);
  const [arena] = findArenaPda(params.roomId, programId);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.creator, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: arena, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(
      concatBytes(DISCRIMINATORS.cancel_room, u64ToLeBytes(params.roomId))
    ),
  });
}

export function buildStartAndDelegateIx(params: {
  payer: PublicKey;
  roomId: bigint;
  /** Number of seated players; every seat PDA is passed so the program can check they are delegated. */
  playerCount: number;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? CANDLEROYALE_PROGRAM_ID;
  const [arena] = findArenaPda(params.roomId, programId);
  const seats = findSeatPdas(params.roomId, params.playerCount, programId);
  const { bufferArena, delegationRecordArena, delegationMetadataArena } =
    findDelegationPdas(arena, programId);

  // Exact account order expanded by #[delegate] in ephemeral-rollups-sdk 0.16.2
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: bufferArena, isSigner: false, isWritable: true },
      { pubkey: delegationRecordArena, isSigner: false, isWritable: true },
      { pubkey: delegationMetadataArena, isSigner: false, isWritable: true },
      { pubkey: arena, isSigner: false, isWritable: true },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // Remaining accounts: every seat PDA in order (each must already be delegated)
      ...seats.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data: Buffer.from(
      concatBytes(
        DISCRIMINATORS.start_and_delegate,
        u64ToLeBytes(params.roomId)
      )
    ),
  });
}

export function buildBeginRoundIx(params: {
  signer: PublicKey;
  roomId: bigint;
  priceFeed: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? CANDLEROYALE_PROGRAM_ID;
  const [arena] = findArenaPda(params.roomId, programId);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.signer, isSigner: true, isWritable: false },
      { pubkey: arena, isSigner: false, isWritable: true },
      { pubkey: params.priceFeed, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concatBytes(DISCRIMINATORS.begin_round, u64ToLeBytes(params.roomId))
    ),
  });
}

export function buildDelegateSeatIx(params: {
  payer: PublicKey;
  roomId: bigint;
  seatIndex: number;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? CANDLEROYALE_PROGRAM_ID;
  const [seat] = findSeatPda(params.roomId, params.seatIndex, programId);
  const {
    bufferArena: bufferSeat,
    delegationRecordArena: delegationRecordSeat,
    delegationMetadataArena: delegationMetadataSeat,
  } = findDelegationPdas(seat, programId);

  // Same #[delegate] expansion as start_and_delegate, for the `seat` field
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: bufferSeat, isSigner: false, isWritable: true },
      { pubkey: delegationRecordSeat, isSigner: false, isWritable: true },
      { pubkey: delegationMetadataSeat, isSigner: false, isWritable: true },
      { pubkey: seat, isSigner: false, isWritable: true },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concatBytes(
        DISCRIMINATORS.delegate_seat,
        u64ToLeBytes(params.roomId),
        Uint8Array.of(params.seatIndex & 0xff)
      )
    ),
  });
}

export function buildTapIx(params: {
  signer: PublicKey;
  roomId: bigint;
  newPosition: PositionDir;
  priceFeed: PublicKey;
  /** The signer's own seat index in the room. */
  seatIndex: number;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? CANDLEROYALE_PROGRAM_ID;
  const [arena] = findArenaPda(params.roomId, programId);
  const [seat] = findSeatPda(params.roomId, params.seatIndex, programId);
  const permission = findPermissionPda(seat);

  const posBuf = new Uint8Array(1);
  new DataView(posBuf.buffer).setInt8(0, params.newPosition);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.signer, isSigner: true, isWritable: false },
      { pubkey: arena, isSigner: false, isWritable: true },
      { pubkey: seat, isSigner: false, isWritable: true },
      { pubkey: params.priceFeed, isSigner: false, isWritable: false },
      { pubkey: permission, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concatBytes(DISCRIMINATORS.tap, u64ToLeBytes(params.roomId), posBuf)
    ),
  });
}

export function buildFinishRoundIx(params: {
  payer: PublicKey;
  roomId: bigint;
  priceFeed: PublicKey;
  playerCount: number;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? CANDLEROYALE_PROGRAM_ID;
  const [arena] = findArenaPda(params.roomId, programId);
  const seats = findSeatPdas(params.roomId, params.playerCount, programId);

  // Exact account order expanded by #[commit] in ephemeral-rollups-sdk 0.16.2:
  // payer, arena, price_feed, magic_program, magic_context
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: arena, isSigner: false, isWritable: true },
      { pubkey: params.priceFeed, isSigner: false, isWritable: false },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      // Remaining accounts: every sealed seat, revealed and undelegated with the arena
      ...seats.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from(
      concatBytes(DISCRIMINATORS.finish_round, u64ToLeBytes(params.roomId))
    ),
  });
}

export function buildAbortStaleRoomIx(params: {
  payer: PublicKey;
  roomId: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? CANDLEROYALE_PROGRAM_ID;
  const [arena] = findArenaPda(params.roomId, programId);

  // Exact account order expanded by #[commit] in ephemeral-rollups-sdk 0.16.2:
  // payer, arena, magic_program, magic_context
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: arena, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(
      concatBytes(DISCRIMINATORS.abort_stale_room, u64ToLeBytes(params.roomId))
    ),
  });
}

/**
 * L1 escape hatch: any seated player aborts a joined room the creator never started,
 * after L1_LOBBY_TIMEOUT_SECS. Seats then reclaim their entry via claim_payout.
 */
export function buildAbortStaleLobbyIx(params: {
  signer: PublicKey;
  roomId: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? CANDLEROYALE_PROGRAM_ID;
  const [arena] = findArenaPda(params.roomId, programId);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.signer, isSigner: true, isWritable: false },
      { pubkey: arena, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(
      concatBytes(DISCRIMINATORS.abort_stale_lobby, u64ToLeBytes(params.roomId))
    ),
  });
}

export function buildClaimPayoutIx(params: {
  payer: PublicKey;
  roomId: bigint;
  seatIndex: number;
  recipient: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? CANDLEROYALE_PROGRAM_ID;
  const [vault] = findVaultPda(params.roomId, programId);
  const [arena] = findArenaPda(params.roomId, programId);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: arena, isSigner: false, isWritable: false },
      { pubkey: params.recipient, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(
      concatBytes(
        DISCRIMINATORS.claim_payout,
        u64ToLeBytes(params.roomId),
        new Uint8Array([params.seatIndex])
      )
    ),
  });
}
