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
  RotateCcw,
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
  buildAbortStaleRoomIx,
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
  getWinningSeatIndices,
  isSeatClaimed,
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
  POS_FLAT,
  POS_LONG,
  POS_SHORT,
  PositionDir,
  SETTLE_GRACE_SECS,
  SOLANA_L1_RPC,
  STALE_LOBBY_TIMEOUT_SECS,
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

  const {
    publicKey,
    connected,
    openModal,
    sendL1Transaction,
    sendErWalletTransaction,
  } = useWallet();

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
  const autoSettledRef = useRef(false);

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
    if (arena.status === "Finished" || arena.status === "Aborted") return 0;
    return Math.max(0, (Number(arena.endsAt) * 1000 - nowMs) / 1000);
  }, [arena, nowMs]);

  const timerExpired =
    arena?.status === "Live" &&
    arena.endsAt > 0n &&
    nowMs >= Number(arena.endsAt) * 1000;

  const isTerminal =
    arena?.status === "Finished" || arena?.status === "Aborted";

  const isCreator =
    publicKey !== null && arena !== null && arena.creator.equals(publicKey);

  const staleAbortAtMs =
    arena && arena.createdAt > 0n
      ? (Number(arena.createdAt) + STALE_LOBBY_TIMEOUT_SECS) * 1000
      : 0;

  const isStaleDelegatedLobby =
    isDelegated &&
    arena?.status === "Lobby" &&
    staleAbortAtMs > 0 &&
    nowMs >= staleAbortAtMs;

  const staleCountdownSec =
    staleAbortAtMs > 0
      ? Math.max(0, Math.ceil((staleAbortAtMs - nowMs) / 1000))
      : STALE_LOBBY_TIMEOUT_SECS;

  const winningSeatIndices = useMemo(
    () =>
      arena && arena.status === "Finished" ? getWinningSeatIndices(arena) : [],
    [arena]
  );

  const claimableSeatIndices = useMemo(() => {
    if (!arena) return [];
    if (arena.status === "Finished") return winningSeatIndices;
    if (arena.status === "Aborted") {
      return Array.from({ length: arena.playerCount }, (_, i) => i);
    }
    return [];
  }, [arena, winningSeatIndices]);

  const seatPayoutLamports = useCallback(
    (seatIndex: number): bigint => {
      if (!arena || !vault) return 0n;
      if (arena.status === "Aborted") return vault.entryFee;
      if (arena.status === "Finished") {
        const count = BigInt(winningSeatIndices.length || 1);
        const base = vault.totalPot / count;
        const dust = vault.totalPot % count;
        return base + (seatIndex === arena.winnerIndex ? dust : 0n);
      }
      return 0n;
    },
    [arena, vault, winningSeatIndices]
  );

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

  // Ranked leaderboard with live mark-to-market PnL (ties share equal rank visually)
  const rankedSeats = useMemo(() => {
    if (!arena) return [];
    const liveRaw =
      arena.status === "Finished" || arena.status === "Aborted"
        ? arena.lastPrice
        : oracleTick?.rawPrice ?? arena.lastPrice;
    return arena.players
      .map((seat, idx) => ({
        seat,
        seatIndex: idx,
        livePnl:
          arena.status === "Finished" || arena.status === "Aborted"
            ? seat.realizedPnl
            : totalSeatPnl(seat, liveRaw),
      }))
      .sort((a, b) => {
        if (b.livePnl !== a.livePnl) return b.livePnl > a.livePnl ? 1 : -1;
        return a.seatIndex - b.seatIndex;
      });
  }, [arena, oracleTick]);

  // Helper: sign ER transaction with zero-popup Session Key when available,
  // or fall back transparently to connected wallet signing if the tab was closed/switched.
  const dispatchErTx = useCallback(
    async (buildIx: (signer: PublicKey) => ReturnType<typeof buildTapIx>) => {
      if (activeSessionKey) {
        const ix = buildIx(activeSessionKey.publicKey);
        return sendErSessionTx(
          erConn,
          new Transaction().add(ix),
          activeSessionKey
        );
      }
      if (publicKey) {
        const ix = buildIx(publicKey);
        return sendErWalletTransaction(erConn, new Transaction().add(ix));
      }
      throw new Error("Connect a Solana Devnet wallet first.");
    },
    [activeSessionKey, publicKey, erConn, sendErWalletTransaction]
  );

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
        text: "Seated on Solana L1 and Session Key bound. Waiting for creator to delegate to MagicBlock ER.",
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
    setBusyAction("Delegating Arena PDA to pinned MagicBlock US Devnet ER…");
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
        text: "Arena is LIVE on MagicBlock ER! Tap LONG / SHORT — 0 popups, 0 gas.",
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
    if (!arena || !mySeat) return;
    if (!activeSessionKey && !publicKey) {
      openModal();
      return;
    }
    setBanner(null);
    setBusyAction(
      activeSessionKey
        ? "Starting countdown on MagicBlock ER (0 gas)…"
        : "Starting countdown on MagicBlock ER (wallet fallback)…"
    );
    try {
      const res = await dispatchErTx((signer) =>
        buildBeginRoundIx({
          signer,
          roomId,
          priceFeed: arena.priceFeed,
        })
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
      if (
        !arena ||
        !isDelegated ||
        !mySeat ||
        (!activeSessionKey && !publicKey) ||
        tapping ||
        timerExpired ||
        isTerminal
      ) {
        return;
      }
      // On-chain enforces NoOpPositionChange — never waste a tx on the same direction
      if (mySeat.position === dir) return;

      setTapping(true);
      setBanner(null);
      if (dir === POS_LONG) pitAudio.playLong();
      else if (dir === POS_SHORT) pitAudio.playShort();
      else pitAudio.playFlat();

      try {
        const res = await dispatchErTx((signer) =>
          buildTapIx({
            signer,
            roomId,
            newPosition: dir,
            priceFeed: arena.priceFeed,
          })
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
      mySeat,
      activeSessionKey,
      publicKey,
      tapping,
      timerExpired,
      isTerminal,
      dispatchErTx,
      roomId,
      oracleTick,
      pushLog,
      syncErArena,
    ]
  );

  // Keyboard hotkeys during active ER match (only with 0-popup Session Key so stray keys never trigger wallet popups)
  useEffect(() => {
    if (!isDelegated || !activeSessionKey || isTerminal) return;
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
  }, [isDelegated, activeSessionKey, isTerminal, handleTap]);

  const handleFinishRound = useCallback(async () => {
    if (!arena) return;
    if (!activeSessionKey && !publicKey) {
      openModal();
      return;
    }
    setBanner(null);
    setBusyAction(
      "Closing all positions on MagicBlock ER & committing state back to Solana L1…"
    );
    try {
      const res = await dispatchErTx((payer) =>
        buildFinishRoundIx({
          payer,
          roomId,
          priceFeed: arena.priceFeed,
        })
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
        text: "Arena settled on Solana L1! Winners can now claim the escrowed SOL pot.",
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
  }, [
    arena,
    activeSessionKey,
    publicKey,
    openModal,
    dispatchErTx,
    roomId,
    oracleTick?.priceUsd,
    pushLog,
    l1Conn,
    arenaPda,
    syncState,
  ]);

  // Automatically crank finish_round inside the 3s grace window when a 0-popup Session Key is active
  useEffect(() => {
    if (
      isDelegated &&
      arena?.status === "Live" &&
      timerExpired &&
      activeSessionKey &&
      !busyAction &&
      !autoSettledRef.current
    ) {
      autoSettledRef.current = true;
      void handleFinishRound();
    }
  }, [
    isDelegated,
    arena?.status,
    timerExpired,
    activeSessionKey,
    busyAction,
    handleFinishRound,
  ]);

  const handleAbortStaleRoom = async () => {
    if (!arena) return;
    if (!activeSessionKey && !publicKey) {
      openModal();
      return;
    }
    setBanner(null);
    setBusyAction(
      "Aborting stale ER lobby & returning Arena to Solana L1 for refunds…"
    );
    try {
      const res = await dispatchErTx((payer) =>
        buildAbortStaleRoomIx({
          payer,
          roomId,
        })
      );
      pushLog({
        layer: "ER",
        action: "abort_stale_room + undelegate",
        sig: res.signature,
        ms: res.latencyMs,
      });

      setBanner({
        kind: "info",
        text: "Stale lobby aborted on ER. Waiting for Arena ownership return on Solana L1…",
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
        text: "Stale room returned to Solana L1! Every seated trader can now claim their entry fee refund.",
      });
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text:
          err instanceof Error
            ? err.message
            : "Failed to abort stale delegated room.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleClaimPayout = async (seatIndex: number) => {
    if (!arena) return;
    if (!connected || !publicKey) {
      openModal();
      return;
    }
    const targetSeat = arena.players[seatIndex];
    if (!targetSeat) return;

    const isRefund = arena.status === "Aborted";
    setBanner(null);
    setBusyAction(
      isRefund
        ? `Refunding entry fee for Seat #${seatIndex + 1} from Solana L1 Vault…`
        : `Releasing payout for Seat #${seatIndex + 1} from Solana L1 Vault…`
    );
    try {
      const ix = buildClaimPayoutIx({
        payer: publicKey,
        roomId,
        seatIndex,
        recipient: targetSeat.wallet,
      });
      const sig = await sendL1Transaction(new Transaction().add(ix));
      pushLog({
        layer: "L1",
        action: isRefund
          ? `refund(seat #${seatIndex + 1})`
          : `claim_payout(seat #${seatIndex + 1})`,
        sig,
      });
      setBanner({
        kind: "success",
        text: isRefund
          ? `Entry fee refunded on Solana L1 to ${shortKey(targetSeat.wallet.toBase58())}!`
          : `Payout sent on Solana L1 to ${shortKey(targetSeat.wallet.toBase58())}!`,
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
    mySeat && oracleTick && !isTerminal
      ? totalSeatPnl(mySeat, oracleTick.rawPrice)
      : mySeat?.realizedPnl ?? 0n;

  const myEntryPriceUsd =
    mySeat && mySeat.entryPrice > 0n
      ? Number(mySeat.entryPrice) / Math.pow(10, market.decimals)
      : null;

  const canTap =
    isDelegated &&
    !!mySeat &&
    (!!activeSessionKey || !!publicKey) &&
    arena !== null &&
    !isTerminal &&
    !timerExpired &&
    !busyAction;

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
                      : arena.status === "Finished" || arena.status === "Aborted"
                        ? "flat"
                        : "short"
                  }`}
                >
                  {isDelegated
                    ? "ER LIVE"
                    : arena.status === "Finished"
                      ? "L1 SETTLED"
                      : arena.status === "Aborted"
                        ? "L1 ABORTED"
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
                    ? isStaleDelegatedLobby
                      ? "Stale Lobby · Refund Abort Ready"
                      : "Delegated · First tap starts clock"
                    : "Waiting in L1 Lobby"
                  : arena.status === "Live"
                    ? timerExpired
                      ? "Clock Zero · Ready to Settle"
                      : "Sprint Live on MagicBlock ER"
                    : arena.status === "Aborted"
                      ? "Aborted · L1 Refunds Open"
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
                  ? arena.status === "Aborted"
                    ? "All refunds paid on L1"
                    : "Paid out on L1"
                  : vault.cancelled
                    ? "Refunded"
                    : arena.status === "Aborted"
                      ? "Entry fees refundable"
                      : winningSeatIndices.length > 1
                        ? `${winningSeatIndices.length}-way equal tie split`
                        : "Winner takes all · Ties split"}
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
                      : "Wallet Fallback Mode · Popups Active"}
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
                          ? isCreator
                            ? "You created and hold Seat #1 in this Arena."
                            : "You are seated in this Arena."
                          : "Open seat available on Solana Devnet."}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                        {mySeat
                          ? isCreator
                            ? "Share the Invite Link so other wallets can join, then delegate to the pinned MagicBlock ER when ready."
                            : "Your 0-popup Session Key is bound on L1. Waiting for the room creator to delegate to MagicBlock ER."
                          : `Escrow ${entrySol.toFixed(3)} SOL into the L1 Vault to enter and bind your 0-popup Session Key.`}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
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

                      {mySeat && isCreator && (
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

                      {mySeat && !isCreator && (
                        <span
                          className="mono"
                          style={{
                            fontSize: 12,
                            padding: "8px 12px",
                            borderRadius: "var(--radius-sm)",
                            background: "var(--bg-surface)",
                            border: "1px solid var(--border-subtle)",
                            color: "var(--gold)",
                          }}
                        >
                          Waiting for creator {shortKey(arena.creator.toBase58())} to start…
                        </span>
                      )}

                      {mySeat &&
                        isCreator &&
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

                {isDelegated && !isTerminal && (
                  <>
                    {arena.status === "Lobby" && mySeat && (activeSessionKey || publicKey) && (
                      <div
                        style={{
                          marginTop: 14,
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 12,
                          flexWrap: "wrap",
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
                          {activeSessionKey ? " (0 gas, 0 popups)." : " (wallet fallback)."}{" "}
                          {!isStaleDelegatedLobby && (
                            <span style={{ color: "var(--ink-secondary)" }}>
                              Stale refund escape unlocks in {staleCountdownSec}s.
                            </span>
                          )}
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

                    {isStaleDelegatedLobby && (
                      <div
                        style={{
                          marginTop: 12,
                          padding: 14,
                          background: "var(--bg-inset)",
                          border: "1px solid rgba(255, 69, 87, 0.45)",
                          borderRadius: "var(--radius-md)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          flexWrap: "wrap",
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--bear)" }}>
                            Delegated Lobby Timed Out ({STALE_LOBBY_TIMEOUT_SECS}s)
                          </div>
                          <div style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                            No round was started after delegation. Anyone can abort and return
                            this Arena to Solana L1 so all seated traders can reclaim their SOL.
                          </div>
                        </div>
                        <button
                          type="button"
                          id="abort-stale-btn"
                          className="btn btn-ghost"
                          style={{
                            borderColor: "rgba(255, 69, 87, 0.5)",
                            color: "var(--bear)",
                          }}
                          onClick={handleAbortStaleRoom}
                          disabled={!!busyAction}
                        >
                          <RotateCcw size={14} /> Abort & Unlock L1 Refunds
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
                        disabled={!canTap || tapping || mySeat?.position === POS_LONG}
                        onClick={() => handleTap(POS_LONG)}
                      >
                        <span
                          className="tap-btn-label"
                          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          <ArrowUpRight size={20} /> LONG 20×
                        </span>
                        <span className="tap-btn-hint">
                          {mySeat?.position === POS_LONG
                            ? "Active Position"
                            : activeSessionKey
                              ? "Key [W] or [↑] · 0 Gas"
                              : "Wallet Fallback · 0 Gas"}
                        </span>
                      </button>

                      <button
                        type="button"
                        id="tap-flat-btn"
                        className={`tap-btn flat ${
                          mySeat?.position === POS_FLAT ? "active" : ""
                        }`}
                        disabled={!canTap || tapping || mySeat?.position === POS_FLAT}
                        onClick={() => handleTap(POS_FLAT)}
                      >
                        <span
                          className="tap-btn-label"
                          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          <Minus size={18} /> FLAT
                        </span>
                        <span className="tap-btn-hint">
                          {mySeat?.position === POS_FLAT
                            ? "Active Position"
                            : activeSessionKey
                              ? "[Space] Lock PnL"
                              : "Wallet Fallback · Lock PnL"}
                        </span>
                      </button>

                      <button
                        type="button"
                        id="tap-short-btn"
                        className={`tap-btn short ${
                          mySeat?.position === POS_SHORT ? "active" : ""
                        }`}
                        disabled={!canTap || tapping || mySeat?.position === POS_SHORT}
                        onClick={() => handleTap(POS_SHORT)}
                      >
                        <span
                          className="tap-btn-label"
                          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          <ArrowDownRight size={20} /> SHORT 20×
                        </span>
                        <span className="tap-btn-hint">
                          {mySeat?.position === POS_SHORT
                            ? "Active Position"
                            : activeSessionKey
                              ? "Key [S] or [↓] · 0 Gas"
                              : "Wallet Fallback · 0 Gas"}
                        </span>
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
                            Closes open positions at the live Pyth Lazer price within{" "}
                            {SETTLE_GRACE_SECS}s of clock zero (or freezes deterministically at{" "}
                            <span className="mono">last_price</span> after grace) and undelegates
                            Arena back to Solana L1.
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

                {/* Settled Victory / Tie-Split / Aborted Refund L1 Claim Panel */}
                {!isDelegated &&
                  isTerminal &&
                  !vault.cancelled &&
                  claimableSeatIndices.length > 0 && (
                    <div
                      style={{
                        marginTop: 16,
                        padding: 20,
                        background: "var(--bg-inset)",
                        border:
                          arena.status === "Aborted"
                            ? "1px solid rgba(255, 69, 87, 0.4)"
                            : "1px solid rgba(245, 196, 81, 0.45)",
                        borderRadius: "var(--radius-md)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 14,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                        <div
                          style={{
                            width: 44,
                            height: 44,
                            borderRadius: 10,
                            background:
                              arena.status === "Aborted"
                                ? "var(--bear-dim)"
                                : "var(--gold-dim)",
                            color:
                              arena.status === "Aborted"
                                ? "var(--bear)"
                                : "var(--gold)",
                            display: "grid",
                            placeItems: "center",
                            flexShrink: 0,
                          }}
                        >
                          {arena.status === "Aborted" ? (
                            <RotateCcw size={20} />
                          ) : (
                            <Trophy size={22} />
                          )}
                        </div>
                        <div>
                          <div
                            className="mono"
                            style={{
                              fontSize: 11,
                              textTransform: "uppercase",
                              color:
                                arena.status === "Aborted"
                                  ? "var(--bear)"
                                  : "var(--gold)",
                              letterSpacing: "0.08em",
                            }}
                          >
                            {arena.status === "Aborted"
                              ? "Stale Lobby Aborted · Solana L1 Refunds"
                              : winningSeatIndices.length > 1
                                ? `Verified Solana L1 Tie Split (${winningSeatIndices.length}-Way)`
                                : "Verified Solana L1 Winner"}
                          </div>
                          <div
                            className="mono"
                            style={{ fontSize: 12, color: "var(--ink-secondary)", marginTop: 2 }}
                          >
                            Escrowed Pot: {potSol.toFixed(3)} SOL ·{" "}
                            {arena.status === "Aborted"
                              ? `Each trader reclaims ${entrySol.toFixed(3)} SOL`
                              : winningSeatIndices.length > 1
                                ? "Exact tie splits the pot equally across tied top seats"
                                : "Permissionless L1 vault release to verified winner"}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {claimableSeatIndices.map((seatIdx) => {
                          const seat = arena.players[seatIdx];
                          if (!seat) return null;
                          const shareLamports = seatPayoutLamports(seatIdx);
                          const shareSol = Number(shareLamports) / LAMPORTS_PER_SOL;
                          const claimed = isSeatClaimed(vault, seatIdx);
                          const isMe =
                            publicKey !== null && seat.wallet.equals(publicKey);

                          return (
                            <div
                              key={seatIdx}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 12,
                                flexWrap: "wrap",
                                padding: "12px 14px",
                                borderRadius: "var(--radius-sm)",
                                background: "var(--bg-surface)",
                                border: "1px solid var(--border-subtle)",
                              }}
                            >
                              <div>
                                <div
                                  className="display"
                                  style={{ fontSize: 17, fontWeight: 700 }}
                                >
                                  {shortKey(seat.wallet.toBase58())}{" "}
                                  {isMe && (
                                    <span
                                      className="mono"
                                      style={{ fontSize: 12, color: "var(--gold)" }}
                                    >
                                      (you)
                                    </span>
                                  )}{" "}
                                  {arena.status === "Finished" && (
                                    <span
                                      className="mono"
                                      style={{
                                        fontSize: 14,
                                        color:
                                          seat.realizedPnl >= 0n
                                            ? "var(--bull)"
                                            : "var(--bear)",
                                      }}
                                    >
                                      {formatPnlPct(seat.realizedPnl)}
                                    </span>
                                  )}
                                </div>
                                <div
                                  className="mono"
                                  style={{ fontSize: 11, color: "var(--ink-secondary)" }}
                                >
                                  Seat #{seatIdx + 1} · {seat.tapCount} ER taps · Share:{" "}
                                  {shareSol.toFixed(4)} SOL
                                </div>
                              </div>

                              {!claimed && shareLamports > 0n ? (
                                <button
                                  type="button"
                                  id={`claim-payout-seat-${seatIdx}`}
                                  className="btn btn-primary"
                                  onClick={() => handleClaimPayout(seatIdx)}
                                  disabled={!!busyAction}
                                >
                                  {connected
                                    ? arena.status === "Aborted"
                                      ? `Refund ${shareSol.toFixed(3)} SOL`
                                      : `Claim ${shareSol.toFixed(3)} SOL`
                                    : "Connect Wallet to Claim"}
                                </button>
                              ) : (
                                <span
                                  className="pos-chip long"
                                  style={{ height: 30, padding: "0 12px" }}
                                >
                                  {shareLamports > 0n
                                    ? arena.status === "Aborted"
                                      ? "L1 Refund Settled ✓"
                                      : "L1 Payout Settled ✓"
                                    : "Free Match Complete ✓"}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
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
                        winningSeatIndices.includes(row.seatIndex);
                      return (
                        <div
                          key={row.seat.wallet.toBase58()}
                          className={`seat-row ${isMe ? "me" : ""}`}
                        >
                          <span
                            className={`seat-rank ${
                              rank === 0 || isWinner ? "top" : ""
                            }`}
                          >
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
