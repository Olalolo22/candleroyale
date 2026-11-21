"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { SOLANA_L1_RPC } from "@sdk/constants";

export interface BrowserSolanaProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey?: { toBase58(): string };
  connect(opts?: {
    onlyIfTrusted?: boolean;
  }): Promise<{ publicKey: { toBase58(): string } }>;
  disconnect(): Promise<void>;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAndSendTransaction?(
    tx: Transaction,
    opts?: { skipPreflight?: boolean }
  ): Promise<{ signature: string } | string>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
  removeListener?(event: string, cb: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    solana?: BrowserSolanaProvider;
    phantom?: { solana?: BrowserSolanaProvider };
    solflare?: BrowserSolanaProvider;
    backpack?: BrowserSolanaProvider;
  }
}

export type WalletKind = "phantom" | "solflare" | "backpack" | "burner";

const BURNER_STORAGE_KEY = "candleroyale_devnet_burner_v1";

function loadOrCreateBurner(): Keypair {
  if (typeof window === "undefined") return Keypair.generate();
  const saved = window.localStorage.getItem(BURNER_STORAGE_KEY);
  if (saved) {
    try {
      const arr = JSON.parse(saved) as number[];
      if (Array.isArray(arr) && arr.length === 64) {
        return Keypair.fromSecretKey(Uint8Array.from(arr));
      }
    } catch {
      // regenerate below
    }
  }
  const kp = Keypair.generate();
  window.localStorage.setItem(
    BURNER_STORAGE_KEY,
    JSON.stringify(Array.from(kp.secretKey))
  );
  return kp;
}

interface WalletContextValue {
  publicKey: PublicKey | null;
  walletKind: WalletKind | null;
  walletLabel: string | null;
  connected: boolean;
  connecting: boolean;
  balanceSol: number | null;
  modalOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
  connect: (kind: WalletKind) => Promise<void>;
  disconnect: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  sendL1Transaction: (tx: Transaction) => Promise<string>;
  burnerKeypair: Keypair | null;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}

function getInjectedProvider(
  kind: Exclude<WalletKind, "burner">
): BrowserSolanaProvider | null {
  if (typeof window === "undefined") return null;
  if (kind === "phantom") {
    if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
    if (window.solana?.isPhantom) return window.solana;
    return null;
  }
  if (kind === "solflare") {
    return window.solflare ?? null;
  }
  if (kind === "backpack") {
    return window.backpack ?? null;
  }
  return null;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [walletKind, setWalletKind] = useState<WalletKind | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [balanceSol, setBalanceSol] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [burnerKeypair, setBurnerKeypair] = useState<Keypair | null>(null);

  const l1Connection = useMemo(
    () => new Connection(SOLANA_L1_RPC, "confirmed"),
    []
  );

  const refreshBalance = useCallback(async () => {
    if (!publicKey) return;
    try {
      const lamports = await l1Connection.getBalance(publicKey, "confirmed");
      setBalanceSol(lamports / LAMPORTS_PER_SOL);
    } catch {
      // keep previous balance on transient RPC glitch
    }
  }, [l1Connection, publicKey]);

  useEffect(() => {
    if (!publicKey) {
      setBalanceSol(null);
      return;
    }
    refreshBalance();
    const id = setInterval(refreshBalance, 10_000);
    return () => clearInterval(id);
  }, [publicKey, refreshBalance]);

  // Eagerly reconnect Phantom if already trusted
  useEffect(() => {
    const provider = getInjectedProvider("phantom");
    if (!provider) return;
    provider
      .connect({ onlyIfTrusted: true })
      .then((res) => {
        if (res?.publicKey) {
          setPublicKey(new PublicKey(res.publicKey.toBase58()));
          setWalletKind("phantom");
        }
      })
      .catch(() => {});
  }, []);

  const connect = useCallback(async (kind: WalletKind) => {
    setConnecting(true);
    try {
      if (kind === "burner") {
        const kp = loadOrCreateBurner();
        setBurnerKeypair(kp);
        setPublicKey(kp.publicKey);
        setWalletKind("burner");
        setModalOpen(false);
        return;
      }

      const provider = getInjectedProvider(kind);
      if (!provider) {
        throw new Error(
          `${kind[0].toUpperCase() + kind.slice(1)} extension not detected in this browser. Install it or use a Devnet Burner wallet for multi-tab testing.`
        );
      }
      const res = await provider.connect();
      const pk = new PublicKey(res.publicKey.toBase58());
      setPublicKey(pk);
      setWalletKind(kind);
      setModalOpen(false);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (walletKind && walletKind !== "burner") {
      const provider = getInjectedProvider(walletKind);
      try {
        await provider?.disconnect();
      } catch {
        // ignore provider disconnect error
      }
    }
    setPublicKey(null);
    setWalletKind(null);
    setBalanceSol(null);
  }, [walletKind]);

  const sendL1Transaction = useCallback(
    async (tx: Transaction): Promise<string> => {
      if (!publicKey || !walletKind) {
        throw new Error("Connect a Solana Devnet wallet first.");
      }
      const { blockhash, lastValidBlockHeight } =
        await l1Connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      let signature: string;
      if (walletKind === "burner") {
        const kp = burnerKeypair ?? loadOrCreateBurner();
        tx.sign(kp);
        signature = await l1Connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
      } else {
        const provider = getInjectedProvider(walletKind);
        if (!provider) throw new Error("Wallet provider disconnected.");
        if (typeof provider.signTransaction === "function") {
          const signed = await provider.signTransaction(tx);
          signature = await l1Connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
        } else if (typeof provider.signAndSendTransaction === "function") {
          const res = await provider.signAndSendTransaction(tx);
          signature = typeof res === "string" ? res : res.signature;
        } else {
          throw new Error("Wallet does not support transaction signing.");
        }
      }

      await l1Connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      refreshBalance();
      return signature;
    },
    [publicKey, walletKind, burnerKeypair, l1Connection, refreshBalance]
  );

  const walletLabel =
    walletKind === "phantom"
      ? "Phantom"
      : walletKind === "solflare"
        ? "Solflare"
        : walletKind === "backpack"
          ? "Backpack"
          : walletKind === "burner"
            ? "Devnet Burner"
            : null;

  return (
    <WalletContext.Provider
      value={{
        publicKey,
        walletKind,
        walletLabel,
        connected: !!publicKey,
        connecting,
        balanceSol,
        modalOpen,
        openModal: () => setModalOpen(true),
        closeModal: () => setModalOpen(false),
        connect,
        disconnect,
        refreshBalance,
        sendL1Transaction,
        burnerKeypair,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
