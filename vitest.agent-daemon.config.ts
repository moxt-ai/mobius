import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        fileParallelism: false,
        include: [
            "tests/agent-daemon/controlled-agent/**/*.{contract,integration}.test.ts",
            "tests/agent-daemon/real/**/*.integration.test.ts",
        ],
        testTimeout: 120_000,
        coverage: {
            provider: "istanbul",
            reporter: ["text-summary", "json"],
            reportsDirectory: "coverage/agent-daemon",
            reportOnFailure: true,
            include: ["packages/cli/src/**/*.{ts,tsx}"],
            exclude: ["packages/cli/src/testing/**"],
        },
    },
});
