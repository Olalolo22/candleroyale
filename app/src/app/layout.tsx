import type { Metadata, Viewport } from "next";
import { WalletProvider } from "@/lib/wallet";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: "#0f1a30",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const SITE_DESCRIPTION =
  "60-second trading battles for up to six players. Pick long or short on live SOL, BTC or ETH; the best score takes the pot. Gasless trades on MagicBlock, stakes on Solana Devnet.";

export const metadata: Metadata = {
  title: {
    default: "CandleRoyale: 60-second trading battles on Solana",
    template: "%s | CandleRoyale",
  },
  description: SITE_DESCRIPTION,
  openGraph: {
    title: "CandleRoyale: 60-second trading battles on Solana",
    description: SITE_DESCRIPTION,
    siteName: "CandleRoyale",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Big+Shoulders+Display:wght@700;800;900&family=JetBrains+Mono:wght@500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
