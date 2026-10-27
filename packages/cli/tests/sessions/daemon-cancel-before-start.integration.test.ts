import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionEvent,
    decodeSessionEventEnvelope,
    decodeSessionOperationFailedEvent,
    encodeSessionCancelCommand,
    encodeSessionPromptCommand,
    SESSION_EVENT_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test, vi } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

// @no-uc: Compatibility; conditional cancellation must never cancel a command which already started.
test("Given running and queued work, When cancellation permits only unstarted work, Then the queued work stops and the running work is preserved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "mobius-cancel-before-start-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            {
                MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"),
                PATH: executableDirectory,
            },
            async (peer) => {
                const running = randomUUID();
                const queued = randomUUID();
                const prompt = (
                    commandId: string,
                    disposition: "reject" | "queue",
                    targetCommandId: string,
                    text: string,
                ) =>
                    encodeSessionPromptCommand({
                        additionalDirectoryIds: [],
                        agentId: "controlled-acp",
                        bindingId: peer.bindingId,
                        commandId,
                        directoryId: "default",
                        disposition,
                        attachments: [],
                        kind: "session.prompt",
                        prompt: text,
                        sessionId: peer.sessionId,
                        targetCommandId,
                    });
                peer.send(prompt(running, "reject", "", "hold after first delta"));
                for (;;) {
                    const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
                    if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.started" &&
                        event.payload.commandId === running
                    ) {
                        break;
                    }
                }
                peer.send(prompt(queued, "queue", running, "This queued instruction must never execute"));
                for (;;) {
                    const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed") {
                        break;
                    }
                }
                peer.send(
                    JSON.stringify({
                        commandId: running,
                        kind: "session.cancel-before-start",
                        sessionId: peer.sessionId,
                    }),
                );
                peer.send(
                    JSON.stringify({
                        commandId: queued,
                        kind: "session.cancel-before-start",
                        sessionId: peer.sessionId,
                    }),
                );
                peer.send(
                    encodeSessionCancelCommand({
                        commandId: running,
                        kind: "session.cancel",
                        sessionId: peer.sessionId,
                    }),
                );
                const completed = new Map<string, string>();
                let queuedStarted = false;
                let runningRefusal: string | undefined;
                while (completed.size < 2) {
                    const raw = await peer.nextMessage();
                    if (decodeMessageKind(raw) === "session.operation.failed") {
                        const failure = decodeSessionOperationFailedEvent(raw);
                        if (failure.requestId === running) {
                            runningRefusal = failure.code;
                        }
                        continue;
                    }
                    if (decodeMessageKind(raw) !== SESSION_EVENT_KIND) {
                        continue;
                    }
                    for (const event of decodeSessionEventEnvelope(raw).events) {
                        if (event.type !== "lifecycle-metadata") {
                            continue;
                        }
                        if (event.payload.kind === "prompt.started" && event.payload.commandId === queued) {
                            queuedStarted = true;
                        }
                        if (event.payload.kind === "prompt.completed") {
                            completed.set(event.payload.commandId, event.payload.stopReason);
                        }
                    }
                }
                expect(queuedStarted).toBe(false);
                expect(completed.get(queued)).toBe("cancelled");
                expect(runningRefusal).toBe("turn_already_started");
                const next = randomUUID();
                peer.send(prompt(next, "reject", "", "The next request completes"));
                for (;;) {
                    const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
                    if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.completed" &&
                        event.payload.commandId === next
                    ) {
                        expect(event.payload.stopReason).toBe("end_turn");
                        break;
                    }
                }
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
    }
}, 90_000);

// @no-uc: Technical regression; cancelling an unacknowledged command prevents its delayed admission.
test("Given an unacknowledged command, When Stop arrives before its prompt, Then a recorded cancellation prevents later execution", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "mobius-cancel-admission-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            {
                MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"),
                PATH: executableDirectory,
            },
            async (peer) => {
                const stopped = randomUUID();
                peer.send(
                    JSON.stringify({
                        commandId: stopped,
                        kind: "session.cancel-before-start",
                        sessionId: peer.sessionId,
                    }),
                );
                let cancelled = false;
                while (!cancelled) {
                    const raw = await peer.nextMessage();
                    if (decodeMessageKind(raw) === "session.operation.failed") {
                        const failure = decodeSessionOperationFailedEvent(raw);
                        expect(failure.requestId).not.toBe(stopped);
                    }
                    if (decodeMessageKind(raw) !== SESSION_EVENT_KIND) {
                        continue;
                    }
                    cancelled = decodeSessionEventEnvelope(raw).events.some(
                        (event) =>
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.completed" &&
                            event.payload.commandId === stopped &&
                            event.payload.stopReason === "cancelled",
                    );
                }
                const prompt = (commandId: string) =>
                    encodeSessionPromptCommand({
                        additionalDirectoryIds: [],
                        agentId: "controlled-acp",
                        bindingId: peer.bindingId,
                        commandId,
                        directoryId: "default",
                        disposition: "reject",
                        attachments: [],
                        kind: "session.prompt",
                        prompt: "This request completes normally",
                        sessionId: peer.sessionId,
                        targetCommandId: "",
                    });
                peer.send(prompt(stopped));
                const next = randomUUID();
                peer.send(prompt(next));
                let stoppedStarted = false;
                let nextCompleted = false;
                while (!nextCompleted) {
                    const raw = await peer.nextMessage();
                    if (decodeMessageKind(raw) !== SESSION_EVENT_KIND) {
                        continue;
                    }
                    for (const event of decodeSessionEventEnvelope(raw).events) {
                        if (event.type !== "lifecycle-metadata") {
                            continue;
                        }
                        if (event.payload.kind === "prompt.started" && event.payload.commandId === stopped) {
                            stoppedStarted = true;
                        }
                        if (event.payload.kind === "prompt.completed" && event.payload.commandId === next) {
                            expect(event.payload.stopReason).toBe("end_turn");
                            nextCompleted = true;
                        }
                    }
                }
                expect(stoppedStarted).toBe(false);
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
    }
}, 90_000);
