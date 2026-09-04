import { fileURLToPath } from "node:url";
import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./packages/web/src", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/tests/**/*.test.ts", "e2e/**/*.test.ts"],
    testTimeout: 5_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/*/src/testing/**",
        "packages/*/tests/**",
        ...coverageConfigDefaults.exclude,
      ],
    },
  },
});
