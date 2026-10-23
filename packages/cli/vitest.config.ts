import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        fileParallelism: true,
        include: [
            "tests/{sessions,runtime,manual}/**/*.{contract,integration}.test.ts",
            "tests/agents/**/*.integration.test.ts",
        ],
        testTimeout: 120_000,
        coverage: {
            provider: "istanbul",
            reporter: ["text-summary", "json"],
            reportsDirectory: "coverage/agent-daemon",
            reportOnFailure: true,
            include: ["src/**/*.{ts,tsx}"],
            exclude: ["src/testing/**"],
        },
    },
});
