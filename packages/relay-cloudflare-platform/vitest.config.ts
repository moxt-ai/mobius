import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const wranglerConfigPath = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
const projectMigrationsPath = fileURLToPath(new URL("../relay-core/migrations/d1", import.meta.url));
const platformMigrationsPath = fileURLToPath(new URL("./migrations/d1", import.meta.url));

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
