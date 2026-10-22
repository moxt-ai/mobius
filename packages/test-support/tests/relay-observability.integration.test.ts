import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";

const logs: Record<string, unknown>[] = [];
let runtime: Miniflare;

beforeAll(async () => {
    const bundle = await build({
        entryPoints: [fileURLToPath(new URL("./fixtures/relay-observability-worker.ts", import.meta.url))],
        bundle: true,
        external: ["cloudflare:workers"],
        format: "esm",
        platform: "browser",
        write: false,
        // Use the same JSON boundary as collected production console records.
        banner: {
            js: `for (const level of ["info", "warn", "error", "debug"]) {
                const write = console[level].bind(console);
                console[level] = (...values) => write(...values.map(value => JSON.stringify(value)));
            }`,
        },
    });
    const output = bundle.outputFiles[0];
    if (output === undefined) {
        throw new Error("Expected the observability Worker bundle");
    }
    runtime = new Miniflare(
        convertV4MiniflareOptions({
            modules: true,
            script: output.text,
            compatibilityDate: "2026-09-03",
            durableObjects: {
                RUNTIME_RELAY: { className: "RuntimeRelay", useSQLite: true },
                PROJECT_RELAY: { className: "ProjectDO", useSQLite: true },
                UNAVAILABLE_PROJECT: { className: "UnavailableProject", useSQLite: true },
            },
            d1Databases: ["PLATFORM_DIRECTORY_DATABASE"],
            kvNamespaces: ["APP_CREDENTIAL_CACHE"],
            r2Buckets: ["R2_BUCKET_APAC", "R2_BUCKET_WNAM"],
            bindings: {
                MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
                MOBIUS_PLATFORM_ALLOWED_ORIGINS: '["*"]',
                MOBIUS_PLATFORM_OIDC_PROVIDERS: "[]",
                MOBIUS_PLATFORM_OPERATOR_SUBJECTS: "[]",
            },
            handleStructuredLogs: (log) => {
                const value: unknown = JSON.parse(log.message);
                if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                    logs.push(value as Record<string, unknown>);
                }
            },
        }),
    );
    await runtime.ready;
    const bindings = await runtime.getBindings<{ PLATFORM_DIRECTORY_DATABASE: D1Database }>();
    const directory = fileURLToPath(new URL("../../relay-cloudflare-platform/migrations/d1", import.meta.url));
    for (const migration of await readD1Migrations(directory)) {
        await bindings.PLATFORM_DIRECTORY_DATABASE.batch(
            migration.queries.map((sql) => bindings.PLATFORM_DIRECTORY_DATABASE.prepare(sql)),
        );
    }
});

afterAll(async () => {
    await runtime?.dispose();
    const artifact = process.env["MOBIUS_LOG_E2E_ARTIFACT"];
    if (artifact !== undefined) {
        await mkdir(dirname(artifact), { recursive: true });
        await writeFile(artifact, `${JSON.stringify({ runtime: "workerd", logs }, null, 2)}\n`);
    }
});

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected an API response object");
    }
    return value as Record<string, unknown>;
}

function text(value: unknown, key: string): string {
    const field = record(value)[key];
    if (typeof field !== "string") {
        throw new Error(`Expected ${key}`);
    }
    return field;
}

async function api(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    status: number,
) {
    const response = await runtime.dispatchFetch(`https://relay.test/mobius/api${path}`, {
        ...init,
        headers: {
            authorization: "Bearer test-developer",
            "x-mobius-oidc-provider": "clerk",
            "content-type": "application/json",
            ...init.headers,
        },
    });
    const value: unknown = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(status);
    return record(value);
}

async function provisionApp() {
    const tenants = (await api("/dashboard/v1/platform/tenants", {}, 200))["tenants"];
    if (!Array.isArray(tenants) || tenants.length === 0) {
        throw new Error("Expected a tenant");
    }
    const app = await api(
        "/dashboard/v1/apps",
        {
            method: "POST",
            body: JSON.stringify({
                displayName: `Logging E2E ${crypto.randomUUID()}`,
                tenantId: text(tenants[0], "tenantId"),
            }),
        },
        201,
    );
    return { appId: text(app, "appId"), appCredential: text(app["defaultCredential"], "credential") };
}

async function provisionProject() {
    const app = await provisionApp();
    const project = await api(
        `/dashboard/v1/apps/${app.appId}/projects`,
        {
            method: "POST",
            body: JSON.stringify({
                displayName: "Logging E2E",
                idempotencyKey: "logging-project",
                locationHint: "apac",
            }),
        },
        201,
    );
    return { ...app, projectId: text(project, "projectId") };
}

async function httpFailure(kind: string): Promise<Record<string, unknown>> {
    const start = logs.length;
    const response = await runtime.dispatchFetch(`https://relay.test/failure/${kind}?token=QUERY_CANARY`, {
        method: "POST",
        headers: { authorization: "Bearer HEADER_CANARY", "cf-ray": "logging-test-ray" },
        body: "BODY_CANARY",
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
    await expect.poll(() => logs.slice(start).find((log) => log["msg"] === "Mobius request failed")).toBeDefined();
    const log = logs.slice(start).find((log) => log["msg"] === "Mobius request failed");
    if (log === undefined) {
        throw new Error("Expected a collected HTTP failure log");
    }
    expect(log).toMatchObject({ method: "POST", path: `/failure/${kind}`, cfRay: "logging-test-ray" });
    expect(JSON.stringify(log)).not.toMatch(/QUERY_CANARY|HEADER_CANARY|BODY_CANARY|PROPERTY_CANARY/);
    return log;
}

// @no-uc: Technical regression; Worker Error JSON serialization must retain overload diagnostics.
it("preserves nested error details and Cloudflare overload flags through the Worker HTTP log boundary", async () => {
    const log = await httpFailure("nested");
    expect(log["err"]).toMatchObject({
        name: "Error",
        message: "Runtime relay request failed",
        stack: expect.stringContaining("Runtime relay request failed"),
        cause: {
            message: "Too many requests queued for the same Durable Object",
            stack: expect.stringContaining("Too many requests queued"),
            overloaded: true,
            retryable: true,
            remote: true,
            code: "ERR_OVERLOADED",
        },
    });
});

// @no-uc: Technical regression; unusual throws must not break failure responses or bounded diagnostic collection.
it.each(["primitive", "object", "circular", "deep", "long", "secrets", "getter"])(
    "safely records %s failures",
    async (kind) => {
        const log = await httpFailure(kind);
        const encoded = JSON.stringify(log["err"]);
        expect(encoded.length).toBeLessThan(40_000);
        expect(encoded).not.toMatch(/PASSWORD_CANARY|URL_CANARY|ERROR_CANARY|PROPERTY_CANARY/);
        if (kind === "primitive") {
            expect(log["err"]).toMatchObject({ message: "Non-Error failure" });
        }
        if (kind === "object") {
            expect(log["err"]).toMatchObject({
                name: "RemoteFailure",
                message: "Remote queue exceeded",
                overloaded: true,
            });
        }
    },
);

// @no-uc: Technical regression; a failing DO hop must identify its target rather than only its caller.
it("identifies the failing Runtime Durable Object through the public pairing and connect APIs", async () => {
    const { projectId, appCredential } = await provisionProject();
    const pairing = await api(
        `/v1/projects/${projectId}/runtime-pairings`,
        {
            method: "POST",
            headers: { authorization: `Bearer ${appCredential}` },
            body: JSON.stringify({ idempotencyKey: "logging-runtime" }),
        },
        201,
    );
    const claimed = await api(
        `/v1/runtime-pairings/${text(pairing, "pairingId")}/redeem`,
        {
            method: "POST",
            body: JSON.stringify({
                agents: [],
                machineName: "Logging test",
                workspaceName: "workspace",
                pairingCode: text(pairing, "pairingCode"),
            }),
        },
        200,
    );
    const start = logs.length;
    const response = await runtime.dispatchFetch("https://relay.test/mobius/api/v1/runtimes/connect?liveness=1", {
        headers: {
            authorization: `Bearer ${text(claimed, "runtimeCredential")}`,
            Upgrade: "websocket",
            "x-test-runtime-failure": "1",
            "cf-ray": "runtime-failure-ray",
        },
    });
    expect(response.status).toBe(500);
    await response.text();
    await expect
        .poll(() => logs.slice(start).find((log) => log["event"] === "runtime_relay_request_failed"))
        .toBeDefined();
    expect(logs.slice(start)).toContainEqual(
        expect.objectContaining({
            event: "runtime_relay_request_failed",
            durableObjectId: expect.any(String),
            runtimeId: text(claimed, "runtimeId"),
            channelId: text(pairing, "channelId"),
            projectId,
            path: `/projects/${projectId}/daemon`,
            cfRay: "runtime-failure-ray",
            err: expect.objectContaining({ message: expect.stringContaining("Runtime DO overloaded") }),
        }),
    );
});

// @no-uc: Technical regression; Project routing failures must identify the target DO and retain overload details.
it("identifies a Project Relay overload through the public HTTP API", async () => {
    const start = logs.length;
    const projectId = "prj_ap_01_abcdefghijklmnopqrstuvwx";
    await api(
        `/v1/projects/${projectId}/runtimes`,
        { headers: { "x-test-project-failure": "1", "cf-ray": "project-failure-ray" } },
        500,
    );
    await expect
        .poll(() => logs.slice(start).find((log) => log["event"] === "project_relay_request_failed"))
        .toBeDefined();
    expect(logs.slice(start)).toContainEqual(
        expect.objectContaining({
            event: "project_relay_request_failed",
            durableObjectClass: "ProjectDO",
            durableObjectId: expect.any(String),
            projectId,
            cfRay: "project-failure-ray",
            err: expect.objectContaining({
                overloaded: true,
                message: expect.stringContaining("Project DO overloaded"),
            }),
        }),
    );
});

// @no-uc: Technical regression; database RPC overloads must identify their target without logging SQL or bound values.
it("identifies a Project database overload through the public project creation API", async () => {
    const app = await provisionApp();
    const start = logs.length;
    await api(
        `/dashboard/v1/apps/${app.appId}/projects`,
        {
            method: "POST",
            headers: { "x-test-project-failure": "1" },
            body: JSON.stringify({
                displayName: "PROJECT_BODY_CANARY",
                idempotencyKey: "failed-project",
                locationHint: "apac",
            }),
        },
        500,
    );
    await expect
        .poll(() => logs.slice(start).find((log) => log["event"] === "project_database_request_failed"))
        .toBeDefined();
    const log = logs.slice(start).find((log) => log["event"] === "project_database_request_failed");
    expect(log).toMatchObject({
        event: "project_database_request_failed",
        durableObjectClass: "ProjectDO",
        durableObjectId: expect.any(String),
        projectId: expect.any(String),
        operation: expect.any(String),
        err: expect.objectContaining({ overloaded: true, message: expect.stringContaining("Project DO overloaded") }),
    });
    expect(JSON.stringify(log)).not.toMatch(/PROJECT_BODY_CANARY|INSERT INTO|SELECT|values|authorization/);
});

// @no-uc: Performance; short-lived Host/control sockets must not add routine lifecycle logs.
it("keeps ordinary Host closes quiet after the real platform close callback completes", async () => {
    const response = await runtime.dispatchFetch("https://relay.test/projects/project-logging/host", {
        headers: {
            Upgrade: "websocket",
            "x-mobius-runtime-id": "runtime-logging",
            "x-mobius-channel-id": "channel-logging",
            "x-mobius-host-credential-id": "ctl_HOST_CREDENTIAL_CANARY",
        },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a Host WebSocket");
    }
    const status = new Promise((resolve) =>
        socket.addEventListener("message", (event) => resolve(event.data), { once: true }),
    );
    socket.accept();
    try {
        expect(JSON.parse(String(await status))).toMatchObject({ kind: "runtime.status" });
        const start = logs.length;
        socket.close(1000, "Control request complete");
        await expect
            .poll(() => logs.slice(start).find((log) => log["event"] === "test_websocket_close_completed"))
            .toBeDefined();
        expect(logs.slice(start).filter((log) => String(log["event"]).startsWith("runtime_websocket_"))).toHaveLength(
            0,
        );
        expect(JSON.stringify(logs.slice(start))).not.toContain("HOST_CREDENTIAL_CANARY");
    } finally {
        if (socket.readyState === 1) {
            socket.close(1000, "Test cleanup");
        }
    }
});

async function daemon() {
    const start = logs.length;
    const response = await runtime.dispatchFetch("https://relay.test/projects/project-logging/daemon", {
        headers: {
            Upgrade: "websocket",
            "x-mobius-runtime-id": "runtime-logging",
            "x-mobius-channel-id": "channel-logging",
        },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a daemon WebSocket");
    }
    socket.accept();
    try {
        await expect
            .poll(() => logs.slice(start).find((log) => log["event"] === "runtime_websocket_accepted"))
            .toBeDefined();
        return socket;
    } catch (error) {
        if (socket.readyState === 1) {
            socket.close(1000, "Test setup failed");
        }
        throw error;
    }
}

// @no-uc: Technical regression; real close callbacks must retain peer diagnostics while detach and reconnect still work.
it("records overload close details and connection epochs without logging healthy heartbeat payloads", async () => {
    const socket = await daemon();
    try {
        const start = logs.length;
        const heartbeat = new Promise((resolve) =>
            socket.addEventListener("message", (event) => resolve(event.data), { once: true }),
        );
        socket.send(JSON.stringify({ kind: "runtime.heartbeat", heartbeatId: "heartbeat-payload-canary" }));
        expect(JSON.parse(String(await heartbeat))).toMatchObject({ kind: "runtime.heartbeat.ack" });
        expect(logs.slice(start)).toHaveLength(0);
        socket.close(1013, "Service overloaded; retry later.");
        await expect
            .poll(() => logs.find((log) => log["event"] === "runtime_websocket_closed" && log["closeCode"] === 1013))
            .toBeDefined();
        const closed = logs.find((log) => log["event"] === "runtime_websocket_closed" && log["closeCode"] === 1013);
        expect(closed).toMatchObject({
            closeCode: 1013,
            closeReason: "Service overloaded; retry later.",
            wasClean: true,
            role: "daemon",
            runtimeId: "runtime-logging",
            projectId: "project-logging",
            durableObjectId: expect.any(String),
            connectionId: expect.any(String),
            connectionEpoch: 1,
        });
        expect(logs).toContainEqual(
            expect.objectContaining({
                event: "runtime_websocket_accepted",
                connectionEpoch: 1,
                connectionId: closed?.["connectionId"],
                runtimeId: "runtime-logging",
            }),
        );
        const next = await daemon();
        next.close(1000, "Test complete");
        await expect
            .poll(() => logs.find((log) => log["event"] === "runtime_websocket_closed" && log["connectionEpoch"] === 2))
            .toBeDefined();
    } finally {
        if (socket.readyState === 1) {
            socket.close(1000, "Test cleanup");
        }
    }
});

// @no-uc: Technical regression; platform-supplied errors must survive the exported hibernatable WebSocket callback.
it("retains a platform WebSocket error and connection identity before closing the socket", async () => {
    const socket = await daemon();
    try {
        const closed = new Promise<number>((resolve) =>
            socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
        );
        const start = logs.length;
        const responsePending = runtime.dispatchFetch("https://relay.test/inject-websocket-error");
        await expect
            .poll(() => logs.slice(start).find((log) => log["event"] === "runtime_websocket_error"))
            .toBeDefined();
        socket.close(1000, "Test complete");
        const response = await responsePending;
        expect(response.status).toBe(204);
        expect(await closed).toBe(1011);
        expect(logs.slice(start)).toContainEqual(
            expect.objectContaining({
                event: "runtime_websocket_error",
                role: "daemon",
                connectionEpoch: expect.any(Number),
                runtimeId: "runtime-logging",
                durableObjectId: expect.any(String),
                err: expect.objectContaining({
                    message: "Runtime relay request failed",
                    cause: expect.objectContaining({ overloaded: true }),
                }),
            }),
        );
    } finally {
        if (socket.readyState === 1) {
            socket.close(1000, "Test cleanup");
        }
    }
});
