import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig, type ViteUserConfig } from "vitest/config";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const wranglerConfigPath = fileURLToPath(new URL("./wrangler.test.jsonc", import.meta.url));
const migrationsPath = fileURLToPath(new URL("./migrations/d1", import.meta.url));

export default defineConfig(async (): Promise<ViteUserConfig> => {
    const migrations = await readD1Migrations(migrationsPath);
    return {
        root: packageDirectory,
        plugins: [
            cloudflareTest({
                wrangler: { configPath: wranglerConfigPath },
                miniflare: {
                    bindings: {
                        MOBIUS_STANDALONE_TOKEN: "standalone_test_owner_secret_0123456789abcdef",
                        TEST_MIGRATIONS: migrations,
                    },
                },
            }),
        ],
        test: {
            include: ["test/**/*.integration.test.ts"],
            setupFiles: ["./test/apply-migrations.ts"],
            testTimeout: 15_000,
        },
    };
});
