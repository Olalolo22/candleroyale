import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { ER_RPC_URL } from "@sdk/constants";

function storageKey(roomId: string, wallet: string) {
  return `candleroyale_sk_${roomId}_${wallet}`;
}

/**
 * Loads or generates an ephemeral in-browser Session Key scoped strictly to one room.
 * Stored in sessionStorage so mid-round tab refreshes retain zero-popup signing ability.
 */
export function getOrCreateSessionKey(roomId: string, wallet: string): Keypair {
  if (typeof window === "undefined") return Keypair.generate();
  const key = storageKey(roomId, wallet);
  const existing = window.sessionStorage.getItem(key);
  if (existing) {
    try {
      const raw = JSON.parse(existing) as number[];
      if (Array.isArray(raw) && raw.length === 64) {
        return Keypair.fromSecretKey(Uint8Array.from(raw));
      }
    } catch {
      // regenerate
    }
  }
  const kp = Keypair.generate();
  window.sessionStorage.setItem(key, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

export function loadExistingSessionKey(
  roomId: string,
  wallet: string
): Keypair | null {
  if (typeof window === "undefined") return null;
  const existing = window.sessionStorage.getItem(storageKey(roomId, wallet));
  if (!existing) return null;
  try {
    const raw = JSON.parse(existing) as number[];
    if (Array.isArray(raw) && raw.length === 64) {
      return Keypair.fromSecretKey(Uint8Array.from(raw));
    }
  } catch {
    return null;
  }
  return null;
}

export interface ErTxResult {
  signature: string;
  latencyMs: number;
}

let cachedErBlockhash: { blockhash: string; fetchedAt: number } | null = null;

// Background refresh: while a round is on, keep a recent blockhash ready so a trade never
// waits a network round trip for one (about 300ms from Lagos). Stops 30s after last use.
let warmTimer: ReturnType<typeof setInterval> | null = null;
let warmConn: Connection | null = null;
let warmLastUse = 0;

async function refreshErBlockhash(conn: Connection): Promise<void> {
  try {
    const latest = await conn.getLatestBlockhash("confirmed");
    cachedErBlockhash = { blockhash: latest.blockhash, fetchedAt: Date.now() };
  } catch {
    // keep the previous one; sendErSessionTx fetches fresh if it gets too old
  }
}

/** Keep a fresh rollup blockhash cached while the player is in a live room. */
export function warmErBlockhash(conn: Connection): void {
  warmConn = conn;
  warmLastUse = Date.now();
  if (warmTimer) return;
  void refreshErBlockhash(conn);
  warmTimer = setInterval(() => {
    if (!warmConn || Date.now() - warmLastUse > 30_000) {
      if (warmTimer) clearInterval(warmTimer);
      warmTimer = null;
      return;
    }
    void refreshErBlockhash(warmConn);
  }, 1000);
}

/**
 * Signs and sends a gasless MagicBlock Ephemeral Rollup transaction with an ephemeral Session Key.
 * Caches ER blockhash for 3s to eliminate an extra RPC round-trip on rapid-fire taps.
 */
export async function sendErSessionTx(
  erConnection: Connection,
  tx: Transaction,
  sessionKey: Keypair
): Promise<ErTxResult> {
  const t0 = performance.now();
  warmErBlockhash(erConnection);
  let blockhash: string;
  if (cachedErBlockhash && Date.now() - cachedErBlockhash.fetchedAt < 3000) {
    blockhash = cachedErBlockhash.blockhash;
  } else {
    const latest = await erConnection.getLatestBlockhash("confirmed");
    blockhash = latest.blockhash;
    cachedErBlockhash = { blockhash, fetchedAt: Date.now() };
  }

  tx.recentBlockhash = blockhash;
  tx.feePayer = sessionKey.publicKey;
  tx.sign(sessionKey);

  const signature = await erConnection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 2,
  });

  // Fast HTTP confirmation poll — lands in ~30-120ms without WebSocket fragility
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const res = await erConnection.getSignatureStatuses([signature]);
    const st = res.value[0];
    if (st) {
      if (st.err) {
        cachedErBlockhash = null;
        throw new Error(`ER transaction failed: ${JSON.stringify(st.err)}`);
      }
      if (
        st.confirmationStatus === "confirmed" ||
        st.confirmationStatus === "finalized"
      ) {
        return {
          signature,
          latencyMs: Math.max(1, Math.round(performance.now() - t0)),
        };
      }
    }
    await new Promise((r) => setTimeout(r, 35));
  }

  cachedErBlockhash = null;
  throw new Error(`ER confirmation timed out for ${signature}`);
}

export function createErConnection(): Connection {
  return new Connection(ER_RPC_URL, "confirmed");
}
