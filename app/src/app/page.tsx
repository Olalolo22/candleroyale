"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Connection, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import { ArrowRight, RefreshCw } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { useWallet } from "@/lib/wallet";
import { getOrCreateSessionKey } from "@/lib/session";
import { useAllMarkets } from "@/lib/useOracleStream";
import { fmtSol } from "@/lib/pit";
import {
  ArenaAccount,
  buildCreateRoomIx,
  buildDelegateSeatIx,
  decodeArena,
  DISCRIMINATORS,
  findSeatPda,
} from "@sdk/codec";
import {
  ARENA_ACCOUNT_SIZE,
  CANDLEROYALE_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  MARKET_FEEDS,
  marketFromFeed,
  SOLANA_L1_RPC,
} from "@sdk/constants";

type MarketKey = "SOL" | "BTC" | "ETH";
type RoomTab = "open" | "trading" | "settled";

interface DiscoveredRoom {
  roomId: string;
  arena: ArenaAccount;
  delegated: boolean;
}

const MARKETS: MarketKey[] = ["SOL", "BTC", "ETH"];

const STAKE_PRESETS = [
  { label: "Free", lamports: 0n },
  { label: "0.01", lamports: 10_000_000n },
  { label: "0.05", lamports: 50_000_000n },
  { label: "0.10", lamports: 100_000_000n },
];

const DURATION_PRESETS = [30, 60, 90];
const SEAT_PRESETS = [1, 2, 4, 6];

const ROUND_STEPS = [
  {
    name: "Stake",
    desc: "Everyone puts the same SOL into a vault on Solana.",
  },
  {
    name: "Trade",
    desc: "Go long, short or flat on a live price, as often as you like. No gas, no popups.",
  },
  {
    name: "Settle",
    desc: "When the clock hits zero, every open position closes at the live price.",
  },
  {
    name: "Payout",
    desc: "The best score takes the pot straight to their wallet. Ties split equally.",
  },
];

function roomTab(r: DiscoveredRoom): RoomTab {
  if (r.arena.status === "Finished" || r.arena.status === "Aborted") {
    return "settled";
  }
  if (r.delegated || r.arena.status === "Live") return "trading";
  return "open";
}

const TAB_LABEL: Record<RoomTab, string> = {
  open: "Open",
  trading: "Trading",
  settled: "Settled",
};

/** Simple ARIA radio group helper: arrow keys move the selection. */
function onRadioKeys<T>(
  e: React.KeyboardEvent,
  options: readonly T[],
  current: T,
  set: (v: T) => void
) {
  const i = options.indexOf(current);
  let next: T | null = null;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    next = options[(i + 1) % options.length];
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    next = options[(i - 1 + options.length) % options.length];
  }
  if (next === null) return;
  e.preventDefault();
  set(next);
  // Roving focus: follow the selection once React re-renders
  const group = e.currentTarget as HTMLElement;
  requestAnimationFrame(() => {
    group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  });
}

export default function LobbyPage() {
  const router = useRouter();
  const { publicKey, connected, openModal, sendL1Transaction } = useWallet();
  const { prices, erSlot } = useAllMarkets();

  const [marketKey, setMarketKey] = useState<MarketKey>("SOL");
  const [stakeLamports, setStakeLamports] = useState<bigint>(10_000_000n);
  const [durationSecs, setDurationSecs] = useState<number>(60);
  const [maxPlayers, setMaxPlayers] = useState<number>(2);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [roomLookup, setRoomLookup] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<DiscoveredRoom[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [tab, setTab] = useState<RoomTab>("open");

  const l1Conn = useMemo(() => new Connection(SOLANA_L1_RPC, "confirmed"), []);

  const fetchOnChainRooms = useCallback(async () => {
    setLoadingRooms(true);
    try {
      const accounts = await l1Conn.getProgramAccounts(CANDLEROYALE_PROGRAM_ID, {
        filters: [{ dataSize: ARENA_ACCOUNT_SIZE }],
      });
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
      const recent = parsed.slice(0, 40);

      // Rooms made before sealed seats existed have no seat account and can never start.
      // Hide them unless they already finished (those still open fine as a record).
      const seatInfos = recent.length
        ? await l1Conn.getMultipleAccountsInfo(
            recent.map((r) => findSeatPda(r.arena.roomId, 0)[0]),
            "confirmed"
          )
        : [];
      setRooms(
        recent.filter(
          (r, i) =>
            seatInfos[i] !== null ||
            r.arena.status === "Finished" ||
            r.arena.status === "Aborted"
        )
      );
    } catch {
      // Program may not have rooms yet or RPC busy
    } finally {
      setLoadingRooms(false);
    }
  }, [l1Conn]);

  useEffect(() => {
    fetchOnChainRooms();
  }, [fetchOnChainRooms]);

  const counts = useMemo(() => {
    const c: Record<RoomTab, number> = { open: 0, trading: 0, settled: 0 };
    for (const r of rooms) c[roomTab(r)] += 1;
    return c;
  }, [rooms]);

  const visibleRooms = useMemo(
    () => rooms.filter((r) => roomTab(r) === tab).slice(0, 12),
    [rooms, tab]
  );

  const handleCreateRoom = async () => {
    setError(null);
    if (!connected || !publicKey) {
      openModal();
      return;
    }

    setCreating(true);
    try {
      const roomId = BigInt(Date.now());
      const sessionKey = getOrCreateSessionKey(roomId.toString(), publicKey.toBase58());
      const ix = buildCreateRoomIx({
        creator: publicKey,
        roomId,
        entryFeeLamports: stakeLamports,
        durationSecs,
        maxPlayers,
        priceFeed: MARKET_FEEDS[marketKey].address,
        sessionKey: sessionKey.publicKey,
      });

      // Your seat is created private and handed to MagicBlock's private rollup in the same step
      const tx = new Transaction().add(
        ix,
        buildDelegateSeatIx({ payer: publicKey, roomId, seatIndex: 0 })
      );
      await sendL1Transaction(tx);
      router.push(`/room/${roomId.toString()}`);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "The room wasn't created. Check your wallet is on Devnet and has enough SOL, then try again."
      );
    } finally {
      setCreating(false);
    }
  };

  const handleJoinById = (e: React.FormEvent) => {
    e.preventDefault();
    setLookupError(null);
    const cleaned = roomLookup.trim().replace(/^.*\/room\//, "");
    if (!/^\d+$/.test(cleaned)) {
      setLookupError("Room codes are numbers. Paste the code or the full invite link.");
      return;
    }
    router.push(`/room/${cleaned}`);
  };

  const stakeSol = Number(stakeLamports) / LAMPORTS_PER_SOL;
  const fullPotSol = stakeSol * maxPlayers;
  const solo = maxPlayers === 1;

  const createLabel = creating
    ? "Waiting for your wallet…"
    : !connected
      ? "Connect wallet to create"
      : stakeLamports > 0n
        ? `Create room and stake ${fmtSol(stakeSol)} SOL`
        : "Create free room";

  return (
    <main className="shell">
      <TopBar erSlot={erSlot} />

      <div className="lobby">
        {/* ── Hero ─────────────────────────────────────────────── */}
        <section aria-labelledby="hero-title">
          <h1 id="hero-title" className="hero-title">
            <span>Sixty seconds.</span>
            <span>Call the candle.</span>
            <span className="ghost">Take the pot.</span>
          </h1>
          <p className="hero-lead">
            Up to six players stake SOL and trade one live price at{" "}
            <strong>20× leverage</strong>. Flip long, short or flat as often as you
            like. Whoever is furthest ahead when the clock runs out{" "}
            <strong>takes everything</strong>.
          </p>

          <ol className="round-steps" aria-label="How a round works">
            {ROUND_STEPS.map((s, i) => (
              <li key={s.name}>
                <span className="step-n" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="step-name">{s.name}</span>
                <span className="step-desc">{s.desc}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* ── Order ticket ─────────────────────────────────────── */}
        <aside className="card ticket" aria-labelledby="ticket-title">
          <div className="ticket-head">
            <h2 id="ticket-title" className="card-title">
              Open a room
            </h2>
            <p>Pick the market and the rules. You can share the invite link next.</p>
          </div>

          <div className="ticket-body">
            {error && (
              <div className="banner error" role="alert">
                {error}
              </div>
            )}

            <fieldset>
              <legend className="field-legend">Market</legend>
              <div
                className="market-board"
                role="radiogroup"
                aria-label="Market"
                onKeyDown={(e) => onRadioKeys(e, MARKETS, marketKey, setMarketKey)}
              >
                {MARKETS.map((k) => {
                  const tick = prices[k];
                  const decimals = k === "SOL" ? 3 : 0;
                  const checked = marketKey === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      tabIndex={checked ? 0 : -1}
                      className="market-opt"
                      onClick={() => setMarketKey(k)}
                    >
                      <span className="market-sym">{k}</span>
                      <span className="market-px">
                        {tick
                          ? `$${tick.priceUsd.toLocaleString(undefined, {
                              minimumFractionDigits: decimals,
                              maximumFractionDigits: decimals,
                            })}`
                          : "Loading…"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <fieldset>
              <legend className="field-legend">
                Stake per player <span>SOL</span>
              </legend>
              <div
                className="choice-row"
                role="radiogroup"
                aria-label="Stake per player"
                onKeyDown={(e) =>
                  onRadioKeys(
                    e,
                    STAKE_PRESETS.map((p) => p.lamports),
                    stakeLamports,
                    setStakeLamports
                  )
                }
              >
                {STAKE_PRESETS.map((p) => {
                  const checked = stakeLamports === p.lamports;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      tabIndex={checked ? 0 : -1}
                      className="choice"
                      onClick={() => setStakeLamports(p.lamports)}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <fieldset>
              <legend className="field-legend">Round length</legend>
              <div
                className="choice-row"
                role="radiogroup"
                aria-label="Round length"
                onKeyDown={(e) =>
                  onRadioKeys(e, DURATION_PRESETS, durationSecs, setDurationSecs)
                }
              >
                {DURATION_PRESETS.map((sec) => {
                  const checked = durationSecs === sec;
                  return (
                    <button
                      key={sec}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      tabIndex={checked ? 0 : -1}
                      className="choice"
                      onClick={() => setDurationSecs(sec)}
                    >
                      {sec}s
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <fieldset>
              <legend className="field-legend">
                Players <span>{solo ? "Solo practice" : `Up to ${maxPlayers}`}</span>
              </legend>
              <div
                className="choice-row"
                role="radiogroup"
                aria-label="Players"
                onKeyDown={(e) => onRadioKeys(e, SEAT_PRESETS, maxPlayers, setMaxPlayers)}
              >
                {SEAT_PRESETS.map((n) => {
                  const checked = maxPlayers === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      tabIndex={checked ? 0 : -1}
                      className="choice"
                      onClick={() => setMaxPlayers(n)}
                    >
                      {n === 1 ? "Solo" : n}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div className="ticket-total">
              <span>{solo ? "Your stake" : "Pot when full"}</span>
              <strong>
                {stakeLamports > 0n ? `${fmtSol(fullPotSol)} SOL` : "Free"}
              </strong>
            </div>

            <button
              type="button"
              id="create-arena-btn"
              className="btn btn-primary btn-lg btn-block"
              onClick={handleCreateRoom}
              disabled={creating}
            >
              {creating && <span className="spinner" aria-hidden="true" />}
              {createLabel}
            </button>

            <p className="ticket-fine">
              Stakes stay in a vault on Solana the whole time. Only the scoreboard
              moves to MagicBlock&apos;s rollup, which is what makes trades instant and
              free.
            </p>
          </div>
        </aside>

        {/* ── Rooms board ──────────────────────────────────────── */}
        <section className="rooms" aria-labelledby="rooms-title">
          <div className="rooms-head">
            <h2 id="rooms-title">Rooms</h2>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div className="tabs" role="tablist" aria-label="Filter rooms">
                {(Object.keys(TAB_LABEL) as RoomTab[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    className="tab"
                    onClick={() => setTab(t)}
                  >
                    {TAB_LABEL[t]}
                    <span className="count">{counts[t]}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-quiet btn-icon"
                onClick={fetchOnChainRooms}
                disabled={loadingRooms}
                aria-label="Refresh rooms"
                title="Refresh rooms"
              >
                {loadingRooms ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <RefreshCw size={16} />
                )}
              </button>
            </div>
          </div>

          <div className="room-list" role="tabpanel" aria-live="polite">
            {visibleRooms.length === 0 ? (
              <div className="empty">
                {loadingRooms ? (
                  <strong>Looking for rooms on Devnet…</strong>
                ) : tab === "open" ? (
                  <>
                    <strong>No open rooms right now.</strong>
                    Open one and send the link to a friend, or fill the seats with
                    practice bots and play right away.
                  </>
                ) : tab === "trading" ? (
                  <>
                    <strong>Nobody is trading right now.</strong>
                    Rooms show up here once their round starts.
                  </>
                ) : (
                  <>
                    <strong>No settled rooms yet.</strong>
                    Finished rounds and their winners land here.
                  </>
                )}
              </div>
            ) : (
              visibleRooms.map((room) => {
                const { roomId, arena } = room;
                const t = roomTab(room);
                const market = marketFromFeed(arena.priceFeed);
                const entry = Number(arena.entryFee) / LAMPORTS_PER_SOL;
                const potSol = entry * arena.playerCount;
                const full = arena.playerCount >= arena.maxPlayers;
                return (
                  <div key={roomId} className="room-row">
                    <span className="room-sym">{market.symbol.split("/")[0]}</span>
                    <div className="room-meta">
                      <span className={`status-tag ${t}`}>
                        {arena.status === "Aborted" ? "Aborted" : TAB_LABEL[t]}
                      </span>
                      <span
                        className="seat-pips"
                        aria-label={`${arena.playerCount} of ${arena.maxPlayers} players`}
                        title={`${arena.playerCount} of ${arena.maxPlayers} players`}
                      >
                        {Array.from({ length: arena.maxPlayers }).map((_, i) => (
                          <i key={i} className={i < arena.playerCount ? "on" : ""} />
                        ))}
                      </span>
                      <span>{arena.durationSecs.toString()}s</span>
                      <span>{entry > 0 ? `${fmtSol(entry)} SOL in` : "Free"}</span>
                      <span className="room-code">#{roomId.slice(-6)}</span>
                    </div>
                    <div className="room-pot">
                      <strong>{entry > 0 ? fmtSol(potSol) : "Free"}</strong>
                      <span>{entry > 0 ? "SOL pot" : "No stake"}</span>
                    </div>
                    <button
                      type="button"
                      className={`btn ${t === "open" && !full ? "btn-primary" : ""}`}
                      onClick={() => router.push(`/room/${roomId}`)}
                    >
                      {t === "open" && !full
                        ? "Join"
                        : arena.status === "Aborted"
                          ? "Refunds"
                          : t === "settled"
                            ? "Results"
                            : "Watch"}
                      <ArrowRight size={15} />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <form className="lookup" onSubmit={handleJoinById}>
            <label htmlFor="room-lookup" className="sr-only">
              Room code or invite link
            </label>
            <input
              id="room-lookup"
              className="input"
              placeholder="Have an invite? Paste the room code or link"
              value={roomLookup}
              onChange={(e) => setRoomLookup(e.target.value)}
              aria-invalid={!!lookupError}
              aria-describedby={lookupError ? "lookup-error" : undefined}
            />
            <button type="submit" className="btn">
              Go to room
            </button>
          </form>
          {lookupError && (
            <p
              id="lookup-error"
              role="alert"
              style={{ margin: "8px 0 0", color: "var(--bear)", fontSize: "0.875rem" }}
            >
              {lookupError}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
