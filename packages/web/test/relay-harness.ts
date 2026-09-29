import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createTestHarness, type TestHarness, unstable_splitSqlQuery } from "wrangler";
import { MIGRATION_WORKER_HOST, MIGRATION_WORKER_NAME } from "./d1-migration-contract.ts";
import migrationWorker from "./d1-migration-worker.ts";

const DIRECTORY_DATABASE_BINDING = "DIRECTORY_DATABASE";
const MIGRATION_PATH = "/apply";

function findRepositoryRoot(start: string): string {
    let candidate = resolve(start);
    while (!existsSync(join(candidate, "pnpm-workspace.yaml"))) {
        const parent = dirname(candidate);
        if (parent === candidate) {
            throw new Error("Could not locate the Mobius repository root");
        }
        candidate = parent;
    }
    return candidate;
}

async function readMigrationQueries(repositoryRoot: string): Promise<string[]> {
    const migrationDirectory = join(repositoryRoot, "packages/relay-core/migrations/d1");
    const names = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
    if (names.length === 0) {
        throw new Error("The Web integration harness found no D1 migrations");
    }
    const migrations = await Promise.all(
        names.map(async (name) => await readFile(join(migrationDirectory, name), "utf8")),
    );
    return migrations.flatMap((migration) => unstable_splitSqlQuery(migration));
}

async function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal, timeoutMessage: string): Promise<T> {
    return await new Promise<T>((resolvePromise, rejectPromise) => {
        const cleanup = (): void => {
            signal.removeEventListener("abort", handleAbort);
        };
        const handleAbort = (): void => {
            cleanup();
            rejectPromise(new Error(timeoutMessage));
        };
        signal.addEventListener("abort", handleAbort, { once: true });
        void operation.then(
            (value) => {
                cleanup();
                resolvePromise(value);
            },
            (error: unknown) => {
                cleanup();
                rejectPromise(error);
            },
        );
    });
}

async function applyMigrations(harness: TestHarness, token: string, queries: readonly string[]): Promise<void> {
    const response = await harness.fetch(new URL(MIGRATION_PATH, `http://${MIGRATION_WORKER_HOST}`), {
        body: JSON.stringify({ queries }),
        headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 204) {
        throw new Error(
            `The Web integration harness could not apply D1 migrations: ${response.status.toString()} ${await response.text()}`,
        );
    }
}

export interface LocalRelay {
    readonly close: () => Promise<void>;
    readonly evictRuntime: (channelId: string) => Promise<void>;
    readonly url: URL;
}

export async function startLocalRelay(): Promise<LocalRelay> {
    if (typeof migrationWorker.fetch !== "function") {
        throw new Error("The Web integration migration Worker is invalid");
    }
    const repositoryRoot = findRepositoryRoot(process.cwd());
    const migrationQueries = await readMigrationQueries(repositoryRoot);
    const migrationToken = crypto.randomUUID();
    const harness = createTestHarness({
        root: repositoryRoot,
        workers: [
            {
                configPath: "packages/relay-cloudflare-standalone/wrangler.jsonc",
                vars: { PUBLIC_PROJECT_BOOTSTRAP_CLIENT_LIMIT: "100" },
            },
            {
                configPath: "packages/recording-cloudflare/wrangler.jsonc",
            },
            {
                config: {
                    compatibility_date: "2026-09-03",
                    d1_databases: [{ binding: DIRECTORY_DATABASE_BINDING }],
                    main: join(repositoryRoot, "packages/web/test/d1-migration-worker.ts"),
                    name: MIGRATION_WORKER_NAME,
                    routes: [`${MIGRATION_WORKER_HOST}/*`],
                    vars: { MIGRATION_TOKEN: migrationToken },
                },
            },
        ],
    });

    try {
        const listening = await waitForOperation(
            harness.listen(),
            AbortSignal.timeout(30_000),
            "The Cloudflare integration harness did not start in time",
        );
        await applyMigrations(harness, migrationToken, migrationQueries);
        return {
            close: async () => {
                await harness.close();
            },
            evictRuntime: async (channelId) => {
                await harness.getWorker().evictDurableObject("RUNTIME_RELAY", {
                    name: channelId,
                    webSockets: "close",
                });
            },
            url: listening.url,
        };
    } catch (error) {
        await harness.close();
        throw error;
    }
}
