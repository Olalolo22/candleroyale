import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Link-preview images read their fonts from ./assets at request time
  outputFileTracingIncludes: {
    "/opengraph-image": ["./assets/**/*"],
    "/room/[id]/opengraph-image": ["./assets/**/*"],
  },
};

export default nextConfig;
