import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    decodeSessionRecordingDirectory,
    encodeSessionRecordingWrite,
    type SessionLiveEvent,
} from "@moxt-ai/mobius-sdk/protocol";
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
    const response = await worker.fetch(
        new Request(`https://recording.test/v1/projects/${projectId}/runtimes/${runtimeId}/sessions`),
        env,
    );
    expect(response.status).toBe(200);
    return decodeSessionRecordingDirectory(await response.text());
}

// @no-uc: Performance; bounded multi-Session ingestion must preserve each history and directory lifecycle.
describe("Recording multi-Session batches", () => {
    it("Given a large legacy directory, When it is read across batches, Then every summary survives and a later missing history fails the body instead of returning a partial directory", async () => {
        const projectId = "large-legacy-project";
        const runtimeId = "large-legacy-runtime";
        const sessions = Array.from({ length: 257 }, (_, index) => `large-${String(index).padStart(4, "0")}`);
        for (let offset = 0; offset < sessions.length; offset += 128) {
            const response = await write(
                projectId,
                runtimeId,
                sessions.slice(offset, offset + 128).flatMap((id) => [requested(id), completed(id, 2)]),
            );
            expect(response.status).toBe(201);
            await response.body?.cancel();
        }
        const summaries = await directory(projectId, runtimeId);
        expect(summaries.sessions.map(({ sessionId, status }) => ({ sessionId, status }))).toEqual(
            [...sessions].reverse().map((sessionId) => ({ sessionId, status: "idle" })),
        );

        const response = await worker.fetch(
            new Request(`https://recording.test/v1/projects/${projectId}/runtimes/${runtimeId}/sessions`),
            env,
        );
        expect(response.status).toBe(200);
        // Remove a history still ahead of the reader through the real storage boundary.
        await runInDurableObject(
            env.SESSION_RECORDING.getByName(JSON.stringify([projectId, "large-0000"])),
            (_instance, state) => {
                state.storage.sql.exec("DELETE FROM recorded_session_events_v2");
            },
        );
        await expect(response.text()).rejects.toThrow();
    });

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

it.each(["session-events", "session-event-batches"])(
    "Given long primary and additional directory references, When %s records a turn, Then the directory and history retain the complete references",
    async (endpoint) => {
        const id = `long-${endpoint}`;
        const bytes = new TextEncoder().encode(`/project/${"\u00e9/".repeat(700)}`);
        const directoryId = `path-${btoa(String.fromCharCode(...bytes))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/=+$/u, "")}`;
        const additionalDirectoryIds = [`${directoryId}YQ`];
        expect(directoryId.length).toBeGreaterThan(2048);
        const longContext = { agentId: "codex", directoryId, additionalDirectoryIds };
        const event: SessionLiveEvent = {
            ...requested(id),
            type: "lifecycle-metadata",
            payload: {
                kind: "prompt.requested",
                commandId: `${id}-turn`,
                content: [{ type: "text", text: "Long workspace recording" }],
                context: longContext,
            },
        };
        const response = await write(id, "long-runtime", [event, completed(id, 2)], endpoint);
        expect(response.status).toBe(201);
        expect(await directory(id, "long-runtime")).toMatchObject({
            sessions: [{ ...longContext, sessionId: id, status: "idle", title: "Long workspace recording" }],
        });
        const history = await worker.fetch(
            new Request(`https://recording.test/v1/projects/${id}/runtimes/long-runtime/sessions/${id}/events`),
            env,
        );
        expect(history.status).toBe(200);
        expect(await history.json()).toMatchObject({ events: [event, completed(id, 2)] });
    },
);
