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
        fileParallelism: false,
        hookTimeout: 40_000,
        include: ["test/**/*.integration.test.tsx"],
        testTimeout: 15_000,
    },
});
