import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { build } from "esbuild";
import { defineConfig, type ViteUserConfig } from "vitest/config";
import { unstable_getMiniflareWorkerOptions, unstable_readConfig } from "wrangler";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const wranglerConfigPath = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
const platformMigrationsPath = fileURLToPath(new URL("./migrations/d1", import.meta.url));
const recordingConfigPath = fileURLToPath(new URL("../recording-cloudflare/wrangler.jsonc", import.meta.url));

/** An auxiliary Miniflare Worker as accepted by the Cloudflare Vitest plugin. */
type AuxiliaryWorkerOptions = NonNullable<
    NonNullable<Extract<Parameters<typeof cloudflareTest>[0], { miniflare?: unknown }>["miniflare"]>["workers"]
>[number];

/**
 * Builds the real Recording Worker beside the Platform runner, so the Platform
 * `RECORDING` service binding resolves to a working provider and policy
 * scenarios exercise actual durable recording.
 */
async function recordingWorkerOptions(): Promise<AuxiliaryWorkerOptions> {
    const config = unstable_readConfig({ config: recordingConfigPath });
    const { workerOptions, main } = unstable_getMiniflareWorkerOptions(config);
    // The Worker is bundled below, so Wrangler's source module rules do not apply.
    const { modulesRules: _recordingModulesRules, ...recordingBindings } = workerOptions;
    const entryPoint = main ?? config.main;
    const workerName = config.name ?? config.topLevelName;
    if (entryPoint === undefined || workerName === undefined) {
        throw new Error("The Recording Worker configuration is incomplete");
    }
    const bundle = await build({
        entryPoints: [entryPoint],
        bundle: true,
        external: ["cloudflare:workers"],
        format: "esm",
        platform: "browser",
        write: false,
    });
    const output = bundle.outputFiles?.[0];
    if (output === undefined) {
        throw new Error("Expected the Recording Worker bundle");
    }
    return {
        ...recordingBindings,
        modules: true,
        name: workerName,
        script: output.text,
    };
}

export default defineConfig(async (): Promise<ViteUserConfig> => {
    const platformMigrations = await readD1Migrations(platformMigrationsPath);
    const recording = await recordingWorkerOptions();

    return {
        root: packageDirectory,
        plugins: [
            cloudflareTest({
                wrangler: { configPath: wranglerConfigPath },
                miniflare: {
                    // Legacy data can outlive the deployment that stopped trusting it.
                    kvNamespaces: ["APP_CREDENTIAL_CACHE"],
                    d1Databases: ["TEST_UNINITIALIZED_SHARD", "TEST_CREDENTIAL_USAGE_DATABASE"],
                    r2Buckets: ["R2_BUCKET_WNAM"],
                    bindings: {
                        MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
                        MOBIUS_PLATFORM_ALLOWED_ORIGINS: '["*"]',
                        MOBIUS_PLATFORM_OIDC_PROVIDERS: "[]",
                        MOBIUS_PLATFORM_OPERATOR_SUBJECTS: "[]",
                        TEST_PLATFORM_MIGRATIONS: platformMigrations,
                    },
                    workers: [recording],
                },
            }),
        ],
        test: {
            include: ["test/**/*.integration.test.ts"],
            setupFiles: ["./test/apply-migrations.ts"],
            // CI runs this suite alongside nine other matrix jobs (see .github/workflows/ci.yml),
            // so shared-runner contention can slow the ~200-round-trip WebSocket replay test well
            // beyond the default budget even though it normally finishes in a couple of seconds.
            testTimeout: 30_000,
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
