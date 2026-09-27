import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep isolated QA builds separate from an existing developer server.
  ...(process.env.QA_LOCAL === "1" ? { distDir: ".qa-local/next" } : {}),
  // Load-test server builds to its own folder so development builds never replace it mid-run.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
