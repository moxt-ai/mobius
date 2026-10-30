import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionOperationFailedEvent,
    encodeSessionPromptCommand,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test, vi } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

async function observe(peer: RealDaemonPeer, ids: readonly string[]) {
    const pending = new Set(ids);
    const started: string[] = [];
    const failures: string[] = [];
    const cancelled: string[] = [];
    let output = "";
    while (pending.size > 0) {
        const raw = await peer.nextMessage();
        const kind = decodeMessageKind(raw);
        if (kind === "session.operation.failed") {
            const event = decodeSessionOperationFailedEvent(raw);
            if (pending.delete(event.requestId)) {
                failures.push(event.code ?? "unknown");
            }
        } else if (kind === "session.event.v2") {
            for (const event of decodeSessionEventEnvelope(raw).events) {
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
                if (payload.kind === "prompt.started") {
                    started.push(payload.commandId);
                }
                if (
                    payload.kind === "prompt.completed" &&
                    pending.has(payload.commandId) &&
                    payload.stopReason === "cancelled" &&
                    payload.execution === "not-started"
                ) {
                    cancelled.push(payload.commandId);
                }
                if (
                    payload.kind === "prompt.completed" ||
                    payload.kind === "prompt.failed" ||
                    payload.kind === "prompt.failed-before-start"
                ) {
                    pending.delete(payload.commandId);
                }
            }
        }
    }
    return { started, failures, cancelled, output };
}

for (const admission of ["before-admission", "queued"] as const) {
    test(`Given a command was explicitly cancelled ${admission}, When receipts are evicted and the Runtime restarts, Then the command cannot execute again and cancellation remains unstarted`, async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-30T08:00:00Z"));
        const directory = await mkdtemp(join(tmpdir(), "mobius-cancelled-identity-"));
        try {
            const executable = await writeControlledAcpExecutable(directory);
            await withControlledDaemon(
                new ControlledAcpAgentSpecification(),
                { MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executable },
                async (peer) => {
                    const commandId = "a-cancelled-original";
                    const cancel = (id: string) =>
                        peer.send(
                            JSON.stringify({
                                kind: "session.cancel-before-start",
                                sessionId: peer.sessionId,
                                commandId: id,
                            }),
                        );
                    const prompt = (
                        id: string,
                        text: string,
                        disposition: "reject" | "queue" = "reject",
                        targetCommandId = "",
                    ) =>
                        encodeSessionPromptCommand({
                            additionalDirectoryIds: [],
                            agentId: "controlled-acp",
                            attachments: [],
                            bindingId: peer.bindingId,
                            commandId: id,
                            directoryId: "default",
                            disposition,
                            kind: "session.prompt",
                            prompt: text,
                            sessionId: peer.sessionId,
                            targetCommandId,
                        });
                    const original = prompt(
                        commandId,
                        "This command was already cancelled",
                        admission === "queued" ? "queue" : "reject",
                        admission === "queued" ? "running-hold" : "",
                    );
                    if (admission === "queued") {
                        peer.send(prompt("running-hold", "hold after first delta"));
                        for (;;) {
                            const raw = await peer.nextMessage();
                            if (
                                decodeMessageKind(raw) === "session.event.v2" &&
                                decodeSessionEventEnvelope(raw).events.some(
                                    (event) =>
                                        event.type === "acp" && event.payload.sessionUpdate === "agent_message_chunk",
                                )
                            ) {
                                break;
                            }
                        }
                        peer.send(original);
                        for (;;) {
                            const raw = await peer.nextMessage();
                            if (
                                decodeMessageKind(raw) === "session.event.v2" &&
                                decodeSessionEventEnvelope(raw).events.some(
                                    (event) =>
                                        event.type === "lifecycle-metadata" &&
                                        event.payload.kind === "session.queue.changed",
                                )
                            ) {
                                break;
                            }
                        }
                    }
                    cancel(commandId);
                    expect(await observe(peer, [commandId])).toEqual({
                        started: [],
                        failures: [],
                        cancelled: [commandId],
                        output: "",
                    });
                    if (admission === "queued") {
                        peer.send(
                            JSON.stringify({
                                kind: "session.cancel",
                                sessionId: peer.sessionId,
                                commandId: "running-hold",
                            }),
                        );
                        await observe(peer, ["running-hold"]);
                    }
                    const pruners = Array.from(
                        { length: 1026 },
                        (_, index) => `z-prune-${String(index).padStart(4, "0")}`,
                    );
                    for (const id of pruners) {
                        cancel(id);
                    }
                    await observe(peer, pruners);
                    const checkCancelled = async () => {
                        peer.send(original);
                        expect(await observe(peer, [commandId])).toEqual({
                            started: [],
                            output: "",
                            cancelled: [],
                            failures: ["command_identity_conflict"],
                        });
                        cancel(commandId);
                        expect(await observe(peer, [commandId])).toEqual({
                            started: [],
                            failures: [],
                            cancelled: [commandId],
                            output: "",
                        });
                    };
                    await checkCancelled();
                    await peer.restart();
                    await checkCancelled();
                    peer.send(prompt("new-intent", "A new intent still runs"));
                    expect((await observe(peer, ["new-intent"])).output).toContain(
                        `Controlled ACP turn ${admission === "queued" ? 2 : 1}: A new intent still runs`,
                    );
                },
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
            vi.useRealTimers();
        }
    }, 90_000);
}
