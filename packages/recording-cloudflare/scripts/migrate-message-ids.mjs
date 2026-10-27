// Run with --help. Credentials are read only from environment variables, never command arguments.
import { parseArgs } from "node:util";

const { values } = parseArgs({
    options: {
        environment: { type: "string" },
        endpoint: { type: "string" },
        apply: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
    },
});
if (values.help) {
    console.log(`Usage: node --use-env-proxy scripts/migrate-message-ids.mjs --environment staging|production --endpoint https://<migration-worker> [--apply]

Requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (Workers read), and MIGRATION_TOKEN.
Deploy Recording with migration support first. Set the same MIGRATION_TOKEN secret on
Recording and the helper configured by wrangler.message-id-migration.jsonc.
Without --apply, scans all stored Session DOs without rewriting events. With --apply,
resumes each DO's durable checkpoint until complete; alarms also continue started work.
Live writes remain enabled. Results are a moving inventory, not a global snapshot.
After completion, delete the helper and remove both MIGRATION_TOKEN secrets.`);
    process.exit(0);
}

function required(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing ${name}`);
    }
    return value;
}
const account = required("CLOUDFLARE_ACCOUNT_ID");
const apiToken = required("CLOUDFLARE_API_TOKEN");
const migrationToken = required("MIGRATION_TOKEN");
if (!/^[a-f0-9]{32}$/.test(account)) {
    throw new Error("Invalid account ID");
}
if (values.environment !== "staging" && values.environment !== "production") {
    throw new Error("Explicit --environment staging|production required");
}
const endpoint = new URL(values.endpoint ?? "");
if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
) {
    throw new Error("Endpoint must be an HTTPS origin");
}
const script = `mobius-recording-${values.environment}`;
if (!endpoint.hostname.startsWith(`mobius-recording-message-id-migration-${values.environment}.`)) {
    throw new Error("Endpoint does not match the selected migration environment");
}

const cancellation = new AbortController();
const cancel = () => cancellation.abort(new Error("Migration runner cancelled"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

function record(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Invalid response object");
    }
    return value;
}
function count(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Invalid response count");
    }
    return value;
}
async function json(url, options) {
    const response = await fetch(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(45_000)]),
    });
    const value = record(await response.json());
    if (!response.ok) {
        const error = typeof value.error === "object" && value.error !== null ? value.error : {};
        const code = typeof error.code === "string" && /^[a-z_]+$/.test(error.code) ? error.code : "request_failed";
        throw new Error(`${code} (HTTP ${response.status})`);
    }
    return value;
}
async function cloudflare(path) {
    const value = await json(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
        headers: { authorization: `Bearer ${apiToken}` },
    });
    if (value.success !== true || !Array.isArray(value.result)) {
        throw new Error("Cloudflare inventory failed");
    }
    return value;
}
async function namespace() {
    for (let page = 1; page <= 1000; page++) {
        const result = await cloudflare(`/workers/durable_objects/namespaces?per_page=100&page=${page}`);
        const found = result.result
            .map(record)
            .find((item) => item.script === script && item.class === "SessionRecordingDurableObject");
        if (found) {
            if (typeof found.id !== "string" || !/^[a-f0-9]{32}$/.test(found.id)) {
                throw new Error("Invalid namespace ID");
            }
            return found.id;
        }
        if (result.result.length < 100) {
            break;
        }
    }
    throw new Error("Session Recording namespace not found");
}

const summary = {
    mode: values.apply ? "apply" : "dry-run",
    environment: values.environment,
    inventoried: 0,
    completed: 0,
    failed: 0,
    missingEvents: 0,
    affectedBatches: 0,
    rewrittenEvents: 0,
    rewrittenBatches: 0,
};
try {
    const id = await namespace();
    const seen = new Set();
    let cursor = "";
    for (;;) {
        const result = await cloudflare(
            `/workers/durable_objects/namespaces/${id}/objects?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        for (const entry of result.result.map(record)) {
            if (entry.hasStoredData !== true) {
                continue;
            }
            if (typeof entry.id !== "string" || !/^[a-f0-9]{64}$/.test(entry.id)) {
                throw new Error("Invalid object ID");
            }
            if (seen.has(entry.id)) {
                continue;
            }
            seen.add(entry.id);
            summary.inventoried++;
            try {
                let afterOrdinal = 0;
                for (;;) {
                    const page = await json(new URL(`/sessions/${entry.id}`, endpoint), {
                        method: "POST",
                        headers: { authorization: `Bearer ${migrationToken}`, "content-type": "application/json" },
                        body: JSON.stringify(values.apply ? { mode: "apply" } : { mode: "dry-run", afterOrdinal }),
                    });
                    const throughOrdinal = count(page.throughOrdinal);
                    if (values.apply) {
                        if (page.kind !== "running" && page.kind !== "complete") {
                            throw new Error("Invalid migration status");
                        }
                        if (page.kind === "complete") {
                            summary.rewrittenEvents += count(page.rewrittenEvents);
                            summary.rewrittenBatches += count(page.rewrittenBatches);
                            break;
                        }
                    } else {
                        if (page.kind !== "dry-run" || typeof page.hasMore !== "boolean") {
                            throw new Error("Invalid preview status");
                        }
                        summary.missingEvents += count(page.missingEvents);
                        summary.affectedBatches += count(page.affectedBatches);
                        if (!page.hasMore) {
                            break;
                        }
                    }
                    if (throughOrdinal <= afterOrdinal) {
                        throw new Error("Migration checkpoint did not advance");
                    }
                    afterOrdinal = throughOrdinal;
                }
                summary.completed++;
            } catch (cause) {
                cancellation.signal.throwIfAborted();
                summary.failed++;
                console.error(
                    JSON.stringify({
                        objectId: entry.id,
                        error: cause instanceof Error ? cause.message : "migration_failed",
                    }),
                );
            }
            if (summary.inventoried % 25 === 0) {
                console.log(JSON.stringify(summary));
            }
        }
        const info = record(result.result_info ?? {});
        const next = info.cursor;
        if (!next || result.result.length === 0) {
            break;
        }
        if (typeof next !== "string" || next === cursor) {
            throw new Error("Invalid inventory cursor");
        }
        cursor = next;
    }
    console.log(JSON.stringify(summary));
    if (summary.failed > 0) {
        process.exitCode = 1;
    }
} finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
}
