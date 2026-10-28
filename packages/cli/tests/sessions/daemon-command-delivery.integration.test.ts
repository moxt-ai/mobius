import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionLiveEvent,
    encodeSessionPromptCommand,
    NATIVE_SESSION_RESULT_KIND,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

const identity = (peer: RealDaemonPeer) => ({
    additionalDirectoryIds: [],
    agentId: "controlled-acp",
    bindingId: peer.bindingId,
    directoryId: "default",
});

const submit = (peer: RealDaemonPeer, commandId: string, prompt: string): void =>
    peer.send(
        encodeSessionPromptCommand({
            ...identity(peer),
            attachments: [],
            commandId,
            disposition: SessionPromptDisposition.Reject,
            kind: "session.prompt",
            prompt,
            sessionId: peer.sessionId,
            targetCommandId: "",
        }),
    );

const waitForLifecycle = async (peer: RealDaemonPeer, commandId: string, kind: string): Promise<void> => {
    for (;;) {
        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
        if (event.type === "lifecycle-metadata" && event.payload.kind === kind && "commandId" in event.payload) {
            if (event.payload.commandId === commandId) {
                return;
            }
        }
    }
};

/** Reads the Session execution the way a reconnecting client does, optionally naming one command. */
const readExecution = async (peer: RealDaemonPeer, commandId?: string) => {
    const requestId = randomUUID();
    peer.send(
        JSON.stringify({
            ...identity(peer),
            action: "active-turn",
            ...(commandId === undefined ? {} : { deliveryCommandId: commandId }),
            kind: "native.session.request",
            requestId,
            sessionId: peer.sessionId,
            targetSessionId: peer.sessionId,
        }),
    );
    for (;;) {
        const raw = await peer.nextMessage();
        if (decodeMessageKind(raw) !== NATIVE_SESSION_RESULT_KIND) {
            continue;
        }
        const result = decodeNativeSessionResult(raw);
        if (result.requestId === requestId && result.action === "active-turn") {
            return { raw: JSON.parse(raw) as Record<string, unknown>, result };
        }
    }
};

// @no-uc: Compatibility; a reconnecting client recovers an unconfirmed submission from the Runtime's execution receipt.
test("Given commands the Runtime finished, failed, is running or never received, When a client reads the Session execution naming each command, Then the Runtime reports each command's delivery, also after a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-command-delivery-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            {
                MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"),
                PATH: executableDirectory,
            },
            async (peer) => {
                const completed = randomUUID();
                submit(peer, completed, "The request completes");
                await waitForLifecycle(peer, completed, "prompt.completed");
                const failed = randomUUID();
                submit(peer, failed, "fail with model unavailable");
                await waitForLifecycle(peer, failed, "prompt.failed");
                const running = randomUUID();
                submit(peer, running, "hold after first delta");
                await waitForLifecycle(peer, running, "prompt.started");
                const neverReceived = randomUUID();

                expect((await readExecution(peer, completed)).result).toMatchObject({
                    command: { state: "completed", stopReason: "end_turn" },
                });
                expect((await readExecution(peer, failed)).result).toMatchObject({
                    command: { state: "failed", code: expect.any(String) },
                });
                expect((await readExecution(peer, running)).result).toMatchObject({
                    command: { state: "accepted" },
                    turn: { commandId: running, state: "running" },
                });
                expect((await readExecution(peer, neverReceived)).result).toMatchObject({
                    command: { state: "unknown" },
                });
                // A client that names no command, such as one released before delivery reads, gets the old answer.
                expect((await readExecution(peer)).raw).not.toHaveProperty("command");

                await peer.restart();
                expect((await readExecution(peer, completed)).result).toMatchObject({
                    command: { state: "completed", stopReason: "end_turn" },
                });
                expect((await readExecution(peer, running)).result).toMatchObject({
                    command: { state: "failed", code: "runtime_restarted" },
                });
                expect((await readExecution(peer, neverReceived)).result).toMatchObject({
                    command: { state: "unknown" },
                });
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 90_000);
