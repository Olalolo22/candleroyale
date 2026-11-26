import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  decodeArena,
  decodeOracleTick,
  decodeVault,
  findArenaPda,
  findVaultPda,
  getWinningSeatIndices,
} from "@sdk/codec";
import {
  DELEGATION_PROGRAM_ID,
  ER_RPC_URL,
  marketFromFeed,
  SOLANA_L1_RPC,
} from "@sdk/constants";
import { badgeFor, fmtSol } from "@/lib/pit";
import { getViewerConnection } from "@/lib/tee";

/**
 * Server-side, read-only snapshot of a room for link previews (metadata + OG image).
 * Never throws: any RPC failure or slow response yields `null`, and callers fall
 * back to a generic card so a flaky RPC can never break a page.
 */

export type RoomPhase = "open" | "full" | "trading" | "settled" | "refunded";

export interface RoomSummary {
  roomCode: string;
  symbol: string; // "BTC"
  phase: RoomPhase;
  entrySol: number;
  potSol: number;
  playerCount: number;
  maxPlayers: number;
  durationSecs: number;
  priceUsd: number | null;
  priceDecimals: number;
  winners: string[]; // trader badges
}

const TIMEOUT_MS = 3500;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function fetchSummary(roomIdStr: string): Promise<RoomSummary | null> {
  if (!/^\d{1,20}$/.test(roomIdStr)) return null;
  const roomId = BigInt(roomIdStr);
  const l1 = new Connection(SOLANA_L1_RPC, "confirmed");
  const [vaultPda] = findVaultPda(roomId);
  const [arenaPda] = findArenaPda(roomId);

  const [vaultInfo, l1ArenaInfo] = await l1.getMultipleAccountsInfo(
    [vaultPda, arenaPda],
    "confirmed"
  );
  if (!vaultInfo || !l1ArenaInfo) return null;

  const vault = decodeVault(vaultInfo.data);
  const delegated = l1ArenaInfo.owner.equals(DELEGATION_PROGRAM_ID);
  const er = new Connection(ER_RPC_URL, "confirmed");

  let arenaData: Uint8Array = l1ArenaInfo.data;
  if (delegated) {
    // Live rooms sit on the private rollup; the scoreboard is public to any signed-in viewer
    const viewer = await getViewerConnection();
    const erInfo = await viewer.getAccountInfo(arenaPda, "confirmed");
    if (erInfo) arenaData = erInfo.data;
  }
  const arena = decodeArena(arenaData);
  const market = marketFromFeed(arena.priceFeed);

  let priceUsd: number | null = null;
  try {
    const feedInfo = await er.getAccountInfo(arena.priceFeed, "confirmed");
    if (feedInfo) priceUsd = decodeOracleTick(feedInfo.data).priceUsd;
  } catch {
    priceUsd = null;
  }

  let phase: RoomPhase;
  if (vault.cancelled || arena.status === "Aborted") phase = "refunded";
  else if (arena.status === "Finished") phase = "settled";
  else if (arena.status === "Live" || delegated) phase = "trading";
  else phase = arena.playerCount >= arena.maxPlayers ? "full" : "open";

  return {
    roomCode: roomIdStr.slice(-6),
    symbol: market.symbol.split("/")[0],
    phase,
    entrySol: Number(vault.entryFee) / LAMPORTS_PER_SOL,
    potSol: Number(vault.totalPot) / LAMPORTS_PER_SOL,
    playerCount: arena.playerCount,
    maxPlayers: arena.maxPlayers,
    durationSecs: Number(arena.durationSecs),
    priceUsd,
    priceDecimals: market.symbol.startsWith("SOL") ? 3 : 2,
    winners:
      arena.status === "Finished"
        ? getWinningSeatIndices(arena).map((i) => badgeFor(arena.players[i].wallet))
        : [],
  };
}

export async function getRoomSummary(roomIdStr: string): Promise<RoomSummary | null> {
  try {
    return await withTimeout(fetchSummary(roomIdStr), TIMEOUT_MS);
  } catch {
    return null;
  }
}

/** Plain-language title and description shared by metadata and the card. */
export function roomCopy(s: RoomSummary | null): { title: string; description: string } {
  if (!s) {
    return {
      title: "Join a CandleRoyale room",
      description:
        "A 60-second trading battle: pick long or short on a live price, and the best score takes the pot. Runs on Solana Devnet with test SOL.",
    };
  }
  const stake = s.entrySol > 0 ? `${fmtSol(s.entrySol)} SOL stake` : "free room";
  const pot = `${fmtSol(s.potSol)} SOL`;
  const round = `${s.durationSecs}-second`;
  const title =
    s.phase === "open"
      ? `Join a ${s.symbol} room: ${stake}`
      : s.phase === "full"
        ? `${s.symbol} room: full, about to start`
        : s.phase === "trading"
          ? `${s.symbol} room: trading now`
          : s.phase === "settled"
            ? s.winners.length > 1
              ? `${s.symbol} room: ${s.winners.join(" & ")} split ${pot}`
              : `${s.symbol} room: ${s.winners[0] ?? "the winner"} took ${pot}`
            : `${s.symbol} room: refunded`;
  const description =
    s.phase === "open"
      ? `Pick long or short on live ${s.symbol}. Best score after ${s.durationSecs} seconds takes the pot. ${s.playerCount} of ${s.maxPlayers} seats taken. Runs on Solana Devnet with test SOL.`
      : `A ${round} ${s.symbol} trading battle on CandleRoyale. Pick long or short on a live price; the best score takes the pot. Runs on Solana Devnet with test SOL.`;
  return { title, description };
}
