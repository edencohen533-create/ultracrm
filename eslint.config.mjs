import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".qa-local/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
  ]),
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs}"],
    rules: {
      // Syncing local state from fetched/props data inside effects is intentional here.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
