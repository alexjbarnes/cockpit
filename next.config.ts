import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: { unoptimized: true },
  allowedDevOrigins: ["192.168.0.39"],
  serverExternalPackages: ["node-pty"],
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
