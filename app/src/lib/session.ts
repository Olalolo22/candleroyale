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

  // Confirm on ER — typically lands in 20–120ms
  const status = await erConnection.confirmTransaction(signature, "confirmed");
  if (status.value.err) {
    // Bust cached blockhash on any failure
    cachedErBlockhash = null;
    throw new Error(`ER transaction failed: ${JSON.stringify(status.value.err)}`);
  }

  return {
    signature,
    latencyMs: Math.max(1, Math.round(performance.now() - t0)),
  };
}

export function createErConnection(): Connection {
  return new Connection(ER_RPC_URL, "confirmed");
}
