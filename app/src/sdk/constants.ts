import { PublicKey } from "@solana/web3.js";

export const CANDLEROYALE_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ||
    "3fgXDqKzQiQQUSfbPXnyuonqJi8BMbeGf9vnxxH9bEtN"
);

export const DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
);
export const MAGIC_PROGRAM_ID = new PublicKey(
  "Magic11111111111111111111111111111111111111"
);
export const MAGIC_CONTEXT_ID = new PublicKey(
  "MagicContext1111111111111111111111111111111"
);
export const ORACLE_PROGRAM_ID = new PublicKey(
  "PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd"
);

// Public Devnet endpoints
export const SOLANA_L1_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.devnet.solana.com";
export const SOLANA_L1_WS =
  process.env.NEXT_PUBLIC_SOLANA_WS || "wss://api.devnet.solana.com";

// Pinned MagicBlock US Devnet ER validator (enforced on-chain in start_and_delegate)
export const ER_VALIDATORS = {
  us: {
    label: "US Devnet ER",
    rpc: "https://devnet-us.magicblock.app",
    ws: "wss://devnet-us.magicblock.app",
    pubkey: new PublicKey("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd"),
  },
} as const;

export const DEFAULT_ER = ER_VALIDATORS.us;
export const ER_RPC_URL = process.env.NEXT_PUBLIC_ER_RPC || DEFAULT_ER.rpc;
export const ER_WS_URL = process.env.NEXT_PUBLIC_ER_WS || DEFAULT_ER.ws;
export const ER_VALIDATOR_PUBKEY = DEFAULT_ER.pubkey;

// Live MagicBlock Pyth Lazer Price Feeds on Devnet ER (8 decimals)
export interface MarketFeed {
  id: "SOL" | "BTC" | "ETH";
  symbol: string;
  name: string;
  address: PublicKey;
  decimals: number;
}

export const MARKET_FEEDS: Record<"SOL" | "BTC" | "ETH", MarketFeed> = {
  SOL: {
    id: "SOL",
    symbol: "SOL/USD",
    name: "Solana",
    address: new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu"),
    decimals: 8,
  },
  BTC: {
    id: "BTC",
    symbol: "BTC/USD",
    name: "Bitcoin",
    address: new PublicKey("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr"),
    decimals: 8,
  },
  ETH: {
    id: "ETH",
    symbol: "ETH/USD",
    name: "Ethereum",
    address: new PublicKey("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG"),
    decimals: 8,
  },
};

export function marketFromFeed(feed: PublicKey): MarketFeed {
  const b58 = feed.toBase58();
  for (const m of Object.values(MARKET_FEEDS)) {
    if (m.address.toBase58() === b58) return m;
  }
  return MARKET_FEEDS.SOL;
}

export const VAULT_SEED = new TextEncoder().encode("vault");
export const ARENA_SEED = new TextEncoder().encode("arena");
export const DELEGATE_BUFFER_TAG = new TextEncoder().encode("buffer");
export const DELEGATION_RECORD_TAG = new TextEncoder().encode("delegation");
export const DELEGATION_METADATA_TAG = new TextEncoder().encode(
  "delegation-metadata"
);

export const VAULT_ACCOUNT_SIZE = 68;
export const ARENA_ACCOUNT_SIZE = 700;
export const MAX_PLAYERS = 6;
export const ARENA_LEVERAGE = 20;
export const PNL_SCALE = 1_000_000; // 10_000 = +1.00%
export const NO_WINNER = 255;
export const MAX_ORACLE_AGE_SECS = 10;
export const SETTLE_GRACE_SECS = 3;
export const STALE_LOBBY_TIMEOUT_SECS = 180;

export const POS_SHORT = -1 as const;
export const POS_FLAT = 0 as const;
export const POS_LONG = 1 as const;
export type PositionDir = typeof POS_SHORT | typeof POS_FLAT | typeof POS_LONG;
