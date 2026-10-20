import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeSessionPromptCommand } from "../../../mobius-sdk/src/protocol/index.ts";

// @no-uc: Performance; concurrent output must preserve transport, cancellation and durable Recording.
// This opt-in E2E runner crosses the public Runtime, HTTP, WebSocket and Recording boundaries.
const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(process.env["MOBIUS_PRESSURE_SOURCE_ROOT"] ?? resolve(here, "../../../.."));
const require = createRequire(join(repository, "packages/test-support/package.json"));
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const pluginDirectory = join(repository, "packages/test-support/node_modules/@cloudflare/vitest-plugin");
const pluginPackage = JSON.parse(await readFile(join(pluginDirectory, "package.json"), "utf8"));
const { readD1Migrations } = await import(pathToFileURL(join(pluginDirectory, pluginPackage.main)));
const { WebSocket } = require("ws");
const output = resolve(process.argv[2] ?? (await mkdtemp(join(tmpdir(), "mobius-pressure-evidence-"))));
await mkdir(output, { recursive: true });
const counts = process.argv.slice(3).map(Number);
const report = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
    node: process.version,
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    boundary:
        "Production Runtime + controlled ACP child processes + real workerd Platform/Relay + Recording Worker and SQLite/D1",
    cases: [],
};

async function bundle(path) {
    const result = await build({
        entryPoints: [join(repository, path)],
        bundle: true,
        format: "esm",
        platform: "browser",
        external: ["cloudflare:workers"],
        write: false,
        banner: {
            js: "for (const level of ['info','warn','error','debug']) { const write=console[level].bind(console); console[level]=(...values)=>write(...values.map(value=>JSON.stringify(value))); }",
        },
    });
    return result.outputFiles[0].text;
}

async function exercise(count) {
    const result = { sessions: count, status: "running" };
    const stage = (value) => {
        result.stage = value;
        console.log(`${count} Sessions: ${value}`);
    };
    const childOutput = [];
    const logs = [];
    const notifications = new EventEmitter();
    let fatal;
    const deadline = AbortSignal.timeout(120_000);
    const check = async (predicate, label) => {
        while (!predicate()) {
            if (fatal !== undefined) {
                throw fatal;
            }
            try {
                await once(notifications, "changed", { signal: deadline });
            } catch (cause) {
                throw new Error(`Unfulfilled pressure condition: ${label}`, { cause });
            }
        }
    };
    const state = await mkdtemp(join(tmpdir(), "mobius-pressure-runtime-"));
    await Promise.all([mkdir(join(state, "home")), mkdir(join(state, "workspace"))]);
    const streams = new Map();
    const emitted = new Set();
    const sessionViewers = new Map();
    const controlSockets = new Set();
    const controlDirectory = await mkdtemp("/tmp/mobius-pressure-control-");
    const controlPath = join(controlDirectory, "driver.sock");
    const control = createServer((socket) => {
        controlSockets.add(socket);
        let buffered = "";
        let key;
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
            buffered += chunk;
            for (;;) {
                const end = buffered.indexOf("\n");
                if (end < 0) {
                    break;
                }
                const message = JSON.parse(buffered.slice(0, end));
                buffered = buffered.slice(end + 1);
                if (message.kind === "stream") {
                    key = `${message.phase}/${message.sessionId}`;
                    streams.set(key, socket);
                } else if (message.kind === "emitted") {
                    emitted.add(`${message.phase}/${message.sessionId}/${message.round}`);
                }
                notifications.emit("changed");
            }
        });
        socket.on("error", (error) => {
            fatal = error;
            notifications.emit("changed");
        });
        socket.on("close", () => {
            controlSockets.delete(socket);
            if (streams.get(key) === socket) {
                streams.delete(key);
            }
            notifications.emit("changed");
        });
    });
    await new Promise((resolve) => control.listen(controlPath, resolve));
    const runtime = new Miniflare(
        convertV4MiniflareOptions({
            workers: [
                {
                    name: "platform",
                    modules: true,
                    script: await bundle("packages/test-support/src/platform-worker-entry.ts"),
                    compatibilityDate: "2026-09-03",
                    durableObjects: {
                        RUNTIME_RELAY: { className: "RuntimeRelay", useSQLite: true },
                        PROJECT_RELAY: { className: "ProjectRelay", useSQLite: true },
                    },
                    d1Databases: ["PLATFORM_DIRECTORY_DATABASE"],
                    kvNamespaces: ["APP_CREDENTIAL_CACHE"],
                    r2Buckets: ["R2_BUCKET_APAC", "R2_BUCKET_WNAM"],
                    serviceBindings: { RECORDING: "recording" },
                    bindings: {
                        RECORDING_PROVIDER_ID: "recording-local",
                        MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
                        MOBIUS_PLATFORM_ALLOWED_ORIGINS: '["*"]',
                        MOBIUS_PLATFORM_OIDC_PROVIDERS: "[]",
                        MOBIUS_PLATFORM_OPERATOR_SUBJECTS: "[]",
                    },
                },
                {
                    name: "recording",
                    modules: true,
                    script: await bundle("packages/recording-cloudflare/src/worker.ts"),
                    compatibilityDate: "2026-09-03",
                    durableObjects: {
                        SESSION_RECORDING: { className: "SessionRecordingDurableObject", useSQLite: true },
                        RECORDING_DIRECTORY: { className: "RecordingDirectoryDurableObject", useSQLite: true },
                    },
                },
            ],
            handleStructuredLogs: (log) => {
                logs.push(log.message);
                notifications.emit("changed");
            },
        }),
    );
    let child;
    let childExited;
    let host;
    let recordIds;
    try {
        stage("starting workerd");
        const origin = (await runtime.ready).origin;
        stage("initializing D1");
        const env = await runtime.getBindings("platform");
        for (const migration of await readD1Migrations(
            join(repository, "packages/relay-cloudflare-platform/migrations/d1"),
        )) {
            await env.PLATFORM_DIRECTORY_DATABASE.batch(
                migration.queries.map((sql) => env.PLATFORM_DIRECTORY_DATABASE.prepare(sql)),
            );
        }
        const api = async (path, method = "GET", body, token, status = 200) => {
            const response = await fetch(`${origin}/mobius/api${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${token ?? "pressure-developer"}`,
                    "x-mobius-oidc-provider": "clerk",
                    "content-type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: deadline,
            });
            const value = await response.json();
            assert.equal(response.status, status, JSON.stringify({ path, value }));
            return value;
        };
        stage("provisioning through public APIs");
        const tenant = (await api("/dashboard/v1/platform/tenants")).tenants[0];
        const app = await api(
            "/dashboard/v1/apps",
            "POST",
            { tenantId: tenant.tenantId, displayName: "Concurrent output E2E" },
            undefined,
            201,
        );
        const credential = app.defaultCredential.credential;
        const project = await api(
            `/dashboard/v1/apps/${app.appId}/projects`,
            "POST",
            { displayName: "Pressure", idempotencyKey: "pressure", locationHint: "apac" },
            undefined,
            201,
        );
        await api(`/dashboard/v1/apps/${app.appId}/recording-policy`, "PUT", { mode: "enabled" });
        const base = `/v1/projects/${project.projectId}`;
        const pairing = await api(`${base}/runtime-pairings`, "POST", { idempotencyKey: "pressure" }, credential, 201);
        const claimed = await api(`/v1/runtime-pairings/${pairing.pairingId}/redeem`, "POST", {
            pairingCode: pairing.pairingCode,
            agents: [],
            machineName: "Isolated pressure test",
            workspaceName: "workspace",
        });
        const relay = new URL(`${origin}/mobius/api/v1/runtimes/connect`);
        relay.protocol = "ws:";
        relay.searchParams.set("token", claimed.runtimeCredential);
        const connectionStates = [];
        child = fork(
            join(here, "runtime-process.mjs"),
            [state, pairing.channelId, relay.href, controlPath, repository],
            {
                env: { PATH: process.env.PATH, HOME: join(state, "home") },
                stdio: ["ignore", "pipe", "pipe", "ipc"],
            },
        );
        child.stdout.on("data", (data) => childOutput.push(String(data)));
        child.stderr.on("data", (data) => {
            childOutput.push(String(data));
            console.error(String(data));
        });
        child.on("message", (message) => {
            if (message.kind === "connection" && connectionStates.at(-1) !== message.status) {
                connectionStates.push(message.status);
            }
            if (message.kind === "metrics") {
                result.runtime = message;
            }
            notifications.emit("changed");
        });
        childExited = once(child, "exit");
        child.on("exit", (code, signal) => {
            fatal = new Error(`Runtime exited: ${code} / ${signal}`);
            notifications.emit("changed");
        });
        stage("connecting Runtime");
        await check(() => connectionStates.includes("online"), "Runtime online");
        const hostUrl = new URL(`${origin}/mobius/api${base}/runtimes/${claimed.runtimeId}/host`);
        hostUrl.protocol = "ws:";
        hostUrl.searchParams.set("token", credential);
        host = new WebSocket(hostUrl);
        const live = new Map();
        const terminals = new Map();
        const pongs = new Map();
        const requests = new Map();
        const failures = [];
        let maximumFrameBytes = 0;
        let hostClosed;
        host.on("close", (code, reason) => {
            hostClosed = { code, reason: String(reason) };
            notifications.emit("changed");
        });
        host.on("message", (bytes) => {
            maximumFrameBytes = Math.max(maximumFrameBytes, bytes.byteLength);
            const message = JSON.parse(String(bytes));
            if (message.kind === "runtime.pong") {
                pongs.set(message.requestId, performance.now());
            }
            if (message.kind === "session.operation.failed") {
                failures.push(message);
            }
            if (
                typeof message.requestId === "string" &&
                ["session.ready", "session.operation.failed"].includes(message.kind)
            ) {
                requests.set(message.requestId, message);
            }
            for (const event of message.events ?? []) {
                const events = live.get(event.sessionId) ?? [];
                events.push(event);
                live.set(event.sessionId, events);
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    terminals.set(event.payload.commandId, {
                        at: performance.now(),
                        stopReason: event.payload.stopReason,
                    });
                }
                if (
                    event.type === "lifecycle-metadata" &&
                    ["prompt.failed", "prompt.failed-before-start"].includes(event.payload.kind)
                ) {
                    fatal = new Error(`Agent turn failed: ${JSON.stringify(event.payload)}`);
                }
            }
            notifications.emit("changed");
        });
        await once(host, "open", { signal: deadline });
        const sessions = [];
        stage("preparing Sessions");
        // Public prepare requests bound to eight at a time; output itself is released concurrently.
        for (let offset = 0; offset < count; offset += 8) {
            sessions.push(
                ...(await Promise.all(
                    Array.from({ length: Math.min(8, count - offset) }, async (_, index) => {
                        const requestId = `prepare-${offset + index}`;
                        host.send(
                            JSON.stringify({
                                kind: "session.prepare",
                                requestId,
                                bindingId: "workspace",
                                agentId: "pressure-agent",
                                directoryId: "default",
                                additionalDirectoryIds: [],
                                sessionId: `pressure-${offset + index}`,
                            }),
                        );
                        await check(() => requests.has(requestId), requestId);
                        const response = requests.get(requestId);
                        assert.equal(response.kind, "session.ready", JSON.stringify(response));
                        return response.sessionId;
                    }),
                )),
            );
        }
        stage("opening one scoped viewer per Session");
        for (let offset = 0; offset < sessions.length; offset += 8) {
            await Promise.all(
                sessions.slice(offset, offset + 8).map(async (id) => {
                    const endpoint = new URL(hostUrl);
                    endpoint.searchParams.set("sessionId", id);
                    const socket = new WebSocket(endpoint);
                    const viewer = { socket, events: 0, digest: createHash("sha256") };
                    sessionViewers.set(id, viewer);
                    socket.on("message", (bytes) => {
                        const message = JSON.parse(String(bytes));
                        for (const event of message.events ?? []) {
                            if (event.sessionId !== id) {
                                fatal = new Error(`Cross-Session event received by ${id}`);
                            }
                            viewer.events += 1;
                            viewer.digest.update(`${JSON.stringify(event)}\n`);
                        }
                        notifications.emit("changed");
                    });
                    socket.on("error", (error) => {
                        fatal = error;
                        notifications.emit("changed");
                    });
                    socket.on("close", () => {
                        fatal = new Error(`Session viewer disconnected: ${id}`);
                        notifications.emit("changed");
                    });
                    await once(socket, "open", { signal: deadline });
                }),
            );
        }
        const sendPrompt = (sessionId, phase) =>
            host.send(
                encodeSessionPromptCommand({
                    kind: "session.prompt",
                    commandId: `${phase}-${sessionId}`,
                    sessionId,
                    agentId: "pressure-agent",
                    bindingId: "workspace",
                    directoryId: "default",
                    additionalDirectoryIds: [],
                    disposition: "reject",
                    targetCommandId: "",
                    prompt: `${phase}|${sessionId}`,
                    images: [],
                    resources: [],
                }),
            );
        const wave = (phase, round, chunks, bytes) => {
            for (const [index, id] of sessions.entries()) {
                const stream = streams.get(`${phase}/${id}`);
                assert.ok(stream, `The controlled Agent stream disappeared: ${id}`);
                stream.write(
                    `${JSON.stringify({ kind: "emit", round, chunks, bytes, pattern: index % 2 === 0 ? '"\\λ' : "x" })}\n`,
                );
            }
        };
        const textEvents = (id, phase, round) =>
            (live.get(id) ?? []).filter(
                (event) => event.type === "acp" && event.payload.messageId === `${phase}-${round}`,
            );
        const ping = async (name) => {
            const start = performance.now();
            host.send(JSON.stringify({ kind: "runtime.ping", requestId: name }));
            await check(() => pongs.has(name) || hostClosed !== undefined, name);
            assert.equal(hostClosed, undefined, JSON.stringify(hostClosed));
            return pongs.get(name) - start;
        };
        for (const id of sessions) {
            sendPrompt(id, "first");
        }
        stage("waiting for concurrent output barrier");
        await check(
            () => sessions.every((id) => streams.has(`first/${id}`)),
            "all Sessions concurrently waiting to output",
        );
        const started = performance.now();
        stage("emitting simultaneous large output");
        wave("first", 0, 2, Math.floor((12 * 1024 * 1024) / count / 2));
        await check(
            () =>
                sessions.every((id) => textEvents(id, "first", 0).length === 2) ||
                connectionStates.includes("reconnecting"),
            "all simultaneous large output received",
        );
        assert.equal(
            connectionStates.includes("reconnecting"),
            false,
            "The daemon disconnected during simultaneous output",
        );
        result.outputPingMilliseconds = await ping("during-output");
        wave("first", 1, 128, 256);
        await check(
            () =>
                [...live.values()].some((events) =>
                    events.some((event) => event.type === "acp" && event.payload.messageId === "first-1"),
                ),
            "second output wave started",
        );
        const stopped = performance.now();
        stage("stopping during output");
        for (const id of sessions) {
            host.send(JSON.stringify({ kind: "session.cancel", commandId: `first-${id}`, sessionId: id }));
        }
        await check(() => sessions.every((id) => terminals.has(`first-${id}`)), "all stop requests settled");
        result.stopMaximumMilliseconds = Math.max(...sessions.map((id) => terminals.get(`first-${id}`).at - stopped));
        assert.equal(sessions.filter((id) => terminals.get(`first-${id}`).stopReason === "cancelled").length, count);
        for (const id of sessions) {
            sendPrompt(id, "next");
        }
        stage("sending follow-up messages");
        await check(() => sessions.every((id) => streams.has(`next/${id}`)), "all follow-up prompts started");
        wave("next", 0, 2, 1024);
        await check(() => sessions.every((id) => emitted.has(`next/${id}/0`)), "follow-up output emitted");
        for (const id of sessions) {
            streams.get(`next/${id}`).write('{"kind":"finish"}\n');
        }
        await check(() => sessions.every((id) => terminals.has(`next-${id}`)), "all follow-up prompts completed");
        assert.equal(sessions.filter((id) => terminals.get(`next-${id}`).stopReason === "end_turn").length, count);
        result.followUpPingMilliseconds = await ping("after-follow-up");
        await check(
            () => sessions.every((id) => sessionViewers.get(id).events === live.get(id).length),
            "scoped viewers received exactly their Session events",
        );
        for (const id of sessions) {
            const expected = createHash("sha256");
            for (const event of live.get(id)) {
                expected.update(`${JSON.stringify(event)}\n`);
            }
            assert.equal(
                sessionViewers.get(id).digest.digest("hex"),
                expected.digest("hex"),
                `Scoped viewer contents: ${id}`,
            );
        }
        result.scopedViewers = sessionViewers.size;
        recordIds = {};
        stage("verifying persisted Recording contents");
        for (const id of sessions) {
            let history;
            do {
                deadline.throwIfAborted();
                history = await api(
                    `${base}/recording/sessions/${id}/events?runtimeId=${claimed.runtimeId}`,
                    "GET",
                    undefined,
                    credential,
                );
            } while (
                !history.events.some(
                    (event) =>
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.completed" &&
                        event.payload.commandId === `next-${id}`,
                )
            );
            const expected = live.get(id);
            assert.deepEqual(
                history.events.map((event) => event.eventId),
                expected.map((event) => event.eventId),
                `Recorded event order/completeness: ${id}`,
            );
            assert.equal(
                history.events.some((event) => event.mobiusMetadata?.omitted),
                false,
                `Recording gap: ${id}`,
            );
            const digest = (events) => createHash("sha256").update(JSON.stringify(events)).digest("hex");
            assert.equal(digest(history.events), digest(expected), `Recorded contents: ${id}`);
            recordIds[id] = { events: history.events.length, sha256: digest(expected) };
        }
        let directory;
        do {
            deadline.throwIfAborted();
            directory = await api(
                `${base}/recording/sessions?runtimeId=${claimed.runtimeId}`,
                "GET",
                undefined,
                credential,
            );
        } while (
            !sessions.every((id) =>
                directory.sessions.some((session) => session.sessionId === id && session.status === "idle"),
            )
        );
        assert.equal(directory.sessions.length, count);
        assert.equal(failures.length, 0, JSON.stringify(failures));
        assert.equal(fatal, undefined);
        assert.equal(hostClosed, undefined);
        assert.deepEqual(connectionStates, ["online"]);
        result.status = "passed";
        result.stopped = count;
        result.followUpsCompleted = count;
        result.recordedSessions = count;
        result.recordedEvents = Object.values(recordIds).reduce((sum, value) => sum + value.events, 0);
        result.maximumHostFrameBytes = maximumFrameBytes;
        result.elapsedMilliseconds = performance.now() - started;
        result.connections = [...connectionStates];
        await writeFile(join(output, `${count}-runtime.log`), childOutput.join(""));
    } catch (error) {
        result.status = "failed";
        result.error = String(error.stack ?? error);
        process.exitCode = 1;
        console.error(JSON.stringify(result));
    } finally {
        stage("cleanup");
        host?.terminate();
        for (const viewer of sessionViewers.values()) {
            viewer.socket.terminate();
        }
        for (const stream of streams.values()) {
            stream.destroy();
        }
        if (child?.connected) {
            child.send("stop");
        }
        if (childExited !== undefined) {
            await childExited;
        }
        await runtime.dispose();
        for (const socket of controlSockets) {
            socket.destroy();
        }
        await new Promise((resolve) => control.close(resolve));
        await rm(controlDirectory, { recursive: true, force: true });
        await rm(state, { recursive: true, force: true });
        await writeFile(join(output, `${count}-runtime.log`), childOutput.join(""));
        await writeFile(join(output, `${count}-worker-logs.json`), `${JSON.stringify(logs, null, 2)}\n`);
        if (recordIds !== undefined) {
            await writeFile(join(output, `${count}-recording.json`), `${JSON.stringify(recordIds, null, 2)}\n`);
        }
    }
    return result;
}

for (const count of counts.length === 0 ? [20, 100, 200] : counts) {
    const result = await exercise(count);
    report.cases.push(result);
    await writeFile(join(output, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(result));
    if (result.status !== "passed") {
        break;
    }
}
