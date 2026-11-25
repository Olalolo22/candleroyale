import { ImageResponse } from "next/og";
import { getRoomSummary } from "@/lib/roomSummary";
import { loadOgFonts, OG_SIZE, RoomCard } from "@/lib/ogCard";

export const alt = "A CandleRoyale room: market, stake, seats and pot";
export const size = OG_SIZE;
export const contentType = "image/png";
// Seats and pot change; let shared links refresh their card every 30s
export const revalidate = 30;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [summary, fonts] = await Promise.all([getRoomSummary(id), loadOgFonts()]);
  return new ImageResponse(<RoomCard s={summary} />, { ...OG_SIZE, fonts });
}
