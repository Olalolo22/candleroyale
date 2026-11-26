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
  ArrowDown,
  Bot,
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  Crown,
  ExternalLink,
  Link2,
  Lock,
  Minus,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { CandleCanvas, TapMarker } from "@/components/CandleCanvas";
import { useWallet } from "@/lib/wallet";
import {
  getOrCreateSessionKey,
  loadExistingSessionKey,
  sendErSessionTx,
  warmErBlockhash,
} from "@/lib/session";
import { getTeeConnection, getViewerConnection } from "@/lib/tee";
import { useOracleStream } from "@/lib/useOracleStream";
import { pitAudio } from "@/lib/audio";
import {
  BOT_STYLE_LABEL,
  BotMemory,
  PracticeBot,
  PricePoint,
  buildBotFundingTx,
  createBots,
  decideBotMove,
  loadBots,
  nextBotDelayMs,
  saveBots,
  sendL1AsKeypair,
  sweepBot,
} from "@/lib/bots";
import {
  badgeFor,
  fmtSol,
  jacketColor,
  pnlClass,
  posClass,
  isLinkOnlyRoom,
  posLabel,
  shortKey,
} from "@/lib/pit";
import {
  ArenaAccount,
  buildAbortStaleLobbyIx,
  buildAbortStaleRoomIx,
  buildBeginRoundIx,
  buildCancelRoomIx,
  buildClaimPayoutIx,
  buildDelegateSeatIx,
  buildFinishRoundIx,
  buildJoinRoomIx,
  buildStartAndDelegateIx,
  buildTapIx,
  decodeArena,
  decodeSeatPosition,
  decodeVault,
  findArenaPda,
  findSeatPda,
  findVaultPda,
  formatPnlPct,
  getWinningSeatIndices,
  isSeatClaimed,
  PlayerSeat,
  SealedSeat,
  totalSeatPnl,
  VaultAccount,
} from "@sdk/codec";
import {
  CANDLEROYALE_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  MARKET_FEEDS,
  marketFromFeed,
  POS_FLAT,
  POS_LONG,
  POS_SHORT,
  PositionDir,
  SETTLE_GRACE_SECS,
  SOLANA_L1_RPC,
  L1_LOBBY_TIMEOUT_SECS,
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

const PHASES = ["Fill seats", "Ready", "Trade", "Settle", "Pay out"] as const;

function jacketStyle(seatIndex: number): React.CSSProperties {
  return { "--jacket-color": jacketColor(seatIndex) } as React.CSSProperties;
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
    refreshBalance,
  } = useWallet();

  const l1Conn = useMemo(() => new Connection(SOLANA_L1_RPC, "confirmed"), []);

  const [vaultPda] = useMemo(
    () => (validRoomId ? findVaultPda(roomId) : [PublicKey.default, 0]),
    [validRoomId, roomId]
  );
  const [arenaPda] = useMemo(
    () => (validRoomId ? findArenaPda(roomId) : [PublicKey.default, 0]),
    [validRoomId, roomId]
  );

  const [vault, setVault] = useState<VaultAccount | null>(null);
  // The public scoreboard as the chain has it. Mid-round it holds banked scores only.
  const [rawArena, setRawArena] = useState<ArenaAccount | null>(null);
  // This player's own sealed position, read from the private rollup with their session key.
  const [mySealed, setMySealed] = useState<SealedSeat | null>(null);
  const [isDelegated, setIsDelegated] = useState(false);
  const [loadingRoom, setLoadingRoom] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [tapping, setTapping] = useState(false);
  const [pendingDir, setPendingDir] = useState<PositionDir | null>(null);
  const [showVictory, setShowVictory] = useState(false);
  // The buzzer reveal: a short beat where sealed positions flip open before the result card
  const [revealing, setRevealing] = useState(false);
  const revealedRef = useRef(false);
  const sawLiveRef = useRef(false);
  const victoryDismissedRef = useRef(false);
  const autoSettledRef = useRef(false);
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

  const feedAddress = rawArena?.priceFeed ?? MARKET_FEEDS.SOL.address;
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
        const viewer = await getViewerConnection();
        const erArenaInfo = await viewer.getAccountInfo(arenaPda, "confirmed");
        if (erArenaInfo) {
          setRawArena(decodeArena(erArenaInfo.data));
        }
      } else if (l1ArenaInfo.owner.equals(CANDLEROYALE_PROGRAM_ID)) {
        setRawArena(decodeArena(l1ArenaInfo.data));
      }
      setLoadingRoom(false);
    } catch {
      // keep existing state on transient RPC error
    }
  }, [validRoomId, l1Conn, vaultPda, arenaPda]);

  // Fast ER-only arena refresh during delegated gameplay
  const syncErArena = useCallback(async () => {
    if (!validRoomId) return;
    try {
      const viewer = await getViewerConnection();
      const erArenaInfo = await viewer.getAccountInfo(arenaPda, "confirmed");
      if (erArenaInfo) {
        const a = decodeArena(erArenaInfo.data);
        setRawArena(a);
        // Have a blockhash ready before the first trade, so no trade waits for one
        if (a.status === "Lobby" || a.status === "Live") warmErBlockhash(viewer);
      }
    } catch {
      // ignore transient ER poll blip
    }
  }, [validRoomId, arenaPda]);

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
    if (!rawArena || !publicKey) return -1;
    return rawArena.players
      .slice(0, rawArena.playerCount)
      .findIndex((p) => p.wallet.equals(publicKey));
  }, [rawArena, publicKey]);

  const mySessionKeyStr =
    rawArena && mySeatIndex >= 0
      ? rawArena.players[mySeatIndex].sessionKey.toBase58()
      : null;

  const activeSessionKey: Keypair | null = useMemo(() => {
    if (!publicKey || !mySessionKeyStr || !validRoomId) return null;
    const loaded = loadExistingSessionKey(roomIdStr, publicKey.toBase58());
    if (loaded && loaded.publicKey.toBase58() === mySessionKeyStr) {
      return loaded;
    }
    return null;
  }, [publicKey, mySessionKeyStr, validRoomId, roomIdStr]);

  // Read my own sealed seat. Only my session key (or wallet) can see it on the private rollup.
  const syncMySeat = useCallback(async () => {
    if (!activeSessionKey || mySeatIndex < 0 || !validRoomId) return;
    try {
      const conn = await getTeeConnection(activeSessionKey);
      const [seatPda] = findSeatPda(roomId, mySeatIndex);
      const info = await conn.getAccountInfo(seatPda, "confirmed");
      const sealed = info ? decodeSeatPosition(info.data) : null;
      if (sealed) setMySealed(sealed);
    } catch {
      // keep last known position on a transient blip
    }
  }, [activeSessionKey, mySeatIndex, validRoomId, roomId]);

  useEffect(() => {
    if (!isDelegated || !activeSessionKey) return;
    syncMySeat();
    const t = setInterval(syncMySeat, 400);
    return () => clearInterval(t);
  }, [isDelegated, activeSessionKey, syncMySeat]);

  // What this tab shows: the public scoreboard, with my own sealed position laid over my
  // seat until the buzzer. After settlement the chain holds everyone's revealed position.
  const arena: ArenaAccount | null = useMemo(() => {
    if (!rawArena) return null;
    if (
      rawArena.status === "Finished" ||
      rawArena.status === "Aborted" ||
      !mySealed ||
      mySeatIndex < 0
    ) {
      return rawArena;
    }
    const players = rawArena.players.slice();
    players[mySeatIndex] = {
      ...players[mySeatIndex],
      position: mySealed.position,
      entryPrice: mySealed.entryPrice,
    };
    return { ...rawArena, players };
  }, [rawArena, mySealed, mySeatIndex]);

  const mySeat: PlayerSeat | null =
    arena && mySeatIndex >= 0 ? arena.players[mySeatIndex] : null;

  // Mid-round, other players' positions are sealed: only their banked score is public.
  const isSealedRound = !!arena && isDelegated && arena.status !== "Finished" && arena.status !== "Aborted";

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

  const staleAbortAtMs =
    arena && arena.createdAt > 0n
      ? (Number(arena.createdAt) + STALE_LOBBY_TIMEOUT_SECS) * 1000
      : 0;

  // L1 escape hatch: joined room whose creator never started it
  const l1AbortAtMs =
    arena && arena.createdAt > 0n
      ? (Number(arena.createdAt) + L1_LOBBY_TIMEOUT_SECS) * 1000
      : 0;
  const isStaleL1Lobby =
    !isDelegated &&
    arena?.status === "Lobby" &&
    arena.playerCount >= 2 &&
    l1AbortAtMs > 0 &&
    nowMs >= l1AbortAtMs;

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

  const unclaimedSeatIndices = useMemo(() => {
    if (!vault) return [];
    return claimableSeatIndices.filter(
      (idx) => !isSeatClaimed(vault, idx) && seatPayoutLamports(idx) > 0n
    );
  }, [vault, claimableSeatIndices, seatPayoutLamports]);

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

  // Ranked leaderboard with live mark-to-market PnL (exact ties share top rank)
  const rankedSeats = useMemo(() => {
    if (!arena) return [];
    const liveRaw = isTerminal
      ? arena.lastPrice
      : oracleTick?.rawPrice ?? arena.lastPrice;
    return arena.players
      .map((seat, idx) => ({
        seat,
        seatIndex: idx,
        // Others: banked score only (their open trade is sealed). Me: banked + my open trade.
        livePnl:
          isTerminal || idx !== mySeatIndex
            ? seat.realizedPnl
            : totalSeatPnl(seat, liveRaw),
      }))
      .sort((a, b) => {
        if (b.livePnl !== a.livePnl) return b.livePnl > a.livePnl ? 1 : -1;
        return a.seatIndex - b.seatIndex;
      });
  }, [arena, isTerminal, oracleTick, mySeatIndex]);

  // Sign ER tx with 0-popup Session Key when available, else fall back to connected wallet
  const dispatchErTx = useCallback(
    async (buildIx: (signer: PublicKey) => ReturnType<typeof buildTapIx>) => {
      if (activeSessionKey) {
        const ix = buildIx(activeSessionKey.publicKey);
        return sendErSessionTx(
          await getTeeConnection(activeSessionKey),
          new Transaction().add(ix),
          activeSessionKey
        );
      }
      if (publicKey) {
        const ix = buildIx(publicKey);
        return sendErWalletTransaction(
          await getViewerConnection(),
          new Transaction().add(ix)
        );
      }
      throw new Error("Connect a Solana Devnet wallet first.");
    },
    [activeSessionKey, publicKey, sendErWalletTransaction]
  );

  // ─── Actions ──────────────────────────────────────────────────────────────

  const handleJoin = async () => {
    setBanner(null);
    if (!connected || !publicKey) {
      openModal();
      return;
    }
    setBusyAction("Joining. Approve the stake in your wallet…");
    try {
      const sk = getOrCreateSessionKey(roomIdStr, publicKey.toBase58());
      const seatIndex = rawArena?.playerCount ?? 0;
      const tx = new Transaction().add(
        buildJoinRoomIx({
          player: publicKey,
          roomId,
          sessionKey: sk.publicKey,
          seatIndex,
        }),
        // Hand the new private seat to MagicBlock's private rollup in the same transaction
        buildDelegateSeatIx({ payer: publicKey, roomId, seatIndex })
      );
      const sig = await sendL1Transaction(tx);
      pushLog({ layer: "L1", action: "join_room", sig });
      setBanner({
        kind: "success",
        text: "Joined. Your stake is in the vault and this tab holds your trading key.",
      });
      await syncState();
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text:
          err instanceof Error
            ? err.message
            : "Couldn't join. Check your wallet is on Devnet and has enough SOL.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleAbortStaleLobby = async () => {
    setBanner(null);
    if (!publicKey) {
      openModal();
      return;
    }
    setBusyAction("Aborting the room so everyone can reclaim their stake…");
    try {
      const ix = buildAbortStaleLobbyIx({ signer: publicKey, roomId });
      const sig = await sendL1Transaction(new Transaction().add(ix));
      pushLog({ layer: "L1", action: "abort_stale_lobby", sig });
      setBanner({
        kind: "info",
        text: "Room aborted. Every player can now reclaim their stake.",
      });
      await syncState();
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text:
          err instanceof Error
            ? err.message
            : "Couldn't abort the room. Try again.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancel = async () => {
    setBanner(null);
    if (!publicKey) return;
    setBusyAction("Cancelling and refunding your stake…");
    try {
      const ix = buildCancelRoomIx({ creator: publicKey, roomId });
      const sig = await sendL1Transaction(new Transaction().add(ix));
      pushLog({ layer: "L1", action: "cancel_room", sig });
      setBanner({
        kind: "info",
        text: "Room cancelled. Your stake is back in your wallet.",
      });
      await syncState();
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text:
          err instanceof Error
            ? err.message
            : "Couldn't cancel the room. Try again.",
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
    setBusyAction("Starting the room on MagicBlock's rollup…");
    try {
      const ix = buildStartAndDelegateIx({
        payer: publicKey,
        roomId,
        playerCount: rawArena?.playerCount ?? 0,
      });
      const sig = await sendL1Transaction(new Transaction().add(ix));
      pushLog({ layer: "L1", action: "start_and_delegate", sig });

      setBanner({
        kind: "info",
        text: "Approved on Solana. Waiting for the rollup to pick up the room…",
      });

      // Wait briefly for ER validator pickup
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 700));
        const viewer = await getViewerConnection();
        const info = await viewer.getAccountInfo(arenaPda, "confirmed");
        if (info) break;
      }

      await syncState();
      setBanner({
        kind: "success",
        text: "Room is live. Your first trade starts the clock.",
      });
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text:
          err instanceof Error
            ? err.message
            : "Couldn't start the room. Nothing was moved; try again.",
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
        ? "Starting the clock…"
        : "Starting the clock. Approve in your wallet…"
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
        text:
          err instanceof Error
            ? err.message
            : "Couldn't start the clock. Try again or just trade.",
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
      // On-chain rejects same-direction no-ops (NoOpPositionChange)
      if (mySeat.position === dir) return;

      setTapping(true);
      setPendingDir(dir);
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
            seatIndex: mySeatIndex,
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
          action: `tap(${posLabel(dir).toLowerCase()})`,
          sig: res.signature,
          ms: res.latencyMs,
          priceUsd: priceNow,
        });

        // Show the new position right away; the next private read confirms it
        setMySealed((prev) =>
          prev
            ? {
                ...prev,
                position: dir,
                entryPrice: dir === POS_FLAT ? 0n : oracleTick?.rawPrice ?? prev.entryPrice,
                sealed: true,
              }
            : prev
        );
        await Promise.all([syncErArena(), syncMySeat()]);
      } catch (err: unknown) {
        setBanner({
          kind: "error",
          text:
            err instanceof Error
              ? err.message
              : "That trade didn't go through. Try again.",
        });
      } finally {
        setTapping(false);
        setPendingDir(null);
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
      syncMySeat,
      mySeatIndex,
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

  const handleFinishRound = useCallback(async (opts?: { quiet?: boolean }): Promise<boolean> => {
    if (!arena) return false;
    if (!activeSessionKey && !publicKey) {
      openModal();
      return false;
    }
    setBanner(null);
    setBusyAction("Closing every position and sending the result to Solana…");
    try {
      const res = await dispatchErTx((payer) =>
        buildFinishRoundIx({
          payer,
          roomId,
          priceFeed: arena.priceFeed,
          playerCount: arena.playerCount,
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
        text: "Final scores are locked. Waiting for Solana to confirm…",
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
        text: "Settled on Solana. Payouts are ready.",
      });
      return true;
    } catch (err: unknown) {
      if (!opts?.quiet) {
        setBanner({
          kind: "error",
          text:
            err instanceof Error
              ? err.message
              : "Couldn't settle the room. Try again.",
        });
      }
      return false;
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

  // Latest status for the auto-settle loop (its closure would otherwise go stale)
  const arenaStatusRef = useRef<string | undefined>(arena?.status);
  arenaStatusRef.current = arena?.status;

  // Automatically settle inside the grace window when a 0-popup Session Key is active.
  // Retries, because the ER clock counts whole seconds and a phone clock can run a little
  // ahead: an attempt that lands before ends_at fails with RoundStillActive, and a single
  // failed try would otherwise push settlement past the grace window to last_price.
  useEffect(() => {
    if (
      !(
        isDelegated &&
        arena?.status === "Live" &&
        timerExpired &&
        activeSessionKey &&
        !busyAction &&
        !autoSettledRef.current
      )
    ) {
      return;
    }
    autoSettledRef.current = true;
    const graceEndMs = (Number(arena.endsAt) + SETTLE_GRACE_SECS) * 1000;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    void (async () => {
      await sleep(350); // let the on-chain second tick over before the first try
      while (Date.now() < graceEndMs + 1500) {
        if (arenaStatusRef.current !== "Live") return; // someone else settled
        if (await handleFinishRound({ quiet: true })) return;
        await sleep(400);
      }
      // Past the grace window: settle anyway (closes at last trade price) and surface errors
      if (arenaStatusRef.current === "Live") await handleFinishRound();
    })();
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
    setBusyAction("Aborting idle room and returning stakes to Solana…");
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
        text: "Room aborted on the rollup. Waiting for Solana to unlock refunds…",
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
        text: "Room returned to Solana. Every player can reclaim their stake.",
      });
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text:
          err instanceof Error
            ? err.message
            : "Couldn't abort the room. Try again.",
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
        ? `Refunding ${badgeFor(targetSeat.wallet)}. Approve in your wallet…`
        : `Paying out ${badgeFor(targetSeat.wallet)}. Approve in your wallet…`
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
          ? `refund(${badgeFor(targetSeat.wallet)})`
          : `claim_payout(${badgeFor(targetSeat.wallet)})`,
        sig,
      });
      setBanner({
        kind: "success",
        text: isRefund
          ? `Refunded ${badgeFor(targetSeat.wallet)} (${shortKey(targetSeat.wallet.toBase58())}).`
          : `Paid out to ${badgeFor(targetSeat.wallet)} (${shortKey(targetSeat.wallet.toBase58())}).`,
      });
      await syncState();
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text:
          err instanceof Error ? err.message : "Couldn't pay out. Try again.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  // ─── Practice bots ────────────────────────────────────────────────────────
  // Real, funded seats driven from this tab. See lib/bots.ts.
  const [bots, setBots] = useState<PracticeBot[]>([]);
  const [botsSwept, setBotsSwept] = useState(false);
  useEffect(() => {
    if (validRoomId) setBots(loadBots(roomIdStr));
  }, [validRoomId, roomIdStr]);

  const botByWallet = useMemo(
    () => new Map(bots.map((b) => [b.wallet.publicKey.toBase58(), b])),
    [bots]
  );
  const seatedBots = useMemo(
    () =>
      arena
        ? bots.filter((b) => arena.players.some((s) => s.wallet.equals(b.wallet.publicKey)))
        : [],
    [arena, bots]
  );
  const seatedBotsRef = useRef<PracticeBot[]>([]);
  seatedBotsRef.current = seatedBots;
  const arenaRef = useRef<ArenaAccount | null>(arena);
  arenaRef.current = arena;

  // Rolling 30s price history the bot strategies read from
  const priceHistoryRef = useRef<PricePoint[]>([]);
  useEffect(() => {
    if (!oracleTick) return;
    const h = priceHistoryRef.current;
    const now = Date.now();
    h.push({ t: now, p: oracleTick.priceUsd });
    while (h.length && now - h[0].t > 30_000) h.shift();
  }, [oracleTick]);

  const handleAddBots = async () => {
    if (!arena || !vault) return;
    if (!connected || !publicKey) {
      openModal();
      return;
    }
    const count = Math.min(3, arena.maxPlayers - arena.playerCount);
    if (count <= 0) return;
    setBanner(null);

    const previous = bots;
    // Bots funded earlier but never seated (a failed attempt) go first, so their SOL is reused
    const seatedNow = arena.players.slice(0, arena.playerCount);
    const reuse = previous
      .filter((b) => !seatedNow.some((s) => s.wallet.equals(b.wallet.publicKey)))
      .slice(0, count);
    const fresh = createBots(count - reuse.length, previous);
    const all = [...previous, ...fresh];
    const toSeat = [...reuse, ...fresh];
    // Persist keys before any SOL moves, so funded bots can never be lost
    saveBots(roomIdStr, all);
    setBots(all);

    const noun = count === 1 ? "bot" : "bots";
    try {
      setBusyAction(`Funding ${count} practice ${noun}. Approve once in your wallet…`);
      try {
        const have = new Map<string, bigint>();
        for (const b of reuse) {
          have.set(
            b.wallet.publicKey.toBase58(),
            BigInt(await l1Conn.getBalance(b.wallet.publicKey, "confirmed"))
          );
        }
        const fundTx = buildBotFundingTx(publicKey, toSeat, vault.entryFee, have);
        if (fundTx.instructions.length > 0) {
          const fundSig = await sendL1Transaction(fundTx);
          pushLog({ layer: "L1", action: `fund ${count} practice ${noun}`, sig: fundSig });
        }
      } catch (err) {
        // Nothing was sent: forget the unfunded bots
        saveBots(roomIdStr, previous);
        setBots(previous);
        throw err;
      }

      const seatBase = arena.playerCount;
      for (let i = 0; i < toSeat.length; i++) {
        const b = toSeat[i];
        setBusyAction(`Seating the ${BOT_STYLE_LABEL[b.style].toLowerCase()} (${i + 1} of ${count})…`);
        const sig = await sendL1AsKeypair(
          l1Conn,
          new Transaction().add(
            buildJoinRoomIx({
              player: b.wallet.publicKey,
              roomId,
              sessionKey: b.session.publicKey,
              seatIndex: seatBase + i,
            }),
            buildDelegateSeatIx({
              payer: b.wallet.publicKey,
              roomId,
              seatIndex: seatBase + i,
            })
          ),
          b.wallet
        );
        pushLog({ layer: "L1", action: `join_room (${BOT_STYLE_LABEL[b.style]})`, sig });
      }
      setBanner({
        kind: "success",
        text: `${count} practice ${noun} seated. Start the room when you're ready.`,
      });
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text:
          err instanceof Error
            ? err.message
            : "Couldn't seat the bots. Any SOL already sent stays in their wallets and can be returned after the round.",
      });
    } finally {
      setBusyAction(null);
      await syncState();
      refreshBalance();
    }
  };

  // Bot trading loop: each bot acts on its own jittered rhythm while the round is live
  const botStateRef = useRef(
    new Map<string, { nextAt: number; inFlight: boolean; pos: PositionDir; mem: BotMemory | null }>()
  );
  const botsLive =
    isDelegated && arena?.status === "Live" && !timerExpired && seatedBots.length > 0;

  useEffect(() => {
    if (!botsLive) return;
    const id = setInterval(() => {
      const a = arenaRef.current;
      if (!a || a.status !== "Live") return;
      const now = Date.now();
      if (now >= Number(a.endsAt) * 1000 - 300) return; // don't race the buzzer
      for (const b of seatedBotsRef.current) {
        const key = b.wallet.publicKey.toBase58();
        const seatIndex = a.players
          .slice(0, a.playerCount)
          .findIndex((s) => s.wallet.equals(b.wallet.publicKey));
        if (seatIndex < 0) continue;
        let st = botStateRef.current.get(key);
        if (!st) {
          // Every seat starts flat; after that the bot tracks its own (sealed) position
          st = { nextAt: now + 500 + Math.random() * 1500, inFlight: false, pos: POS_FLAT, mem: null };
          botStateRef.current.set(key, st);
        }
        if (st.inFlight || now < st.nextAt) continue;
        st.nextAt = now + nextBotDelayMs(b.style);

        const move = decideBotMove(b.style, priceHistoryRef.current, st.pos, st.mem, now);
        if (move === null) continue;

        const state = st;
        state.inFlight = true;
        getTeeConnection(b.session)
          .then((conn) =>
            sendErSessionTx(
              conn,
              new Transaction().add(
                buildTapIx({
                  signer: b.session.publicKey,
                  roomId,
                  newPosition: move,
                  priceFeed: a.priceFeed,
                  seatIndex,
                })
              ),
              b.session
            )
          )
          .then((res) => {
            state.pos = move;
            const hist = priceHistoryRef.current;
            const p = hist.length ? hist[hist.length - 1].p : 0;
            state.mem = move === POS_FLAT ? null : { enteredAt: Date.now(), entryPrice: p };
            pushLog({
              layer: "ER",
              action: `${BOT_STYLE_LABEL[b.style]}: ${posLabel(move).toLowerCase()}`,
              sig: res.signature,
              ms: res.latencyMs,
            });
          })
          .catch(async () => {
            // Resync from the bot's own sealed seat; the next tick decides again
            try {
              const conn = await getTeeConnection(b.session);
              const info = await conn.getAccountInfo(findSeatPda(roomId, seatIndex)[0], "confirmed");
              const sealed = info ? decodeSeatPosition(info.data) : null;
              if (sealed) state.pos = sealed.position;
            } catch {
              // keep the last known position
            }
          })
          .finally(() => {
            state.inFlight = false;
          });
      }
    }, 250);
    return () => clearInterval(id);
  }, [botsLive, roomId, pushLog]);

  // After the round: claim anything bots are owed, then send all their SOL back
  const handleSweepBots = async () => {
    if (!arena || !vault) return;
    if (!connected || !publicKey) {
      openModal();
      return;
    }
    setBanner(null);
    const winners =
      arena.status === "Aborted" ? null : new Set(getWinningSeatIndices(arena));
    const botsOwed = seatedBots.filter((b) => {
      const i = arena.players.findIndex((s) => s.wallet.equals(b.wallet.publicKey));
      return i >= 0 && (winners === null || winners.has(i)) && !isSeatClaimed(vault, i);
    }).length;
    setBusyAction(
      botsOwed === 0
        ? "Returning your bots' leftover SOL…"
        : arena.status === "Aborted"
          ? "Refunding your bots' stakes and returning their SOL…"
          : "Claiming what your bots won and returning their SOL…"
    );
    let returned = 0;
    try {
      for (const b of bots) {
        const seatIndex = arena.players
          .slice(0, arena.playerCount)
          .findIndex((s) => s.wallet.equals(b.wallet.publicKey));
        const owed =
          seatIndex >= 0 &&
          !vault.cancelled &&
          (winners === null || winners.has(seatIndex)) &&
          !isSeatClaimed(vault, seatIndex);
        if (owed) {
          const sig = await sendL1AsKeypair(
            l1Conn,
            new Transaction().add(
              buildClaimPayoutIx({
                payer: b.wallet.publicKey,
                roomId,
                seatIndex,
                recipient: b.wallet.publicKey,
              })
            ),
            b.wallet
          );
          pushLog({ layer: "L1", action: `claim_payout (${BOT_STYLE_LABEL[b.style]})`, sig });
        }
        const before = await l1Conn.getBalance(b.wallet.publicKey, "confirmed");
        const sig = await sweepBot(l1Conn, b, publicKey);
        if (sig) {
          returned += before - 5_000;
          pushLog({ layer: "L1", action: `return SOL (${BOT_STYLE_LABEL[b.style]})`, sig });
        }
      }
      setBotsSwept(true);
      setBanner({
        kind: "success",
        text:
          returned > 0
            ? `Returned ${fmtSol(returned / LAMPORTS_PER_SOL)} SOL from your bots.`
            : "Your bots had nothing left to return.",
      });
    } catch (err: unknown) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : "Couldn't return the bots' SOL. Try again.",
      });
    } finally {
      setBusyAction(null);
      await syncState();
      refreshBalance();
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

  const winnerSeats = useMemo(
    () =>
      arena && arena.status === "Finished"
        ? winningSeatIndices
            .map((idx) => ({ seatIndex: idx, seat: arena.players[idx] }))
            .filter((x): x is { seatIndex: number; seat: PlayerSeat } => !!x.seat)
        : [],
    [arena, winningSeatIndices]
  );

  const primaryWinner = winnerSeats[0] ?? null;
  const isTie = winnerSeats.length > 1;
  const iWon = !!(
    publicKey && winnerSeats.some((w) => w.seat.wallet.equals(publicKey))
  );
  const myWinningSeatIndex = useMemo(() => {
    if (!publicKey) return -1;
    return winnerSeats.find((w) => w.seat.wallet.equals(publicKey))?.seatIndex ?? -1;
  }, [publicKey, winnerSeats]);

  const isCreator = !!(publicKey && arena && publicKey.equals(arena.creator));
  const seatsOpen = arena ? arena.maxPlayers - arena.playerCount : 0;

  // ─── Phase: where this room is in its life ────────────────────────────────
  // 0 Fill seats · 1 Ready · 2 Trade · 3 Settle · 4 Pay out · 5 Done
  const phase = useMemo(() => {
    if (!arena || !vault) return 0;
    if (arena.status === "Finished" || arena.status === "Aborted") {
      return unclaimedSeatIndices.length === 0 || potSol === 0 ? 5 : 4;
    }
    if (arena.status === "Live") return timerExpired ? 3 : 2;
    return isDelegated ? 1 : 0;
  }, [arena, vault, isDelegated, timerExpired, potSol, unclaimedSeatIndices.length]);

  // Victory reveal: once per room, when the round finishes while we're watching,
  // or when someone opens a settled room whose pot is still unclaimed.
  useEffect(() => {
    if (arena?.status === "Live") sawLiveRef.current = true;
    if (
      arena?.status === "Finished" &&
      primaryWinner &&
      vault &&
      !vault.cancelled &&
      (sawLiveRef.current || unclaimedSeatIndices.length > 0)
    ) {
      if (sawLiveRef.current && !revealedRef.current) {
        revealedRef.current = true;
        setRevealing(true);
        setTimeout(() => setRevealing(false), 2600);
        return;
      }
      if (revealing) return;
      setShowVictory((prev) => prev || !victoryDismissedRef.current);
    }
  }, [arena?.status, primaryWinner, vault, unclaimedSeatIndices.length, revealing]);

  const dismissVictory = useCallback(() => {
    victoryDismissedRef.current = true;
    setShowVictory(false);
  }, []);

  useEffect(() => {
    if (!showVictory) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissVictory();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showVictory, dismissVictory]);

  // ─── Clock rendering ─────────────────────────────────────────────────────
  const durationSecs = arena ? Number(arena.durationSecs) : 60;
  const clockWhole = Math.floor(remainingSec);
  const clockTenth = Math.floor((remainingSec - clockWhole) * 10);
  const clockUrgent = arena?.status === "Live" && remainingSec > 0 && remainingSec <= 10;
  const clockIdle = !arena || arena.status !== "Live";
  const clockFrac = durationSecs > 0 ? Math.min(1, remainingSec / durationSecs) : 0;

  const clockStatus = !arena
    ? ""
    : arena.status === "Lobby"
      ? isDelegated
        ? isStaleDelegatedLobby
          ? "Idle too long — refunds available"
          : "Starts on the first trade"
        : "Starts after the room goes live"
      : arena.status === "Live"
        ? timerExpired
          ? "Time's up"
          : clockUrgent
            ? "Final seconds"
            : "Trading"
        : arena.status === "Aborted"
          ? "Aborted — refunds open"
          : vault?.cancelled
            ? "Cancelled"
            : "Final";

  // ─── Next move: the one thing to do now ───────────────────────────────────
  const renderNextMove = () => {
    if (!arena || !vault) return null;

    if (busyAction) {
      return (
        <section className="card next-move working" aria-live="polite">
          <div className="working-line">
            <span className="spinner" aria-hidden="true" />
            {busyAction}
          </div>
        </section>
      );
    }

    let title = "";
    let body: React.ReactNode = null;
    let actions: React.ReactNode = null;

    if (vault.cancelled) {
      title = "Room cancelled";
      body = "The creator cancelled before anyone joined. Stakes went back to their wallets.";
      actions = (
        <Link href="/" className="btn btn-primary btn-lg">
          Back to rooms
        </Link>
      );
    } else if (phase === 0) {
      if (!mySeat && seatsOpen > 0) {
        title = "Take a seat";
        body =
          entrySol > 0
            ? `Stake ${fmtSol(entrySol)} SOL to join. You approve once; your trades after that need no popups and no gas, and stay hidden from other players until the buzzer.`
            : "This room is free. You approve once to join; your trades after that need no popups and stay hidden until the buzzer.";
        actions = (
          <button
            type="button"
            id="join-room-btn"
            className="btn btn-primary btn-lg"
            onClick={handleJoin}
            disabled={!!busyAction}
          >
            {!connected
              ? "Connect wallet to join"
              : entrySol > 0
                ? `Join for ${fmtSol(entrySol)} SOL`
                : "Join free room"}
          </button>
        );
      } else if (!mySeat) {
        title = "This room is full";
        body = `Waiting for ${badgeFor(arena.creator)} to start it. You can watch the round from here.`;
      } else if (!isCreator && isStaleL1Lobby) {
        title = "The creator never started this room";
        body = `It's been over ${Math.round(L1_LOBBY_TIMEOUT_SECS / 60)} minutes. Abort it and every player gets their stake back.`;
        actions = (
          <button
            type="button"
            id="abort-stale-lobby-btn"
            className="btn btn-primary btn-lg"
            onClick={handleAbortStaleLobby}
            disabled={!!busyAction}
          >
            {connected ? "Abort and refund everyone" : "Connect wallet to abort"}
          </button>
        );
      } else if (!isCreator) {
        title = "You're seated";
        body = `Waiting for the room creator (${badgeFor(arena.creator)}) to start the room and lock seats.`;
        actions =
          seatsOpen > 0 && arena.maxPlayers > 1 ? (
            <button type="button" className="btn btn-lg" onClick={handleCopyInvite}>
              {copiedLink ? <Check size={16} /> : <Link2 size={16} />}
              {copiedLink ? "Link copied" : "Copy invite link"}
            </button>
          ) : null;
      } else {
        title = seatsOpen > 0 && arena.maxPlayers > 1 ? "Waiting for players" : "Everyone's in";
        body =
          seatsOpen > 0 && arena.maxPlayers > 1
            ? `${seatsOpen} ${seatsOpen === 1 ? "seat is" : "seats are"} open. Send the invite link, or fill seats with practice bots. Starting locks the seats.`
            : "Start the room to move it onto MagicBlock's private rollup. Trades there are instant and free, and each position stays sealed until the buzzer.";
        actions = (
          <>
            {seatsOpen > 0 && arena.maxPlayers > 1 && (
              <button type="button" className="btn btn-lg" onClick={handleCopyInvite}>
                {copiedLink ? <Check size={16} /> : <Link2 size={16} />}
                {copiedLink ? "Link copied" : "Copy invite link"}
              </button>
            )}
            {seatsOpen > 0 && arena.maxPlayers > 1 && (
              <button
                type="button"
                id="add-bots-btn"
                className="btn btn-lg"
                onClick={handleAddBots}
                disabled={!!busyAction}
                title="Each bot gets its own wallet and pays its own stake, funded by you in one approval"
              >
                <Bot size={16} />
                Add {Math.min(3, seatsOpen)} practice {Math.min(3, seatsOpen) === 1 ? "bot" : "bots"}
              </button>
            )}
            <button
              type="button"
              id="delegate-arena-btn"
              className="btn btn-primary btn-lg"
              onClick={handleDelegate}
              disabled={!!busyAction}
            >
              Start room
            </button>
            {arena.playerCount === 1 && (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={handleCancel}
                disabled={!!busyAction}
              >
                Cancel and refund
              </button>
            )}
          </>
        );
      }
    } else if (phase === 1 || phase === 2) {
      if (isStaleDelegatedLobby) {
        title = "Room timed out before starting";
        body = `Nobody started trading within ${STALE_LOBBY_TIMEOUT_SECS} seconds. Anyone can abort the room and send it back to Solana so players can reclaim their stakes.`;
        actions = (
          <button
            type="button"
            id="abort-stale-btn"
            className="btn btn-primary btn-lg"
            onClick={handleAbortStaleRoom}
            disabled={!!busyAction}
          >
            <RotateCcw size={16} />
            {activeSessionKey || connected
              ? "Abort and unlock refunds"
              : "Connect wallet to abort"}
          </button>
        );
      } else if (!mySeat) {
        title = phase === 1 ? "About to start" : "You're watching";
        body =
          phase === 1
            ? `The clock starts on the first trade. If nobody starts in ${staleCountdownSec}s, refunds unlock automatically.`
            : "Banked scores update live. Open positions stay sealed until the buzzer.";
      } else if (phase === 1) {
        title = activeSessionKey ? "Ready when you are" : "Ready — wallet fallback mode";
        body = activeSessionKey
          ? `Your first trade seals your seat and starts the clock for everyone, or start it now. Refunds unlock in ${staleCountdownSec}s if nobody trades.`
          : "This tab doesn't hold your zero-popup key, so trades will ask your wallet to approve (still zero gas).";
        actions = (
          <button
            type="button"
            className="btn btn-lg"
            onClick={handleBeginRound}
            disabled={!!busyAction}
          >
            <Play size={16} /> Start clock
          </button>
        );
      } else if (!activeSessionKey) {
        title = "Wallet fallback active";
        body =
          "Your zero-popup key lives in the tab that joined. You can still trade here using wallet approvals (still zero gas).";
      } else {
        return null; // trading with 0-popup session key: the pad is the action
      }
    } else if (phase === 3) {
      title = "Time's up";
      body = `Settle within ${SETTLE_GRACE_SECS}s of zero to close open positions at the live price; after that, positions lock at the last trade price so nobody can time the close.`;
      actions = (
        <button
          type="button"
          id="finish-round-btn"
          className="btn btn-primary btn-lg"
          onClick={() => void handleFinishRound()}
          disabled={!!busyAction}
        >
          {activeSessionKey || connected
            ? "Settle the room"
            : "Connect wallet to settle"}
        </button>
      );
    } else if (phase === 4 && arena.status === "Aborted") {
      title = "Room aborted — refunds ready";
      body = `Each player gets their ${fmtSol(entrySol)} SOL stake back from the Solana vault.`;
      actions = (
        <>
          {unclaimedSeatIndices.map((seatIdx) => {
            const seat = arena.players[seatIdx];
            if (!seat) return null;
            const shareSol = Number(seatPayoutLamports(seatIdx)) / LAMPORTS_PER_SOL;
            const isMe = !!(publicKey && seat.wallet.equals(publicKey));
            return (
              <button
                key={seatIdx}
                type="button"
                id={`claim-payout-seat-${seatIdx}`}
                className={`btn ${isMe ? "btn-primary" : ""} btn-lg`}
                onClick={() => handleClaimPayout(seatIdx)}
                disabled={!!busyAction}
              >
                {!connected
                  ? "Connect wallet to refund"
                  : isMe
                    ? `Refund my ${fmtSol(shareSol)} SOL`
                    : `Refund ${badgeFor(seat.wallet)} (${fmtSol(shareSol)} SOL)`}
              </button>
            );
          })}
        </>
      );
    } else if (phase === 4 && primaryWinner) {
      if (isTie) {
        const splitSol =
          Number(seatPayoutLamports(unclaimedSeatIndices[0] ?? primaryWinner.seatIndex)) /
          LAMPORTS_PER_SOL;
        title = `${winnerSeats.length}-way tie — pot splits equally`;
        body = `Tied winners each claim ${fmtSol(splitSol)} SOL from the Solana vault.`;
        actions = (
          <>
            {unclaimedSeatIndices.map((seatIdx) => {
              const seat = arena.players[seatIdx];
              if (!seat) return null;
              const shareSol = Number(seatPayoutLamports(seatIdx)) / LAMPORTS_PER_SOL;
              const isMe = !!(publicKey && seat.wallet.equals(publicKey));
              return (
                <button
                  key={seatIdx}
                  type="button"
                  id={`claim-payout-seat-${seatIdx}`}
                  className={`btn ${isMe ? "btn-primary" : ""} btn-lg`}
                  onClick={() => handleClaimPayout(seatIdx)}
                  disabled={!!busyAction}
                >
                  {!connected
                    ? "Connect wallet to pay out"
                    : isMe
                      ? `Claim my ${fmtSol(shareSol)} SOL`
                      : `Pay ${badgeFor(seat.wallet)} (${fmtSol(shareSol)} SOL)`}
                </button>
              );
            })}
          </>
        );
      } else {
        title = iWon
          ? "You won. Claim your pot"
          : `${badgeFor(primaryWinner.seat.wallet)} won`;
        body = iWon
          ? `${fmtSol(potSol)} SOL is waiting in the vault for you.`
          : `Anyone can send the ${fmtSol(potSol)} SOL pot to the winner's wallet.`;
        actions = (
          <button
            type="button"
            id="claim-payout-btn"
            className="btn btn-primary btn-lg"
            onClick={() => handleClaimPayout(primaryWinner.seatIndex)}
            disabled={!!busyAction}
          >
            {!connected
              ? "Connect wallet to pay out"
              : iWon
                ? `Claim ${fmtSol(potSol)} SOL`
                : "Pay out the winner"}
          </button>
        );
      }
    } else {
      title = arena.status === "Aborted" ? "All stakes refunded" : "Round complete";
      body =
        arena.status === "Aborted"
          ? "Every seated player received their stake back on Solana."
          : primaryWinner
            ? isTie
              ? potSol > 0
                ? `${winnerSeats.map((w) => badgeFor(w.seat.wallet)).join(" & ")} split the ${fmtSol(potSol)} SOL pot.`
                : `${winnerSeats.map((w) => badgeFor(w.seat.wallet)).join(" & ")} tied at the top in a free round.`
              : potSol > 0
                ? `${badgeFor(primaryWinner.seat.wallet)} took the ${fmtSol(potSol)} SOL pot. Positions were sealed until the buzzer. The standings show what everyone held.`
                : `${badgeFor(primaryWinner.seat.wallet)} topped the board in a free round.`
            : "This round is over.";
      actions = (
        <Link href="/" className="btn btn-primary btn-lg">
          Play again
        </Link>
      );
    }

    if (isTerminal && bots.length > 0 && !botsSwept && !vault.cancelled) {
      const base = actions;
      actions = (
        <>
          {base}
          <button
            type="button"
            className="btn btn-lg"
            onClick={handleSweepBots}
            disabled={!!busyAction}
            title="Claims anything your bots are owed, then sends all their SOL back to your wallet"
          >
            <Bot size={16} />
            Return bot SOL to me
          </button>
        </>
      );
    }

    return (
      <section className="card next-move" aria-live="polite">
        <div>
          <h2>{title}</h2>
          {body && <p>{body}</p>}
        </div>
        {actions && <div className="next-move-actions">{actions}</div>}
      </section>
    );
  };

  const showPad = !!(arena && mySeat && isDelegated && !isTerminal);

  return (
    <main className="shell">
      <TopBar erSlot={oracleTick ? Number(oracleTick.postedSlot) : null} />

      {loadingRoom ? (
        <div className="card room-state" aria-busy="true">
          <span className="spinner" aria-hidden="true" style={{ margin: "0 auto 14px", display: "block" }} />
          <p>Loading room #{roomIdStr.slice(-6)}…</p>
        </div>
      ) : notFound || !arena || !vault ? (
        <div className="card room-state">
          <h1>Room not found</h1>
          <p>
            There&apos;s no room with code <span className="addr">{roomIdStr}</span> on
            Devnet. Check the invite link, or open a new room.
          </p>
          <Link href="/" className="btn btn-primary btn-lg">
            Back to rooms
          </Link>
        </div>
      ) : (
        <>
          {/* ── Room bar ─────────────────────────────────────────── */}
          <div className="room-bar">
            <div className="room-bar-left">
              <Link href="/" className="btn btn-quiet btn-icon" aria-label="Back to rooms" title="Back to rooms">
                <ArrowLeft size={18} />
              </Link>
              <h1 className="room-heading">
                {market.symbol.split("/")[0]} room
                <small>#{roomIdStr.slice(-6)}</small>
                {isLinkOnlyRoom(roomIdStr) && (
                  <span className="room-tag" title="Kept off the room list. Only people with the invite link can find it.">
                    Link only
                  </span>
                )}
              </h1>
            </div>
            <div className="room-bar-right">
              <button type="button" className="btn btn-sm" onClick={handleCopyInvite}>
                {copiedLink ? <Check size={14} color="#2bd67b" /> : <Copy size={14} />}
                {copiedLink ? "Copied" : "Invite link"}
              </button>
              <a
                href={`https://explorer.solana.com/address/${arenaPda.toBase58()}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
                className="btn btn-quiet btn-sm"
              >
                Scoreboard account <ExternalLink size={12} />
              </a>
              <a
                href={`https://explorer.solana.com/address/${vaultPda.toBase58()}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
                className="btn btn-quiet btn-sm"
              >
                Vault <ExternalLink size={12} />
              </a>
            </div>
          </div>

          {/* ── Phase rail ───────────────────────────────────────── */}
          {!vault.cancelled && (
            <ol className="phase-rail" aria-label="Round progress">
              {PHASES.map((p, i) => (
                <li
                  key={p}
                  className={`phase ${i < phase ? "done" : i === phase ? "now" : ""}`}
                  aria-current={i === phase ? "step" : undefined}
                >
                  {p}
                </li>
              ))}
            </ol>
          )}

          <div aria-live="polite">
            {banner && (
              <div className={`banner ${banner.kind}`} role={banner.kind === "error" ? "alert" : undefined}>
                <span>{banner.text}</span>
                <button
                  type="button"
                  className="btn btn-quiet btn-icon btn-sm"
                  style={{ width: 28, height: 28 }}
                  onClick={() => setBanner(null)}
                  aria-label="Dismiss message"
                  title="Dismiss"
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>

          <div className="room-grid">
            {/* ── Main column ────────────────────────────────────── */}
            <div className="room-main">
              <section className="card chart-card" aria-label="Live price">
                <CandleCanvas
                  candles={candles}
                  livePriceUsd={oracleTick?.priceUsd ?? null}
                  entryPriceUsd={myEntryPriceUsd}
                  position={mySeat?.position ?? POS_FLAT}
                  symbol={market.symbol}
                  tapMarkers={tapMarkers}
                  erRttMs={oracleRttMs}
                />
              </section>

              {renderNextMove()}

              {showPad && mySeat && (
                <section className="card card-body" aria-label="Your trades">
                  <div className="pad-readout">
                    <div>
                      <div className="score-label">
                        Your score{" "}
                        {mySealed ? (
                          <span className={`pos-chip ${posClass(mySeat.position)}`} style={{ marginLeft: 6 }}>
                            {posLabel(mySeat.position)}
                          </span>
                        ) : (
                          <span className="pos-chip flat" style={{ marginLeft: 6 }}>
                            <Lock size={11} aria-hidden="true" /> Sealed
                          </span>
                        )}
                      </div>
                      <div className={`score ${pnlClass(myLivePnl)}`}>
                        {formatPnlPct(myLivePnl)}
                      </div>
                    </div>
                    <div className="taps">
                      <strong>{mySeat.tapCount}</strong>
                      trades, zero gas
                    </div>
                  </div>
                  <p className="seal-note">
                    <Lock size={13} aria-hidden="true" />
                    {!activeSessionKey
                      ? "Your position is only visible in the tab you joined from."
                      : mySealed?.sealed
                        ? "Only you can see your position. Everyone sees it at the buzzer."
                        : "Your first trade seals your seat. Only you see your position until the buzzer."}
                  </p>

                  <div className={canTap ? "pad-dock" : undefined}>
                    <div className="pad" role="group" aria-label="Choose a position">
                      <button
                        type="button"
                        id="tap-long-btn"
                        className={`pad-btn long ${mySeat.position === POS_LONG ? "active" : ""} ${pendingDir === POS_LONG ? "pending" : ""}`}
                        disabled={!canTap || tapping || mySeat.position === POS_LONG}
                        onClick={() => handleTap(POS_LONG)}
                        aria-pressed={mySeat.position === POS_LONG}
                        aria-keyshortcuts="W ArrowUp"
                      >
                        <span className="pad-key" aria-hidden="true">W</span>
                        <span className="pad-label">
                          <ArrowUp size={28} strokeWidth={3} /> Long
                        </span>
                        <span className="pad-hint">
                          {mySeat.position === POS_LONG
                            ? "Current position"
                            : "Bet the price rises"}
                        </span>
                      </button>

                      <button
                        type="button"
                        id="tap-flat-btn"
                        className={`pad-btn flat ${mySeat.position === POS_FLAT ? "active" : ""} ${pendingDir === POS_FLAT ? "pending" : ""}`}
                        disabled={!canTap || tapping || mySeat.position === POS_FLAT}
                        onClick={() => handleTap(POS_FLAT)}
                        aria-pressed={mySeat.position === POS_FLAT}
                        aria-keyshortcuts="Space"
                      >
                        <span className="pad-key" aria-hidden="true">␣</span>
                        <span className="pad-label">
                          <Minus size={24} strokeWidth={3} /> Flat
                        </span>
                        <span className="pad-hint">
                          {mySeat.position === POS_FLAT
                            ? "Current position"
                            : "Lock your score"}
                        </span>
                      </button>

                      <button
                        type="button"
                        id="tap-short-btn"
                        className={`pad-btn short ${mySeat.position === POS_SHORT ? "active" : ""} ${pendingDir === POS_SHORT ? "pending" : ""}`}
                        disabled={!canTap || tapping || mySeat.position === POS_SHORT}
                        onClick={() => handleTap(POS_SHORT)}
                        aria-pressed={mySeat.position === POS_SHORT}
                        aria-keyshortcuts="S ArrowDown"
                      >
                        <span className="pad-key" aria-hidden="true">S</span>
                        <span className="pad-label">
                          <ArrowDown size={28} strokeWidth={3} /> Short
                        </span>
                        <span className="pad-hint">
                          {mySeat.position === POS_SHORT
                            ? "Current position"
                            : "Bet the price falls"}
                        </span>
                      </button>
                    </div>
                  </div>
                </section>
              )}
            </div>

            {/* ── Side column: the board ─────────────────────────── */}
            <aside className="room-side">
              <section className="card clock-card" aria-label="Round clock and pot">
                <div
                  className={`clock ${clockUrgent ? "urgent" : ""} ${clockIdle ? "idle" : ""}`}
                  role="timer"
                  aria-label={`${clockWhole} seconds left`}
                >
                  <span className="clock-tick" key={clockUrgent ? clockWhole : "steady"}>
                    {clockWhole}
                  </span>
                  <span className="tenths">.{clockTenth}</span>
                </div>
                <p className="clock-status">{clockStatus}</p>
                <div className="clock-bar" aria-hidden="true">
                  <i style={{ transform: `scaleX(${clockFrac})` }} />
                </div>

                <div className="pot-line">
                  <div>
                    <div className="pot-label">Pot</div>
                    <div className="pot">
                      {fmtSol(potSol)}
                      <small>SOL</small>
                    </div>
                  </div>
                  <div className="pot-note">
                    {vault.claimed ? (
                      arena.status === "Aborted" ? "All refunded" : "Paid out"
                    ) : vault.cancelled ? (
                      "Refunded"
                    ) : arena.status === "Aborted" ? (
                      "Stakes refundable"
                    ) : entrySol > 0 ? (
                      <>
                        {fmtSol(entrySol)} SOL each
                        <br />
                        {isTie ? `${winnerSeats.length}-way split` : "Best score wins · Ties split"}
                      </>
                    ) : (
                      "Free round"
                    )}
                  </div>
                </div>
              </section>

              <section className="card" aria-labelledby="standings-title">
                <div className="card-head">
                  <h2 id="standings-title" className="card-title">
                    Standings
                  </h2>
                  <span className="card-note">
                    {revealing
                      ? "Buzzer. Every position is public now"
                      : isSealedRound && arena.status === "Live"
                        ? "Open trades stay hidden until the buzzer"
                        : `${arena.playerCount} of ${arena.maxPlayers} players`}
                  </span>
                </div>
                <div className="card-body">
                  <ol className={`standings ${revealing ? "revealing" : ""}`}>
                    {rankedSeats.map((row, rank) => {
                      const isMe = publicKey !== null && row.seat.wallet.equals(publicKey);
                      const isWinner =
                        arena.status === "Finished" &&
                        winningSeatIndices.includes(row.seatIndex);
                      return (
                        <li
                          key={row.seat.wallet.toBase58()}
                          className={`standing ${rank === 0 || isWinner ? "lead" : ""} ${isMe ? "me" : ""}`}
                        >
                          <span className="rank" aria-label={isWinner ? "Winner" : `Rank ${rank + 1}`}>
                            {isWinner ? <Crown size={16} color="#ffc928" /> : rank + 1}
                          </span>
                          <span className="badge" style={jacketStyle(row.seatIndex)}>
                            {badgeFor(row.seat.wallet)}
                          </span>
                          <span className="who">
                            <span className="addr">{shortKey(row.seat.wallet.toBase58())}</span>
                            {isMe && <span className="you"> You</span>}
                            {botByWallet.has(row.seat.wallet.toBase58()) && (
                              <span className="bot-tag">
                                {BOT_STYLE_LABEL[botByWallet.get(row.seat.wallet.toBase58())!.style]}
                              </span>
                            )}
                            <br />
                            {arena.status === "Aborted" ? null : isSealedRound && !(isMe && mySealed) ? (
                              <>
                                <span className="sealed">
                                  <Lock size={11} aria-hidden="true" /> Sealed
                                </span>
                                ,{" "}
                              </>
                            ) : (
                              <>
                                <span
                                  className={`${posClass(row.seat.position) === "long" ? "up" : posClass(row.seat.position) === "short" ? "down" : ""} ${arena.status === "Finished" ? "revealed" : ""}`}
                                  style={{ "--i": rank } as React.CSSProperties}
                                >
                                  {posLabel(row.seat.position)}
                                  {arena.status === "Finished" ? " at the buzzer" : ""}
                                </span>
                                ,{" "}
                              </>
                            )}
                            {row.seat.tapCount} {row.seat.tapCount === 1 ? "trade" : "trades"}
                          </span>
                          <span className={`pnl ${pnlClass(row.livePnl)}`}>
                            {formatPnlPct(row.livePnl)}
                            {isSealedRound && !isMe && <small>banked</small>}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                  {arena.status === "Lobby" && seatsOpen > 0 && (
                    <p className="seat-open">
                      {seatsOpen} {seatsOpen === 1 ? "seat" : "seats"} open
                    </p>
                  )}
                </div>
              </section>

              <details className="card tape" open>
                <summary>
                  <div className="card-head">
                    <h2 className="card-title">On-chain log</h2>
                    <span className="card-note">
                      {txFeed.length} {txFeed.length === 1 ? "transaction" : "transactions"}
                    </span>
                  </div>
                </summary>
                <div className="card-body">
                  {txFeed.length === 0 ? (
                    <p className="tape-empty">
                      Every stake, trade and payout from this tab shows up here with
                      its signature and how fast it landed.
                    </p>
                  ) : (
                    <ul className="tape-list">
                      {txFeed.map((t) => (
                        <li key={t.id} className="tape-row">
                          <span className={`layer ${t.layer === "ER" ? "er" : "l1"}`}>
                            {t.layer}
                          </span>
                          <span className="act">
                            {t.action}
                            {t.ms !== undefined && <span className="ms">{t.ms}ms</span>}
                          </span>
                          {t.layer === "L1" ? (
                            <a
                              href={`https://explorer.solana.com/tx/${t.sig}?cluster=devnet`}
                              target="_blank"
                              rel="noreferrer"
                              className="addr"
                            >
                              {t.sig.slice(0, 8)} <ExternalLink size={10} />
                            </a>
                          ) : (
                            <span className="addr" title={t.sig}>
                              {t.sig.slice(0, 8)}, no fee
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            </aside>
          </div>

          {/* ── Victory reveal ───────────────────────────────────── */}
          {showVictory && primaryWinner && (
            <div
              className="overlay"
              onClick={(e) => {
                if (e.target === e.currentTarget) dismissVictory();
              }}
            >
              <div
                className="victory"
                role="dialog"
                aria-modal="true"
                aria-labelledby="victory-title"
              >
                <button
                  type="button"
                  className="btn btn-quiet btn-icon victory-close"
                  onClick={dismissVictory}
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
                <p className="victory-kicker">
                  {isTie
                    ? iWon
                      ? "You tied for first"
                      : "Exact tie"
                    : iWon
                      ? "You won the round"
                      : "Round over"}
                </p>
                <div
                  style={{
                    display: "inline-flex",
                    gap: 10,
                    justifyContent: "center",
                    flexWrap: "wrap",
                  }}
                >
                  {winnerSeats.map((w) => (
                    <span
                      key={w.seatIndex}
                      className="badge badge-lg"
                      style={jacketStyle(w.seatIndex)}
                    >
                      {badgeFor(w.seat.wallet)}
                    </span>
                  ))}
                </div>
                <h2 id="victory-title" className="victory-title">
                  {isTie
                    ? `Pot splits ${winnerSeats.length} ways`
                    : iWon
                      ? "The pot is yours"
                      : `${badgeFor(primaryWinner.seat.wallet)} takes the pot`}
                </h2>
                <div className={`victory-pnl ${pnlClass(primaryWinner.seat.realizedPnl)}`}>
                  {formatPnlPct(primaryWinner.seat.realizedPnl)}
                </div>
                <div className="victory-stats">
                  <div>
                    <strong>{potSol > 0 ? `${fmtSol(potSol)} SOL` : "Free"}</strong>
                    Pot
                  </div>
                  <div>
                    <strong>
                      {isTie
                        ? winnerSeats.length
                        : primaryWinner.seat.tapCount}
                    </strong>
                    {isTie ? "Tied winners" : "Gasless trades"}
                  </div>
                </div>
                {unclaimedSeatIndices.length > 0 && potSol > 0 ? (
                  (() => {
                    const targetSeatIdx =
                      myWinningSeatIndex >= 0 &&
                      unclaimedSeatIndices.includes(myWinningSeatIndex)
                        ? myWinningSeatIndex
                        : unclaimedSeatIndices[0];
                    const targetShareSol =
                      Number(seatPayoutLamports(targetSeatIdx)) / LAMPORTS_PER_SOL;
                    const claimingOwn = targetSeatIdx === myWinningSeatIndex;
                    return (
                      <button
                        type="button"
                        className="btn btn-primary btn-lg btn-block"
                        onClick={() => {
                          if (!connected) {
                            dismissVictory();
                            openModal();
                            return;
                          }
                          dismissVictory();
                          handleClaimPayout(targetSeatIdx);
                        }}
                        disabled={!!busyAction}
                      >
                        {!connected
                          ? "Connect wallet to pay out"
                          : claimingOwn
                            ? `Claim ${fmtSol(targetShareSol)} SOL`
                            : isTie
                              ? `Pay ${badgeFor(arena.players[targetSeatIdx].wallet)} (${fmtSol(targetShareSol)} SOL)`
                              : "Pay out the winner"}
                      </button>
                    );
                  })()
                ) : (
                  <button
                    type="button"
                    className="btn btn-lg btn-block"
                    onClick={dismissVictory}
                  >
                    See the final board
                  </button>
                )}
                <p className="victory-foot">
                  {isTie ? "Tied winners " : "Winner wallet "}
                  <span className="addr">
                    {winnerSeats
                      .map((w) => shortKey(w.seat.wallet.toBase58()))
                      .join(", ")}
                  </span>
                </p>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}
