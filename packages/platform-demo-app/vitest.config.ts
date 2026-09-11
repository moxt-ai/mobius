import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const wranglerConfigPath = fileURLToPath(new URL("../relay-cloudflare-platform/wrangler.demo.jsonc", import.meta.url));
const projectMigrationsPath = fileURLToPath(new URL("../relay-cloudflare/migrations/d1", import.meta.url));
const platformMigrationsPath = fileURLToPath(new URL("../relay-cloudflare-platform/migrations/d1", import.meta.url));

export default defineConfig(async () => {
    const projectMigrations = await readD1Migrations(projectMigrationsPath);
    const platformMigrations = await readD1Migrations(platformMigrationsPath);

    return {
        root: packageDirectory,
        plugins: [
            cloudflareTest({
                wrangler: { configPath: wranglerConfigPath },
                miniflare: {
                    bindings: {
                        MOBIUS_DEMO_ALLOWED_ORIGIN: "http://127.0.0.1:5190",
                        MOBIUS_DEMO_DEVELOPER_TOKEN: "developer-token-developer-token-32",
                        SESSION_ACTIVE_SESSIONS_PER_PROJECT: "8",
                        SESSION_ARCHIVE_BYTES_PER_SESSION: "16384",
                        TEST_PLATFORM_MIGRATIONS: platformMigrations,
                        TEST_PROJECT_MIGRATIONS: projectMigrations,
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
