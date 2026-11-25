import { ImageResponse } from "next/og";
import { HomeCard, loadOgFonts, OG_SIZE } from "@/lib/ogCard";

export const alt = "CandleRoyale: Sixty seconds. Call the candle. Take the pot.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(<HomeCard />, { ...OG_SIZE, fonts: await loadOgFonts() });
}
