import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionOperationFailedEvent,
    encodeSessionCancelCommand,
    encodeSessionPromptCommand,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

type Settlement = { readonly kind: "completed" } | { readonly kind: "failed"; readonly code: string | undefined };

async function observe(peer: RealDaemonPeer, commandIds: readonly string[]) {
    const pending = new Set(commandIds);
    const outcomes = new Map<string, Settlement>();
    const completedCommandIds: string[] = [];
    const restatedCommandIds: string[] = [];
    const unstartedCommandIds: string[] = [];
    let output = "";
    while (pending.size > 0) {
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === "session.operation.failed") {
            const failure = decodeSessionOperationFailedEvent(message);
            if (pending.delete(failure.requestId)) {
                outcomes.set(failure.requestId, { kind: "failed", code: failure.code });
            }
        } else if (kind === "session.event.v2") {
            for (const event of decodeSessionEventEnvelope(message).events) {
                if (event.type === "acp") {
                    if (
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        output += event.payload.content.text;
                    }
                    continue;
                }
                const payload = event.payload;
                if (payload.kind === "prompt.completed") {
                    (event.mobiusMetadata?.restated === true ? restatedCommandIds : completedCommandIds).push(
                        payload.commandId,
                    );
                    if (payload.execution === "not-started") {
                        unstartedCommandIds.push(payload.commandId);
                    }
                    if (pending.delete(payload.commandId)) {
                        outcomes.set(payload.commandId, { kind: "completed" });
                    }
                } else if (
                    (payload.kind === "prompt.failed" || payload.kind === "prompt.failed-before-start") &&
                    pending.delete(payload.commandId)
                ) {
                    outcomes.set(payload.commandId, { kind: "failed", code: payload.code });
                }
            }
        }
    }
    return { outcomes, output, completedCommandIds, restatedCommandIds, unstartedCommandIds };
}

test("Given an executed command, When its receipt is evicted and the daemon restarts, Then retries and delayed cancellations preserve its executed identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-execution-identity-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executableDirectory },
            async (peer) => {
                const original: SessionPromptCommand = {
                    additionalDirectoryIds: [],
                    agentId: "controlled-acp",
                    attachments: [],
                    bindingId: peer.bindingId,
                    commandId: randomUUID(),
                    directoryId: "default",
                    disposition: SessionPromptDisposition.Reject,
                    kind: "session.prompt",
                    prompt: "Original operation",
                    sessionId: peer.sessionId,
                    targetCommandId: "",
                };
                const send = (command: SessionPromptCommand) => peer.send(encodeSessionPromptCommand(command));
                send(original);
                const first = await observe(peer, [original.commandId]);
                expect(first.outcomes.get(original.commandId)).toEqual({ kind: "completed" });
                expect(first.output).toContain("Controlled ACP turn 1: Original operation");

                // A fresh prompt's Agent turn number exposes any accidental re-execution.
                send(original);
                const control = { ...original, commandId: randomUUID(), prompt: "Before eviction" };
                send(control);
                const beforeEviction = await observe(peer, [control.commandId]);
                expect(beforeEviction.output).toContain("Controlled ACP turn 2: Before eviction");
                expect(beforeEviction.completedCommandIds).toEqual([control.commandId]);
                // The retry is answered from the receipt: its outcome is restated, not recorded again.
                expect(beforeEviction.restatedCommandIds).toEqual([original.commandId]);

                const rejected = Array.from({ length: 1_026 }, () => randomUUID());
                for (const commandId of rejected) {
                    send({ ...original, commandId, agentId: "missing-agent" });
                }
                const failures = await observe(peer, rejected);
                for (const outcome of failures.outcomes.values()) {
                    expect(outcome.kind).toBe("failed");
                }

                const cancelExpired = async () => {
                    peer.send(
                        encodeSessionCancelCommand({
                            kind: "session.cancel",
                            commandId: original.commandId,
                            sessionId: peer.sessionId,
                        }),
                    );
                    const cancelled = await observe(peer, [original.commandId]);
                    expect(cancelled.outcomes.get(original.commandId)).toEqual({ kind: "completed" });
                    expect(cancelled.unstartedCommandIds).not.toContain(original.commandId);
                    peer.send(
                        JSON.stringify({
                            kind: "session.cancel-before-start",
                            commandId: original.commandId,
                            sessionId: peer.sessionId,
                        }),
                    );
                    expect((await observe(peer, [original.commandId])).outcomes.get(original.commandId)).toEqual({
                        kind: "failed",
                        code: "turn_already_started",
                    });
                };
                await cancelExpired();
                send(original);
                expect((await observe(peer, [original.commandId])).outcomes.get(original.commandId)).toEqual({
                    kind: "failed",
                    code: "command_result_expired",
                });
                send({ ...original, prompt: "Different operation" });
                expect((await observe(peer, [original.commandId])).outcomes.get(original.commandId)).toEqual({
                    kind: "failed",
                    code: "command_identity_conflict",
                });

                await peer.restart();
                await cancelExpired();
                send(original);
                expect((await observe(peer, [original.commandId])).outcomes.get(original.commandId)).toEqual({
                    kind: "failed",
                    code: "command_result_expired",
                });
                const afterRestart = { ...original, commandId: randomUUID(), prompt: "After restart" };
                send(afterRestart);
                expect((await observe(peer, [afterRestart.commandId])).output).toContain(
                    "Controlled ACP turn 3: After restart",
                );
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 90_000);
