import { fileURLToPath } from "node:url";
import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./packages/web/src", import.meta.url)),
        },
    },
    test: {
        exclude: [...configDefaults.exclude, "tests/agent-daemon/**"],
        fileParallelism: true,
        maxWorkers: 4,
        include: [
            "tests/**/*.integration.test.ts",
            "packages/*/tests/**/*.contract.test.ts",
            "packages/*/tests/**/*.integration.test.ts",
            "e2e/**/*.e2e.test.ts",
        ],
        testTimeout: 15_000,
        coverage: {
            provider: "istanbul",
            reporter: ["text-summary", "json"],
            reportsDirectory: "coverage/root",
            reportOnFailure: true,
            include: ["packages/*/src/**/*.{ts,tsx}"],
            exclude: ["packages/*/src/testing/**", "packages/*/tests/**", ...coverageConfigDefaults.exclude],
        },
    },
});
