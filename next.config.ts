import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@earendil-works/pi-coding-agent"],
  turbopack: {
    root: process.cwd()
  }
};

export default nextConfig;
