"use client";

import { useEffect, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeOracleTick, OracleTick } from "@sdk/codec";
import { ER_RPC_URL, ER_WS_URL, MARKET_FEEDS } from "@sdk/constants";

export interface PricePoint {
  ts: number;
  priceUsd: number;
  rawPrice: bigint;
  slot: bigint;
}

export interface CandleBar {
  bucketMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const CANDLE_MS = 2500; // 2.5s micro-candles for 60s sprints
const MAX_POINTS = 240;
const MAX_CANDLES = 44;

export function useOracleStream(feedAddress: PublicKey) {
  const [latest, setLatest] = useState<OracleTick | null>(null);
  const [points, setPoints] = useState<PricePoint[]>([]);
  const [candles, setCandles] = useState<CandleBar[]>([]);
  const [connected, setConnected] = useState(false);
  const [rttMs, setRttMs] = useState<number | null>(null);

  const feedStr = feedAddress.toBase58();
  const lastPriceRef = useRef<bigint>(0n);

  useEffect(() => {
    let active = true;
    const conn = new Connection(ER_RPC_URL, {
      commitment: "confirmed",
      wsEndpoint: ER_WS_URL,
    });

    const ingest = (data: Uint8Array, measuredMs?: number) => {
      if (!active) return;
      try {
        const tick = decodeOracleTick(data);
        setLatest(tick);
        setConnected(true);
        if (measuredMs !== undefined) setRttMs(measuredMs);

        const nowMs = Date.now();
        lastPriceRef.current = tick.rawPrice;

        setPoints((prev) => {
          const next = [
            ...prev,
            {
              ts: nowMs,
              priceUsd: tick.priceUsd,
              rawPrice: tick.rawPrice,
              slot: tick.postedSlot,
            },
          ];
          return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
        });

        const bucketMs = Math.floor(nowMs / CANDLE_MS) * CANDLE_MS;
        setCandles((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.bucketMs === bucketMs) {
            const updated: CandleBar = {
              ...last,
              high: Math.max(last.high, tick.priceUsd),
              low: Math.min(last.low, tick.priceUsd),
              close: tick.priceUsd,
            };
            return [...prev.slice(0, -1), updated];
          }
          const openPrice = last ? last.close : tick.priceUsd;
          const bar: CandleBar = {
            bucketMs,
            open: openPrice,
            high: Math.max(openPrice, tick.priceUsd),
            low: Math.min(openPrice, tick.priceUsd),
            close: tick.priceUsd,
          };
          const next = [...prev, bar];
          return next.length > MAX_CANDLES ? next.slice(-MAX_CANDLES) : next;
        });
      } catch {
        // ignore malformed transient payload
      }
    };

    const poll = async () => {
      const t0 = performance.now();
      try {
        const info = await conn.getAccountInfo(new PublicKey(feedStr), "confirmed");
        if (info) {
          ingest(info.data, Math.round(performance.now() - t0));
        }
      } catch {
        if (active) setConnected(false);
      }
    };

    poll();

    // Live WebSocket subscription on MagicBlock ER + 350ms safety poll
    let subId: number | null = null;
    try {
      subId = conn.onAccountChange(
        new PublicKey(feedStr),
        (acc) => ingest(acc.data),
        "confirmed"
      );
    } catch {
      // fallback to polling below
    }

    const interval = setInterval(poll, 350);

    return () => {
      active = false;
      clearInterval(interval);
      if (subId !== null) {
        conn.removeAccountChangeListener(subId).catch(() => {});
      }
    };
  }, [feedStr]);

  return { latest, points, candles, connected, rttMs };
}

/** Polls all 3 live MagicBlock ER Pyth Lazer feeds for the Lobby market selector. */
export function useAllMarkets() {
  const [prices, setPrices] = useState<
    Record<"SOL" | "BTC" | "ETH", OracleTick | null>
  >({
    SOL: null,
    BTC: null,
    ETH: null,
  });
  const [erSlot, setErSlot] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const conn = new Connection(ER_RPC_URL, "confirmed");
    const keys = [
      MARKET_FEEDS.SOL.address,
      MARKET_FEEDS.BTC.address,
      MARKET_FEEDS.ETH.address,
    ];

    const refresh = async () => {
      try {
        const res = await conn.getMultipleAccountsInfoAndContext(
          keys,
          "confirmed"
        );
        if (!active) return;
        setErSlot(res.context.slot);
        const [sol, btc, eth] = res.value;
        setPrices({
          SOL: sol ? decodeOracleTick(sol.data) : null,
          BTC: btc ? decodeOracleTick(btc.data) : null,
          ETH: eth ? decodeOracleTick(eth.data) : null,
        });
      } catch {
        // transient RPC blip
      }
    };

    refresh();
    const id = setInterval(refresh, 1000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return { prices, erSlot };
}
