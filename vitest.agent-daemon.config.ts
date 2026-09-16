import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        fileParallelism: false,
        include: ["tests/agent-daemon/cases/**/*.integration.test.ts"],
        testTimeout: 120_000,
    },
});
