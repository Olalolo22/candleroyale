import { PublicKey } from "@solana/web3.js";
import { POS_LONG, POS_SHORT, PositionDir } from "@sdk/constants";

/**
 * Trader-pit identity helpers. Every seat gets a three-letter pit badge
 * (derived from its wallet) and a jacket colour (derived from its seat),
 * so standings read like a trading pit instead of a list of base58 strings.
 */

const JACKETS = [
  "#5ab8ff", // sky
  "#a98bff", // violet
  "#ff9b3d", // orange
  "#ff7ac6", // pink
  "#eef1f7", // chalk
  "#d9b48f", // sand
];

export function jacketColor(seatIndex: number): string {
  return JACKETS[((seatIndex % JACKETS.length) + JACKETS.length) % JACKETS.length];
}

export function badgeFor(wallet: PublicKey | string): string {
  const s = typeof wallet === "string" ? wallet : wallet.toBase58();
  const letters = s.replace(/[^A-Za-z]/g, "").toUpperCase();
  return (letters + "XXX").slice(0, 3);
}

/**
 * Private rooms ("invite link only") get a room number with this bit set, so the room
 * list can skip them. Nothing on-chain changes: anyone reading Solana directly can still
 * find the room, it just isn't advertised.
 */
export const LINK_ONLY_ROOM_FLAG = 1n << 52n;

export function isLinkOnlyRoom(roomId: bigint | string): boolean {
  try {
    return (BigInt(roomId) & LINK_ONLY_ROOM_FLAG) !== 0n;
  } catch {
    return false;
  }
}

export function shortKey(k: string): string {
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

export function fmtSol(sol: number): string {
  if (sol === 0) return "0";
  if (sol < 0.1) return sol.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return sol.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function posLabel(pos: PositionDir): "Long" | "Short" | "Flat" {
  if (pos === POS_LONG) return "Long";
  if (pos === POS_SHORT) return "Short";
  return "Flat";
}

export function posClass(pos: PositionDir): "long" | "short" | "flat" {
  if (pos === POS_LONG) return "long";
  if (pos === POS_SHORT) return "short";
  return "flat";
}

export function pnlClass(v: bigint): string {
  if (v > 0n) return "up";
  if (v < 0n) return "down";
  return "";
}
