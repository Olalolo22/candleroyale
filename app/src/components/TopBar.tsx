"use client";

import React, { useEffect, useState } from "react";
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
import { badgeFor, shortKey } from "@/lib/pit";
import { CANDLEROYALE_PROGRAM_ID } from "@sdk/constants";

const WALLETS: { kind: WalletKind; name: string; note: string }[] = [
  { kind: "phantom", name: "Phantom", note: "Recommended" },
  { kind: "solflare", name: "Solflare", note: "Browser extension" },
  { kind: "backpack", name: "Backpack", note: "Browser extension" },
];

function BrandMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <rect x="5.2" y="2" width="2" height="22" rx="1" fill="#2BD67B" />
      <rect x="2" y="7" width="8.4" height="11" rx="1.5" fill="#2BD67B" />
      <rect x="18.8" y="1" width="2" height="21" rx="1" fill="#FF5A4E" />
      <rect x="15.6" y="5" width="8.4" height="9" rx="1.5" fill="#FF5A4E" />
    </svg>
  );
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

  // Escape closes the wallet sheet
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen, closeModal]);

  const handleConnect = async (kind: WalletKind) => {
    setConnectErr(null);
    try {
      await connect(kind);
    } catch (err: unknown) {
      setConnectErr(
        err instanceof Error
          ? err.message
          : "That wallet didn't connect. Check it's installed and set to Devnet."
      );
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
        <Link href="/" className="brand" aria-label="CandleRoyale home">
          <BrandMark />
          <span className="brand-name">
            Candle<b>Royale</b>
          </span>
        </Link>

        <div className="topbar-right">
          <a
            href={`https://explorer.solana.com/address/${CANDLEROYALE_PROGRAM_ID.toBase58()}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="net-status"
            title={
              erSlot
                ? `MagicBlock rollup is live at slot ${erSlot.toLocaleString()}`
                : "Connecting to the MagicBlock rollup"
            }
          >
            <span className={`net-dot ${erSlot ? "" : "stale"}`} />
            <span className="net-label">
              {erSlot ? `Devnet slot ${erSlot.toLocaleString()}` : "Connecting…"}
            </span>
          </a>

          <button
            type="button"
            className="btn btn-quiet btn-icon"
            onClick={() => setSfxOn(pitAudio.toggle())}
            aria-label={sfxOn ? "Mute sound effects" : "Turn on sound effects"}
            aria-pressed={sfxOn}
          >
            {sfxOn ? <Volume2 size={17} /> : <VolumeX size={17} />}
          </button>

          {connected && publicKey ? (
            <div className="wallet-chip">
              <span
                className="badge"
                style={{ minWidth: 40, height: 24, fontSize: "0.9rem" }}
                aria-hidden="true"
              >
                {badgeFor(publicKey)}
              </span>
              <span className="addr">{shortKey(publicKey.toBase58())}</span>
              <span className="bal">
                {balanceSol !== null ? `${balanceSol.toFixed(3)} SOL` : "…"}
              </span>
              <button
                type="button"
                className="btn btn-quiet btn-icon btn-sm copy-btn"
                style={{ width: 30 }}
                onClick={handleCopy}
                aria-label="Copy wallet address"
              >
                {copiedAddr ? <Check size={14} color="#2bd67b" /> : <Copy size={14} />}
              </button>
              <button
                type="button"
                className="btn btn-quiet btn-icon btn-sm"
                style={{ width: 30 }}
                onClick={() => disconnect()}
                aria-label={`Disconnect ${walletLabel ?? "wallet"}`}
              >
                <LogOut size={14} />
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
              <Wallet size={16} />
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>
      </header>

      {modalOpen && (
        <div
          className="overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wallet-modal-title"
          >
            <div className="modal-head">
              <h2 id="wallet-modal-title">Connect a wallet</h2>
              <button
                type="button"
                className="btn btn-quiet btn-icon"
                onClick={closeModal}
                aria-label="Close"
              >
                <X size={17} />
              </button>
            </div>

            <p className="modal-lead">
              You approve once to put your stake in the room. After that, every
              trade is signed by a temporary key in this tab, so no more popups
              and no gas.
            </p>

            {connectErr && <div className="banner error">{connectErr}</div>}

            <div className="wallet-list">
              {WALLETS.map((w) => (
                <button
                  key={w.kind}
                  type="button"
                  className="wallet-opt"
                  onClick={() => handleConnect(w.kind)}
                >
                  <span>{w.name}</span>
                  <span>{w.note}</span>
                </button>
              ))}
              <button
                type="button"
                className="wallet-opt burner"
                onClick={() => handleConnect("burner")}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <KeyRound size={16} color="#ffc928" />
                  Devnet burner
                </span>
                <span>Best for a second tab</span>
              </button>
            </div>

            <div className="modal-foot">
              <span>Need Devnet SOL?</span>
              <a
                href="https://faucet.solana.com"
                target="_blank"
                rel="noreferrer"
                onClick={() => setTimeout(refreshBalance, 4000)}
              >
                Get some from the faucet <ExternalLink size={13} />
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
