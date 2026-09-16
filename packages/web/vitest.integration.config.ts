import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const packageDirectory = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("../web-core/src", import.meta.url)),
        },
    },
    root: packageDirectory,
    test: {
        environment: "happy-dom",
        environmentOptions: {
            happyDOM: {
                url: "http://127.0.0.1/",
            },
        },
        fileParallelism: true,
        maxWorkers: 4,
        hookTimeout: 40_000,
        include: ["test/**/*.integration.test.tsx", "test/**/*.e2e.test.tsx"],
        testTimeout: 45_000,
        coverage: {
            provider: "istanbul",
            allowExternal: true,
            reporter: ["text-summary", "json"],
            reportsDirectory: "../../coverage/web",
            reportOnFailure: true,
            include: ["src/**/*.{ts,tsx}", "../web-core/src/**/*.{ts,tsx}"],
            exclude: ["**/*.d.ts", "**/testing/**"],
        },
    },
});
