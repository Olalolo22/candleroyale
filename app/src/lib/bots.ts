import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { POS_FLAT, POS_LONG, POS_SHORT, PositionDir } from "@sdk/constants";

/**
 * Practice bots: automated rival traders for solo demos and practice.
 *
 * Each bot is a real seat, the same as a human player:
 *   - its own L1 wallet, funded by the room creator (one wallet approval),
 *     which pays its own entry fee into the vault via join_room;
 *   - its own unfunded session key, which signs gasless taps on the ER.
 * Nothing is faked: bot stakes sit in the vault and bot PnL comes from the
 * same live oracle price. Bot keys live in this tab's sessionStorage, so the
 * creator's tab drives them and can sweep their SOL back afterwards.
 */

export type BotStyle = "momentum" | "contrarian" | "scalper";

export interface PracticeBot {
  wallet: Keypair;
  session: Keypair;
  style: BotStyle;
}

export const BOT_STYLE_LABEL: Record<BotStyle, string> = {
  momentum: "Momentum bot",
  contrarian: "Contrarian bot",
  scalper: "Scalper bot",
};

const STYLES: BotStyle[] = ["momentum", "contrarian", "scalper"];

/**
 * Sent on top of the stake. Covers the bot's private seat account (about 1.5M lamports of
 * rent, which stays with the seat), the seat's privacy rent, fees, and the bot wallet's own
 * rent-exempt minimum so it can still be swept afterwards.
 */
export const BOT_FUND_BUFFER_LAMPORTS = 4_000_000n;
const TX_FEE_LAMPORTS = 5_000;

const storageKey = (roomId: string) => `candleroyale_bots_v1_${roomId}`;

interface StoredBot {
  w: number[];
  s: number[];
  style: BotStyle;
}

export function loadBots(roomId: string): PracticeBot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(storageKey(roomId));
    if (!raw) return [];
    return (JSON.parse(raw) as StoredBot[]).map((b) => ({
      wallet: Keypair.fromSecretKey(Uint8Array.from(b.w)),
      session: Keypair.fromSecretKey(Uint8Array.from(b.s)),
      style: b.style,
    }));
  } catch {
    return [];
  }
}

export function saveBots(roomId: string, bots: PracticeBot[]) {
  if (typeof window === "undefined") return;
  const data: StoredBot[] = bots.map((b) => ({
    w: Array.from(b.wallet.secretKey),
    s: Array.from(b.session.secretKey),
    style: b.style,
  }));
  window.sessionStorage.setItem(storageKey(roomId), JSON.stringify(data));
}

/** New bots, cycling styles after the ones already seated so a room gets a mix. */
export function createBots(count: number, existing: PracticeBot[]): PracticeBot[] {
  return Array.from({ length: count }, (_, i) => ({
    wallet: Keypair.generate(),
    session: Keypair.generate(),
    style: STYLES[(existing.length + i) % STYLES.length],
  }));
}

export function buildBotFundingTx(
  funder: PublicKey,
  bots: PracticeBot[],
  entryFeeLamports: bigint
): Transaction {
  const tx = new Transaction();
  for (const b of bots) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: funder,
        toPubkey: b.wallet.publicKey,
        lamports: Number(entryFeeLamports + BOT_FUND_BUFFER_LAMPORTS),
      })
    );
  }
  return tx;
}

/** Sign an L1 transaction with a local keypair (bot) and poll until confirmed. */
export async function sendL1AsKeypair(
  conn: Connection,
  tx: Transaction,
  signer: Keypair
): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`Bot transaction failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      return sig;
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error(`Bot transaction not confirmed in time: ${sig}`);
}

/** Send everything a bot wallet holds (minus the fee) back to `to`. Returns null if empty. */
export async function sweepBot(
  conn: Connection,
  bot: PracticeBot,
  to: PublicKey
): Promise<string | null> {
  const bal = await conn.getBalance(bot.wallet.publicKey, "confirmed");
  if (bal <= TX_FEE_LAMPORTS) return null;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: bot.wallet.publicKey,
      toPubkey: to,
      lamports: bal - TX_FEE_LAMPORTS,
    })
  );
  return sendL1AsKeypair(conn, tx, bot.wallet);
}

// ─── Strategy ───────────────────────────────────────────────────────────────

export interface PricePoint {
  t: number; // ms
  p: number; // USD
}

export interface BotMemory {
  enteredAt: number;
  entryPrice: number;
}

/** Relative change (in basis points) between the price `lookbackMs` ago and now. */
function moveBps(history: PricePoint[], lookbackMs: number): number | null {
  if (history.length < 2) return null;
  const now = history[history.length - 1];
  let then = history[0];
  for (let i = history.length - 1; i >= 0; i--) {
    if (now.t - history[i].t >= lookbackMs) {
      then = history[i];
      break;
    }
  }
  if (then === now || then.p <= 0) return null;
  return ((now.p - then.p) / then.p) * 10_000;
}

/**
 * Decide a bot's next position, or null to hold. Never returns the current
 * position (the program rejects no-op taps).
 *
 * Thresholds are tiny on purpose: a 60s round on SOL usually moves only a few
 * basis points, and the bots should visibly trade, not sit flat.
 */
export function decideBotMove(
  style: BotStyle,
  history: PricePoint[],
  current: PositionDir,
  memory: BotMemory | null,
  now: number
): PositionDir | null {
  const rand = Math.random();
  let want: PositionDir | null = null;

  if (style === "momentum") {
    const m = moveBps(history, 5_000);
    if (m === null) want = rand < 0.5 ? POS_LONG : POS_SHORT;
    else if (m > 0.4) want = POS_LONG;
    else if (m < -0.4) want = POS_SHORT;
    else if (rand < 0.15) want = POS_FLAT;
  } else if (style === "contrarian") {
    const m = moveBps(history, 3_000);
    if (m === null) want = rand < 0.5 ? POS_SHORT : POS_LONG;
    else if (m > 0.6) want = POS_SHORT;
    else if (m < -0.6) want = POS_LONG;
    else if (current === POS_FLAT && rand < 0.3) want = rand < 0.15 ? POS_LONG : POS_SHORT;
  } else {
    // scalper: jump on short moves, bank small wins or cut quickly
    const m = moveBps(history, 2_000);
    if (current === POS_FLAT) {
      if (m !== null && Math.abs(m) > 0.2) want = m > 0 ? POS_LONG : POS_SHORT;
      else if (rand < 0.35) want = rand < 0.17 ? POS_LONG : POS_SHORT;
    } else if (memory && history.length) {
      const p = history[history.length - 1].p;
      const pnlBps =
        ((p - memory.entryPrice) / memory.entryPrice) * 10_000 * (current === POS_LONG ? 1 : -1);
      if (pnlBps > 0.8 || pnlBps < -0.6 || now - memory.enteredAt > 7_000) want = POS_FLAT;
    }
  }

  return want === null || want === current ? null : want;
}

/** Each bot acts on its own jittered rhythm so they don't move in lockstep. */
export function nextBotDelayMs(style: BotStyle): number {
  const base = style === "scalper" ? 1_600 : style === "momentum" ? 2_600 : 3_200;
  return base + Math.random() * 2_200;
}
