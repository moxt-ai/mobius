import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { build } from "esbuild";
import { defineConfig, type ViteUserConfig } from "vitest/config";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const wranglerConfigPath = fileURLToPath(new URL("./wrangler.test.jsonc", import.meta.url));
const migrationsPath = fileURLToPath(new URL("./migrations/d1", import.meta.url));
const recordingWorkerPath = fileURLToPath(new URL("../recording-cloudflare/src/worker.ts", import.meta.url));

/**
 * Bundles the production Recording Worker so the Standalone integration boundary keeps the real
 * Relay-to-Recording service binding instead of replacing it with a fake.
 */
async function bundleRecordingWorker(): Promise<string> {
    const bundle = await build({
        bundle: true,
        entryPoints: [recordingWorkerPath],
        external: ["cloudflare:workers"],
        format: "esm",
        platform: "browser",
        write: false,
    });
    const output = bundle.outputFiles[0];
    if (output === undefined) {
        throw new Error("The Recording Worker bundle is required");
    }
    return output.text;
}

export default defineConfig(async (): Promise<ViteUserConfig> => {
    const [migrations, recordingWorker] = await Promise.all([
        readD1Migrations(migrationsPath),
        bundleRecordingWorker(),
    ]);
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
                    // The production Recording Worker runs as its own Worker behind the `RECORDING` service
                    // binding, so the integration boundary keeps the real Relay-to-Recording round trip.
                    workers: [
                        {
                            name: "mobius-recording-test",
                            modules: [{ type: "ESModule", path: "recording-worker.mjs", contents: recordingWorker }],
                            mainModule: "recording-worker.mjs",
                            durableObjects: {
                                SESSION_RECORDING: {
                                    className: "SessionRecordingDurableObject",
                                    useSQLite: true,
                                },
                                RECORDING_DIRECTORY: {
                                    className: "RecordingDirectoryDurableObject",
                                    useSQLite: true,
                                },
                            },
                        },
                    ],
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
