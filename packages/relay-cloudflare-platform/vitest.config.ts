import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig, type ViteUserConfig } from "vitest/config";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const wranglerConfigPath = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
const projectMigrationsPath = fileURLToPath(new URL("../relay-core/migrations/d1", import.meta.url));
const platformMigrationsPath = fileURLToPath(new URL("./migrations/dashboard", import.meta.url));
const shardingMigrationsPath = fileURLToPath(new URL("./migrations/sharding", import.meta.url));

export default defineConfig(async (): Promise<ViteUserConfig> => {
    const projectMigrations = await readD1Migrations(projectMigrationsPath);
    const platformMigrations = await readD1Migrations(platformMigrationsPath);
    const shardingMigrations = await readD1Migrations(shardingMigrationsPath);

    return {
        root: packageDirectory,
        plugins: [
            cloudflareTest({
                wrangler: { configPath: wranglerConfigPath },
                miniflare: {
                    d1Databases: ["TEST_UNINITIALIZED_SHARD", "D1_SHARD_WNAM_01"],
                    r2Buckets: ["R2_BUCKET_WNAM"],
                    bindings: {
                        SESSION_ACTIVE_SESSIONS_PER_PROJECT: "8",
                        SESSION_ARCHIVE_BYTES_PER_SESSION: "16384",
                        TEST_PLATFORM_MIGRATIONS: platformMigrations,
                        TEST_PROJECT_MIGRATIONS: projectMigrations,
                        TEST_SHARDING_MIGRATIONS: shardingMigrations,
                    },
                },
            }),
        ],
        test: {
            include: ["test/**/*.integration.test.ts"],
            setupFiles: ["./test/apply-migrations.ts"],
            testTimeout: 15_000,
            coverage: {
                provider: "istanbul",
                reporter: ["text-summary", "json"],
                reportsDirectory: "../../coverage/platform",
                reportOnFailure: true,
                include: ["src/**/*.{ts,tsx}"],
                exclude: ["**/*.d.ts", "**/testing/**"],
            },
        },
    };
});
