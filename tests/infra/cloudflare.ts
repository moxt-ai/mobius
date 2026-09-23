/// <reference types="@cloudflare/workers-types" />
import { fileURLToPath, URL as NodeURL } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare, WebSocketPair, Response as WorkerResponse } from "miniflare";
import type { PlatformRelayBindings } from "./app.ts";
import { miniflareDurableObjects } from "./miniflare-durable-objects.ts";

export { convertV4MiniflareOptions, Miniflare, miniflareDurableObjects, WebSocketPair, WorkerResponse };

/** Owns the real Cloudflare adapters for Runtime/Worker integration scenarios. */
async function createCloudflareRuntime(allowedOrigins: ReadonlySet<string>) {
    const packageDirectory = new NodeURL("../../packages/relay-cloudflare-platform/", import.meta.url);
    const bundle = await build({
        entryPoints: [fileURLToPath(new NodeURL("../../tests/infra/platform-worker-entry.ts", packageDirectory))],
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
    const runtime = new Miniflare(
        convertV4MiniflareOptions({
            modules: true,
            script: output.text,
            compatibilityDate: "2026-09-03",
            d1Databases: ["PLATFORM_DIRECTORY_DATABASE"],
            kvNamespaces: ["APP_CREDENTIAL_CACHE"],
            r2Buckets: ["R2_BUCKET_APAC", "R2_BUCKET_WNAM"],
            bindings: {
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
    const runtime = await createCloudflareRuntime(allowedOrigins);
    try {
        const ready = await runtime.ready;
        const env = await runtime.getBindings<PlatformRelayBindings>();
        await migrate(
            env.PLATFORM_DIRECTORY_DATABASE,
            new NodeURL("../../packages/relay-cloudflare-platform/migrations/d1", import.meta.url),
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
