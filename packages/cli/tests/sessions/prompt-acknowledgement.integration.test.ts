import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    encodeSessionPromptCommand,
    type SessionLiveEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

const submit = (peer: RealDaemonPeer, prompt: string, commandId: string, targetCommandId = "") =>
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

type Frame =
    | { readonly kind: "event"; readonly event: SessionLiveEvent }
    | { readonly kind: "message"; readonly message: Readonly<Record<string, unknown>> };

/** Reads the daemon's frames in order until one matches. */
async function next(peer: RealDaemonPeer, seen: Frame[], matches: (frame: Frame) => boolean): Promise<Frame> {
    for (;;) {
        const raw = await peer.nextMessage();
        const frames: Frame[] =
            decodeMessageKind(raw) === "session.event.v2"
                ? decodeSessionEventEnvelope(raw).events.map((event) => ({ kind: "event", event }))
                : [{ kind: "message", message: JSON.parse(raw) as Record<string, unknown> }];
        for (const frame of frames) {
            seen.push(frame);
            if (matches(frame)) {
                return frame;
            }
        }
    }
}

const lifecycle =
    (kind: string, commandId?: string) =>
    (frame: Frame): boolean =>
        frame.kind === "event" &&
        frame.event.type === "lifecycle-metadata" &&
        frame.event.payload.kind === kind &&
        (commandId === undefined ||
            ("commandId" in frame.event.payload && frame.event.payload.commandId === commandId));

test("Given a running prompt, When queue prompts are rejected, admitted and retried, Then the daemon answers each command for itself", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-prompt-acknowledgement-"));
    try {
        const executableDirectory = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"), PATH: executableDirectory },
            async (peer) => {
                const seen: Frame[] = [];
                const running = randomUUID();
                submit(peer, "hold after first delta", running);
                await next(peer, seen, lifecycle("prompt.started", running));

                // A queue prompt naming an unavailable target is rejected before it enters the queue.
                const rejected = randomUUID();
                submit(peer, "never queued", rejected, "not-a-command");
                await next(peer, seen, lifecycle("prompt.failed-before-start", rejected));

                // The first queue change afterwards belongs to the prompt that is admitted, and names it.
                const admitted = randomUUID();
                submit(peer, "queued behind the running prompt", admitted, running);
                const change = await next(peer, seen, lifecycle("session.queue.changed"));
                expect(change.kind === "event" && change.event.payload).toEqual({
                    changedByCommandId: admitted,
                    kind: "session.queue.changed",
                });

                // A retry of the running command records nothing new and is answered directly.
                submit(peer, "hold after first delta", running);
                const accepted = await next(
                    peer,
                    seen,
                    (frame) => frame.kind === "message" && frame.message["kind"] === "session.prompt.accepted",
                );
                expect(accepted.kind === "message" && accepted.message).toEqual({
                    kind: "session.prompt.accepted",
                    requestId: running,
                    sessionId: peer.sessionId,
                    state: "running",
                });

                peer.send(JSON.stringify({ kind: "session.cancel", commandId: running, sessionId: peer.sessionId }));
                await next(peer, seen, lifecycle("prompt.completed", running));
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 120_000);
