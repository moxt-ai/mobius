import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay, setInterval } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
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
const durationSeconds = Number(process.env["MOBIUS_PRESSURE_DURATION_SECONDS"] ?? 60);
assert.ok(Number.isSafeInteger(durationSeconds) && durationSeconds > 0);
const expectBatches = process.env["MOBIUS_PRESSURE_EXPECT_BATCH"] !== "0";
const bundledWorkers = new Map();
const report = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
    node: process.version,
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    boundary:
        "Production Runtime + controlled ACP child processes + real workerd Platform/Relay + Recording Worker and SQLite/D1",
    cases: [],
};

async function requestJson(url, options) {
    return await new Promise((resolve, reject) => {
        // Keep each observation independent of pooled sockets from disposed workerd instances.
        const request = httpRequest(url, { ...options, agent: false }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () => {
                try {
                    resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
                } catch (cause) {
                    reject(new Error(`Invalid JSON from ${url.pathname}`, { cause }));
                }
            });
        });
        request.on("error", reject);
        request.end(options.body);
    });
}

async function bundle(path) {
    if (bundledWorkers.has(path)) {
        return bundledWorkers.get(path);
    }
    const result = await build({
        entryPoints: [join(repository, path)],
        bundle: true,
        format: "esm",
        platform: "browser",
        external: ["cloudflare:workers"],
        write: false,
        plugins:
            process.env["MOBIUS_PRESSURE_SOURCE_OVERRIDES"] === undefined
                ? []
                : [
                      {
                          name: "source-snapshot",
                          setup(builder) {
                              builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
                                  const source = relative(repository, path);
                                  if (source.startsWith("..")) {
                                      return;
                                  }
                                  try {
                                      return {
                                          contents: await readFile(
                                              join(process.env["MOBIUS_PRESSURE_SOURCE_OVERRIDES"], source),
                                              "utf8",
                                          ),
                                          loader: "ts",
                                      };
                                  } catch (error) {
                                      if (error.code !== "ENOENT") {
                                          throw error;
                                      }
                                  }
                              });
                          },
                      },
                  ],
        banner: {
            js: "for (const level of ['info','warn','error','debug']) { const write=console[level].bind(console); console[level]=(...values)=>write(...values.map(value=>JSON.stringify(value))); }",
        },
    });
    bundledWorkers.set(path, result.outputFiles[0].text);
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
    const deadline = AbortSignal.timeout((durationSeconds + 180) * 1000);
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
            const response = await requestJson(new URL(`${origin}/mobius/api${path}`), {
                method,
                headers: {
                    authorization: `Bearer ${token ?? "pressure-developer"}`,
                    "x-mobius-oidc-provider": "clerk",
                    "content-type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: deadline,
            });
            assert.equal(response.status, status, JSON.stringify({ path, value: response.value }));
            return response.value;
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
                    `${JSON.stringify({ kind: "emit", round, chunks, bytes, messageId: round >= 2 ? `${phase}-stream-${Math.floor((round - 2) / 50)}` : `${phase}-${round}`, pattern: index % 2 === 0 ? '"\\λ' : "x" })}\n`,
                );
            }
        };
        const textEvents = (id, phase, round) =>
            (live.get(id) ?? []).filter(
                (event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text" &&
                    event.payload.content.text.startsWith(`${phase}:${round}:`),
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
        const ingestMetrics = () => {
            const totals = {
                recordingRequests: 0,
                policyQueries: 0,
                sessionRequests: 0,
                directoryRequests: 0,
                sessionSqlReads: 0,
                sessionSqlWrites: 0,
                directorySqlReads: 0,
                directorySqlWrites: 0,
                indexedSessions: 0,
                indexedEvents: 0,
            };
            for (const message of logs) {
                let value = message;
                for (let depth = 0; depth < 3 && typeof value === "string"; depth += 1) {
                    try {
                        value = JSON.parse(value);
                    } catch {
                        break;
                    }
                }
                if (value?.event === "recording_ingest") {
                    totals.recordingRequests += 1;
                    totals.sessionRequests += value.sessionRequests;
                    totals.directoryRequests += value.directoryRequests;
                } else if (value?.event === "recording_policy_read") {
                    totals.policyQueries += 1;
                } else if (value?.event === "recording_directory_write") {
                    totals.directorySqlReads += value.sqlReads;
                    totals.directorySqlWrites += value.sqlWrites;
                    totals.indexedSessions += value.sessions;
                    totals.indexedEvents += value.events;
                } else if (value?.event === "recording_session_write") {
                    totals.sessionSqlReads += value.sqlReads;
                    totals.sessionSqlWrites += value.sqlWrites;
                }
            }
            return totals;
        };
        const convergeDirectory = async (status, label, since, minimumTimes = new Map()) => {
            const visible = new Map();
            let reads = 0;
            do {
                deadline.throwIfAborted();
                if (fatal !== undefined) {
                    throw fatal;
                }
                const directory = await api(
                    `${base}/recording/sessions?runtimeId=${claimed.runtimeId}`,
                    "GET",
                    undefined,
                    credential,
                );
                reads += 1;
                for (const entry of directory.sessions) {
                    if (
                        entry.status === status &&
                        Date.parse(entry.updatedAt) >= (minimumTimes.get(entry.sessionId) ?? 0) &&
                        !visible.has(entry.sessionId)
                    ) {
                        visible.set(entry.sessionId, performance.now() - since);
                    }
                }
                if (sessions.every((id) => visible.has(id))) {
                    break;
                }
                await delay(20, undefined, { signal: deadline });
            } while (sessions.some((id) => !visible.has(id)));
            const latencies = sessions.map((id) => visible.get(id)).sort((a, b) => a - b);
            const summary = {
                maximumMilliseconds: latencies.at(-1),
                p95Milliseconds: latencies[Math.ceil(latencies.length * 0.95) - 1],
                publicReadRequests: reads,
            };
            result.directoryConvergence ??= {};
            result.directoryConvergence[label] = summary;
        };
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
        await convergeDirectory(
            "running",
            "initialRunning",
            started,
            new Map(sessions.map((id) => [id, Date.parse(live.get(id).at(-1).recordedAt)])),
        );
        stage(`sustained output for ${durationSeconds} seconds at 20 events per Session per second`);
        const beforeMetrics = ingestMetrics();
        const sustainedStarted = performance.now();
        const activityProbes = [];
        const activityLags = [];
        const activityAges = [];
        let round = 2;
        for await (const _tick of setInterval(100, undefined, { signal: deadline })) {
            wave("first", round, 2, 1024);
            if ((round - 2) % 10 === 0) {
                const latest = new Map(sessions.map((id) => [id, Date.parse(live.get(id).at(-1).recordedAt)]));
                const probe = api(
                    `${base}/recording/sessions?runtimeId=${claimed.runtimeId}`,
                    "GET",
                    undefined,
                    credential,
                )
                    .then((directory) => {
                        for (const entry of directory.sessions) {
                            assert.equal(entry.status, "running", `Directory status during output: ${entry.sessionId}`);
                            activityLags.push(Math.max(0, latest.get(entry.sessionId) - Date.parse(entry.updatedAt)));
                            activityAges.push(Math.max(0, Date.now() - Date.parse(entry.updatedAt)));
                        }
                        assert.equal(directory.sessions.length, sessions.length);
                    })
                    .catch((error) => {
                        fatal = error;
                        notifications.emit("changed");
                    });
                activityProbes.push(probe);
            }
            round += 1;
            if (round === durationSeconds * 10 + 2) {
                break;
            }
        }
        const emittedUntil = performance.now();
        const finalRound = round - 1;
        await check(
            () => sessions.every((id) => textEvents(id, "first", finalRound).length === 2),
            "all sustained output arrived",
        );
        for (const [sessionIndex, id] of sessions.entries()) {
            const chunks = live
                .get(id)
                .filter(
                    (event) =>
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.messageId?.startsWith("first-stream-"),
                );
            assert.equal(chunks.length, durationSeconds * 20, `Every controlled steady output chunk arrived: ${id}`);
            for (const [index, event] of chunks.entries()) {
                const marker = `first:${2 + Math.floor(index / 2)}:${index % 2}:`;
                assert.equal(
                    event.payload.content.text,
                    marker.padEnd(1024, sessionIndex % 2 === 0 ? '"\\λ' : "x"),
                    `Steady output contents: ${id}/${index}`,
                );
            }
        }
        const tailObserved = performance.now();
        await convergeDirectory(
            "running",
            "sustainedActivity",
            tailObserved,
            new Map(sessions.map((id) => [id, Date.parse(textEvents(id, "first", finalRound).at(-1).recordedAt)])),
        );
        await Promise.all(activityProbes);
        assert.equal(fatal, undefined);
        const distribution = (values) => {
            values.sort((a, b) => a - b);
            return {
                samples: values.length,
                p95Milliseconds: values[Math.ceil(values.length * 0.95) - 1],
                maximumMilliseconds: values.at(-1),
            };
        };
        const afterMetrics = ingestMetrics();
        result.sustained = {
            configuredSeconds: durationSeconds,
            directoryLagBehindLive: distribution(activityLags),
            directoryActivityAge: distribution(activityAges),
            injectionMilliseconds: emittedUntil - sustainedStarted,
            eventsPerSession: durationSeconds * 20,
            events: durationSeconds * 20 * count,
            metrics: Object.fromEntries(
                Object.keys(afterMetrics).map((key) => [key, afterMetrics[key] - beforeMetrics[key]]),
            ),
        };
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
        await convergeDirectory("idle", "stopped", stopped);
        const followUpStarted = performance.now();
        for (const id of sessions) {
            sendPrompt(id, "next");
        }
        stage("sending follow-up messages");
        await check(() => sessions.every((id) => streams.has(`next/${id}`)), "all follow-up prompts started");
        await convergeDirectory("running", "followUpRunning", followUpStarted);
        wave("next", 0, 2, 1024);
        await check(() => sessions.every((id) => emitted.has(`next/${id}/0`)), "follow-up output emitted");
        const followUpFinishing = performance.now();
        for (const id of sessions) {
            streams.get(`next/${id}`).write('{"kind":"finish"}\n');
        }
        await check(() => sessions.every((id) => terminals.has(`next-${id}`)), "all follow-up prompts completed");
        assert.equal(sessions.filter((id) => terminals.get(`next-${id}`).stopReason === "end_turn").length, count);
        result.followUpPingMilliseconds = await ping("after-follow-up");
        await convergeDirectory("idle", "followUpCompleted", followUpFinishing);
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
        result.ingestMetrics = ingestMetrics();
        assert.ok(result.ingestMetrics.recordingRequests > 0, "Production Recording request counters are required");
        assert.ok(
            result.ingestMetrics.directorySqlReads > 0 && result.ingestMetrics.directorySqlWrites > 0,
            "Real Directory SQL counters are required",
        );
        if (expectBatches) {
            assert.ok(
                result.ingestMetrics.directoryRequests < result.ingestMetrics.sessionRequests / 2,
                "Directory requests must be shared across Sessions",
            );
            assert.ok(
                result.ingestMetrics.directorySqlWrites <= result.ingestMetrics.indexedSessions,
                "Each Session is written at most once per Directory batch",
            );
        }
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
        result.error = inspect(error, { depth: 8 });
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
