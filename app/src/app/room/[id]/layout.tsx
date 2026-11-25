import type { Metadata } from "next";
import { getRoomSummary, roomCopy } from "@/lib/roomSummary";

// Per-room link preview text. The card image comes from ./opengraph-image.tsx.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { title, description } = roomCopy(await getRoomSummary(id));
  return {
    title,
    description,
    openGraph: { title, description, type: "website", siteName: "CandleRoyale" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default function RoomLayout({ children }: { children: React.ReactNode }) {
  return children;
}
