import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig, type ViteUserConfig } from "vitest/config";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const wranglerConfigPath = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
const migrationsPath = fileURLToPath(new URL("../relay-core/migrations/d1", import.meta.url));

export default defineConfig(async (): Promise<ViteUserConfig> => {
    const migrations = await readD1Migrations(migrationsPath);
    const legacyAgentCatalogMigration = migrations.find(
        (migration) => migration.name === "0016_normalize_legacy_agent_catalogs.sql",
    );
    if (legacyAgentCatalogMigration === undefined) {
        throw new Error("The legacy Agent catalog migration is missing");
    }

    return {
        root: packageDirectory,
        plugins: [
            cloudflareTest({
                wrangler: { configPath: wranglerConfigPath },
                miniflare: {
                    outboundService: "test-oidc-provider",
                    workers: [
                        {
                            name: "test-oidc-provider",
                            modules: true,
                            scriptPath: fileURLToPath(new URL("./test/fixtures/oidc-provider.js", import.meta.url)),
                            compatibilityDate: "2026-09-03",
                        },
                    ],
                    bindings: {
                        PUBLIC_PROJECT_BOOTSTRAP_CLIENT_LIMIT: "100000",
                        PUBLIC_PROJECT_BOOTSTRAP_TOTAL_LIMIT: "100000",
                        SESSION_ACTIVE_SESSIONS_PER_PROJECT: "2",
                        SESSION_ARCHIVE_BYTES_PER_SESSION: "16384",
                        TEST_LEGACY_AGENT_CATALOG_MIGRATION: legacyAgentCatalogMigration.queries,
                        TEST_MIGRATIONS: migrations,
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
                reportsDirectory: "../../coverage/standalone",
                reportOnFailure: true,
                include: ["src/**/*.{ts,tsx}"],
                exclude: ["**/*.d.ts", "**/testing/**"],
            },
        },
    };
});
