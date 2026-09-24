import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep isolated QA builds separate from an existing developer server.
  ...(process.env.QA_LOCAL === "1" ? { distDir: ".qa-local/next" } : {}),
};

export default nextConfig;
