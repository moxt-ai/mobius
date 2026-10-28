import { fileURLToPath, URL as NodeURL } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare, WebSocketPair, Response as WorkerResponse } from "miniflare";

type TestPlatformBindings = {
    readonly PLATFORM_DIRECTORY_DATABASE: D1Database;
    readonly R2_BUCKET_APAC: R2Bucket;
    readonly R2_BUCKET_WNAM: R2Bucket;
};

import { miniflareDurableObjects } from "./miniflare-durable-objects.ts";

export { convertV4MiniflareOptions, Miniflare, miniflareDurableObjects, WebSocketPair, WorkerResponse };

/** Prepare once per suite run; only immutable code is shared, never a runtime or its storage. */
export async function prepareTestMobiusPlatformBindings() {
    const bundle = await build({
        entryPoints: [fileURLToPath(new NodeURL("./platform-worker-entry.ts", import.meta.url))],
        bundle: true,
        external: ["cloudflare:workers"],
        format: "esm",
        platform: "browser",
        write: false,
    });
    const output = bundle.outputFiles[0];
    if (output === undefined) {
        throw new Error("Expected the Platform Worker bundle");
    }
    const script = output.text;
    return (allowedOrigins: ReadonlySet<string> = new Set(["*"])) => createPlatformBindings(script, allowedOrigins);
}

/** Owns the real Cloudflare adapters for Runtime/Worker integration scenarios. */
function createCloudflareRuntime(script: string, allowedOrigins: ReadonlySet<string>) {
    const packageDirectory = new NodeURL("../../relay-cloudflare-platform/", import.meta.url);
    const runtime = new Miniflare(
        convertV4MiniflareOptions({
            modules: true,
            script,
            compatibilityDate: "2026-09-03",
            d1Databases: ["PLATFORM_DIRECTORY_DATABASE"],
            r2Buckets: ["R2_BUCKET_APAC", "R2_BUCKET_WNAM"],
            bindings: {
                MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
                MOBIUS_PLATFORM_ALLOWED_ORIGINS: JSON.stringify([...allowedOrigins]),
                MOBIUS_PLATFORM_OIDC_PROVIDERS: "[]",
                MOBIUS_PLATFORM_OPERATOR_SUBJECTS: "[]",
            },
            durableObjects: miniflareDurableObjects(new NodeURL("wrangler.jsonc", packageDirectory)),
        }),
    );
    return runtime;
}

async function migrate(database: D1Database, directory: NodeURL) {
    for (const migration of await readD1Migrations(fileURLToPath(directory))) {
        await database.batch(migration.queries.map((query) => database.prepare(query)));
    }
}

export async function createTestMobiusPlatformBindings(allowedOrigins: ReadonlySet<string> = new Set(["*"])) {
    const createBindings = await prepareTestMobiusPlatformBindings();
    return createBindings(allowedOrigins);
}

async function createPlatformBindings(script: string, allowedOrigins: ReadonlySet<string>) {
    const runtime = createCloudflareRuntime(script, allowedOrigins);
    try {
        const ready = await runtime.ready;
        const env = await runtime.getBindings<TestPlatformBindings>();
        await migrate(
            env.PLATFORM_DIRECTORY_DATABASE,
            new NodeURL("../../relay-cloudflare-platform/migrations/d1", import.meta.url),
        );
        const request = async (input: Request): Promise<Response> => {
            const body = input.body === null ? undefined : await input.arrayBuffer();
            const result = await runtime.dispatchFetch(input.url, {
                method: input.method,
                headers: Object.fromEntries(input.headers),
                ...(body === undefined ? {} : { body }),
            });
            const hasBody = result.status !== 204 && result.status !== 205 && result.status !== 304;
            return new Response(hasBody ? await result.arrayBuffer() : null, {
                status: result.status,
                statusText: result.statusText,
                headers: Object.fromEntries(result.headers),
            });
        };
        return { env, origin: ready.origin, request, [Symbol.asyncDispose]: () => runtime.dispose() };
    } catch (cause) {
        await runtime.dispose();
        throw cause;
    }
}
