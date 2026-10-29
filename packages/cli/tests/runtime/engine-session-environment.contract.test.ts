import { on, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeDaemonToServiceMessage,
    encodeSessionPrepareCommand,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { expect, test, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { MobiusRuntimeEngine, type RunLoopParams } from "../../src/exports/engine.ts";

test.for(["saved", "provided"] as const)(
    "Given an embedded Engine with a %s connection, When successive loops prepare concurrent Sessions with and without scoped environments, Then Agent children receive only their own loop and Session identity",
    async (kind, { signal }) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
        const directory = await mkdtemp(join(tmpdir(), "mobius-engine-session-env-"));
        const workspace = join(directory, "workspace");
        const executable = join(directory, "codex.mjs");
        const reports = join(directory, "environments.jsonl");
        await mkdir(workspace);
        await writeFile(reports, "");
        await writeFile(
            executable,
            `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
    process.stdout.write("codex-cli 0.154.0\\n");
    process.exit(0);
}
let thread = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method === "thread/start") {
        appendFileSync(${JSON.stringify(reports)}, JSON.stringify({
            context: process.env.MOBIUS_TEST_SESSION_CONTEXT,
            base: process.env.MOBIUS_TEST_BASE,
        }) + "\\n");
    }
    const result = request.method === "thread/start"
        ? { thread: { id: "environment-thread-" + process.pid + "-" + ++thread } }
        : request.method === "model/list" ? { data: [], nextCursor: null } : {};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`,
            { mode: 0o700 },
        );
        const http = createServer((request, response) => {
            request.resume();
            response.writeHead(204).end();
        });
        const relay = new WebSocketServer({ server: http });
        relay.on("connection", (socket) => {
            socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
            socket.on("message", (encoded) => {
                if (encoded.toString() === RUNTIME_HEARTBEAT_MESSAGE) {
                    socket.send(RUNTIME_HEARTBEAT_ACK_MESSAGE);
                }
            });
        });
        await listen(http);
        const origin = `http://127.0.0.1:${port(http)}`;
        const engine = new MobiusRuntimeEngine({
            engineDataDir: join(directory, "data"),
            agentLaunchEnvironment: {
                PATH: "",
                MOBIUS_CODEX_PATH: executable,
                MOBIUS_CLAUDE_PATH: "",
                MOBIUS_PI_PATH: "",
                MOBIUS_OPENCODE_PATH: "",
                MOBIUS_TEST_BASE: "launch-environment",
                MOBIUS_TEST_SESSION_CONTEXT: "unscoped",
            },
        });
        try {
            const saved = await engine.getConnectionManager().save(
                {
                    appId: "environment-app",
                    channelId: "environment-channel",
                    defaultWorkspace: workspace,
                    pairingId: "environment-pairing",
                    relayOrigin: new URL(origin),
                    runtimeCredential: "r".repeat(43),
                    runtimeId: "environment-runtime",
                },
                signal,
            );
            const connection: RunLoopParams["connection"] =
                kind === "saved"
                    ? { kind, connectionId: saved.connectionId }
                    : {
                          kind,
                          connection: {
                              channelId: saved.channelId,
                              defaultWorkspace: workspace,
                              relayUrl: `ws://127.0.0.1:${port(http)}/daemon`,
                              runtimeCredential: saved.runtimeCredential,
                          },
                      };
            const expected: { readonly context: string; readonly base: string }[] = [];
            for (const scope of ["first-loop", "second-loop", undefined]) {
                const shutdown = new AbortController();
                const loopSignal = AbortSignal.any([signal, shutdown.signal]);
                const connected = once(relay, "connection", { signal: loopSignal });
                const execution = engine.runLoop({
                    connection,
                    signal: loopSignal,
                    ...(scope === undefined
                        ? {}
                        : {
                              sessionEnvironment: ({ sessionId, agentId }) => ({
                                  MOBIUS_TEST_SESSION_CONTEXT: JSON.stringify({ scope, sessionId, agentId }),
                              }),
                          }),
                });
                // Observe preparation errors immediately as well as on cleanup.
                void execution.catch((cause: unknown) => shutdown.abort(cause));
                try {
                    const socket: WebSocket = (await connected)[0];
                    const ready = new Set<string>();
                    const receive = async () => {
                        for await (const [encoded] of on(socket, "message", { signal: loopSignal })) {
                            const text = String(encoded);
                            if (text === RUNTIME_HEARTBEAT_MESSAGE) {
                                continue;
                            }
                            const message = decodeDaemonToServiceMessage(text);
                            if (message.kind === "session.operation.failed") {
                                throw new Error(message.message);
                            }
                            if (message.kind === "session.ready") {
                                ready.add(message.sessionId);
                            }
                            if (ready.size === 2) {
                                return;
                            }
                        }
                    };
                    const prepared = receive();
                    for (const sessionId of ["session-a", "session-b"]) {
                        socket.send(
                            encodeSessionPrepareCommand({
                                kind: "session.prepare",
                                requestId: `prepare-${sessionId}`,
                                sessionId,
                                agentId: "codex",
                                bindingId: "workspace",
                                directoryId: "default",
                                additionalDirectoryIds: [],
                            }),
                        );
                        expected.push({
                            context:
                                scope === undefined
                                    ? "unscoped"
                                    : JSON.stringify({ scope, sessionId, agentId: "codex" }),
                            base: "launch-environment",
                        });
                    }
                    await prepared;
                    const observed: unknown[] = (await readFile(reports, "utf8"))
                        .trim()
                        .split("\n")
                        .map((line) => JSON.parse(line));
                    expect(observed).toHaveLength(expected.length);
                    expect(observed).toEqual(expect.arrayContaining(expected));
                } finally {
                    shutdown.abort();
                    await execution;
                }
            }
        } finally {
            for (const socket of relay.clients) {
                socket.terminate();
            }
            await new Promise<void>((resolve) => relay.close(() => http.close(() => resolve())));
            await rm(directory, { recursive: true, force: true });
            vi.useRealTimers();
        }
    },
);
