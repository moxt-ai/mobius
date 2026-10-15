import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    type AgentApp,
    type AgentConnection,
    agent as createAgentApp,
    methods,
    PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import {
    decodeMessageKind,
    decodeSessionClosedEvent,
    decodeSessionOperationFailedEvent,
    decodeSessionStatusChangedEvent,
    encodeSessionCloseCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test, vi } from "vitest";
import type {
    AcpEndpointTermination,
    InProcessAcpEndpoint,
    InProcessAcpEndpointFactory,
} from "../../src/acp/in-process/acp-endpoint.ts";
import { InProcessAcpAgentDefinition } from "../../src/agent-catalog/agent-specification.ts";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { prepareNewRealSession, withRealDaemon } from "../support/agents/real-daemon.ts";

const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

class ControlledCloseEndpoint implements InProcessAcpEndpoint {
    readonly #app: AgentApp;
    readonly #closeGate: Promise<void>;
    readonly #closeStarted: (() => void) | null;
    #connection: AgentConnection | null = null;
    readonly #termination = Promise.withResolvers<AcpEndpointTermination>();
    readonly terminated = this.#termination.promise;

    constructor(closeGate: Promise<void>, closeStarted: (() => void) | null) {
        this.#closeGate = closeGate;
        this.#closeStarted = closeStarted;
        this.#app = createAgentApp({ name: "controlled-close-agent" })
            .onConnect((connection) => {
                this.#connection = connection;
            })
            .onRequest(methods.agent.initialize, () => ({
                agentCapabilities: {
                    loadSession: false,
                    promptCapabilities: { embeddedContext: false, image: false },
                    sessionCapabilities: { close: {} },
                },
                agentInfo: { name: "Controlled Close Agent", version: "1.0.0" },
                authMethods: [],
                protocolVersion: PROTOCOL_VERSION,
            }))
            .onRequest(methods.agent.session.new, () => ({ sessionId: crypto.randomUUID() }))
            .onRequest(methods.agent.session.close, () => ({}));
    }

    readonly app = (): AgentApp => this.#app;
    readonly initialize = async (signal: AbortSignal): Promise<void> => signal.throwIfAborted();
    readonly close = async (): Promise<void> => {
        this.#closeStarted?.();
        await this.#closeGate;
        this.#connection?.close();
        this.#termination.resolve({ kind: "closed" });
    };
}

class ControlledCloseAgentSpecification extends InProcessAcpAgentDefinition {
    readonly agentExecutable = "node";
    readonly id = "controlled-close";
    readonly label = "Controlled Close";
    override readonly maximumTestedAgentVersion = process.versions.node;
    override readonly minimumSupportedAgentVersion = process.versions.node;
    readonly #closeGate = Promise.withResolvers<void>();
    readonly closeStarted = Promise.withResolvers<void>();
    #createdEndpoints = 0;
    readonly createEndpoint: InProcessAcpEndpointFactory = () => {
        const runtimeEndpoint = this.#createdEndpoints > 0;
        this.#createdEndpoints += 1;
        return new ControlledCloseEndpoint(
            runtimeEndpoint ? this.#closeGate.promise : Promise.resolve(),
            runtimeEndpoint ? this.closeStarted.resolve : null,
        );
    };

    constructor() {
        super("MOBIUS_TEST_CONTROLLED_CLOSE_PATH");
    }

    readonly releaseClose = (): void => this.#closeGate.resolve();
}

test("Given retained Agent teardown does not finish, When the Session close deadline elapses, Then the daemon reports a typed timeout", async () => {
    const agent = new ControlledCloseAgentSpecification();
    await withRealDaemon(agent, { MOBIUS_TEST_CONTROLLED_CLOSE_PATH: process.execPath }, async (peer) => {
        const sessionId = await prepareNewRealSession(peer, agent.id);
        vi.useFakeTimers({ toFake: ["clearTimeout", "setTimeout"] });
        try {
            const requestId = crypto.randomUUID();
            peer.send(
                encodeSessionCloseCommand({
                    kind: "session.close",
                    requestId,
                    sessionId,
                }),
            );
            await agent.closeStarted.promise;
            const response = peer.nextMessage();
            await vi.advanceTimersByTimeAsync(30_000);
            expect(decodeSessionOperationFailedEvent(await response)).toEqual({
                code: "session_close_timeout",
                kind: "session.operation.failed",
                message: "The Session could not close before its deadline",
                requestId,
                sessionId,
            });
        } finally {
            agent.releaseClose();
            await vi.runAllTimersAsync();
            vi.useRealTimers();
        }
    });
});

test("Given an active Agent session holding an exclusive writer lock, When a public close command reaches the daemon, Then the process stops and releases the writer lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-session-close-"));
    const executableDirectory = join(directory, "bin");
    const executable = join(executableDirectory, "controlled-acp");
    const nativeStateDirectory = join(directory, "native");
    await Promise.all([mkdir(executableDirectory), mkdir(nativeStateDirectory)]);
    await writeFile(
        executable,
        `#!${process.execPath}\nif (process.argv.includes("--version")) {\n  process.stdout.write("1.0.0\\n");\n} else {\n  process.argv.push(\n    "--agent-name", "Controlled ACP",\n    "--agent-version", "1.0.0",\n    "--exclusive-writer",\n    "--no-load-session",\n    "--http-mcp",\n    "--no-additional-directories",\n    "--no-delete-session",\n    "--no-fork-session",\n    "--no-embedded-context",\n  );\n  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});\n}\n`,
        { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    try {
        await withRealDaemon(
            new ControlledAcpAgentSpecification(),
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory, PATH: executableDirectory },
            async (peer) => {
                const sessionId = await prepareNewRealSession(peer, "controlled-acp");
                const promptCommandId = crypto.randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        additionalDirectoryIds: [],
                        agentId: "controlled-acp",
                        bindingId: peer.bindingId,
                        commandId: promptCommandId,
                        directoryId: "default",
                        disposition: SessionPromptDisposition.Reject,
                        images: [],
                        kind: "session.prompt",
                        prompt: "interleave progress and hold",
                        resources: [],
                        sessionId,
                        targetCommandId: "",
                    }),
                );
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) !== "session.status.changed") {
                        continue;
                    }
                    const event = decodeSessionStatusChangedEvent(message);
                    if (
                        event.sessionId === sessionId &&
                        event.status.kind === "working" &&
                        event.status.commandId === promptCommandId
                    ) {
                        break;
                    }
                }
                const closeRequestId = crypto.randomUUID();
                peer.send(
                    encodeSessionCloseCommand({
                        kind: "session.close",
                        requestId: closeRequestId,
                        sessionId,
                    }),
                );
                for (;;) {
                    const message = await peer.nextMessage();
                    const kind = decodeMessageKind(message);
                    if (kind === "session.operation.failed") {
                        const failure = decodeSessionOperationFailedEvent(message);
                        if (failure.requestId === closeRequestId) {
                            throw new Error(JSON.stringify(failure));
                        }
                        continue;
                    }
                    if (kind !== "session.closed") {
                        continue;
                    }
                    expect(decodeSessionClosedEvent(message)).toEqual({
                        kind: "session.closed",
                        requestId: closeRequestId,
                        sessionId,
                    });
                    break;
                }
                expect((await readdir(nativeStateDirectory)).filter((entry) => entry.endsWith(".writer"))).toEqual([]);
            },
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
