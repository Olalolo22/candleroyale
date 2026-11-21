"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  Check,
  Copy,
  Crown,
  ExternalLink,
  KeyRound,
  Minus,
  Play,
  ShieldCheck,
  Trophy,
  Zap,
} from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { CandleCanvas, TapMarker } from "@/components/CandleCanvas";
import { useWallet } from "@/lib/wallet";
import {
  createErConnection,
  getOrCreateSessionKey,
  loadExistingSessionKey,
  sendErSessionTx,
} from "@/lib/session";
import { useOracleStream } from "@/lib/useOracleStream";
import { pitAudio } from "@/lib/audio";
import {
  ArenaAccount,
  buildBeginRoundIx,
  buildCancelRoomIx,
  buildClaimPayoutIx,
  buildFinishRoundIx,
  buildJoinRoomIx,
  buildStartAndDelegateIx,
  buildTapIx,
  decodeArena,
  decodeVault,
  findArenaPda,
  findVaultPda,
  formatPnlPct,
  PlayerSeat,
  totalSeatPnl,
  VaultAccount,
} from "@sdk/codec";
import {
  CANDLEROYALE_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  ER_VALIDATOR_PUBKEY,
  MARKET_FEEDS,
  marketFromFeed,
  NO_WINNER,
  POS_FLAT,
  POS_LONG,
  POS_SHORT,
  PositionDir,
  SOLANA_L1_RPC,
} from "@sdk/constants";

interface ExecutionLogEntry {
  id: string;
  layer: "L1" | "ER";
  action: string;
  sig: string;
  ms?: number;
  priceUsd?: number;
  ts: string;
}

function shortKey(k: string) {
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

function posLabel(pos: PositionDir) {
  if (pos === POS_LONG) return "LONG";
  if (pos === POS_SHORT) return "SHORT";
  return "FLAT";
}

function posClass(pos: PositionDir) {
  if (pos === POS_LONG) return "long";
  if (pos === POS_SHORT) return "short";
  return "flat";
}

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const roomIdStr = params?.id ?? "";
  const validRoomId = /^\d+$/.test(roomIdStr);
  const roomId = useMemo(
    () => (validRoomId ? BigInt(roomIdStr) : 0n),
    [validRoomId, roomIdStr]
  );

  const { publicKey, connected, openModal, sendL1Transaction } = useWallet();

  const l1Conn = useMemo(() => new Connection(SOLANA_L1_RPC, "confirmed"), []);
  const erConn = useMemo(() => createErConnection(), []);

  const [vaultPda] = useMemo(
    () => (validRoomId ? findVaultPda(roomId) : [PublicKey.default, 0]),
    [validRoomId, roomId]
  );
  const [arenaPda] = useMemo(
    () => (validRoomId ? findArenaPda(roomId) : [PublicKey.default, 0]),
    [validRoomId, roomId]
  );

  const [vault, setVault] = useState<VaultAccount | null>(null);
  const [arena, setArena] = useState<ArenaAccount | null>(null);
  const [isDelegated, setIsDelegated] = useState(false);
  const [loadingRoom, setLoadingRoom] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [tapping, setTapping] = useState(false);
  const [banner, setBanner] = useState<{
    kind: "error" | "info" | "success";
    text: string;
  } | null>(null);

  const [txFeed, setTxFeed] = useState<ExecutionLogEntry[]>([]);
  const [tapMarkers, setTapMarkers] = useState<TapMarker[]>([]);
  const [copiedLink, setCopiedLink] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastUrgentSecRef = useRef<number>(-1);
  const victoryPlayedRef = useRef(false);

  const feedAddress = arena?.priceFeed ?? MARKET_FEEDS.SOL.address;
  const market = useMemo(() => marketFromFeed(feedAddress), [feedAddress]);
  const {
    latest: oracleTick,
    candles,
    rttMs: oracleRttMs,
  } = useOracleStream(feedAddress);

  const pushLog = useCallback((entry: Omit<ExecutionLogEntry, "id" | "ts">) => {
    const ts = new Date().toTimeString().slice(0, 8);
    setTxFeed((prev) => [
      { ...entry, id: `${Date.now()}-${Math.random()}`, ts },
      ...prev.slice(0, 29),
    ]);
  }, []);

  // Poll L1 Vault + Arena ownership, and switch Arena reads to ER when delegated
  const syncState = useCallback(async () => {
    if (!validRoomId) {
      setNotFound(true);
      setLoadingRoom(false);
      return;
    }
    try {
      const [vaultInfo, l1ArenaInfo] = await l1Conn.getMultipleAccountsInfo(
        [vaultPda, arenaPda],
        "confirmed"
      );

      if (!vaultInfo || !l1ArenaInfo) {
        setNotFound(true);
        setLoadingRoom(false);
        return;
      }

      setNotFound(false);
      setVault(decodeVault(vaultInfo.data));

      const delegatedNow = l1ArenaInfo.owner.equals(DELEGATION_PROGRAM_ID);
      setIsDelegated(delegatedNow);

      if (delegatedNow) {
        const erArenaInfo = await erConn.getAccountInfo(arenaPda, "confirmed");
        if (erArenaInfo) {
          setArena(decodeArena(erArenaInfo.data));
        }
      } else if (l1ArenaInfo.owner.equals(CANDLEROYALE_PROGRAM_ID)) {
        setArena(decodeArena(l1ArenaInfo.data));
      }
      setLoadingRoom(false);
    } catch {
      // keep existing state on transient RPC error
    }
  }, [validRoomId, l1Conn, erConn, vaultPda, arenaPda]);

  // Fast ER-only arena refresh during delegated gameplay
  const syncErArena = useCallback(async () => {
    if (!validRoomId) return;
    try {
      const erArenaInfo = await erConn.getAccountInfo(arenaPda, "confirmed");
      if (erArenaInfo) {
        setArena(decodeArena(erArenaInfo.data));
      }
    } catch {
      // ignore transient ER poll blip
    }
  }, [validRoomId, erConn, arenaPda]);

  useEffect(() => {
    syncState();
    const l1Timer = setInterval(syncState, 2200);
    return () => clearInterval(l1Timer);
  }, [syncState]);

  useEffect(() => {
    if (!isDelegated) return;
    const erTimer = setInterval(syncErArena, 400);
    return () => clearInterval(erTimer);
  }, [isDelegated, syncErArena]);

  // 100ms local chronometer display synced to on-chain endsAt
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  const mySeatIndex = useMemo(() => {
    if (!arena || !publicKey) return -1;
    return arena.players.findIndex((p) => p.wallet.equals(publicKey));
  }, [arena, publicKey]);

  const mySeat: PlayerSeat | null =
    arena && mySeatIndex >= 0 ? arena.players[mySeatIndex] : null;

  const activeSessionKey: Keypair | null = useMemo(() => {
    if (!publicKey || !mySeat || !validRoomId) return null;
    const loaded = loadExistingSessionKey(roomIdStr, publicKey.toBase58());
    if (loaded && loaded.publicKey.equals(mySeat.sessionKey)) {
      return loaded;
    }
    return null;
  }, [publicKey, mySeat, validRoomId, roomIdStr]);

  const remainingSec = useMemo(() => {
    if (!arena) return 0;
    if (arena.status === "Lobby") return Number(arena.durationSecs);
    if (arena.status === "Finished") return 0;
    return Math.max(0, (Number(arena.endsAt) * 1000 - nowMs) / 1000);
  }, [arena, nowMs]);

  const timerExpired =
    arena?.status === "Live" &&
    arena.endsAt > 0n &&
    nowMs >= Number(arena.endsAt) * 1000;

  // Audio ticks for final 10 seconds + victory fanfare
  useEffect(() => {
    if (arena?.status === "Live" && remainingSec > 0 && remainingSec <= 10) {
      const whole = Math.ceil(remainingSec);
      if (whole !== lastUrgentSecRef.current) {
        lastUrgentSecRef.current = whole;
        pitAudio.playTick(whole <= 3);
      }
    }
    if (arena?.status === "Finished" && !victoryPlayedRef.current) {
      victoryPlayedRef.current = true;
      pitAudio.playVictory();
    }
  }, [arena?.status, remainingSec]);

  // Ranked leaderboard with live mark-to-market PnL
  const rankedSeats = useMemo(() => {
    if (!arena) return [];
    const liveRaw =
      arena.status === "Finished"
        ? arena.lastPrice
        : oracleTick?.rawPrice ?? arena.lastPrice;
    return arena.players
      .map((seat, idx) => ({
        seat,
        seatIndex: idx,
        livePnl:
          arena.status === "Finished"
            ? seat.realizedPnl
            : totalSeatPnl(seat, liveRaw),
      }))
      .sort((a, b) => {
        if (b.livePnl !== a.livePnl) return b.livePnl > a.livePnl ? 1 : -1;
        if (b.seat.tapCount !== a.seat.tapCount) {
          return b.seat.tapCount - a.seat.tapCount;
        }
        return a.seatIndex - b.seatIndex;
      });
  }, [arena, oracleTick]);

  // ─── Actions ──────────────────────────────────────────────────────────────

  const handleJoin = async () => {
    setBanner(null);
    if (!connected || !publicKey) {
      openModal();
      return;
    }
    setBusyAction("Joining arena & escrowing SOL on Solana L1…");
    try {
      const sk = getOrCreateSessionKey(roomIdStr, publicKey.toBase58());
      const ix = buildJoinRoomIx({
        player: publicKey,
        roomId,
        sessionKey: sk.publicKey,
      });
      const sig = await sendL1Transaction(new Transaction().add(ix));
      pushLog({ layer: "L1", action: "join_room", sig });
      setBanner({
        kind: "success",
        text: "Seated on Solana L1 and Session Key bound. Ready to delegate to MagicBlock ER.",
      });
      await syncState();
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to join room.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancel = async () => {
    setBanner(null);
    if (!publicKey) return;
    setBusyAction("Cancelling lobby & refunding SOL from L1 Vault…");
    try {
      const ix = buildCancelRoomIx({ creator: publicKey, roomId });
      const sig = await sendL1Transaction(new Transaction().add(ix));
      pushLog({ layer: "L1", action: "cancel_room", sig });
      setBanner({ kind: "info", text: "Room cancelled and SOL refunded." });
      await syncState();
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to cancel room.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleDelegate = async () => {
    setBanner(null);
    if (!connected || !publicKey) {
      openModal();
      return;
    }
    setBusyAction("Delegating Arena PDA to MagicBlock US Devnet ER…");
    try {
      const ix = buildStartAndDelegateIx({
        payer: publicKey,
        roomId,
        validator: ER_VALIDATOR_PUBKEY,
      });
      const sig = await sendL1Transaction(new Transaction().add(ix));
      pushLog({ layer: "L1", action: "start_and_delegate", sig });

      setBanner({
        kind: "info",
        text: "Delegated on L1. Syncing Arena state into MagicBlock ER…",
      });

      // Wait briefly for ER validator pickup
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 700));
        const info = await erConn.getAccountInfo(arenaPda, "confirmed");
        if (info) break;
      }

      await syncState();
      setBanner({
        kind: "success",
        text: "Arena is LIVE on MagicBlock ER! Tap LONG / SHORT / FLAT — 0 popups, 0 gas.",
      });
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Delegation failed.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleBeginRound = async () => {
    if (!activeSessionKey || !arena) return;
    setBanner(null);
    setBusyAction("Starting countdown on MagicBlock ER (0 gas)…");
    try {
      const ix = buildBeginRoundIx({
        signer: activeSessionKey.publicKey,
        roomId,
        priceFeed: arena.priceFeed,
      });
      const res = await sendErSessionTx(
        erConn,
        new Transaction().add(ix),
        activeSessionKey
      );
      pushLog({
        layer: "ER",
        action: "begin_round",
        sig: res.signature,
        ms: res.latencyMs,
        priceUsd: oracleTick?.priceUsd,
      });
      await syncErArena();
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to start round on ER.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleTap = useCallback(
    async (dir: PositionDir) => {
      if (!arena || !isDelegated || !activeSessionKey || tapping || timerExpired) {
        return;
      }
      if (arena.status === "Finished") return;

      setTapping(true);
      setBanner(null);
      if (dir === POS_LONG) pitAudio.playLong();
      else if (dir === POS_SHORT) pitAudio.playShort();
      else pitAudio.playFlat();

      try {
        const ix = buildTapIx({
          signer: activeSessionKey.publicKey,
          roomId,
          newPosition: dir,
          priceFeed: arena.priceFeed,
        });
        const res = await sendErSessionTx(
          erConn,
          new Transaction().add(ix),
          activeSessionKey
        );

        const priceNow = oracleTick?.priceUsd;
        if (priceNow) {
          setTapMarkers((prev) => [
            ...prev.slice(-30),
            { ts: Date.now(), priceUsd: priceNow, position: dir },
          ]);
        }

        pushLog({
          layer: "ER",
          action: `tap(${posLabel(dir)})`,
          sig: res.signature,
          ms: res.latencyMs,
          priceUsd: priceNow,
        });

        await syncErArena();
      } catch (err: unknown) {
        setBanner({
          kind: "error",
          text: err instanceof Error ? err.message : "ER tap failed.",
        });
      } finally {
        setTapping(false);
      }
    },
    [
      arena,
      isDelegated,
      activeSessionKey,
      tapping,
      timerExpired,
      roomId,
      erConn,
      oracleTick,
      pushLog,
      syncErArena,
    ]
  );

  // Keyboard hotkeys during active ER match (W/Up = LONG, Space = FLAT, S/Down = SHORT)
  useEffect(() => {
    if (!isDelegated || !activeSessionKey || arena?.status === "Finished") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === "w" || e.key === "W" || e.key === "ArrowUp") {
        e.preventDefault();
        handleTap(POS_LONG);
      } else if (e.key === "s" || e.key === "S" || e.key === "ArrowDown") {
        e.preventDefault();
        handleTap(POS_SHORT);
      } else if (e.key === " ") {
        e.preventDefault();
        handleTap(POS_FLAT);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDelegated, activeSessionKey, arena?.status, handleTap]);

  const handleFinishRound = async () => {
    if (!arena) return;
    setBanner(null);
    setBusyAction(
      "Closing all positions on MagicBlock ER & committing state back to Solana L1…"
    );
    try {
      const signerKp = activeSessionKey;
      if (!signerKp) {
        throw new Error(
          "Session key not found in this browser tab. Re-open from the tab that joined the room."
        );
      }
      const ix = buildFinishRoundIx({
        payer: signerKp.publicKey,
        roomId,
        priceFeed: arena.priceFeed,
      });
      const res = await sendErSessionTx(
        erConn,
        new Transaction().add(ix),
        signerKp
      );
      pushLog({
        layer: "ER",
        action: "finish_round + undelegate",
        sig: res.signature,
        ms: res.latencyMs,
        priceUsd: oracleTick?.priceUsd,
      });

      setBanner({
        kind: "info",
        text: "MagicBlock ER committed final PnL. Waiting for Arena ownership return on Solana L1…",
      });

      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const info = await l1Conn.getAccountInfo(arenaPda, "confirmed");
        if (info && info.owner.equals(CANDLEROYALE_PROGRAM_ID)) {
          break;
        }
      }

      await syncState();
      setBanner({
        kind: "success",
        text: "Arena settled on Solana L1! Winner can now claim the escrowed SOL pot.",
      });
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text:
          err instanceof Error
            ? err.message
            : "Failed to finish round & undelegate.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleClaimPayout = async () => {
    if (!arena || !publicKey || arena.winnerIndex === NO_WINNER) return;
    const winningSeat = arena.players[arena.winnerIndex];
    if (!winningSeat) return;

    setBanner(null);
    setBusyAction("Releasing escrowed SOL pot from Solana L1 Vault…");
    try {
      const ix = buildClaimPayoutIx({
        payer: publicKey,
        roomId,
        winner: winningSeat.wallet,
      });
      const sig = await sendL1Transaction(new Transaction().add(ix));
      pushLog({ layer: "L1", action: "claim_payout", sig });
      setBanner({
        kind: "success",
        text: `Pot paid on Solana L1 to ${shortKey(winningSeat.wallet.toBase58())}!`,
      });
      await syncState();
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to claim payout.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCopyInvite = () => {
    if (typeof window === "undefined") return;
    navigator.clipboard.writeText(window.location.href);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 1600);
  };

  const potSol = vault ? Number(vault.totalPot) / LAMPORTS_PER_SOL : 0;
  const entrySol = vault ? Number(vault.entryFee) / LAMPORTS_PER_SOL : 0;
  const myLivePnl =
    mySeat && oracleTick && arena?.status !== "Finished"
      ? totalSeatPnl(mySeat, oracleTick.rawPrice)
      : mySeat?.realizedPnl ?? 0n;

  const myEntryPriceUsd =
    mySeat && mySeat.entryPrice > 0n
      ? Number(mySeat.entryPrice) / Math.pow(10, market.decimals)
      : null;

  const canTap =
    isDelegated &&
    !!activeSessionKey &&
    arena !== null &&
    arena.status !== "Finished" &&
    !timerExpired &&
    !busyAction;

  const winnerSeat =
    arena &&
    arena.status === "Finished" &&
    arena.winnerIndex < arena.players.length
      ? arena.players[arena.winnerIndex]
      : null;

  return (
    <main className="shell">
      <TopBar erSlot={oracleTick ? Number(oracleTick.postedSlot) : null} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 14,
        }}
      >
        <Link
          href="/"
          className="btn btn-ghost"
          style={{ height: 34, padding: "0 12px" }}
        >
          <ArrowLeft size={14} /> Lobby
        </Link>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            className="btn"
            style={{ height: 34, fontSize: 12 }}
            onClick={handleCopyInvite}
          >
            {copiedLink ? <Check size={13} color="#00d084" /> : <Copy size={13} />}
            {copiedLink ? "Invite Link Copied" : "Copy Room Invite"}
          </button>
          <a
            href={`https://explorer.solana.com/address/${arenaPda.toBase58()}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost"
            style={{ height: 34, fontSize: 12 }}
          >
            Arena PDA <ExternalLink size={12} />
          </a>
          <a
            href={`https://explorer.solana.com/address/${vaultPda.toBase58()}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost"
            style={{ height: 34, fontSize: 12 }}
          >
            L1 Vault <ExternalLink size={12} />
          </a>
        </div>
      </div>

      {loadingRoom ? (
        <div className="panel" style={{ padding: 48, textAlign: "center" }}>
          <p className="mono" style={{ color: "var(--ink-secondary)" }}>
            Loading Arena #{roomIdStr} from Solana Devnet & MagicBlock ER…
          </p>
        </div>
      ) : notFound || !arena || !vault ? (
        <div className="panel" style={{ padding: 48, textAlign: "center" }}>
          <h1 className="display" style={{ marginTop: 0 }}>
            Arena Not Found on Devnet
          </h1>
          <p style={{ color: "var(--ink-secondary)", marginBottom: 20 }}>
            Room ID <span className="mono">{roomIdStr}</span> does not exist on
            Solana Devnet program{" "}
            <span className="mono">
              {shortKey(CANDLEROYALE_PROGRAM_ID.toBase58())}
            </span>
            .
          </p>
          <Link href="/" className="btn btn-primary">
            Back to Lobby
          </Link>
        </div>
      ) : (
        <>
          {banner && (
            <div className={`status-banner ${banner.kind}`}>
              <span>{banner.text}</span>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ height: 24, padding: "0 8px", fontSize: 11 }}
                onClick={() => setBanner(null)}
              >
                Dismiss
              </button>
            </div>
          )}

          {busyAction && (
            <div className="status-banner info">
              <span className="mono">{busyAction}</span>
            </div>
          )}

          {/* Top Arena Telemetry Header */}
          <section className="panel arena-header">
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <span className="display" style={{ fontSize: 20, fontWeight: 700 }}>
                  {market.symbol} Pit
                </span>
                <span
                  className={`pos-chip ${
                    isDelegated
                      ? "long"
                      : arena.status === "Finished"
                        ? "flat"
                        : "short"
                  }`}
                >
                  {isDelegated
                    ? "ER LIVE"
                    : arena.status === "Finished"
                      ? "L1 SETTLED"
                      : "L1 LOBBY"}
                </span>
              </div>
              <div
                className="mono"
                style={{ fontSize: 12, color: "var(--ink-secondary)" }}
              >
                Room #{roomIdStr.slice(-6)} · {arena.playerCount}/
                {arena.maxPlayers} traders · 20× leverage
              </div>
            </div>

            <div className="clock-box">
              <div
                className={`clock-digits ${
                  arena.status === "Live" && remainingSec <= 10 ? "urgent" : ""
                }`}
              >
                {remainingSec.toFixed(1)}s
              </div>
              <div className="clock-caption">
                {arena.status === "Lobby"
                  ? isDelegated
                    ? "Delegated · First tap starts clock"
                    : "Waiting in L1 Lobby"
                  : arena.status === "Live"
                    ? timerExpired
                      ? "Clock Zero · Ready to Settle"
                      : "Sprint Live on MagicBlock ER"
                    : vault.cancelled
                      ? "Lobby Cancelled"
                      : "Finalized on Solana L1"}
              </div>
            </div>

            <div className="pot-box">
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "var(--ink-muted)",
                }}
              >
                L1 Escrowed Pot
              </span>
              <span className="pot-amount">{potSol.toFixed(3)} SOL</span>
              <span
                className="mono"
                style={{ fontSize: 11, color: "var(--ink-secondary)" }}
              >
                {vault.claimed
                  ? "Paid out on L1"
                  : vault.cancelled
                    ? "Refunded"
                    : "Winner takes all"}
              </span>
            </div>
          </section>

          {/* Main Cockpit Grid */}
          <div className="arena-grid">
            {/* Left: Live Chart + Pit Controls + Action Stage */}
            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">
                  Live Pyth Lazer Feed · {market.symbol}
                </span>
                {mySeat ? (
                  <span
                    className="mono"
                    style={{
                      fontSize: 12,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      color: activeSessionKey ? "var(--bull)" : "var(--gold)",
                    }}
                  >
                    <KeyRound size={13} />
                    {activeSessionKey
                      ? `Session Key ${shortKey(activeSessionKey.publicKey.toBase58())} · 0 Popups`
                      : "Session key lives in creator tab"}
                  </span>
                ) : (
                  <span
                    className="mono"
                    style={{ fontSize: 12, color: "var(--ink-muted)" }}
                  >
                    Spectator Mode
                  </span>
                )}
              </div>

              <div className="panel-body">
                <CandleCanvas
                  candles={candles}
                  livePriceUsd={oracleTick?.priceUsd ?? null}
                  entryPriceUsd={myEntryPriceUsd}
                  position={mySeat?.position ?? POS_FLAT}
                  symbol={market.symbol}
                  tapMarkers={tapMarkers}
                  erRttMs={oracleRttMs}
                />

                {/* Phase-Specific Controls */}
                {!isDelegated && arena.status === "Lobby" && !vault.cancelled && (
                  <div
                    style={{
                      marginTop: 16,
                      padding: 16,
                      background: "var(--bg-inset)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "var(--radius-md)",
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                        {mySeat
                          ? "You are seated in this Arena."
                          : "Open seat available on Solana Devnet."}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                        {mySeat
                          ? "Share the Invite Link so another wallet can join, or delegate now to start trading on MagicBlock ER."
                          : `Escrow ${entrySol.toFixed(3)} SOL into the L1 Vault to enter and bind your 0-popup Session Key.`}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {!mySeat && arena.playerCount < arena.maxPlayers && (
                        <button
                          type="button"
                          id="join-room-btn"
                          className="btn btn-primary btn-lg"
                          onClick={handleJoin}
                          disabled={!!busyAction}
                        >
                          {connected
                            ? `Join Arena (${entrySol.toFixed(2)} SOL)`
                            : "Connect Wallet to Join"}
                        </button>
                      )}

                      {mySeat && (
                        <button
                          type="button"
                          id="delegate-arena-btn"
                          className="btn btn-primary btn-lg"
                          onClick={handleDelegate}
                          disabled={!!busyAction}
                        >
                          <Zap size={16} />
                          Start & Delegate to MagicBlock ER
                        </button>
                      )}

                      {mySeat &&
                        publicKey?.equals(vault.creator) &&
                        arena.playerCount === 1 && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={handleCancel}
                            disabled={!!busyAction}
                          >
                            Cancel & Refund
                          </button>
                        )}
                    </div>
                  </div>
                )}

                {isDelegated && arena.status !== "Finished" && (
                  <>
                    {arena.status === "Lobby" && activeSessionKey && (
                      <div
                        style={{
                          marginTop: 14,
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 12,
                          padding: "10px 14px",
                          background: "var(--gold-dim)",
                          border: "1px solid rgba(245, 196, 81, 0.35)",
                          borderRadius: "var(--radius-sm)",
                          fontSize: 12,
                        }}
                      >
                        <span style={{ color: "#fde6a8" }}>
                          Arena is delegated to MagicBlock ER! Tap{" "}
                          <strong>LONG / SHORT</strong> below or click Start Clock
                          (0 gas).
                        </span>
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ height: 32, fontSize: 12 }}
                          onClick={handleBeginRound}
                          disabled={!!busyAction}
                        >
                          <Play size={13} /> Start Clock
                        </button>
                      </div>
                    )}

                    {/* Big Tactile Pit Tap Controls */}
                    <div className="tap-bar">
                      <button
                        type="button"
                        id="tap-long-btn"
                        className={`tap-btn long ${
                          mySeat?.position === POS_LONG ? "active" : ""
                        }`}
                        disabled={!canTap || tapping}
                        onClick={() => handleTap(POS_LONG)}
                      >
                        <span
                          className="tap-btn-label"
                          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          <ArrowUpRight size={20} /> LONG 20×
                        </span>
                        <span className="tap-btn-hint">Key [W] or [↑] · 0 Gas</span>
                      </button>

                      <button
                        type="button"
                        id="tap-flat-btn"
                        className={`tap-btn flat ${
                          mySeat?.position === POS_FLAT ? "active" : ""
                        }`}
                        disabled={!canTap || tapping}
                        onClick={() => handleTap(POS_FLAT)}
                      >
                        <span
                          className="tap-btn-label"
                          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          <Minus size={18} /> FLAT
                        </span>
                        <span className="tap-btn-hint">[Space] Lock PnL</span>
                      </button>

                      <button
                        type="button"
                        id="tap-short-btn"
                        className={`tap-btn short ${
                          mySeat?.position === POS_SHORT ? "active" : ""
                        }`}
                        disabled={!canTap || tapping}
                        onClick={() => handleTap(POS_SHORT)}
                      >
                        <span
                          className="tap-btn-label"
                          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          <ArrowDownRight size={20} /> SHORT 20×
                        </span>
                        <span className="tap-btn-hint">Key [S] or [↓] · 0 Gas</span>
                      </button>
                    </div>

                    {timerExpired && (
                      <div
                        style={{
                          marginTop: 16,
                          padding: 16,
                          background: "var(--gold-dim)",
                          border: "1px solid rgba(245, 196, 81, 0.45)",
                          borderRadius: "var(--radius-md)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          flexWrap: "wrap",
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 15, color: "#fde6a8" }}>
                            Clock Hit 0.0s — Seal Final Standings on Solana L1
                          </div>
                          <div style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                            Closes all open positions at the live Pyth Lazer price and
                            undelegates Arena from MagicBlock ER back to Solana L1.
                          </div>
                        </div>
                        <button
                          type="button"
                          id="finish-round-btn"
                          className="btn btn-primary btn-lg"
                          onClick={handleFinishRound}
                          disabled={!!busyAction}
                        >
                          <ShieldCheck size={16} /> Finish & Commit to L1
                        </button>
                      </div>
                    )}
                  </>
                )}

                {/* Settled Victory & L1 Claim Panel */}
                {!isDelegated &&
                  arena.status === "Finished" &&
                  !vault.cancelled &&
                  winnerSeat && (
                    <div
                      style={{
                        marginTop: 16,
                        padding: 20,
                        background: "var(--bg-inset)",
                        border: "1px solid rgba(245, 196, 81, 0.45)",
                        borderRadius: "var(--radius-md)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 16,
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                        <div
                          style={{
                            width: 44,
                            height: 44,
                            borderRadius: 10,
                            background: "var(--gold-dim)",
                            color: "var(--gold)",
                            display: "grid",
                            placeItems: "center",
                          }}
                        >
                          <Trophy size={22} />
                        </div>
                        <div>
                          <div
                            className="mono"
                            style={{
                              fontSize: 11,
                              textTransform: "uppercase",
                              color: "var(--gold)",
                              letterSpacing: "0.08em",
                            }}
                          >
                            Verified Solana L1 Winner
                          </div>
                          <div
                            className="display"
                            style={{ fontSize: 20, fontWeight: 700 }}
                          >
                            {shortKey(winnerSeat.wallet.toBase58())}{" "}
                            <span
                              className="mono"
                              style={{
                                fontSize: 16,
                                color:
                                  winnerSeat.realizedPnl >= 0n
                                    ? "var(--bull)"
                                    : "var(--bear)",
                              }}
                            >
                              {formatPnlPct(winnerSeat.realizedPnl)}
                            </span>
                          </div>
                          <div
                            className="mono"
                            style={{ fontSize: 12, color: "var(--ink-secondary)" }}
                          >
                            {winnerSeat.tapCount} gasless ER taps · Pot:{" "}
                            {potSol.toFixed(3)} SOL
                          </div>
                        </div>
                      </div>

                      {!vault.claimed && potSol > 0 ? (
                        <button
                          type="button"
                          id="claim-payout-btn"
                          className="btn btn-primary btn-lg"
                          onClick={handleClaimPayout}
                          disabled={!!busyAction}
                        >
                          {connected
                            ? `Claim ${potSol.toFixed(3)} SOL on Solana L1`
                            : "Connect Wallet to Claim"}
                        </button>
                      ) : (
                        <span className="pos-chip long" style={{ height: 32, padding: "0 12px" }}>
                          {potSol > 0 ? "L1 Payout Settled ✓" : "Free Match Complete ✓"}
                        </span>
                      )}
                    </div>
                  )}
              </div>
            </section>

            {/* Right: Live Leaderboard + Personal Telemetry + ER Execution Tape */}
            <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {mySeat && (
                <div className="panel">
                  <div className="panel-header">
                    <span className="panel-title">Your Position</span>
                    <span className={`pos-chip ${posClass(mySeat.position)}`}>
                      {posLabel(mySeat.position)}
                    </span>
                  </div>
                  <div
                    className="panel-body"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 12,
                    }}
                  >
                    <div>
                      <div className="spec-label">Live Score (20×)</div>
                      <div
                        className={`mono ${
                          myLivePnl > 0n
                            ? "pos"
                            : myLivePnl < 0n
                              ? "neg"
                              : ""
                        }`}
                        style={{
                          fontSize: 26,
                          fontWeight: 700,
                          color:
                            myLivePnl > 0n
                              ? "var(--bull)"
                              : myLivePnl < 0n
                                ? "var(--bear)"
                                : "var(--ink-primary)",
                        }}
                      >
                        {formatPnlPct(myLivePnl)}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div className="spec-label">Gasless ER Taps</div>
                      <div className="mono" style={{ fontSize: 26, fontWeight: 700 }}>
                        {mySeat.tapCount}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Live Standings */}
              <div className="panel">
                <div className="panel-header">
                  <span className="panel-title">Live Standings</span>
                  <span
                    className="mono"
                    style={{ fontSize: 11, color: "var(--ink-muted)" }}
                  >
                    {isDelegated ? "MagicBlock ER" : "Solana L1"}
                  </span>
                </div>
                <div className="panel-body">
                  <div className="seat-list">
                    {rankedSeats.map((row, rank) => {
                      const isMe =
                        publicKey !== null && row.seat.wallet.equals(publicKey);
                      const isWinner =
                        arena.status === "Finished" &&
                        row.seatIndex === arena.winnerIndex;
                      return (
                        <div
                          key={row.seat.wallet.toBase58()}
                          className={`seat-row ${isMe ? "me" : ""}`}
                        >
                          <span className={`seat-rank ${rank === 0 ? "top" : ""}`}>
                            {isWinner ? <Crown size={14} /> : `#${rank + 1}`}
                          </span>
                          <div>
                            <div
                              className="mono"
                              style={{ fontSize: 12, fontWeight: 600 }}
                            >
                              {shortKey(row.seat.wallet.toBase58())}{" "}
                              {isMe && (
                                <span style={{ color: "var(--gold)" }}>(you)</span>
                              )}
                            </div>
                            <div
                              className="mono"
                              style={{ fontSize: 11, color: "var(--ink-muted)" }}
                            >
                              {row.seat.tapCount} taps
                            </div>
                          </div>
                          <span className={`pos-chip ${posClass(row.seat.position)}`}>
                            {posLabel(row.seat.position)}
                          </span>
                          <span
                            className={`pnl-val ${
                              row.livePnl > 0n
                                ? "pos"
                                : row.livePnl < 0n
                                  ? "neg"
                                  : ""
                            }`}
                          >
                            {formatPnlPct(row.livePnl)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* On-Chain Execution Tape */}
              <div className="panel">
                <div className="panel-header">
                  <span className="panel-title">Execution Tape (Live Txs)</span>
                  <span
                    className="mono"
                    style={{ fontSize: 11, color: "var(--ink-muted)" }}
                  >
                    {txFeed.length} confirmed
                  </span>
                </div>
                <div className="panel-body">
                  {txFeed.length === 0 ? (
                    <div
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: "var(--ink-muted)",
                        textAlign: "center",
                        padding: "14px 4px",
                      }}
                    >
                      Every L1 escrow, delegation, ER tap, and L1 payout signature
                      appears here with live latency.
                    </div>
                  ) : (
                    <div className="tx-feed">
                      {txFeed.map((t) => (
                        <div key={t.id} className="tx-row">
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span
                              style={{
                                padding: "2px 5px",
                                borderRadius: 3,
                                fontSize: 10,
                                fontWeight: 700,
                                background:
                                  t.layer === "ER"
                                    ? "var(--bull-dim)"
                                    : "var(--gold-dim)",
                                color:
                                  t.layer === "ER"
                                    ? "var(--bull)"
                                    : "var(--gold)",
                              }}
                            >
                              {t.layer}
                            </span>
                            <span style={{ color: "var(--ink-primary)" }}>
                              {t.action}
                            </span>
                            {t.ms !== undefined && (
                              <span style={{ color: "var(--bull)" }}>
                                {t.ms}ms
                              </span>
                            )}
                          </div>
                          {t.layer === "L1" ? (
                            <a
                              href={`https://explorer.solana.com/tx/${t.sig}?cluster=devnet`}
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                color: "var(--gold)",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 3,
                              }}
                            >
                              {t.sig.slice(0, 8)}… <ExternalLink size={10} />
                            </a>
                          ) : (
                            <span title={t.sig}>{t.sig.slice(0, 10)}… · 0 SOL</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
