import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        exclude: [...configDefaults.exclude, "packages/cli/tests/**"],
        fileParallelism: true,
        maxWorkers: 4,
        include: ["packages/*/tests/**/*.contract.test.ts", "packages/*/tests/**/*.integration.test.ts"],
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
