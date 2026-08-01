import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin turbopack root to this package (avoids picking a parent lockfile).
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
