import { env } from "cloudflare:workers";
import { decodeSessionRecordingDirectory, decodeSessionRecordingHistory } from "@moxt-ai/mobius-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordingWorker } from "../src/worker.ts";

let testNumber = 0;
let projectId = "";
beforeEach(() => {
    projectId = `project-live-${++testNumber}`;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T00:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());
const worker = createRecordingWorker();
const event = {
    eventId: "live-event-1",
    position: "0",
    provenance: { kind: "original" },
    recordedAt: "2026-10-09T00:00:00.000Z",
    sessionGenerationId: "session-generation-live",
    sessionId: "live-session",
    type: "acp",
    payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Live reply" } },
};
function write(runtimeId = "runtime-live", envelope: unknown = { kind: "session.event.v2", events: [event] }): Request {
    return new Request("https://recording.internal/v1/session-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, runtimeId, envelope }),
    });
}

describe("Recording live V2 events", () => {
    it("Given an event broadcast to browsers, When Recording receives the same V2 event, Then history retains its identity and payload unchanged", async () => {
        expect((await worker.fetch(write(), env)).status).toBe(201);
        const response = await worker.fetch(
            new Request(
                `https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions/live-session/events`,
            ),
            env,
        );
        expect(response.status).toBe(200);
        expect(decodeSessionRecordingHistory(await response.text())).toEqual({
            sessionId: event.sessionId,
            events: [event],
        });
    });
    it("Given a legacy event envelope, When a caller submits it, Then Recording rejects the retired contract", async () => {
        const response = await worker.fetch(
            write("runtime-live", {
                kind: "session.event",
                sessionId: event.sessionId,
                payload: JSON.stringify({ kind: "session.started" }),
            }),
            env,
        );
        expect(response.status).toBe(400);
    });
    it("Given a recorded session belongs to a Runtime, When another Runtime submits an event for it, Then its history is protected", async () => {
        expect((await worker.fetch(write(), env)).status).toBe(201);
        expect((await worker.fetch(write("runtime-other"), env)).status).toBe(409);
    });
});

it("Given a recording exists, When a different Runtime reads it, Then its contents are unavailable", async () => {
    expect((await worker.fetch(write(), env)).status).toBe(201);
    expect(
        (
            await worker.fetch(
                new Request(
                    `https://recording.internal/v1/projects/${projectId}/runtimes/runtime-other/sessions/live-session/events`,
                ),
                env,
            )
        ).status,
    ).toBe(404);
});
it("Given prompt context and a later Agent title, When the Runtime loads its recorded directory, Then the Session identity and latest title are returned", async () => {
    const context = { agentId: "codex", directoryId: "default", additionalDirectoryIds: ["docs"] };
    const requested = {
        ...event,
        eventId: "requested",
        type: "lifecycle-metadata",
        payload: {
            kind: "prompt.requested",
            commandId: "command",
            content: [{ type: "text", text: "First prompt" }],
            context,
        },
    };
    expect(
        (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: [requested] }), env)).status,
    ).toBe(201);
    const titled = {
        ...event,
        eventId: "title",
        recordedAt: "2026-10-09T01:00:00.000Z",
        payload: { sessionUpdate: "session_info_update", title: "Agent title" },
    };
    expect(
        (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: [titled] }), env)).status,
    ).toBe(201);
    expect((await worker.fetch(write(), env)).status).toBe(201);
    const response = await worker.fetch(
        new Request(`https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions`),
        env,
    );
    expect(decodeSessionRecordingDirectory(await response.text())).toEqual({
        sessions: [
            {
                ...context,
                runtimeId: "runtime-live",
                sessionId: event.sessionId,
                status: "running",
                title: "Agent title",
                updatedAt: titled.recordedAt,
            },
        ],
    });
});
it("Given a prompt that later completes, When the Runtime loads its recorded directory, Then the Session status reflects the latest lifecycle outcome", async () => {
    const context = { agentId: "codex", directoryId: "default", additionalDirectoryIds: [] };
    const lifecycle = (kind: string, recordedAt: string, payload: Record<string, unknown>) => ({
        ...event,
        eventId: kind,
        recordedAt,
        type: "lifecycle-metadata",
        payload: { commandId: "command", kind, ...payload },
    });
    const requested = lifecycle("prompt.requested", "2026-10-09T00:00:00.000Z", {
        content: [{ type: "text", text: "Run" }],
        context,
    });
    expect(
        (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: [requested] }), env)).status,
    ).toBe(201);
    expect(
        (
            await worker.fetch(
                write("runtime-live", {
                    kind: "session.event.v2",
                    events: [
                        lifecycle("prompt.failed", "2026-10-09T00:30:00.000Z", {
                            attemptId: "attempt-1",
                            code: "agent_crashed",
                            message: "The Agent exited unexpectedly",
                        }),
                    ],
                }),
                env,
            )
        ).status,
    ).toBe(201);
    const directory = await worker.fetch(
        new Request(`https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions`),
        env,
    );
    expect(decodeSessionRecordingDirectory(await directory.text())).toMatchObject({
        sessions: [{ sessionId: event.sessionId, status: "failed" }],
    });
    expect(
        (
            await worker.fetch(
                write("runtime-live", {
                    kind: "session.event.v2",
                    events: [lifecycle("prompt.completed", "2026-10-09T01:00:00.000Z", { stopReason: "end_turn" })],
                }),
                env,
            )
        ).status,
    ).toBe(201);
    const recovered = await worker.fetch(
        new Request(`https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions`),
        env,
    );
    expect(decodeSessionRecordingDirectory(await recovered.text())).toMatchObject({
        sessions: [{ sessionId: event.sessionId, status: "idle" }],
    });
});
it("Given a session that never requested a prompt, When the Runtime loads its recorded directory, Then the session is not listed", async () => {
    expect((await worker.fetch(write(), env)).status).toBe(201);
    const response = await worker.fetch(
        new Request(`https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions`),
        env,
    );
    expect(response.status).toBe(200);
    expect(decodeSessionRecordingDirectory(await response.text())).toEqual({ sessions: [] });
});
it("Given a duplicate live frame, When Recording receives both broadcasts, Then it keeps both without inventing delivery guarantees", async () => {
    expect((await worker.fetch(write(), env)).status).toBe(201);
    expect((await worker.fetch(write(), env)).status).toBe(201);
    const response = await worker.fetch(
        new Request(
            `https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions/live-session/events`,
        ),
        env,
    );
    expect(decodeSessionRecordingHistory(await response.text()).events).toEqual([event, event]);
});
it("Given an invalid execution context, When submitted at the Recording boundary, Then it is rejected", async () => {
    const invalid = {
        ...event,
        type: "lifecycle-metadata",
        payload: {
            kind: "prompt.requested",
            commandId: "command",
            content: [{ type: "text", text: "Prompt" }],
            context: { agentId: "codex", directoryId: "default", additionalDirectoryIds: ["../docs"] },
        },
    };
    expect(
        (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: [invalid] }), env)).status,
    ).toBe(400);
});
