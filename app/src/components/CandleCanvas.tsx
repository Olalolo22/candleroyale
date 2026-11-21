"use client";

import React, { useEffect, useRef } from "react";
import { CandleBar } from "@/lib/useOracleStream";
import { POS_LONG, POS_SHORT, PositionDir } from "@sdk/constants";

export interface TapMarker {
  ts: number;
  priceUsd: number;
  position: PositionDir;
}

interface CandleCanvasProps {
  candles: CandleBar[];
  livePriceUsd: number | null;
  entryPriceUsd: number | null;
  position: PositionDir;
  symbol: string;
  tapMarkers: TapMarker[];
  erRttMs: number | null;
}

export function CandleCanvas({
  candles,
  livePriceUsd,
  entryPriceUsd,
  position,
  symbol,
  tapMarkers,
  erRttMs,
}: CandleCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const draw = () => {
      const rect = wrap.getBoundingClientRect();
      const width = Math.max(300, Math.floor(rect.width));
      const height = Math.max(240, Math.floor(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.save();
      ctx.scale(dpr, dpr);

      // Clear background
      ctx.fillStyle = "#0C0F14";
      ctx.fillRect(0, 0, width, height);

      const padTop = 64;
      const padBottom = 26;
      const padLeft = 14;
      const padRight = 84;
      const plotW = width - padLeft - padRight;
      const plotH = height - padTop - padBottom;

      if (candles.length === 0 || livePriceUsd === null) {
        ctx.fillStyle = "#5D6676";
        ctx.font = '500 13px "JetBrains Mono", monospace';
        ctx.textAlign = "center";
        ctx.fillText(
          "Subscribing to live MagicBlock Pyth Lazer ER stream…",
          width / 2,
          height / 2
        );
        ctx.restore();
        return;
      }

      // Compute price bounds including active entry line
      let minP = Infinity;
      let maxP = -Infinity;
      for (const c of candles) {
        if (c.low < minP) minP = c.low;
        if (c.high > maxP) maxP = c.high;
      }
      if (entryPriceUsd && entryPriceUsd > 0 && position !== 0) {
        if (entryPriceUsd < minP) minP = entryPriceUsd;
        if (entryPriceUsd > maxP) maxP = entryPriceUsd;
      }
      if (livePriceUsd < minP) minP = livePriceUsd;
      if (livePriceUsd > maxP) maxP = livePriceUsd;

      const rawRange = maxP - minP;
      const minSpan = Math.max(livePriceUsd * 0.00035, 0.002);
      const span = Math.max(rawRange * 1.35, minSpan);
      const mid = (maxP + minP) / 2;
      const lo = mid - span / 2;
      const hi = mid + span / 2;

      const priceToY = (p: number) =>
        padTop + ((hi - p) / (hi - lo)) * plotH;

      // Subtle horizontal reference guides (4 levels)
      ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
      ctx.lineWidth = 1;
      ctx.font = '500 11px "JetBrains Mono", monospace';
      ctx.fillStyle = "#5D6676";
      ctx.textAlign = "left";

      const decimals = livePriceUsd > 1000 ? 2 : 4;
      for (let i = 0; i <= 4; i++) {
        const p = hi - ((hi - lo) * i) / 4;
        const y = Math.round(priceToY(p)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight + 4, y);
        ctx.stroke();
        ctx.fillText(p.toFixed(decimals), width - padRight + 10, y + 4);
      }

      // Draw candlesticks
      const slots = Math.max(candles.length, 28);
      const step = plotW / slots;
      const bodyW = Math.max(4, Math.min(14, step * 0.62));
      const startSlot = slots - candles.length;

      candles.forEach((c, idx) => {
        const cx = padLeft + (startSlot + idx + 0.5) * step;
        const yOpen = priceToY(c.open);
        const yClose = priceToY(c.close);
        const yHigh = priceToY(c.high);
        const yLow = priceToY(c.low);
        const bullish = c.close >= c.open;
        const color = bullish ? "#00D084" : "#FF4557";

        // Wick
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(cx, yHigh);
        ctx.lineTo(cx, yLow);
        ctx.stroke();

        // Body
        const top = Math.min(yOpen, yClose);
        const bodyH = Math.max(2, Math.abs(yClose - yOpen));
        ctx.fillStyle = color;
        ctx.fillRect(cx - bodyW / 2, top, bodyW, bodyH);
      });

      // Draw tap markers aligned to candle buckets
      const firstBucket = candles[0]?.bucketMs ?? 0;
      const lastBucket = candles[candles.length - 1]?.bucketMs ?? 0;
      for (const m of tapMarkers) {
        if (m.ts < firstBucket - 2500) continue;
        const frac =
          lastBucket > firstBucket
            ? Math.min(1, Math.max(0, (m.ts - firstBucket) / (lastBucket - firstBucket)))
            : 1;
        const mx =
          padLeft + (startSlot + frac * Math.max(0, candles.length - 1) + 0.5) * step;
        const my = priceToY(m.priceUsd);

        ctx.save();
        if (m.position === POS_LONG) {
          ctx.fillStyle = "#00D084";
          ctx.beginPath();
          ctx.moveTo(mx, my - 7);
          ctx.lineTo(mx - 5, my + 3);
          ctx.lineTo(mx + 5, my + 3);
          ctx.closePath();
          ctx.fill();
        } else if (m.position === POS_SHORT) {
          ctx.fillStyle = "#FF4557";
          ctx.beginPath();
          ctx.moveTo(mx, my + 7);
          ctx.lineTo(mx - 5, my - 3);
          ctx.lineTo(mx + 5, my - 3);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillStyle = "#94A3B8";
          ctx.beginPath();
          ctx.arc(mx, my, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // Draw Entry Price line if in LONG or SHORT
      if (entryPriceUsd && entryPriceUsd > 0 && position !== 0) {
        const ey = Math.round(priceToY(entryPriceUsd)) + 0.5;
        const entryColor = position === POS_LONG ? "#00D084" : "#FF4557";

        ctx.save();
        ctx.strokeStyle = entryColor;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(padLeft, ey);
        ctx.lineTo(width - padRight, ey);
        ctx.stroke();
        ctx.setLineDash([]);

        // Entry tag on right axis
        ctx.fillStyle = entryColor;
        ctx.fillRect(width - padRight + 4, ey - 9, padRight - 8, 18);
        ctx.fillStyle = position === POS_LONG ? "#032619" : "#2B060B";
        ctx.font = '700 10px "JetBrains Mono", monospace';
        ctx.fillText(
          entryPriceUsd.toFixed(decimals),
          width - padRight + 9,
          ey + 3.5
        );
        ctx.restore();
      }

      // Draw Live Price hairline + pill
      const ly = Math.round(priceToY(livePriceUsd)) + 0.5;
      ctx.save();
      ctx.strokeStyle = "rgba(245, 196, 81, 0.7)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(padLeft, ly);
      ctx.lineTo(width - padRight, ly);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "#F5C451";
      ctx.fillRect(width - padRight + 4, ly - 10, padRight - 8, 20);
      ctx.fillStyle = "#241902";
      ctx.font = '700 11px "JetBrains Mono", monospace';
      ctx.fillText(
        livePriceUsd.toFixed(decimals),
        width - padRight + 9,
        ly + 4
      );
      ctx.restore();

      ctx.restore();
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [candles, livePriceUsd, entryPriceUsd, position, tapMarkers]);

  const decimals = livePriceUsd && livePriceUsd > 1000 ? 2 : 4;

  return (
    <div ref={wrapRef} className="chart-wrap">
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      <div className="chart-overlay-price">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span className="live-price-big">
            {livePriceUsd !== null ? `$${livePriceUsd.toFixed(decimals)}` : "—"}
          </span>
          <span
            className="mono"
            style={{ fontSize: 12, color: "var(--ink-secondary)" }}
          >
            {symbol}
          </span>
        </div>
        <div className="live-price-sub">
          Pyth Lazer on MagicBlock ER · 2.5s candles
          {erRttMs !== null ? ` · ${erRttMs}ms feed` : ""}
        </div>
      </div>
    </div>
  );
}
