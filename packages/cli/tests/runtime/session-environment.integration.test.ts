import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    encodeSessionRestoreCommand,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { expect, test, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { LocalAgentDefinition } from "../../src/acp/agent/agent-definition.ts";
import { RuntimeLocalContext } from "../../src/runtime/config.ts";
import { runRuntime } from "../../src/runtime/run.ts";
import { fakeAgentHarness } from "../support/agent-harness.ts";
import { createControlledRuntimeConfig } from "../support/controlled-runtime-config.ts";

// @no-uc: Embedding compatibility; exercises the production Runtime's public protocol and real
// ACP child processes. The controlled executable is not evidence for a vendor shell tool.
test("session environment stays isolated through concurrent prompts and Runtime restoration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-session-environment-"));
    const workspace = join(directory, "workspace");
    const harnessState = join(directory, "harness");
    const launches = join(directory, "launches.jsonl");
    const launcher = join(directory, "agent.mjs");
    const peer = new URL("../sessions/fixtures/acp-peer.ts", import.meta.url).href;
    await Promise.all([mkdir(workspace), mkdir(harnessState), writeFile(launches, "")]);
    await writeFile(
        launcher,
        `
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ context: process.env.MOBIUS_TEST_SESSION_CONTEXT ?? null }) + "\\n");
await import(${JSON.stringify(peer)});
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
    let socket: WebSocket | undefined;
    server.on("connection", (connected) => {
        socket = connected;
        connected.on("message", (value) => {
            const message = value.toString();
            if (message === RUNTIME_HEARTBEAT_MESSAGE) {
                connected.send(RUNTIME_HEARTBEAT_ACK_MESSAGE);
            } else {
                frames.push(message);
            }
        });
        connected.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
    });
    await listen(relay);
    const config = {
        ...createControlledRuntimeConfig(
            {
                channelId: "environment",
                defaultWorkspace: workspace,
                relayUrl: new URL(
                    `ws://127.0.0.1:${port(relay)}/mobius/api/v1/runtimes/connect?token=${"r".repeat(43)}`,
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
    let execution = runRuntime(config, cancellation.signal);
    const send = (message: string): void => {
        if (socket === undefined) {
            throw new Error("The Runtime has not connected");
        }
        socket.send(message);
    };
    const base = (sessionId: string) => ({
        additionalDirectoryIds: [],
        agentId: "codex",
        bindingId: config.bindingId,
        directoryId: "default",
        sessionId,
    });
    const ready = async (requestId: string) => {
        await vi.waitFor(
            () =>
                expect(
                    frames.some((frame) => {
                        const event = JSON.parse(frame) as { kind: string; requestId?: string };
                        if (event.kind === "session.operation.failed" && event.requestId === requestId) {
                            throw new Error(frame);
                        }
                        return (
                            (event.kind === "session.ready" || event.kind === "session.restored") &&
                            event.requestId === requestId
                        );
                    }),
                ).toBe(true),
            { timeout: 10_000 },
        );
    };
    const readLaunches = async () =>
        (await readFile(launches, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { context: string | null });
    try {
        await vi.waitFor(() => expect(socket?.readyState).toBe(1));
        for (const sessionId of ["session-a", "session-b"]) {
            send(
                encodeSessionPrepareCommand({
                    ...base(sessionId),
                    kind: "session.prepare",
                    requestId: `prepare-${sessionId}`,
                }),
            );
        }
        await Promise.all([ready("prepare-session-a"), ready("prepare-session-b")]);
        expect(await readLaunches()).toEqual(
            expect.arrayContaining([{ context: "session-a" }, { context: "session-b" }]),
        );
        for (const sessionId of ["session-a", "session-b"]) {
            send(
                encodeSessionPromptCommand({
                    ...base(sessionId),
                    kind: "session.prompt",
                    commandId: `prompt-${sessionId}`,
                    disposition: SessionPromptDisposition.Reject,
                    targetCommandId: "",
                    prompt: "hello",
                    images: [],
                    resources: [],
                }),
            );
        }
        await vi.waitFor(
            () => {
                for (const sessionId of ["session-a", "session-b"]) {
                    expect(
                        frames.some(
                            (frame) => frame.includes('"prompt.completed"') && frame.includes(`prompt-${sessionId}`),
                        ),
                    ).toBe(true);
                }
            },
            { timeout: 10_000 },
        );
        expect(await readLaunches()).toHaveLength(2);
        cancellation.abort();
        await execution;
        socket = undefined;
        cancellation = new AbortController();
        execution = runRuntime(config, cancellation.signal);
        await vi.waitFor(() => expect(socket?.readyState).toBe(1));
        send(encodeSessionRestoreCommand({ ...base("session-a"), kind: "session.restore", requestId: "restore-a" }));
        await ready("restore-a");
        expect((await readLaunches()).at(-1)).toEqual({ context: "session-a" });
        expect(agent.environment).not.toHaveProperty("MOBIUS_TEST_SESSION_CONTEXT");
    } finally {
        cancellation.abort();
        await execution;
        for (const connection of server.clients) {
            connection.terminate();
        }
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        await new Promise<void>((resolve, reject) => relay.close((error) => (error ? reject(error) : resolve())));
        await rm(directory, { recursive: true, force: true });
    }
});
