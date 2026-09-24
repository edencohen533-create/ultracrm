import { defineConfig } from "vitest/config";
import path from "node:path";

/** Integration tests run against the DATABASE_URL in .env (an isolated UltraCRM database). */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { include: ["tests/integration/**/*.test.ts"], environment: "node", testTimeout: 120000, hookTimeout: 60000, fileParallelism: false, setupFiles: ["./tests/integration/setup.ts"] },
});
