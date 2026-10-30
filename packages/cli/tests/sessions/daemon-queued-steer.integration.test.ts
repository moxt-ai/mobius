import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionOperationFailedEvent,
    encodeSessionPromptCommand,
    encodeSessionPromptDispositionCommand,
    SESSION_PROMPT_DISPOSITION_KIND,
    type SessionLiveEvent,
    type SessionOperationFailedEvent,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test, vi } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

const submit = (peer: RealDaemonPeer, prompt: string, targetCommandId = "") => {
    const commandId = randomUUID();
    peer.send(
        encodeSessionPromptCommand({
            additionalDirectoryIds: [],
            agentId: "controlled-acp",
            attachments: [],
            bindingId: peer.bindingId,
            commandId,
            directoryId: "default",
            disposition: targetCommandId === "" ? "reject" : "queue",
            kind: "session.prompt",
            prompt,
            sessionId: peer.sessionId,
            targetCommandId,
        }),
    );
    return commandId;
};

const steer = (peer: RealDaemonPeer, commandId: string, sessionId = peer.sessionId) =>
    peer.send(
        encodeSessionPromptDispositionCommand({
            kind: SESSION_PROMPT_DISPOSITION_KIND,
            commandId,
            sessionId,
            disposition: SessionPromptDisposition.Steer,
        }),
    );

const cancel = (peer: RealDaemonPeer, commandId: string) =>
    peer.send(JSON.stringify({ kind: "session.cancel", commandId, sessionId: peer.sessionId }));

const observe = (peer: RealDaemonPeer) => {
    const events: SessionLiveEvent[] = [];
    const failures: SessionOperationFailedEvent[] = [];
    const next = async () => {
        const raw = await peer.nextMessage();
        switch (decodeMessageKind(raw)) {
            case "session.event.v2":
                events.push(...decodeSessionEventEnvelope(raw).events);
                break;
            case "session.operation.failed":
                failures.push(decodeSessionOperationFailedEvent(raw));
                break;
        }
    };
    return {
        events,
        failures,
        until: async (ready: () => boolean) => {
            while (!ready()) {
                await next();
            }
        },
        lifecycle: async (kind: string, commandId?: string) => {
            while (
                !events.some(
                    (event) =>
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === kind &&
                        (commandId === undefined ||
                            ("commandId" in event.payload && event.payload.commandId === commandId)),
                )
            ) {
                await next();
            }
        },
    };
};

const scenario = async (run: (peer: RealDaemonPeer) => Promise<void>) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "mobius-queued-steer-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            {
                MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"),
                PATH: executableDirectory,
            },
            run,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
    }
};

test("Given queued work has started or completed, When a client sends a late steer, Then it receives the actual state without executing the message again", async () => {
    await scenario(async (peer) => {
        const observed = observe(peer);
        const running = submit(peer, "hold after first delta");
        await observed.lifecycle("prompt.started", running);
        const queued = submit(peer, "hold after first delta", running);
        await observed.lifecycle("session.queue.changed");
        cancel(peer, running);
        await observed.lifecycle("prompt.started", queued);
        steer(peer, queued);
        await observed.until(() => observed.failures.length === 1);
        expect(observed.failures[0]).toMatchObject({
            requestId: queued,
            sessionId: peer.sessionId,
            code: "turn_already_started",
        });
        cancel(peer, queued);
        await observed.lifecycle("prompt.completed", queued);
        steer(peer, queued);
        steer(peer, queued, "another-session");
        await observed.until(() => observed.failures.length === 3);
        expect(observed.failures.slice(1)).toMatchObject([
            { requestId: queued, sessionId: peer.sessionId, code: "turn_already_started" },
            { requestId: queued, sessionId: "another-session", code: "turn_not_active" },
        ]);
        expect(
            observed.events.filter(
                (event) =>
                    event.type === "lifecycle-metadata" &&
                    event.payload.kind === "prompt.started" &&
                    event.payload.commandId === queued,
            ),
        ).toHaveLength(1);
        const diagnostics = await peer.readDiagnostics();
        expect(diagnostics).toContain('"event":"session_prompt_disposition_failed"');
        expect(diagnostics).toContain(`"commandId":"${queued}"`);
        expect(diagnostics).not.toContain("hold after first delta");
    });
});

test("Given a queued instruction, When two clients request steering together, Then the instruction is delivered once and any late refusal identifies its state", async () => {
    await scenario(async (peer) => {
        const observed = observe(peer);
        const running = submit(peer, "wait for steering");
        await observed.until(() =>
            observed.events.some(
                (event) => event.type === "acp" && event.payload.sessionUpdate === "agent_message_chunk",
            ),
        );
        const instruction = "Apply the queued instruction once";
        const queued = submit(peer, instruction, running);
        await observed.lifecycle("session.queue.changed");
        steer(peer, queued);
        steer(peer, queued);
        await observed.lifecycle("prompt.completed", queued);
        await observed.lifecycle("prompt.completed", running);
        expect(observed.failures.every((failure) => failure.code === "turn_already_started")).toBe(true);
        expect(
            observed.events.filter(
                (event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "user_message_chunk" &&
                    event.payload.content.type === "text" &&
                    event.payload.content.text === instruction,
            ),
        ).toHaveLength(1);
        expect(observed.events).toContainEqual(
            expect.objectContaining({
                type: "acp",
                payload: expect.objectContaining({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: `Steered: ${instruction}` },
                }),
            }),
        );
    });
});
