import { env } from "cloudflare:workers";
import { encodeSessionRecordingWrite, type SessionLiveEvent } from "@moxt-ai/mobius-sdk/protocol";
import { describe, expect, it } from "vitest";
import { createRecordingWorker } from "../src/worker.ts";

const worker = createRecordingWorker();
const context = { agentId: "pressure", directoryId: "default", additionalDirectoryIds: [] };

function requested(sessionId: string, position = 1): SessionLiveEvent {
    return {
        sessionId,
        eventId: `${sessionId}-${position}`,
        position: String(position),
        sessionGenerationId: "batch-generation",
        recordedAt: "2026-10-21T00:00:00.000Z",
        type: "lifecycle-metadata",
        payload: {
            kind: "prompt.requested",
            commandId: `${sessionId}-turn`,
            content: [{ type: "text", text: "Batch title" }],
            context,
        },
    };
}

function chunk(sessionId: string, position: number): SessionLiveEvent {
    return {
        ...requested(sessionId, position),
        type: "acp",
        payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Output ${position}` } },
    };
}

function completed(sessionId: string, position: number): SessionLiveEvent {
    return {
        ...requested(sessionId, position),
        type: "lifecycle-metadata",
        payload: { kind: "prompt.completed", commandId: `${sessionId}-turn`, stopReason: "end_turn" },
    };
}

async function write(
    projectId: string,
    runtimeId: string,
    events: readonly SessionLiveEvent[],
    path = "session-event-batches",
) {
    return await worker.fetch(
        new Request(`https://recording.test/v1/${path}`, {
            method: "POST",
            body: encodeSessionRecordingWrite({ projectId, runtimeId, envelope: { kind: "session.event.v2", events } }),
        }),
        env,
    );
}

async function directory(projectId: string, runtimeId: string) {
    return await (
        await worker.fetch(
            new Request(`https://recording.test/v1/projects/${projectId}/runtimes/${runtimeId}/sessions`),
            env,
        )
    ).json();
}

// @no-uc: Performance; bounded multi-Session ingestion must preserve each history and directory lifecycle.
describe("Recording multi-Session batches", () => {
    it("Given interleaved Sessions, When one batch is recorded, Then each complete history and directory outcome is retained", async () => {
        const sessions = ["batch-one", "batch-two", "batch-three"];
        const events = [
            ...sessions.map((id) => requested(id)),
            ...Array.from({ length: 8 }, (_, index) => sessions.map((id) => chunk(id, index + 2))).flat(),
            ...sessions.map((id) => completed(id, 10)),
        ];
        const response = await write("batch-project", "batch-runtime", events);
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({
            results: sessions.map((sessionId) => ({ sessionId, kind: "recorded" })),
        });
        for (const id of sessions) {
            const history = await worker.fetch(
                new Request(
                    `https://recording.test/v1/projects/batch-project/runtimes/batch-runtime/sessions/${id}/events`,
                ),
                env,
            );
            expect(await history.json()).toMatchObject({
                sessionId: id,
                events: events.filter((event) => event.sessionId === id),
            });
        }
        expect(await directory("batch-project", "batch-runtime")).toEqual({
            sessions: sessions
                .map((sessionId) => ({
                    ...context,
                    sessionId,
                    runtimeId: "batch-runtime",
                    title: "Batch title",
                    status: "idle",
                    updatedAt: "2026-10-21T00:00:00.000Z",
                }))
                .sort((a, b) => b.sessionId.localeCompare(a.sessionId)),
        });
    });

    it("Given an identity conflict in one Session, When a mixed batch arrives, Then the healthy Session records and the conflicting history stays unchanged", async () => {
        expect(
            (await write("partial-project", "old-runtime", [requested("owned-session")], "session-events")).status,
        ).toBe(201);
        const response = await write("partial-project", "new-runtime", [
            requested("owned-session", 2),
            requested("healthy-session"),
            completed("healthy-session", 2),
        ]);
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({
            results: [
                { sessionId: "owned-session", kind: "failed", code: "write_failed" },
                { sessionId: "healthy-session", kind: "recorded" },
            ],
        });
        expect(await directory("partial-project", "new-runtime")).toMatchObject({
            sessions: [{ sessionId: "healthy-session", status: "idle" }],
        });
        const old = await worker.fetch(
            new Request(
                "https://recording.test/v1/projects/partial-project/runtimes/old-runtime/sessions/owned-session/events",
            ),
            env,
        );
        expect(await old.json()).toMatchObject({ events: [requested("owned-session")] });
    });

    it("Given completion followed by a new request and title reset, When a batch is folded, Then its ordered status, context and fallback title survive", async () => {
        const id = "ordered-session";
        const reset: SessionLiveEvent = {
            ...chunk(id, 3),
            type: "acp",
            payload: { sessionUpdate: "session_info_update", title: "" },
        };
        const later: SessionLiveEvent = {
            ...requested(id, 4),
            type: "lifecycle-metadata",
            payload: {
                kind: "prompt.requested",
                commandId: "next-turn",
                content: [{ type: "text", text: "New fallback" }],
                context: { ...context, agentId: "next-agent" },
            },
        };
        const older = { ...chunk(id, 5), recordedAt: "2026-10-20T00:00:00.000Z" };
        expect(
            (await write("ordered-project", "ordered-runtime", [requested(id), completed(id, 2), reset, later, older]))
                .status,
        ).toBe(201);
        expect(await directory("ordered-project", "ordered-runtime")).toEqual({
            sessions: [
                {
                    ...context,
                    agentId: "next-agent",
                    sessionId: id,
                    runtimeId: "ordered-runtime",
                    title: "New fallback",
                    status: "running",
                    updatedAt: "2026-10-21T00:00:00.000Z",
                },
            ],
        });
    });
});
