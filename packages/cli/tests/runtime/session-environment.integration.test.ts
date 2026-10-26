import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeNativeSessionResult,
    encodeNativeSessionCommand,
    encodeSessionCloseCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    encodeSessionRestoreCommand,
    NATIVE_SESSION_REQUEST_KIND,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { LocalAgentDefinition } from "../../src/acp/agent/agent-definition.ts";
import { RuntimeLocalContext } from "../../src/runtime/config.ts";
import { runRuntime } from "../../src/runtime/run.ts";
import { fakeAgentHarness } from "../support/agent-harness.ts";
import { createControlledRuntimeConfig } from "../support/controlled-runtime-config.ts";

// @no-uc: Compatibility; public Runtime commands and real ACP children verify embedding context isolation.
test("Given scoped environments, When Sessions run concurrently and restore, Then their children retain the right identity", async ({
    signal,
}) => {
    const peer = await runtimePeer(signal);
    try {
        for (const sessionId of ["session-a", "session-b"]) {
            peer.send(
                encodeSessionPrepareCommand({
                    ...peer.base(sessionId),
                    kind: "session.prepare",
                    requestId: `prepare-${sessionId}`,
                }),
            );
        }
        await Promise.all([
            peer.next("prepare-session-a", ["session.ready"]),
            peer.next("prepare-session-b", ["session.ready"]),
        ]);
        expect(await peer.launches()).toEqual(
            expect.arrayContaining([{ context: "session-a" }, { context: "session-b" }]),
        );
        await Promise.all([peer.prompt("session-a", "prompt-a"), peer.prompt("session-b", "prompt-b")]);
        expect(await peer.launches()).toHaveLength(2);
        await peer.restart("runtime");
        peer.send(
            encodeSessionRestoreCommand({ ...peer.base("session-a"), kind: "session.restore", requestId: "restore-a" }),
        );
        await peer.next("restore-a", ["session.restored"]);
        expect((await peer.launches()).at(-1)).toEqual({ context: "session-a" });
        expect(peer.agent.environment).not.toHaveProperty("MOBIUS_TEST_SESSION_CONTEXT");
    } finally {
        await peer.close();
    }
});

// @no-uc: Technical regression; native discovery, new destinations and canonical reimports must not share identity.
test("Given native history, When it is imported, reopened and forked, Then execution uses the destination or canonical Session", async ({
    signal,
}) => {
    const peer = await runtimePeer(signal);
    try {
        peer.send(
            encodeSessionPrepareCommand({ ...peer.base("seed"), kind: "session.prepare", requestId: "prepare-seed" }),
        );
        await peer.next("prepare-seed", ["session.ready"]);
        await peer.prompt("seed", "seed-history");
        await peer.restart("import-runtime");
        peer.send(
            encodeNativeSessionCommand({
                ...peer.base("discovery"),
                kind: NATIVE_SESSION_REQUEST_KIND,
                requestId: "native-list",
                action: "list",
                cursor: null,
            }),
        );
        const listed = decodeNativeSessionResult(await peer.next("native-list", ["native.session.result"]));
        if (listed.action !== "list" || listed.entries[0] === undefined) {
            throw new Error("Expected the seeded native conversation");
        }
        const entryId = listed.entries[0].entryId;
        const open = async (action: "import" | "fork", targetSessionId: string, requestId: string) => {
            peer.send(
                encodeNativeSessionCommand({
                    ...peer.base("discovery"),
                    kind: NATIVE_SESSION_REQUEST_KIND,
                    requestId,
                    action,
                    entryId,
                    targetSessionId,
                }),
            );
            const result = decodeNativeSessionResult(await peer.next(requestId, ["native.session.result"]));
            if (result.action !== "import" && result.action !== "fork") {
                throw new Error("Expected the native opening result");
            }
            return result.ready.sessionId;
        };
        const imported = await open("import", "import-destination", "native-import");
        expect(imported).toBe("import-destination");
        expect.soft((await peer.nativeRequests()).at(-1)).toMatchObject({ context: imported });
        peer.send(
            encodeSessionCloseCommand({ sessionId: imported, requestId: "close-imported", kind: "session.close" }),
        );
        await peer.next("close-imported", ["session.closed"]);
        const canonical = await open("import", "unused-reimport-destination", "native-reimport");
        expect(canonical).toBe(imported);
        expect.soft((await peer.nativeRequests()).at(-1)).toMatchObject({ context: canonical });
        const forked = await open("fork", "fork-destination", "native-fork");
        expect(forked).toBe("fork-destination");
        expect.soft((await peer.nativeRequests()).at(-1)).toMatchObject({ context: forked });
    } finally {
        await peer.close();
    }
});

async function runtimePeer(signal: AbortSignal) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "mobius-session-environment-"));
    const workspace = join(directory, "workspace");
    const harnessState = join(directory, "harness");
    const launches = join(directory, "launches.jsonl");
    const nativeRequests = join(directory, "native-requests.jsonl");
    const launcher = join(directory, "agent.mjs");
    const agentPeer = new URL("../sessions/fixtures/acp-peer.ts", import.meta.url).href;
    await Promise.all([mkdir(workspace), mkdir(harnessState), writeFile(launches, ""), writeFile(nativeRequests, "")]);
    await writeFile(
        launcher,
        `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const context = process.env.MOBIUS_TEST_SESSION_CONTEXT ?? null;
appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ context }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (typeof request.method === "string" && /^(?:session|_session)\\//.test(request.method) && request.method !== "session/list") {
        appendFileSync(${JSON.stringify(nativeRequests)}, JSON.stringify({ context, method: request.method }) + "\\n");
    }
});
await import(${JSON.stringify(agentPeer)});
`,
    );
    const external = fakeAgentHarness({ id: "codex", label: "Controlled ACP" }, harnessState);
    const agent = new LocalAgentDefinition(
        external.id,
        external.label,
        process.execPath,
        [launcher],
        external.environment,
        external.adapterVersion,
        external.agentVersion,
        undefined,
        undefined,
        external.capabilities,
    );
    const relay = createServer((_request, response) => response.writeHead(204).end());
    const server = new WebSocketServer({ server: relay });
    const frames: string[] = [];
    const listeners = new Set<(frame: string) => void>();
    let socket: WebSocket | undefined;
    server.on("connection", (connected) => {
        socket = connected;
        connected.on("message", (value) => {
            const frame = value.toString();
            if (frame === RUNTIME_HEARTBEAT_MESSAGE) {
                connected.send(RUNTIME_HEARTBEAT_ACK_MESSAGE);
            } else {
                frames.push(frame);
                for (const listener of listeners) {
                    listener(frame);
                }
            }
        });
        connected.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
    });
    const listening = once(relay, "listening", { signal });
    relay.listen(0, "127.0.0.1");
    await listening;
    const address = relay.address();
    if (address === null || typeof address === "string") {
        throw new Error("Expected the relay port");
    }
    const config = {
        ...createControlledRuntimeConfig(
            {
                channelId: "environment",
                defaultWorkspace: workspace,
                relayUrl: new URL(
                    `ws://127.0.0.1:${address.port}/mobius/api/v1/runtimes/connect?token=${"r".repeat(43)}`,
                ),
            },
            [agent],
            new RuntimeLocalContext(join(directory, "runtime"), process.env),
        ),
        sessionEnvironment: ({ sessionId }: { sessionId: string; agentId: string }) => ({
            MOBIUS_TEST_SESSION_CONTEXT: sessionId,
        }),
    };
    let cancellation = new AbortController();
    const connected = once(server, "connection", { signal });
    let execution = runRuntime(config, cancellation.signal);
    await connected;
    const abort = () => cancellation.abort();
    signal.addEventListener("abort", abort, { once: true });
    const next = (requestId: string, kinds: readonly string[]): Promise<string> => {
        const matches = (frame: string): boolean => {
            const value: unknown = JSON.parse(frame);
            if (typeof value !== "object" || value === null || !("kind" in value) || typeof value.kind !== "string") {
                return false;
            }
            const addressed =
                ("requestId" in value && value.requestId === requestId) ||
                ("commandId" in value && value.commandId === requestId) ||
                (kinds.includes("prompt.completed") && frame.includes(JSON.stringify(requestId)));
            if (!addressed) {
                return false;
            }
            if (value.kind.endsWith(".failed")) {
                throw new Error(frame);
            }
            return (
                kinds.includes(value.kind) ||
                (kinds.includes("prompt.completed") && frame.includes(JSON.stringify("prompt.completed")))
            );
        };
        signal.throwIfAborted();
        const existing = frames.find(matches);
        if (existing !== undefined) {
            return Promise.resolve(existing);
        }
        return new Promise<string>((resolve, reject) => {
            const cleanup = () => {
                listeners.delete(receive);
                signal.removeEventListener("abort", cancelled);
            };
            const cancelled = () => {
                cleanup();
                reject(signal.reason);
            };
            const receive = (frame: string) => {
                try {
                    if (matches(frame)) {
                        cleanup();
                        resolve(frame);
                    }
                } catch (error) {
                    cleanup();
                    reject(error);
                }
            };
            listeners.add(receive);
            signal.addEventListener("abort", cancelled, { once: true });
        });
    };
    const send = (frame: string) => {
        if (socket === undefined) {
            throw new Error("The Runtime has not connected");
        }
        socket.send(frame);
    };
    const base = (sessionId: string) => ({
        additionalDirectoryIds: [],
        agentId: "codex",
        bindingId: config.bindingId,
        directoryId: "default",
        sessionId,
    });
    const readContexts = async (path: string) =>
        (await readFile(path, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                const value: unknown = JSON.parse(line);
                if (
                    typeof value !== "object" ||
                    value === null ||
                    !("context" in value) ||
                    (value.context !== null && typeof value.context !== "string")
                ) {
                    throw new Error("Invalid child context report");
                }
                return { context: value.context };
            });
    return {
        agent,
        base,
        next,
        send,
        launches: () => readContexts(launches),
        nativeRequests: () => readContexts(nativeRequests),
        prompt: async (sessionId: string, commandId: string) => {
            send(
                encodeSessionPromptCommand({
                    ...base(sessionId),
                    kind: "session.prompt",
                    commandId,
                    disposition: SessionPromptDisposition.Reject,
                    targetCommandId: "",
                    prompt: commandId,
                    images: [],
                    resources: [],
                }),
            );
            await next(commandId, ["prompt.completed"]);
        },
        restart: async (stateName: string) => {
            cancellation.abort();
            await execution;
            cancellation = new AbortController();
            const connected = once(server, "connection", { signal });
            execution = runRuntime(
                { ...config, localContext: new RuntimeLocalContext(join(directory, stateName), process.env) },
                cancellation.signal,
            );
            await connected;
        },
        close: async () => {
            signal.removeEventListener("abort", abort);
            cancellation.abort();
            await execution;
            for (const connection of server.clients) {
                connection.terminate();
            }
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
            await new Promise<void>((resolve, reject) => relay.close((error) => (error ? reject(error) : resolve())));
            await rm(directory, { recursive: true, force: true });
            vi.useRealTimers();
        },
    };
}
