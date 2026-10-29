import { execFile } from "node:child_process";
import { on, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { decodeDaemonToServiceMessage } from "@moxt-ai/mobius-sdk/protocol";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { expect, test, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { MobiusRuntimeEngine, type RunLoopParams } from "../../src/exports/engine.ts";
import { decodeReleasedRuntimeDiagnostics } from "./fixtures/released-runtime-diagnostics.ts";

interface ProbeOptions {
    readonly scenario:
        | "delayed"
        | "empty"
        | "nonzero"
        | "nonzero-held"
        | "adapter-empty"
        | "readiness-failure"
        | "limit"
        | "held";
    readonly stream: "stdout" | "stderr";
    readonly connection: "saved" | "provided";
}

interface VersionWriter {
    readonly pid: number;
    readonly closed: Promise<void>;
    readonly release: () => void;
}

async function expectWriterStopped(writer: VersionWriter): Promise<void> {
    await writer.closed;
    if (process.platform !== "linux") {
        expect(() => process.kill(writer.pid, 0)).toThrow();
        return;
    }
    // An orphan's PID may remain until the runner's init reaps it. A zombie
    // cannot execute or retain the output pipe, even though kill(pid, 0) succeeds.
    const stat = await readFile(`/proc/${writer.pid.toString()}/stat`, "utf8").catch((error: unknown) => {
        const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
        // Linux can reap the process between opening its proc entry and reading it.
        if (code === "ENOENT" || code === "ESRCH") {
            return null;
        }
        throw error;
    });
    if (stat !== null) {
        expect(["Z", "X"]).toContain(
            stat
                .slice(stat.lastIndexOf(")") + 1)
                .trimStart()
                .charAt(0),
        );
    }
}

async function createProbeEngine(options: ProbeOptions, signal: AbortSignal) {
    const directory = await mkdtemp(join(tmpdir(), "mobius-agent-output-drain-"));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const pendingWriters: VersionWriter[] = [];
    const writerWaiters: ((writer: VersionWriter) => void)[] = [];
    const writerResponses: ServerResponse[] = [];
    let releaseVersions = options.scenario !== "held" && options.scenario !== "nonzero-held";
    const control = createServer((request, response) => {
        const pid = Number(new URL(request.url ?? "", "http://localhost").searchParams.get("pid"));
        const closed = once(response, "close", { signal }).then(() => undefined);
        void closed.catch(() => undefined);
        const writer = { pid, closed, release: () => response.writeHead(204).end() };
        writerResponses.push(response);
        const waiting = writerWaiters.shift();
        if (waiting === undefined) {
            pendingWriters.push(writer);
        } else {
            waiting(writer);
        }
        if (releaseVersions) {
            writer.release();
        }
    });
    await listen(control);
    const agent = join(directory, "codex.mjs");
    const fixture = new URL("./fixtures/version-probe-peer.mjs", import.meta.url);
    await writeFile(agent, `#!${process.execPath}\nawait import(${JSON.stringify(fixture.href)});\n`, { mode: 0o700 });
    const catalogs: unknown[] = [];
    const http = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
            body += chunk;
        });
        request.on("end", () => {
            catalogs.push(JSON.parse(body));
            response.writeHead(204).end();
        });
    });
    const relay = new WebSocketServer({ server: http });
    const connected = Promise.withResolvers<WebSocket>();
    const online = Promise.withResolvers<void>();
    void connected.promise.catch(() => undefined);
    void online.promise.catch(() => undefined);
    relay.on("connection", (socket) => {
        connected.resolve(socket);
        socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
        socket.on("message", (encoded) => {
            if (String(encoded) === '{"kind":"runtime.heartbeat"}') {
                socket.send(JSON.stringify({ kind: "runtime.heartbeat.ack" }));
            }
        });
    });
    await listen(http);
    const shutdown = new AbortController();
    const loopSignal = AbortSignal.any([signal, shutdown.signal]);
    const engine = new MobiusRuntimeEngine({
        engineDataDir: join(directory, "installations", "probe-app"),
        agentLaunchEnvironment: {
            PATH: "",
            MOBIUS_CODEX_PATH: agent,
            MOBIUS_CLAUDE_PATH: "",
            MOBIUS_PI_PATH: "",
            MOBIUS_OPENCODE_PATH: "",
            MOBIUS_TEST_PROBE_CONTROL: `http://127.0.0.1:${port(control)}`,
            MOBIUS_TEST_PROBE_SCENARIO: options.scenario,
            MOBIUS_TEST_PROBE_STREAM: options.stream,
            MOBIUS_TEST_PROBE_STATE: join(directory, "probe-state"),
        },
    });
    const saved = await engine.getConnectionManager().save(
        {
            appId: "probe-app",
            channelId: "output-drain",
            defaultWorkspace: workspace,
            pairingId: "probe-pairing",
            relayOrigin: new URL(`http://127.0.0.1:${port(http)}`),
            runtimeCredential: "r".repeat(43),
            runtimeId: "probe-runtime",
        },
        signal,
    );
    const connection: RunLoopParams["connection"] =
        options.connection === "saved"
            ? { kind: "saved", connectionId: saved.connectionId }
            : {
                  kind: "provided",
                  connection: {
                      channelId: saved.channelId,
                      defaultWorkspace: workspace,
                      relayUrl: `ws://127.0.0.1:${port(http)}/daemon`,
                      runtimeCredential: saved.runtimeCredential,
                  },
              };
    const execution = engine.runLoop({
        connection,
        signal: loopSignal,
        onConnectionStatus: (status) => {
            if (status === "online") {
                online.resolve();
            }
        },
    });
    void execution.catch((error: unknown) => {
        connected.reject(error);
        online.reject(error);
    });
    return {
        directory,
        catalogs,
        execution,
        shutdown,
        signal: loopSignal,
        allowVersions: () => {
            releaseVersions = true;
            for (const response of writerResponses) {
                if (!response.destroyed && !response.writableEnded) {
                    response.writeHead(204).end();
                }
            }
        },
        localLogs: async () => {
            const { stdout } = await promisify(execFile)(
                process.execPath,
                [resolve(import.meta.dirname, "../../dist/cli.js"), "logs", "--json", "--state-directory", directory],
                { signal, env: { HOME: directory, PATH: "" } },
            );
            return stdout;
        },
        online: async () => (await Promise.all([connected.promise, online.promise]))[0],
        nextWriter: async (): Promise<VersionWriter> => {
            const writer = pendingWriters.shift();
            if (writer !== undefined) {
                return writer;
            }
            signal.throwIfAborted();
            return await new Promise<VersionWriter>((resolve, reject) => {
                const received = (value: VersionWriter): void => {
                    signal.removeEventListener("abort", aborted);
                    resolve(value);
                };
                const aborted = (): void => {
                    const index = writerWaiters.indexOf(received);
                    if (index >= 0) {
                        writerWaiters.splice(index, 1);
                    }
                    reject(signal.reason);
                };
                signal.addEventListener("abort", aborted, { once: true });
                writerWaiters.push(received);
            });
        },
        close: async () => {
            shutdown.abort();
            await execution.catch(() => undefined);
            for (const socket of relay.clients) {
                socket.terminate();
            }
            await new Promise<void>((resolve) => relay.close(() => http.close(() => resolve())));
            for (const response of writerResponses) {
                response.destroy();
            }
            control.closeAllConnections();
            await new Promise<void>((resolve) => control.close(() => resolve()));
            await rm(directory, { force: true, recursive: true });
        },
    };
}

async function request(
    socket: WebSocket,
    message: Readonly<Record<string, unknown>> & { readonly requestId: string },
    signal: AbortSignal,
) {
    const messages = on(socket, "message", { signal });
    try {
        socket.send(JSON.stringify(message));
        for await (const [encoded] of messages) {
            const decoded = decodeDaemonToServiceMessage(String(encoded));
            if ("requestId" in decoded && decoded.requestId === message.requestId) {
                if (decoded.kind === "runtime.diagnostics.result") {
                    expect(decodeReleasedRuntimeDiagnostics(String(encoded))).toEqual(decoded);
                }
                return decoded;
            }
        }
        throw new Error("The Runtime disconnected before answering");
    } finally {
        await messages.return?.();
    }
}

async function diagnostics(socket: WebSocket, signal: AbortSignal) {
    const result = await request(socket, { kind: "runtime.diagnostics.read", requestId: "probe-report" }, signal);
    if (result.kind !== "runtime.diagnostics.result") {
        throw new Error("Expected a Runtime diagnostic report");
    }
    return result;
}

test("Given three Runtime connections discovered delayed version output, When their catalogs refresh concurrently, Then every connection retains its ready Agent", async ({
    signal,
}) => {
    vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date"] });
    const peers: Awaited<ReturnType<typeof createProbeEngine>>[] = [];
    try {
        for (let index = 0; index < 3; index += 1) {
            const peer = await createProbeEngine(
                { scenario: "delayed", stream: "stdout", connection: "saved" },
                signal,
            );
            peers.push(peer);
            await peer.online();
        }
        const results = await Promise.all(
            peers.map(
                async (peer, index) =>
                    await request(
                        await peer.online(),
                        { kind: "agent.catalog.discover", requestId: `refresh-${index.toString()}` },
                        peer.signal,
                    ),
            ),
        );
        for (const result of results) {
            expect(result).toMatchObject({
                kind: "agent.catalog.discovered",
                agents: [expect.objectContaining({ id: "codex", agentVersion: "codex-cli 0.154.0" })],
            });
        }
    } finally {
        await Promise.all(peers.map(async (peer) => await peer.close()));
        vi.useRealTimers();
    }
});

test.for([
    { stream: "stdout", connection: "provided" },
    { stream: "stderr", connection: "saved" },
] as const)(
    "Given a version launcher exits before its inherited $stream pipe closes, When a $connection Engine discovers the Agent, Then its catalog retains the Agent and a Session can be prepared",
    async (options, { signal }) => {
        vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date"] });
        const peer = await createProbeEngine({ ...options, scenario: "delayed" }, signal);
        try {
            const socket = await peer.online();
            expect(peer.catalogs).toContainEqual(
                expect.objectContaining({
                    agents: expect.arrayContaining([
                        expect.objectContaining({ id: "codex", agentVersion: "codex-cli 0.154.0" }),
                    ]),
                }),
            );
            expect(
                await request(
                    socket,
                    {
                        kind: "session.prepare",
                        requestId: "prepare-after-output-drain",
                        sessionId: "output-drain-session",
                        agentId: "codex",
                        bindingId: "workspace",
                        directoryId: "default",
                        additionalDirectoryIds: [],
                    },
                    peer.signal,
                ),
            ).toMatchObject({
                kind: "session.ready",
                requestId: "prepare-after-output-drain",
                sessionId: "output-drain-session",
                agentVersion: "codex-cli 0.154.0",
            });
        } finally {
            await peer.close();
            vi.useRealTimers();
        }
    },
);

test.for([
    {
        scenario: "empty",
        source: "agent_version",
        code: "agent_probe_failed",
        failureCode: "process_exit_failed",
        exitCode: "0",
        probeReason: "empty_version_output",
    },
    {
        scenario: "nonzero",
        source: "agent_version",
        code: "agent_probe_failed",
        failureCode: "process_exit_failed",
        exitCode: "7",
    },
    {
        scenario: "nonzero-held",
        source: "agent_version",
        code: "agent_probe_failed",
        failureCode: "process_exit_failed",
        exitCode: "7",
    },
    { scenario: "limit", source: "agent_version", code: "agent_probe_failed", failureCode: "process_output_limit" },
    {
        scenario: "adapter-empty",
        source: "adapter_version",
        code: "adapter_probe_failed",
        failureCode: "process_exit_failed",
        probeReason: "empty_version_output",
    },
    {
        scenario: "readiness-failure",
        source: "acp_readiness",
        code: "acp_incompatible",
        failureCode: "acp_incompatible",
    },
] as const)(
    "Given a $scenario version probe failure, When an Engine publishes its inventory, Then the diagnostic report identifies the failed stage without publishing private output",
    async ({ scenario, code, ...expected }, { signal }) => {
        vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date"] });
        const peer = await createProbeEngine({ scenario, stream: "stdout", connection: "provided" }, signal);
        try {
            const socket = await peer.online();
            expect(peer.catalogs).toEqual([{ agents: [] }]);
            const report = await diagnostics(socket, peer.signal);
            expect(report.entries).toContainEqual(
                expect.objectContaining({
                    ...expected,
                    event: "agent_probe_failed",
                    agentId: "codex",
                    attempt: "1",
                    timeoutMilliseconds: expected.source === "acp_readiness" ? "60000" : "10000",
                    timestamp: "2026-10-29T00:00:00.000Z",
                    channelId: "output-drain",
                }),
            );
            expect(report.entries).toContainEqual(
                expect.objectContaining({
                    event: "agent_discovery_result",
                    agentId: "codex",
                    code,
                }),
            );
            expect(JSON.stringify(report)).not.toContain("private-probe-output-with-credential");
            expect(JSON.stringify(report)).not.toContain(peer.directory);
            expect(await peer.localLogs()).not.toContain("private-probe-output-with-credential");
        } finally {
            await peer.close();
            vi.useRealTimers();
        }
    },
);

test("Given a version launcher exited but a descendant holds its output open, When both deterministic probe deadlines expire, Then discovery reports a bounded timeout and releases both descendants", async ({
    signal,
}) => {
    vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const peer = await createProbeEngine({ scenario: "held", stream: "stdout", connection: "saved" }, signal);
    try {
        const first = await peer.nextWriter();
        await vi.advanceTimersByTimeAsync(10_000);
        const second = await peer.nextWriter();
        await vi.advanceTimersByTimeAsync(10_000);
        const socket = await peer.online();
        expect(peer.catalogs).toEqual([{ agents: [] }]);
        const report = await diagnostics(socket, peer.signal);
        const failures = report.entries.filter((entry) => entry["event"] === "agent_probe_failed");
        expect(failures).toHaveLength(2);
        expect(failures).toEqual(
            expect.arrayContaining(
                ["1", "2"].map((attempt) =>
                    expect.objectContaining({
                        agentId: "codex",
                        source: "agent_version",
                        attempt,
                        failureCode: "process_timeout",
                        exitCode: "0",
                    }),
                ),
            ),
        );
        expect(report.entries).toContainEqual(
            expect.objectContaining({ event: "agent_discovery_result", agentId: "codex", code: "agent_probe_timeout" }),
        );
        await expectWriterStopped(first);
        await expectWriterStopped(second);
    } finally {
        await peer.close();
        vi.useRealTimers();
    }
});

test("Given a version pipe times out once, When the retry drains normally, Then discovery retains the Agent and the recovered timeout remains in the diagnostic report", async ({
    signal,
}) => {
    vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const peer = await createProbeEngine({ scenario: "held", stream: "stderr", connection: "provided" }, signal);
    try {
        const first = await peer.nextWriter();
        await vi.advanceTimersByTimeAsync(10_000);
        await peer.nextWriter();
        peer.allowVersions();
        const socket = await peer.online();
        expect(peer.catalogs).toContainEqual(
            expect.objectContaining({ agents: expect.arrayContaining([expect.objectContaining({ id: "codex" })]) }),
        );
        const report = await diagnostics(socket, peer.signal);
        expect(report.entries.filter((entry) => entry["event"] === "agent_probe_failed")).toEqual([
            expect.objectContaining({ attempt: "1", failureCode: "process_timeout", source: "agent_version" }),
        ]);
        expect(report.entries).toContainEqual(
            expect.objectContaining({ event: "agent_discovery_result", agentId: "codex", code: "ready" }),
        );
        await expectWriterStopped(first);
    } finally {
        await peer.close();
        vi.useRealTimers();
    }
});

test("Given a version pipe remains open after its launcher exits, When the host cancels discovery, Then cancellation is preserved, the descendant exits, and local logs distinguish cancellation from failure", async ({
    signal,
}) => {
    vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const peer = await createProbeEngine({ scenario: "held", stream: "stdout", connection: "saved" }, signal);
    try {
        const writer = await peer.nextWriter();
        const reason = new Error("Host cancelled discovery");
        peer.shutdown.abort(reason);
        await expect(peer.execution).rejects.toBe(reason);
        expect(peer.catalogs).toEqual([]);
        await expectWriterStopped(writer);
        const logs = await peer.localLogs();
        expect(JSON.parse(logs)).toMatchObject({
            entries: expect.arrayContaining([
                expect.objectContaining({
                    lines: expect.arrayContaining([expect.stringContaining('"event":"agent_probe_cancelled"')]),
                }),
            ]),
        });
        expect(logs).not.toContain("Host cancelled discovery");
    } finally {
        await peer.close();
        vi.useRealTimers();
    }
});
