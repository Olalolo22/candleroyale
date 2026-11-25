import { Connection, Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { TEE_RPC_URL } from "@sdk/constants";

/**
 * MagicBlock Private Ephemeral Rollup (TEE) access.
 *
 * Every request to the private rollup carries a token tied to one public key. The
 * rollup then only shows that key the private accounts it is a member of. We sign the
 * login challenge with the player's per-room session key, so it never needs a wallet
 * popup. Same flow as getAuthToken() in @magicblock-labs/ephemeral-rollups-sdk.
 */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet), enough for encoding a 64-byte signature. */
export function base58Encode(bytes: Uint8Array): string {
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

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const tokenCache = new Map<string, CachedToken>();
const inFlight = new Map<string, Promise<string>>();
const DEFAULT_TTL_MS = 10 * 60_000;

function toMs(expiresAt: unknown): number {
  const n = typeof expiresAt === "number" ? expiresAt : Number(expiresAt);
  if (!Number.isFinite(n) || n <= 0) return Date.now() + DEFAULT_TTL_MS;
  // The rollup answers in seconds; the SDK's own fallback is milliseconds.
  return n < 1e12 ? n * 1000 : n;
}

async function login(keypair: Keypair, rpcUrl: string): Promise<CachedToken> {
  const pubkey = keypair.publicKey.toBase58();
  const challengeRes = await fetch(
    `${rpcUrl}/auth/challenge?pubkey=${encodeURIComponent(pubkey)}`
  );
  const { challenge, error } = (await challengeRes.json()) as {
    challenge?: string;
    error?: string;
  };
  if (error) throw new Error(`Private rollup challenge failed: ${error}`);
  if (!challenge) throw new Error("Private rollup sent no challenge");

  const signature = ed25519.sign(
    new TextEncoder().encode(challenge),
    keypair.secretKey.slice(0, 32)
  );

  const loginRes = await fetch(`${rpcUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pubkey,
      challenge,
      signature: base58Encode(signature),
    }),
  });
  const body = (await loginRes.json()) as {
    token?: string;
    expiresAt?: number;
    error?: string;
  };
  if (loginRes.status !== 200 || !body.token) {
    throw new Error(`Private rollup login failed: ${body.error ?? loginRes.status}`);
  }
  return { token: body.token, expiresAtMs: toMs(body.expiresAt) };
}

/** Returns a cached token for this key, logging in again 30s before it expires. */
export async function getTeeToken(
  keypair: Keypair,
  rpcUrl = TEE_RPC_URL
): Promise<string> {
  const id = `${rpcUrl}|${keypair.publicKey.toBase58()}`;
  const cached = tokenCache.get(id);
  if (cached && cached.expiresAtMs > Date.now() + 30_000) return cached.token;
  const pending = inFlight.get(id);
  if (pending) return pending;

  const p = login(keypair, rpcUrl)
    .then((t) => {
      tokenCache.set(id, t);
      return t.token;
    })
    .finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

const connCache = new Map<string, { token: string; conn: Connection }>();

/** A Connection to the private rollup that sees what `keypair` is allowed to see. */
export async function getTeeConnection(
  keypair: Keypair,
  rpcUrl = TEE_RPC_URL
): Promise<Connection> {
  const id = `${rpcUrl}|${keypair.publicKey.toBase58()}`;
  const token = await getTeeToken(keypair, rpcUrl);
  const hit = connCache.get(id);
  if (hit && hit.token === token) return hit.conn;
  const conn = new Connection(
    `${rpcUrl}?token=${encodeURIComponent(token)}`,
    "confirmed"
  );
  connCache.set(id, { token, conn });
  return conn;
}

let viewerKey: Keypair | null = null;

/**
 * A throwaway key that is a member of nothing. Its connection reads public accounts
 * (the room scoreboard) and gets nothing back for anyone's sealed seat.
 */
export function getViewerConnection(rpcUrl = TEE_RPC_URL): Promise<Connection> {
  if (!viewerKey) viewerKey = Keypair.generate();
  return getTeeConnection(viewerKey, rpcUrl);
}
