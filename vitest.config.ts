import { fileURLToPath } from "node:url";
import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./packages/web-core/src", import.meta.url)),
        },
    },
    test: {
        fileParallelism: false,
        include: [
            "tests/**/*.integration.test.ts",
            "packages/*/tests/**/*.contract.test.ts",
            "packages/*/tests/**/*.integration.test.ts",
            "e2e/**/*.e2e.test.ts",
        ],
        testTimeout: 15_000,
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov"],
            include: ["packages/*/src/**/*.ts"],
            exclude: ["packages/*/src/testing/**", "packages/*/tests/**", ...coverageConfigDefaults.exclude],
        },
    },
});
