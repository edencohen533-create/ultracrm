import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
        // Compatible baseline; script nonces require a separate CSP rollout for Meta and WebRTC.
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
      ] },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      // The sandbox payment page is shown inside the CRM's own call screen (same origin only; no card fields on it).
      { source: "/pay/sandbox/:path*", headers: [
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" },
      ] },
    ];
  },
  // Keep isolated QA builds separate from an existing developer server.
  ...(process.env.QA_LOCAL === "1" ? { distDir: ".qa-local/next" } : {}),
  // Load-test server builds to its own folder so development builds never replace it mid-run.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
