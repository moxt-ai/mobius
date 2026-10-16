import { env } from "cloudflare:workers";
import {
    decodeSessionRecordingDirectory,
    decodeSessionRecordingHistory,
    decodeSessionRecordingHistoryPage,
} from "@moxt-ai/mobius-protocol";
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
    recordedAt: "2026-10-09T00:00:00.000Z",
    sessionGenerationId: "session-generation-live",
    sessionId: "live-session",
    type: "acp",
    payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Live reply" } },
};
const { position: _historicalPosition, ...historicalEvent } = event;
function write(runtimeId = "runtime-live", envelope: unknown = { kind: "session.event.v2", events: [event] }): Request {
    return new Request("https://recording.internal/v1/session-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, runtimeId, envelope }),
    });
}
function numberedEvents(count: number, start = 0) {
    return Array.from({ length: count }, (_, index) => ({
        ...event,
        eventId: `event-${start + index}`,
        position: String(start + index),
        payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Reply ${start + index}` } },
    }));
}

describe("Recording live V2 events", () => {
    it("Given an event broadcast to browsers, When Recording receives the live event, Then its positioned representation is retained", async () => {
        expect((await worker.fetch(write(), env)).status).toBe(201);
        const response = await worker.fetch(
            new Request(
                `https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions/live-session/events`,
            ),
            env,
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            sessionId: event.sessionId,
            events: [event],
        });
    });
    it("Given a historical event without a live position, When it is submitted to Recording, Then Recording rejects it", async () => {
        const response = await worker.fetch(
            write("runtime-live", { kind: "session.event.v2", events: [historicalEvent] }),
            env,
        );
        expect(response.status).toBe(400);
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
it("Given recorded prompt lifecycles, When a caller reads selected Session status, Then one and many status reads return summaries without loading the full Runtime directory", async () => {
    const context = { agentId: "codex", directoryId: "default", additionalDirectoryIds: [] };
    const lifecycle = (sessionId: string, eventId: string, kind: string, recordedAt: string) => ({
        ...event,
        eventId,
        recordedAt,
        sessionId,
        type: "lifecycle-metadata",
        payload:
            kind === "prompt.requested"
                ? {
                      commandId: "command",
                      content: [{ type: "text", text: "Run" }],
                      context,
                      kind,
                  }
                : { commandId: "command", kind, stopReason: "end_turn" },
    });
    const sessions = ["status-session-1", "status-session-2"];
    for (const [index, sessionId] of sessions.entries()) {
        expect(
            (
                await worker.fetch(
                    write("runtime-live", {
                        kind: "session.event.v2",
                        events: [
                            lifecycle(
                                sessionId,
                                `${sessionId}-requested`,
                                "prompt.requested",
                                `2026-10-09T0${index}:00:00.000Z`,
                            ),
                            lifecycle(
                                sessionId,
                                `${sessionId}-completed`,
                                "prompt.completed",
                                `2026-10-09T0${index}:30:00.000Z`,
                            ),
                        ],
                    }),
                    env,
                )
            ).status,
        ).toBe(201);
    }

    const single = await worker.fetch(
        new Request(
            `https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions/${sessions[0]}`,
        ),
        env,
    );
    expect(single.status).toBe(200);
    expect(await single.json()).toMatchObject({
        runtimeId: "runtime-live",
        sessionId: sessions[0],
        status: "idle",
    });

    const batchUrl = new URL(`https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions`);
    for (const sessionId of sessions) {
        batchUrl.searchParams.append("sessionId", sessionId);
    }
    const batch = await worker.fetch(new Request(batchUrl), env);
    expect(batch.status).toBe(200);
    expect(decodeSessionRecordingDirectory(await batch.text()).sessions).toEqual(
        expect.arrayContaining(
            sessions.map((sessionId) =>
                expect.objectContaining({ sessionId, runtimeId: "runtime-live", status: "idle" }),
            ),
        ),
    );
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

describe("Recording incremental reads", () => {
    function read(query = ""): Request {
        return new Request(
            `https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions/live-session/events${query}`,
        );
    }
    it("Given recorded batches, When a caller reads after a mid-history position, Then only later events are returned with page cursors", async () => {
        for (const batch of [numberedEvents(3, 0), numberedEvents(3, 3)]) {
            expect(
                (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: batch }), env)).status,
            ).toBe(201);
        }
        const response = await worker.fetch(read("?after=3"), env);
        expect(response.status).toBe(200);
        const livePage: unknown = await response.clone().json();
        expect(livePage).toMatchObject({ events: [{ position: "4" }, { position: "5" }] });
        const page = decodeSessionRecordingHistoryPage(await response.text());
        expect(page.events.map((candidate) => candidate.position)).toEqual(["4", "5"]);
        expect(page.nextCursor).toBe("v2:2:5");
        expect(page.tailCursor).toBe("v2:2:5");
        expect(page.generationReset).toBe(false);
        expect(page.truncated).toBe(false);
        expect(page.sessionId).toBe("live-session");
        expect(page.version).toBe(2);
    });
    it("Given a limit smaller than the remaining events, When a caller reads a page, Then the page is truncated at the limit", async () => {
        for (const batch of [numberedEvents(3, 0), numberedEvents(3, 3)]) {
            expect(
                (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: batch }), env)).status,
            ).toBe(201);
        }
        const response = await worker.fetch(read("?after=1&limit=2"), env);
        expect(response.status).toBe(200);
        const page = decodeSessionRecordingHistoryPage(await response.text());
        expect(page.events.map((candidate) => candidate.eventId)).toEqual(["event-2", "event-3"]);
        expect(page.nextCursor).toBe("v2:2:3");
        expect(page.tailCursor).toBe("v2:2:5");
        expect(page.truncated).toBe(true);
    });
    it("Given the caller has caught up, When a caller reads after the tail, Then an empty page closes the poll loop", async () => {
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: numberedEvents(2, 0) }), env))
                .status,
        ).toBe(201);
        const response = await worker.fetch(read("?after=1"), env);
        expect(response.status).toBe(200);
        const page = decodeSessionRecordingHistoryPage(await response.text());
        expect(page.events).toEqual([]);
        expect(page.nextCursor).toBe(null);
        expect(page.tailCursor).toBe("v2:1:1");
        expect(page.truncated).toBe(false);
    });
    it("Given a cursor beyond the recorded tail, When the Runtime later records more events, Then the poll resumes from the held cursor", async () => {
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: numberedEvents(2, 0) }), env))
                .status,
        ).toBe(201);
        expect((await worker.fetch(read("?after=9"), env)).status).toBe(200);
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: numberedEvents(2, 2) }), env))
                .status,
        ).toBe(201);
        const page = decodeSessionRecordingHistoryPage(await (await worker.fetch(read("?after=9"), env)).text());
        expect(page.events).toEqual([]);
        expect(page.tailCursor).toBe("v2:2:3");
    });
    it("Given a boundary batch that starts before the cursor, When only its later half is new, Then decoding drops the delivered prefix", async () => {
        const spanning = numberedEvents(4, 0);
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: spanning }), env)).status,
        ).toBe(201);
        const page = decodeSessionRecordingHistoryPage(await (await worker.fetch(read("?after=1"), env)).text());
        expect(page.events.map((candidate) => candidate.eventId)).toEqual(["event-2", "event-3"]);
    });
    it("Given duplicate broadcasts of one batch, When a caller reads incrementally, Then the repeated position is skipped without hiding new events", async () => {
        const batch = { kind: "session.event.v2", events: numberedEvents(2, 0) };
        expect((await worker.fetch(write("runtime-live", batch), env)).status).toBe(201);
        expect((await worker.fetch(write("runtime-live", batch), env)).status).toBe(201);
        const page = decodeSessionRecordingHistoryPage(await (await worker.fetch(read("?after=0"), env)).text());
        expect(page.events.map((candidate) => candidate.eventId)).toEqual(["event-0", "event-1", "event-0", "event-1"]);
    });
    it("Given a daemon reload creates a new Session generation, When a caller continues from an append cursor, Then restarted events are retained", async () => {
        const first = numberedEvents(3, 1);
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: first }), env)).status,
        ).toBe(201);
        const initial = decodeSessionRecordingHistoryPage(
            await (await worker.fetch(read("?after=0&limit=2"), env)).text(),
        );

        expect(initial.nextCursor).not.toBeNull();
        const restarted = numberedEvents(2, 1).map((candidate) => ({
            ...candidate,
            eventId: `reloaded-${candidate.eventId}`,
            sessionGenerationId: "session-generation-reloaded",
        }));
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: restarted }), env)).status,
        ).toBe(201);
        const followUp = new URL(
            `https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions/live-session/events`,
        );
        followUp.searchParams.set("after", initial.nextCursor ?? "");
        followUp.searchParams.set("limit", "10");
        const followUpResponse = await worker.fetch(new Request(followUp), env);
        const page = decodeSessionRecordingHistoryPage(await followUpResponse.text());
        expect(page.events.map((candidate) => candidate.eventId)).toEqual([
            "event-3",
            "reloaded-event-1",
            "reloaded-event-2",
        ]);
        expect(page.generationReset).toBe(true);
        expect(page.nextCursor).toBe("v2:2:2");
    });
    it("Given a legacy position cursor and a generation reset, When a caller polls incrementally, Then it receives a full replay reset", async () => {
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: numberedEvents(2, 1) }), env))
                .status,
        ).toBe(201);
        const restarted = numberedEvents(2, 1).map((candidate) => ({
            ...candidate,
            eventId: `legacy-reloaded-${candidate.eventId}`,
            sessionGenerationId: "session-generation-legacy-reloaded",
        }));
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: restarted }), env)).status,
        ).toBe(201);
        const page = decodeSessionRecordingHistoryPage(
            await (await worker.fetch(read("?after=1&limit=3"), env)).text(),
        );
        expect(page.events.map((candidate) => candidate.eventId)).toEqual([
            "event-1",
            "event-2",
            "legacy-reloaded-event-1",
        ]);
        expect(page.generationReset).toBe(true);
        expect(page.truncated).toBe(true);
        expect(page.nextCursor).toBe("v2:2:1");
    });
    it("Given a long Session with many recorded batches, When a caller follows page cursors from the start, Then every event is returned once in order", async () => {
        const batchCount = 70;
        for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
            expect(
                (
                    await worker.fetch(
                        write("runtime-live", {
                            kind: "session.event.v2",
                            events: numberedEvents(3, 1 + batchIndex * 3),
                        }),
                        env,
                    )
                ).status,
            ).toBe(201);
        }
        const received: string[] = [];
        let cursor = "0";
        let tailCursor = "";
        for (;;) {
            const page = decodeSessionRecordingHistoryPage(
                await (await worker.fetch(read(`?after=${encodeURIComponent(cursor)}&limit=50`), env)).text(),
            );
            received.push(...page.events.map((candidate) => candidate.position));
            tailCursor = page.tailCursor;
            if (!page.truncated || page.nextCursor === null) {
                break;
            }
            cursor = page.nextCursor;
        }
        expect(received).toEqual(Array.from({ length: batchCount * 3 }, (_, index) => String(index + 1)));
        expect(tailCursor).toBe(`v2:${batchCount}:${batchCount * 3}`);
        const resumed = decodeSessionRecordingHistoryPage(
            await (await worker.fetch(read("?after=100&limit=4"), env)).text(),
        );
        expect(resumed.events.map((candidate) => candidate.position)).toEqual(["101", "102", "103", "104"]);
        expect(resumed.nextCursor).toBe("v2:35:104");
        expect(resumed.generationReset).toBe(false);
    });
    it("Given no incremental query, When a caller reads the session, Then the full history contract is unchanged", async () => {
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: numberedEvents(2, 0) }), env))
                .status,
        ).toBe(201);
        const response = await worker.fetch(read(), env);
        expect(response.status).toBe(200);
        expect(decodeSessionRecordingHistory(await response.text()).events).toHaveLength(2);
    });
    it("Given a malformed cursor or limit, When a caller reads incrementally, Then the request is rejected", async () => {
        expect((await worker.fetch(read("?after=not-a-position"), env)).status).toBe(400);
        expect((await worker.fetch(read("?after=0&limit=0"), env)).status).toBe(400);
        expect((await worker.fetch(read("?after=0&limit=99999"), env)).status).toBe(400);
    });
    it("Given a well-formed cursor that no longer resolves, When a caller reads incrementally, Then the failure is reported as a structured error rather than opaque text", async () => {
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: numberedEvents(1, 0) }), env))
                .status,
        ).toBe(201);
        // A cursor of valid shape whose batch is absent resolves to nothing inside the Durable Object.
        const response = await worker.fetch(read("?after=v2:999:1&limit=10"), env);
        expect(response.status).toBe(500);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.json()).toEqual({
            error: { code: "internal_error", message: "The Recording request could not be completed" },
        });
    });
});
