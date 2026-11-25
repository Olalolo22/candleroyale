import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomSummary } from "@/lib/roomSummary";
import { fmtSol } from "@/lib/pit";

/**
 * Link-preview cards (1200x630) in the app's "open outcry" style, rendered by
 * next/og. Satori supports a CSS subset: every element with more than one
 * child is display:flex, and there are no text outlines.
 */

export const OG_SIZE = { width: 1200, height: 630 };

const C = {
  floor: "#0f1a30",
  board: "#16233f",
  rail: "#24345a",
  railStrong: "#34497a",
  chalk: "#eef1f7",
  slate: "#8c9ab8",
  slateDim: "#5f6d8c",
  jacket: "#ffc928",
  jacketInk: "#2a1f00",
  bull: "#2bd67b",
  bear: "#ff5a4e",
};

const asset = (f: string) => readFile(join(process.cwd(), "assets", f));

export async function loadOgFonts() {
  const [black, extra, medium, semi] = await Promise.all([
    asset("BigShouldersDisplay-Black.ttf"),
    asset("BigShouldersDisplay-ExtraBold.ttf"),
    asset("Archivo-Medium.ttf"),
    asset("Archivo-SemiBold.ttf"),
  ]);
  return [
    { name: "Shoulders", data: black, weight: 900 as const, style: "normal" as const },
    { name: "Shoulders", data: extra, weight: 800 as const, style: "normal" as const },
    { name: "Archivo", data: medium, weight: 500 as const, style: "normal" as const },
    { name: "Archivo", data: semi, weight: 600 as const, style: "normal" as const },
  ];
}

function Brand() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", height: 44 }}>
          <div style={{ width: 3, height: 6, background: C.bull, borderRadius: 2 }} />
          <div style={{ width: 13, height: 24, background: C.bull, borderRadius: 3 }} />
          <div style={{ width: 3, height: 10, background: C.bull, borderRadius: 2 }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", height: 44 }}>
          <div style={{ width: 3, height: 3, background: C.bear, borderRadius: 2 }} />
          <div style={{ width: 13, height: 18, background: C.bear, borderRadius: 3 }} />
          <div style={{ width: 3, height: 14, background: C.bear, borderRadius: 2 }} />
        </div>
      </div>
      <div style={{ display: "flex", fontFamily: "Shoulders", fontWeight: 800, fontSize: 44, color: C.chalk }}>
        <span>Candle</span>
        <span style={{ color: C.jacket }}>Royale</span>
      </div>
      <div
        style={{
          display: "flex",
          marginLeft: 6,
          padding: "4px 12px",
          border: `2px solid ${C.railStrong}`,
          borderRadius: 6,
          color: C.slate,
          fontFamily: "Archivo",
          fontWeight: 600,
          fontSize: 22,
        }}
      >
        Devnet
      </div>
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "56px 64px",
        background: C.floor,
        backgroundImage: `linear-gradient(${C.board} 0%, ${C.floor} 70%)`,
        fontFamily: "Archivo",
        color: C.chalk,
      }}
    >
      {children}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", fontSize: 24, fontWeight: 500, color: C.slate }}>{label}</div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          fontFamily: "Shoulders",
          fontWeight: 800,
          fontSize: 64,
          lineHeight: 1,
          color: accent ?? C.chalk,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Seats({ taken, max }: { taken: number; max: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <span>{`${taken} of ${max}`}</span>
      <div style={{ display: "flex", gap: 5 }}>
        {Array.from({ length: max }).map((_, i) => (
          <div
            key={i}
            style={{ width: 12, height: 30, borderRadius: 3, background: i < taken ? C.chalk : C.railStrong }}
          />
        ))}
      </div>
    </div>
  );
}

function Cta({ s }: { s: RoomSummary }) {
  const base = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "20px 30px",
    borderRadius: 14,
    fontFamily: "Shoulders",
    fontWeight: 800,
    fontSize: 44,
  } as const;
  if (s.phase === "open") {
    return (
      <div style={{ ...base, background: C.jacket, color: C.jacketInk }}>
        {s.entrySol > 0 ? `Join for ${fmtSol(s.entrySol)} SOL` : "Join free"}
      </div>
    );
  }
  if (s.phase === "trading") {
    return (
      <div style={{ ...base, border: `3px solid ${C.bull}`, color: C.bull }}>
        <div style={{ width: 16, height: 16, borderRadius: 8, background: C.bull }} />
        <span>Trading now</span>
      </div>
    );
  }
  if (s.phase === "settled") {
    return (
      <div style={{ ...base, background: C.jacket, color: C.jacketInk }}>
        {s.winners.length > 1 ? `${s.winners.join(" & ")} split the pot` : `${s.winners[0] ?? "Winner"} took the pot`}
      </div>
    );
  }
  return (
    <div style={{ ...base, border: `3px solid ${C.railStrong}`, color: C.slate }}>
      {s.phase === "full" ? "Full, about to start" : "Refunded"}
    </div>
  );
}

export function RoomCard({ s }: { s: RoomSummary | null }) {
  if (!s) {
    return (
      <Frame>
        <Brand />
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", fontFamily: "Shoulders", fontWeight: 900, fontSize: 140, lineHeight: 0.9 }}>
            Join the room
          </div>
          <div style={{ display: "flex", fontSize: 38, color: C.slate }}>
            A 60-second trading battle. Best score takes the pot.
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 28, color: C.slateDim }}>Open the link to see the seats and stake.</div>
      </Frame>
    );
  }

  const price =
    s.priceUsd !== null
      ? `$${s.priceUsd.toLocaleString("en-US", {
          minimumFractionDigits: s.priceDecimals,
          maximumFractionDigits: s.priceDecimals,
        })}`
      : null;

  return (
    <Frame>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Brand />
        {price && (
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span style={{ fontSize: 24, color: C.slate, fontWeight: 500 }}>{`${s.symbol} now`}</span>
            <span style={{ fontFamily: "Shoulders", fontWeight: 800, fontSize: 44, color: C.chalk }}>{price}</span>
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 22 }}>
          <span style={{ fontFamily: "Shoulders", fontWeight: 900, fontSize: 168, lineHeight: 0.86 }}>
            {`${s.symbol} room`}
          </span>
          <span style={{ fontSize: 30, color: C.slateDim, fontWeight: 500 }}>{`#${s.roomCode}`}</span>
        </div>
        <div style={{ display: "flex", fontSize: 36, color: C.slate, fontWeight: 500 }}>
          {`${s.durationSecs}-second trading battle. Best score takes the pot.`}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 56 }}>
          <Stat label="Stake" value={s.entrySol > 0 ? `${fmtSol(s.entrySol)} SOL` : "Free"} />
          <Stat label="Players" value={<Seats taken={s.playerCount} max={s.maxPlayers} />} />
          <Stat label="Pot" value={s.potSol > 0 ? `${fmtSol(s.potSol)} SOL` : "Free"} accent={C.jacket} />
        </div>
        <Cta s={s} />
      </div>
    </Frame>
  );
}

export function HomeCard() {
  return (
    <Frame>
      <Brand />
      <div style={{ display: "flex", flexDirection: "column", fontFamily: "Shoulders", fontWeight: 900, fontSize: 112, lineHeight: 0.92 }}>
        <span>Sixty seconds.</span>
        <span>Call the candle.</span>
        <span style={{ color: C.slateDim }}>Take the pot.</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", fontSize: 32, color: C.slate, fontWeight: 500 }}>
          PvP trading battles on Solana, live on MagicBlock
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {["SOL", "BTC", "ETH"].map((m) => (
            <div
              key={m}
              style={{
                display: "flex",
                padding: "8px 18px",
                borderRadius: 10,
                border: `2px solid ${C.railStrong}`,
                fontFamily: "Shoulders",
                fontWeight: 800,
                fontSize: 36,
                color: C.chalk,
              }}
            >
              {m}
            </div>
          ))}
        </div>
      </div>
    </Frame>
  );
}
