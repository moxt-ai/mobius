import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const wranglerConfigPath = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
const migrationsPath = fileURLToPath(new URL("../relay-cloudflare/migrations/d1", import.meta.url));

export default defineConfig(async () => {
    const migrations = await readD1Migrations(migrationsPath);

    return {
        root: packageDirectory,
        plugins: [
            cloudflareTest({
                wrangler: { configPath: wranglerConfigPath },
                miniflare: {
                    bindings: {
                        PUBLIC_PROJECT_BOOTSTRAP_CLIENT_LIMIT: "100000",
                        PUBLIC_PROJECT_BOOTSTRAP_TENANT_LIMIT: "100000",
                        SESSION_ACTIVE_SESSIONS_PER_PROJECT: "2",
                        SESSION_ACTIVE_SESSIONS_PER_TENANT: "1000",
                        SESSION_ARCHIVE_BYTES_PER_SESSION: "16384",
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
