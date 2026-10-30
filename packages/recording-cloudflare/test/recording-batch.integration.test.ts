import {
    createExecutionContext,
    runDurableObjectAlarm,
    runInDurableObject,
    waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    decodeSessionRecordingDirectoryV2,
    decodeSessionRecordingTurnPage,
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

async function write(projectId: string, runtimeId: string, events: readonly SessionLiveEvent[]) {
    return await worker.fetch(
        new Request("https://recording.test/v1/session-event-batches", {
            method: "POST",
            body: encodeSessionRecordingWrite({ projectId, runtimeId, envelope: { kind: "session.event.v2", events } }),
        }),
        env,
    );
}

async function directory(projectId: string, runtimeId: string) {
    const response = await worker.fetch(
        new Request(`https://recording.test/v2/projects/${projectId}/runtimes/${runtimeId}/sessions`),
        env,
    );
    expect(response.status).toBe(200);
    return decodeSessionRecordingDirectoryV2(await response.text());
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
                    updatedAt: "2026-10-21T00:00:00.000Z",
                }))
                .sort((a, b) => b.sessionId.localeCompare(a.sessionId)),
        });
    });

    it("Given a Session another Runtime recorded, When a mixed batch records it too, Then every Session records and the earlier history stays unchanged", async () => {
        expect((await write("partial-project", "old-runtime", [requested("owned-session")])).status).toBe(201);
        const response = await write("partial-project", "new-runtime", [
            requested("owned-session", 2),
            requested("healthy-session"),
            completed("healthy-session", 2),
        ]);
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({
            results: [
                { sessionId: "owned-session", kind: "recorded" },
                { sessionId: "healthy-session", kind: "recorded" },
            ],
        });
        const old = await worker.fetch(
            new Request(
                "https://recording.test/v1/projects/partial-project/runtimes/old-runtime/sessions/owned-session/events",
            ),
            env,
        );
        expect(await old.json()).toMatchObject({ events: [requested("owned-session")] });
    });

    it("Given a directory that cannot index a Session, When its batch is recorded, Then the Session reports its own durable write", async () => {
        const projectId = "unindexed-project";
        const runtimeId = "unindexed-runtime";
        // Corrupt the derived index through its real storage boundary; the Session history is separate.
        await runInDurableObject(
            env.RECORDING_DIRECTORY.getByName(JSON.stringify([projectId, runtimeId])),
            (_instance, state) => {
                state.storage.sql.exec(
                    "INSERT INTO recording_session_summaries (session_id, runtime_id, agent_id, directory_id, additional_directory_ids_json, title, prompted, updated_at) VALUES ('unindexed-session', ?, 'pressure', 'default', 'not-json', 'Unreadable', 1, 0)",
                    runtimeId,
                );
            },
        );
        const events = [requested("unindexed-session"), chunk("unindexed-session", 2)];

        const response = await write(projectId, runtimeId, events);

        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({ results: [{ sessionId: "unindexed-session", kind: "recorded" }] });
        const history = await worker.fetch(
            new Request(
                `https://recording.test/v1/projects/${projectId}/runtimes/${runtimeId}/sessions/unindexed-session/events`,
            ),
            env,
        );
        expect(await history.json()).toMatchObject({ events });
    });

    it("Given a directory that failed to index a Session's first prompt, When the directory recovers, Then the Session indexes it without another prompt", async () => {
        const projectId = "recovering-project";
        const runtimeId = "recovering-runtime";
        const sessionId = "recovering-session";
        const summaries = (statement: string) =>
            runInDurableObject(
                env.RECORDING_DIRECTORY.getByName(JSON.stringify([projectId, runtimeId])),
                (_instance, state) => {
                    state.storage.sql.exec(statement, runtimeId);
                },
            );
        // An unreadable summary makes the directory fail this Session's update through its real storage boundary.
        await summaries(
            "INSERT INTO recording_session_summaries (session_id, runtime_id, agent_id, directory_id, additional_directory_ids_json, title, prompted, updated_at) VALUES ('recovering-session', ?, 'pressure', 'default', 'not-json', 'Unreadable', 1, 0)",
        );
        expect(await (await write(projectId, runtimeId, [requested(sessionId)])).json()).toEqual({
            results: [{ sessionId, kind: "recorded" }],
        });
        await summaries("DELETE FROM recording_session_summaries WHERE runtime_id = ?");
        expect(await directory(projectId, runtimeId)).toEqual({ sessions: [] });

        expect(
            await runDurableObjectAlarm(
                env.SESSION_RECORDING.getByName(JSON.stringify([projectId, runtimeId, sessionId])),
            ),
        ).toBe(true);

        expect(await directory(projectId, runtimeId)).toEqual({
            sessions: [
                { ...context, sessionId, runtimeId, title: "Batch title", updatedAt: "2026-10-21T00:00:00.000Z" },
            ],
        });
    });

    it("Given a recorded Session, When later output is recorded with an execution context, Then its activity is indexed once that context settles", async () => {
        const projectId = "deferred-project";
        const runtimeId = "deferred-runtime";
        expect((await write(projectId, runtimeId, [requested("deferred-session")])).status).toBe(201);
        const later = { ...chunk("deferred-session", 2), recordedAt: "2026-10-21T00:00:05.000Z" };

        const execution = createExecutionContext();
        const response = await worker.fetch(
            new Request("https://recording.test/v1/session-event-batches", {
                method: "POST",
                body: encodeSessionRecordingWrite({
                    projectId,
                    runtimeId,
                    envelope: { kind: "session.event.v2", events: [later] },
                }),
            }),
            env,
            execution,
        );
        expect(await response.json()).toEqual({ results: [{ sessionId: "deferred-session", kind: "recorded" }] });
        await waitOnExecutionContext(execution);

        expect(await directory(projectId, runtimeId)).toMatchObject({
            sessions: [{ sessionId: "deferred-session", updatedAt: "2026-10-21T00:00:05.000Z" }],
        });
    });

    it("Given output this deployment cannot read, When it is recorded, Then the Session's directory activity still advances", async () => {
        const projectId = "unread-activity-project";
        const runtimeId = "unread-activity-runtime";
        expect((await write(projectId, runtimeId, [requested("unread-activity-session")])).status).toBe(201);
        const future = {
            ...chunk("unread-activity-session", 2),
            payload: { sessionUpdate: "future_update", value: 1 },
            recordedAt: "2026-10-21T00:00:07.000Z",
        };
        // A Session info update that fails the live schema changes no title, but it is still activity.
        const unreadTitle = {
            ...chunk("unread-activity-session", 3),
            payload: { sessionUpdate: "session_info_update", title: "t".repeat(1_000_001) },
            recordedAt: "2026-10-21T00:00:09.000Z",
        };
        for (const event of [future, unreadTitle]) {
            const response = await worker.fetch(
                new Request("https://recording.test/v1/session-event-batches", {
                    method: "POST",
                    body: JSON.stringify({
                        projectId,
                        runtimeId,
                        envelope: { kind: "session.event.v2", events: [event] },
                    }),
                }),
                env,
            );
            expect(await response.json()).toEqual({
                results: [{ sessionId: "unread-activity-session", kind: "recorded" }],
            });
        }

        expect(await directory(projectId, runtimeId)).toMatchObject({
            sessions: [
                { sessionId: "unread-activity-session", title: "Batch title", updatedAt: "2026-10-21T00:00:09.000Z" },
            ],
        });
    });

    it("Given completion followed by a new request and title reset, When a batch is folded, Then its ordered context and fallback title survive", async () => {
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
                    updatedAt: "2026-10-21T00:00:00.000Z",
                },
            ],
        });
    });

    it("Given an Agent title longer than a summary title, When it is recorded, Then the directory and history show the same bounded title and later writes still index", async () => {
        const projectId = "long-title-project";
        const runtimeId = "long-title-runtime";
        const id = "long-title-session";
        const titled: SessionLiveEvent = {
            ...chunk(id, 2),
            type: "acp",
            payload: { sessionUpdate: "session_info_update", title: ` ${"t".repeat(1_500)}` },
        };
        const later = { ...chunk(id, 3), recordedAt: "2026-10-21T00:00:05.000Z" };

        for (const events of [[requested(id), titled], [later]]) {
            const response = await write(projectId, runtimeId, events);
            expect(await response.json()).toEqual({ results: [{ sessionId: id, kind: "recorded" }] });
        }

        const title = "t".repeat(1_000);
        expect(await directory(projectId, runtimeId)).toMatchObject({
            sessions: [{ sessionId: id, title, updatedAt: "2026-10-21T00:00:05.000Z" }],
        });
        const turns = await worker.fetch(
            new Request(`https://recording.test/v1/projects/${projectId}/runtimes/${runtimeId}/sessions/${id}/turns`),
            env,
        );
        expect(turns.status).toBe(200);
        expect(decodeSessionRecordingTurnPage(await turns.text()).title).toBe(title);
    });

    it("Given an unbounded Agent title committed before titles were bounded, When the Session records again, Then the directory indexes it bounded", async () => {
        const projectId = "committed-title-project";
        const runtimeId = "committed-title-runtime";
        const id = "committed-title-session";
        expect((await write(projectId, runtimeId, [requested(id)])).status).toBe(201);
        // An earlier deployment committed the Agent's title verbatim with its batch.
        await runInDurableObject(
            env.SESSION_RECORDING.getByName(JSON.stringify([projectId, runtimeId, id])),
            (_, state) => {
                state.storage.sql.exec(
                    "INSERT INTO pending_directory_updates (operations_json, events) VALUES (?, 1)",
                    JSON.stringify([
                        { kind: "title", title: "t".repeat(1_500), recordedAt: "2026-10-21T00:00:01.000Z" },
                    ]),
                );
            },
        );

        const response = await write(projectId, runtimeId, [
            { ...chunk(id, 2), recordedAt: "2026-10-21T00:00:05.000Z" },
        ]);

        expect(await response.json()).toEqual({ results: [{ sessionId: id, kind: "recorded" }] });
        expect(await directory(projectId, runtimeId)).toMatchObject({
            sessions: [{ sessionId: id, title: "t".repeat(1_000), updatedAt: "2026-10-21T00:00:05.000Z" }],
        });
    });
});

it("Given long primary and additional directory references, When a turn is recorded, Then the directory and history retain the complete references", async () => {
    const id = "long-session";
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
    const response = await write(id, "long-runtime", [event, completed(id, 2)]);
    expect(response.status).toBe(201);
    expect(await directory(id, "long-runtime")).toMatchObject({
        sessions: [{ ...longContext, sessionId: id, title: "Long workspace recording" }],
    });
    const history = await worker.fetch(
        new Request(`https://recording.test/v1/projects/${id}/runtimes/long-runtime/sessions/${id}/events`),
        env,
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ events: [event, completed(id, 2)] });
});
