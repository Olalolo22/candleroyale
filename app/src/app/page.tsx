"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Connection, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import {
  ArrowRight,
  RefreshCw,
  ShieldCheck,
  Trophy,
  Users,
  Zap,
} from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { useWallet } from "@/lib/wallet";
import { getOrCreateSessionKey } from "@/lib/session";
import { useAllMarkets } from "@/lib/useOracleStream";
import {
  ArenaAccount,
  buildCreateRoomIx,
  decodeArena,
  DISCRIMINATORS,
} from "@sdk/codec";
import {
  ARENA_ACCOUNT_SIZE,
  CANDLEROYALE_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  MARKET_FEEDS,
  marketFromFeed,
  SOLANA_L1_RPC,
} from "@sdk/constants";

interface DiscoveredRoom {
  roomId: string;
  arena: ArenaAccount;
  delegated: boolean;
}

const STAKE_PRESETS = [
  { label: "Free", lamports: 0n },
  { label: "0.01 SOL", lamports: 10_000_000n },
  { label: "0.05 SOL", lamports: 50_000_000n },
  { label: "0.10 SOL", lamports: 100_000_000n },
];

const DURATION_PRESETS = [30, 60, 90];
const SEAT_PRESETS = [1, 2, 4, 6];

export default function LobbyPage() {
  const router = useRouter();
  const { publicKey, connected, openModal, sendL1Transaction } = useWallet();
  const { prices, erSlot } = useAllMarkets();

  const [marketKey, setMarketKey] = useState<"SOL" | "BTC" | "ETH">("SOL");
  const [stakeLamports, setStakeLamports] = useState<bigint>(10_000_000n);
  const [durationSecs, setDurationSecs] = useState<number>(60);
  const [maxPlayers, setMaxPlayers] = useState<number>(2);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [roomLookup, setRoomLookup] = useState("");
  const [rooms, setRooms] = useState<DiscoveredRoom[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);

  const l1Conn = useMemo(() => new Connection(SOLANA_L1_RPC, "confirmed"), []);

  const fetchOnChainRooms = useCallback(async () => {
    setLoadingRooms(true);
    try {
      const accounts = await l1Conn.getProgramAccounts(
        CANDLEROYALE_PROGRAM_ID,
        {
          filters: [{ dataSize: ARENA_ACCOUNT_SIZE }],
        }
      );
      const parsed: DiscoveredRoom[] = [];
      for (const acc of accounts) {
        try {
          if (
            acc.account.data[0] !== DISCRIMINATORS.account_Arena[0] ||
            acc.account.data[1] !== DISCRIMINATORS.account_Arena[1]
          ) {
            continue;
          }
          const arena = decodeArena(acc.account.data);
          parsed.push({
            roomId: arena.roomId.toString(),
            arena,
            delegated: acc.account.owner.equals(DELEGATION_PROGRAM_ID),
          });
        } catch {
          // ignore non-arena accounts
        }
      }
      parsed.sort((a, b) => Number(b.arena.roomId - a.arena.roomId));
      setRooms(parsed.slice(0, 12));
    } catch {
      // Program may not have rooms yet or RPC busy
    } finally {
      setLoadingRooms(false);
    }
  }, [l1Conn]);

  useEffect(() => {
    fetchOnChainRooms();
  }, [fetchOnChainRooms]);

  const handleCreateRoom = async () => {
    setError(null);
    if (!connected || !publicKey) {
      openModal();
      return;
    }

    setCreating(true);
    try {
      const roomId = BigInt(Date.now());
      const sessionKey = getOrCreateSessionKey(
        roomId.toString(),
        publicKey.toBase58()
      );
      const ix = buildCreateRoomIx({
        creator: publicKey,
        roomId,
        entryFeeLamports: stakeLamports,
        durationSecs,
        maxPlayers,
        priceFeed: MARKET_FEEDS[marketKey].address,
        sessionKey: sessionKey.publicKey,
      });

      const tx = new Transaction().add(ix);
      await sendL1Transaction(tx);
      router.push(`/room/${roomId.toString()}`);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to create room on Solana Devnet."
      );
    } finally {
      setCreating(false);
    }
  };

  const handleJoinById = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = roomLookup.trim().replace(/^.*\/room\//, "");
    if (!/^\d+$/.test(cleaned)) {
      setError("Enter a numeric Room ID or paste a /room/<id> link.");
      return;
    }
    router.push(`/room/${cleaned}`);
  };

  return (
    <main className="shell">
      <TopBar erSlot={erSlot} />

      <div className="lobby-grid">
        {/* Left: Pit Pitch + Live ER Markets + On-Chain Open Arenas */}
        <section>
          <p className="hero-eyebrow">Entertainment Finance · Solana Blitz v10</p>
          <h1 className="hero-title">
            60-Second PvP Micro-Trading on Live Pyth Feeds.
          </h1>
          <p className="hero-lead">
            Escrow real SOL on Solana L1, delegate the battleground into a
            MagicBlock Ephemeral Rollup, and flip 20× LONG, SHORT, or FLAT with
            zero gas and zero wallet popups. Highest PnL when the clock hits
            zero claims the entire pot on L1.
          </p>

          <div className="ticker-strip">
            {(["SOL", "BTC", "ETH"] as const).map((k) => {
              const feed = MARKET_FEEDS[k];
              const tick = prices[k];
              const decimals = k === "BTC" || k === "ETH" ? 2 : 4;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setMarketKey(k)}
                  className={`ticker-card ${marketKey === k ? "selected" : ""}`}
                >
                  <div className="ticker-sym">
                    <span>{feed.symbol}</span>
                    <span style={{ color: "var(--bull)", fontSize: 11 }}>
                      ER LIVE
                    </span>
                  </div>
                  <div className="ticker-price">
                    {tick ? `$${tick.priceUsd.toFixed(decimals)}` : "Loading…"}
                  </div>
                  <div className="ticker-meta">
                    {tick ? `slot ${tick.postedSlot.toString()}` : "Pyth Lazer"}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="spec-row" style={{ marginBottom: 24 }}>
            <div>
              <div className="spec-label">Custody</div>
              <div className="spec-val">Solana L1 Vault</div>
            </div>
            <div>
              <div className="spec-label">Execution</div>
              <div className="spec-val">MagicBlock ER · 0 Gas</div>
            </div>
            <div>
              <div className="spec-label">Scoring</div>
              <div className="spec-val">20× Mark-to-Market</div>
            </div>
          </div>

          {/* Live On-Chain Rooms */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">On-Chain Arenas (Solana Devnet)</span>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ height: 30, padding: "0 10px", fontSize: 12 }}
                onClick={fetchOnChainRooms}
                disabled={loadingRooms}
              >
                <RefreshCw size={13} />
                {loadingRooms ? "Scanning…" : "Refresh"}
              </button>
            </div>
            <div className="panel-body">
              <form
                onSubmit={handleJoinById}
                style={{ display: "flex", gap: 8, marginBottom: 14 }}
              >
                <input
                  className="input"
                  placeholder="Paste Room ID or /room/... URL"
                  value={roomLookup}
                  onChange={(e) => setRoomLookup(e.target.value)}
                />
                <button type="submit" className="btn" style={{ flexShrink: 0 }}>
                  Open <ArrowRight size={14} />
                </button>
              </form>

              {rooms.length === 0 ? (
                <div
                  style={{
                    padding: "22px 12px",
                    textAlign: "center",
                    fontSize: 13,
                    color: "var(--ink-muted)",
                    border: "1px dashed var(--border-subtle)",
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  {loadingRooms
                    ? "Querying Solana Devnet for CandleRoyale arenas…"
                    : "No open Devnet rooms found yet. Launch the first arena on the right and share its URL to battle."}
                </div>
              ) : (
                <div className="seat-list">
                  {rooms.map(({ roomId, arena }) => {
                    const market = marketFromFeed(arena.priceFeed);
                    const potSol =
                      (Number(arena.entryFee) * arena.playerCount) /
                      LAMPORTS_PER_SOL;
                    return (
                      <div
                        key={roomId}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          padding: "11px 12px",
                          background: "var(--bg-inset)",
                          border: "1px solid var(--border-subtle)",
                          borderRadius: "var(--radius-sm)",
                        }}
                      >
                        <div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              marginBottom: 3,
                            }}
                          >
                            <span className="mono" style={{ fontWeight: 700, fontSize: 13 }}>
                              {market.symbol}
                            </span>
                            <span
                              className={`pos-chip ${
                                arena.status === "Lobby"
                                  ? "long"
                                  : arena.status === "Live"
                                    ? "short"
                                    : "flat"
                              }`}
                            >
                              {arena.status}
                            </span>
                            <span
                              className="mono"
                              style={{ fontSize: 11, color: "var(--ink-muted)" }}
                            >
                              #{roomId.slice(-6)}
                            </span>
                          </div>
                          <div
                            className="mono"
                            style={{ fontSize: 11, color: "var(--ink-secondary)" }}
                          >
                            {arena.playerCount}/{arena.maxPlayers} traders ·{" "}
                            {arena.durationSecs.toString()}s ·{" "}
                            <span style={{ color: "var(--gold)" }}>
                              {potSol.toFixed(2)} SOL pot
                            </span>
                          </div>
                        </div>

                        <button
                          type="button"
                          className="btn"
                          onClick={() => router.push(`/room/${roomId}`)}
                        >
                          Enter <ArrowRight size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Right: Launch Arena Panel */}
        <aside className="panel">
          <div className="panel-header">
            <span className="panel-title">Create Battle Arena</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--gold)" }}>
              L1 Escrow + Session Key
            </span>
          </div>
          <div className="panel-body">
            {error && <div className="status-banner error">{error}</div>}

            <div className="field">
              <div className="field-label">
                <span>Live Price Feed (MagicBlock ER)</span>
                <span className="mono" style={{ color: "var(--gold)" }}>
                  {MARKET_FEEDS[marketKey].symbol}
                </span>
              </div>
              <div className="segmented">
                {(["SOL", "BTC", "ETH"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`seg-btn ${marketKey === k ? "active" : ""}`}
                    onClick={() => setMarketKey(k)}
                  >
                    {k}/USD
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <div className="field-label">
                <span>Entry Stake (Escrowed on L1)</span>
                <span className="mono" style={{ color: "var(--ink-primary)" }}>
                  Winner takes all
                </span>
              </div>
              <div className="segmented">
                {STAKE_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={`seg-btn ${stakeLamports === p.lamports ? "active" : ""}`}
                    onClick={() => setStakeLamports(p.lamports)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <div className="field-label">
                <span>Sprint Clock</span>
                <span className="mono">{durationSecs} seconds</span>
              </div>
              <div className="segmented">
                {DURATION_PRESETS.map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    className={`seg-btn ${durationSecs === sec ? "active" : ""}`}
                    onClick={() => setDurationSecs(sec)}
                  >
                    {sec}s
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <div className="field-label">
                <span>Arena Seats</span>
                <span className="mono">
                  {maxPlayers === 1 ? "Solo Time Trial" : `Up to ${maxPlayers} PvP`}
                </span>
              </div>
              <div className="segmented">
                {SEAT_PRESETS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`seg-btn ${maxPlayers === n ? "active" : ""}`}
                    onClick={() => setMaxPlayers(n)}
                  >
                    {n === 1 ? "1 Solo" : `${n}P`}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              id="create-arena-btn"
              className="btn btn-primary btn-lg"
              style={{ width: "100%", marginTop: 6 }}
              onClick={handleCreateRoom}
              disabled={creating}
            >
              {creating
                ? "Confirming on Solana Devnet…"
                : connected
                  ? stakeLamports > 0n
                    ? `Create Arena · Escrow ${(Number(stakeLamports) / LAMPORTS_PER_SOL).toFixed(2)} SOL`
                    : "Create Free Arena on Devnet"
                  : "Connect Wallet to Create Arena"}
            </button>

            <div
              style={{
                marginTop: 20,
                paddingTop: 16,
                borderTop: "1px solid var(--border-subtle)",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                fontSize: 12,
                color: "var(--ink-secondary)",
              }}
            >
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <ShieldCheck size={15} color="#f5c451" style={{ flexShrink: 0, marginTop: 2 }} />
                <span>
                  <strong style={{ color: "var(--ink-primary)" }}>L1 Vault Custody:</strong>{" "}
                  SOL stays in an undelegated L1 PDA. Only the battle state delegates to ER.
                </span>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <Zap size={15} color="#00d084" style={{ flexShrink: 0, marginTop: 2 }} />
                <span>
                  <strong style={{ color: "var(--ink-primary)" }}>Session Keys on ER:</strong>{" "}
                  Approve once to enter, then flip positions with zero wallet popups and 0 gas.
                </span>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <Users size={15} color="#9aa3b2" style={{ flexShrink: 0, marginTop: 2 }} />
                <span>
                  <strong style={{ color: "var(--ink-primary)" }}>2-Tab PvP Ready:</strong>{" "}
                  Open a second browser tab with Solflare or the Devnet Burner to duel live.
                </span>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <Trophy size={15} color="#f5c451" style={{ flexShrink: 0, marginTop: 2 }} />
                <span>
                  <strong style={{ color: "var(--ink-primary)" }}>Trustless Settlement:</strong>{" "}
                  Final PnL commits from MagicBlock ER back to Solana L1 to unlock the pot.
                </span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
