"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  LogOut,
  Volume2,
  VolumeX,
  Wallet,
  X,
} from "lucide-react";
import { useWallet, WalletKind } from "@/lib/wallet";
import { pitAudio } from "@/lib/audio";
import { CANDLEROYALE_PROGRAM_ID } from "@sdk/constants";

function shortKey(k: string) {
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

export function TopBar({ erSlot }: { erSlot?: number | null }) {
  const {
    publicKey,
    walletLabel,
    connected,
    connecting,
    balanceSol,
    modalOpen,
    openModal,
    closeModal,
    connect,
    disconnect,
    refreshBalance,
  } = useWallet();

  const [sfxOn, setSfxOn] = useState(() => pitAudio.enabled);
  const [connectErr, setConnectErr] = useState<string | null>(null);
  const [copiedAddr, setCopiedAddr] = useState(false);

  const handleConnect = async (kind: WalletKind) => {
    setConnectErr(null);
    try {
      await connect(kind);
    } catch (err: unknown) {
      setConnectErr(err instanceof Error ? err.message : "Failed to connect wallet");
    }
  };

  const handleCopy = () => {
    if (!publicKey) return;
    navigator.clipboard.writeText(publicKey.toBase58());
    setCopiedAddr(true);
    setTimeout(() => setCopiedAddr(false), 1500);
  };

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <rect x="4" y="2" width="1.6" height="14" rx="0.8" fill="#00D084" />
              <rect x="2.5" y="5" width="4.6" height="7" rx="1" fill="#00D084" />
              <rect x="12.4" y="1" width="1.6" height="15" rx="0.8" fill="#FF4557" />
              <rect x="10.9" y="4" width="4.6" height="6.5" rx="1" fill="#FF4557" />
            </svg>
          </div>
          <span className="brand-name">
            CandleRoyale <span className="brand-tag">Devnet · MagicBlock ER</span>
          </span>
        </Link>

        <div className="topbar-right">
          <a
            href={`https://explorer.solana.com/address/${CANDLEROYALE_PROGRAM_ID.toBase58()}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="net-pill"
            title="Live MagicBlock US Devnet Ephemeral Rollup"
          >
            <span className={`net-dot ${erSlot ? "" : "stale"}`} />
            <span>
              {erSlot ? `ER #${erSlot.toLocaleString()}` : "ER Connecting"}
            </span>
          </a>

          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setSfxOn(pitAudio.toggle())}
            aria-label={sfxOn ? "Mute sound effects" : "Enable sound effects"}
            style={{ width: 38, padding: 0 }}
          >
            {sfxOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
          </button>

          {connected && publicKey ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                type="button"
                className="btn"
                onClick={handleCopy}
                title="Copy connected Devnet address"
              >
                <span className="mono" style={{ fontSize: 12 }}>
                  {shortKey(publicKey.toBase58())}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 12,
                    color: "var(--gold)",
                    paddingLeft: 6,
                    borderLeft: "1px solid var(--border-subtle)",
                  }}
                >
                  {balanceSol !== null ? `${balanceSol.toFixed(3)} SOL` : "…"}
                </span>
                {copiedAddr ? <Check size={13} color="#00d084" /> : <Copy size={13} />}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => disconnect()}
                title={`Disconnect ${walletLabel ?? "wallet"}`}
                style={{ width: 38, padding: 0 }}
              >
                <LogOut size={15} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              id="connect-wallet-btn"
              className="btn btn-primary"
              onClick={openModal}
              disabled={connecting}
            >
              <Wallet size={15} />
              {connecting ? "Connecting…" : "Connect Wallet"}
            </button>
          )}
        </div>
      </header>

      {modalOpen && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div className="modal-card">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 14,
              }}
            >
              <h2 className="display" style={{ margin: 0, fontSize: 19 }}>
                Connect Solana Devnet Wallet
              </h2>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={closeModal}
                style={{ width: 32, height: 32, padding: 0 }}
              >
                <X size={15} />
              </button>
            </div>

            <p
              style={{
                margin: "0 0 16px",
                fontSize: 13,
                lineHeight: 1.5,
                color: "var(--ink-secondary)",
              }}
            >
              Your main wallet signs once on Solana L1 to escrow your stake and bind an
              ephemeral Session Key. All in-round LONG / SHORT / FLAT taps run gasless
              on MagicBlock ER with zero popups.
            </p>

            {connectErr && (
              <div className="status-banner error">{connectErr}</div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                type="button"
                className="btn btn-lg"
                style={{ justifyContent: "space-between" }}
                onClick={() => handleConnect("phantom")}
              >
                <span>Phantom</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                  Recommended
                </span>
              </button>
              <button
                type="button"
                className="btn btn-lg"
                style={{ justifyContent: "space-between" }}
                onClick={() => handleConnect("solflare")}
              >
                <span>Solflare</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                  Extension
                </span>
              </button>
              <button
                type="button"
                className="btn btn-lg"
                style={{ justifyContent: "space-between" }}
                onClick={() => handleConnect("backpack")}
              >
                <span>Backpack</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                  Extension
                </span>
              </button>
              <button
                type="button"
                className="btn btn-lg"
                style={{
                  justifyContent: "space-between",
                  borderStyle: "dashed",
                }}
                onClick={() => handleConnect("burner")}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <KeyRound size={15} color="#f5c451" />
                  Devnet Burner Keypair
                </span>
                <span className="mono" style={{ fontSize: 11, color: "var(--gold)" }}>
                  2-Tab PvP
                </span>
              </button>
            </div>

            <div
              style={{
                marginTop: 16,
                paddingTop: 14,
                borderTop: "1px solid var(--border-subtle)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 12,
                color: "var(--ink-muted)",
              }}
            >
              <span>Need Devnet SOL?</span>
              <a
                href="https://faucet.solana.com"
                target="_blank"
                rel="noreferrer"
                onClick={() => setTimeout(refreshBalance, 4000)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  color: "var(--gold)",
                }}
              >
                faucet.solana.com <ExternalLink size={12} />
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
