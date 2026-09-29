import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, type ViteUserConfig } from "vitest/config";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const wranglerConfigPath = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));

export default defineConfig(
    async (): Promise<ViteUserConfig> => ({
        root: packageDirectory,
        plugins: [cloudflareTest({ wrangler: { configPath: wranglerConfigPath } })],
        test: {
            include: ["test/**/*.integration.test.ts"],
            testTimeout: 15_000,
        },
    }),
);
