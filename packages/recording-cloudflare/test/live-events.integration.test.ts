import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    decodeSessionRecordingDirectoryV2,
    decodeSessionRecordingHistory,
    decodeSessionRecordingHistoryPage,
} from "@moxt-ai/mobius-sdk/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordingDirectoryDurableObjectMigrations } from "../src/generated/recording-directory-do-migrations.ts";
import { applyDurableObjectMigrations } from "../src/storage/durable-object-migrations.ts";
import { createRecordingWorker, RecordingDirectoryDurableObject } from "../src/worker.ts";

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
    return new Request("https://recording.internal/v1/session-event-batches", {
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
    // @no-uc: Performance; a waiting durable read must return committed new events without an empty-poll round trip.
    it("wakes a caught-up reader after a new durable event is written", async () => {
        expect((await worker.fetch(write(), env)).status).toBe(201);
        const path = `https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions/live-session/events`;
        const first = await worker.fetch(new Request(`${path}?limit=100`), env);
        const cursor = decodeSessionRecordingHistoryPage(await first.text()).tailCursor;
        const waiting = worker.fetch(new Request(`${path}?after=${cursor}&limit=100&waitMs=5000`), env);
        const barrier = await worker.fetch(new Request(`${path}?after=${cursor}&limit=100`), env);
        expect(decodeSessionRecordingHistoryPage(await barrier.text()).events).toEqual([]);
        const next = { ...event, eventId: "next-live-event", position: "1" };
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: [next] }), env)).status,
        ).toBe(201);
        const response = await waiting;
        expect(response.headers.get("Server-Timing")).toMatch(/recording-read;dur=[0-9.]+/u);
        expect(response.headers.get("Server-Timing")).toMatch(/recording-wait;dur=[0-9.]+/u);
        expect(response.status).toBe(200);
        expect(decodeSessionRecordingHistoryPage(await response.text()).events).toEqual([next]);
    });

    it("Given a caught-up reader waiting for output, When a write only repeats recorded events, Then the reader keeps waiting and receives the next new event", async () => {
        expect((await worker.fetch(write(), env)).status).toBe(201);
        const path = `https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions/live-session/events`;
        const first = await worker.fetch(new Request(`${path}?limit=100`), env);
        const cursor = decodeSessionRecordingHistoryPage(await first.text()).tailCursor;
        const waiting = worker.fetch(new Request(`${path}?after=${cursor}&limit=100&waitMs=5000`), env);
        const barrier = await worker.fetch(new Request(`${path}?after=${cursor}&limit=100`), env);
        expect(decodeSessionRecordingHistoryPage(await barrier.text()).events).toEqual([]);
        expect((await worker.fetch(write(), env)).status).toBe(201);
        const next = { ...event, eventId: "next-live-event", position: "1" };
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: [next] }), env)).status,
        ).toBe(201);
        expect(decodeSessionRecordingHistoryPage(await (await waiting).text()).events).toEqual([next]);
    });

    // @no-uc: Technical regression; abandoning a held read must cancel its wait without failing the Worker.
    it("cancels an abandoned live read and still accepts the following reader", async () => {
        expect((await worker.fetch(write(), env)).status).toBe(201);
        const path = `https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions/live-session/events`;
        const initial = await worker.fetch(new Request(`${path}?limit=100`), env);
        const cursor = decodeSessionRecordingHistoryPage(await initial.text()).tailCursor;
        const abort = new AbortController();
        const waiting = worker.fetch(
            new Request(`${path}?after=${cursor}&limit=100&waitMs=5000`, { signal: abort.signal }),
            env,
        );
        const cancellation = expect(waiting).rejects.toThrow(/cancel|abort/iu);
        expect((await worker.fetch(new Request(`${path}?after=${cursor}&limit=100`), env)).status).toBe(200);
        abort.abort(new DOMException("The reader cancelled its live read", "AbortError"));
        await cancellation;
        const nextRead = worker.fetch(new Request(`${path}?after=${cursor}&limit=100&waitMs=5000`), env);
        expect((await worker.fetch(new Request(`${path}?after=${cursor}&limit=100`), env)).status).toBe(200);
        const next = { ...event, eventId: "after-abandoned-read", position: "1" };
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: [next] }), env)).status,
        ).toBe(201);
        expect(decodeSessionRecordingHistoryPage(await (await nextRead).text()).events).toEqual([next]);
    });

    // @no-uc: Technical regression; a finite empty wait must retain the last durable cursor.
    it("finishes an empty wait without moving its durable cursor", async () => {
        expect((await worker.fetch(write(), env)).status).toBe(201);
        const path = `https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions/live-session/events`;
        const initial = await worker.fetch(new Request(`${path}?limit=100`), env);
        const cursor = decodeSessionRecordingHistoryPage(await initial.text()).tailCursor;
        const response = await worker.fetch(new Request(`${path}?after=${cursor}&limit=100&waitMs=1`), env);
        expect(decodeSessionRecordingHistoryPage(await response.text())).toMatchObject({
            events: [],
            nextCursor: null,
            tailCursor: cursor,
        });
    });

    // @no-uc: Technical regression; malformed long-poll budgets cannot allocate unbounded worker waiters.
    it("rejects an invalid wait budget before reading a session", async () => {
        const path = `https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions/live-session/events`;
        for (const waitMs of ["-1", "10001", "1.5", "never"]) {
            expect((await worker.fetch(new Request(`${path}?limit=100&waitMs=${waitMs}`), env)).status).toBe(400);
        }
    });

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
    const firstPrompt = `\n> ## ${"\u{1f680}".repeat(45)}\nAdditional instructions`;
    const requested = {
        ...event,
        eventId: "requested",
        type: "lifecycle-metadata",
        payload: {
            kind: "prompt.requested",
            commandId: "command",
            content: [{ type: "text", text: firstPrompt }],
            context,
        },
    };
    expect(
        (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: [requested] }), env)).status,
    ).toBe(201);
    const summaryUrl = `https://recording.internal/v2/projects/${projectId}/runtimes/runtime-live/sessions/${event.sessionId}`;
    expect(await (await worker.fetch(new Request(summaryUrl), env)).json()).toMatchObject({
        title: `${"\u{1f680}".repeat(41)}\u2026`,
    });
    const followUp = {
        ...requested,
        eventId: "follow-up",
        position: "1",
        payload: {
            ...requested.payload,
            commandId: "follow-up",
            content: [{ type: "text", text: "Continue with a different request" }],
        },
    };
    expect(
        (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: [followUp] }), env)).status,
    ).toBe(201);
    expect(await (await worker.fetch(new Request(summaryUrl), env)).json()).toMatchObject({
        title: `${"\u{1f680}".repeat(41)}\u2026`,
    });
    const agentTitle = "Agent title that intentionally exceeds the fallback title limit";
    const titled = {
        ...event,
        eventId: "title",
        position: "2",
        recordedAt: "2026-10-09T01:00:00.000Z",
        payload: { sessionUpdate: "session_info_update", title: agentTitle },
    };
    expect(
        (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: [titled] }), env)).status,
    ).toBe(201);
    expect(
        (
            await worker.fetch(
                write("runtime-live", { kind: "session.event.v2", events: [{ ...event, position: "3" }] }),
                env,
            )
        ).status,
    ).toBe(201);
    const response = await worker.fetch(
        new Request(`https://recording.internal/v2/projects/${projectId}/runtimes/runtime-live/sessions`),
        env,
    );
    expect(decodeSessionRecordingDirectoryV2(await response.text())).toEqual({
        sessions: [
            {
                ...context,
                runtimeId: "runtime-live",
                sessionId: event.sessionId,
                title: agentTitle,
                updatedAt: titled.recordedAt,
            },
        ],
    });
});
it("Given a recording with no completion event, When a caller reads V2 summaries, Then metadata is available without claiming a current execution status", async () => {
    const context = { agentId: "codex", directoryId: "default", additionalDirectoryIds: [] };
    const requested = {
        ...event,
        eventId: "requested-without-completion",
        type: "lifecycle-metadata",
        payload: {
            kind: "prompt.requested",
            commandId: "command",
            content: [{ type: "text", text: "Recorded prompt" }],
            context,
        },
    };
    expect(
        (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: [requested] }), env)).status,
    ).toBe(201);
    const path = `https://recording.internal/v2/projects/${projectId}/runtimes/runtime-live/sessions`;
    const summary = {
        ...context,
        runtimeId: "runtime-live",
        sessionId: event.sessionId,
        title: "Recorded prompt",
        updatedAt: event.recordedAt,
    };
    for (const query of ["", `?sessionId=${event.sessionId}`]) {
        const response = await worker.fetch(new Request(`${path}${query}`), env);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ sessions: [summary] });
    }
    const single = await worker.fetch(new Request(`${path}/${event.sessionId}`), env);
    expect(single.status).toBe(200);
    expect(await single.json()).toEqual(summary);
});
it("Given a directory with a stale persisted status, When it upgrades, Then V2 preserves its metadata without inventing a missing lifecycle outcome", async () => {
    const stub = env.RECORDING_DIRECTORY.getByName(JSON.stringify([projectId, "runtime-live"]));
    const response = await runInDurableObject(stub, async (_instance, state) => {
        // Restore the deployed pre-removal schema with its original, immutable migrations.
        state.storage.sql.exec("DROP TABLE recording_session_summaries");
        state.storage.sql.exec("DELETE FROM recording_schema_migrations");
        applyDurableObjectMigrations(state.storage, recordingDirectoryDurableObjectMigrations.slice(0, 3));
        state.storage.sql.exec(
            `INSERT INTO recording_session_summaries
             (session_id, runtime_id, agent_id, directory_id, additional_directory_ids_json, title, prompted, status, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            event.sessionId,
            "runtime-live",
            "codex",
            "default",
            "[]",
            "Existing recording",
            1,
            "running",
            Date.parse(event.recordedAt),
        );
        const upgraded = new RecordingDirectoryDurableObject(state, env);
        return await upgraded.fetch(new Request("https://directory.internal/sessions?runtimeId=runtime-live"));
    });
    expect(response.status).toBe(200);
    const expected = {
        sessions: [
            {
                sessionId: event.sessionId,
                runtimeId: "runtime-live",
                agentId: "codex",
                directoryId: "default",
                additionalDirectoryIds: [],
                title: "Existing recording",
                updatedAt: event.recordedAt,
            },
        ],
    };
    expect(await response.json()).toEqual(expected);
    const path = `https://recording.internal/v2/projects/${projectId}/runtimes/runtime-live/sessions`;
    const summaries = await worker.fetch(new Request(path), env);
    expect(summaries.status).toBe(200);
    expect(await summaries.json()).toEqual(expected);
});
it("Given a session that never requested a prompt, When the Runtime loads its recorded directory, Then the session is not listed", async () => {
    expect((await worker.fetch(write(), env)).status).toBe(201);
    const response = await worker.fetch(
        new Request(`https://recording.internal/v2/projects/${projectId}/runtimes/runtime-live/sessions`),
        env,
    );
    expect(response.status).toBe(200);
    expect(decodeSessionRecordingDirectoryV2(await response.text())).toEqual({ sessions: [] });
});
it("Given a recorded live frame, When Recording receives the same frame again, Then it stores the event once", async () => {
    expect((await worker.fetch(write(), env)).status).toBe(201);
    expect((await worker.fetch(write(), env)).status).toBe(201);
    const response = await worker.fetch(
        new Request(
            `https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions/live-session/events`,
        ),
        env,
    );
    expect(decodeSessionRecordingHistory(await response.text()).events).toEqual([event]);
});
it("Given a Session event that arrives after a later one, When Recording receives it, Then it is stored", async () => {
    const [first, second, third] = numberedEvents(3, 0);
    for (const events of [[first, third], [second]]) {
        expect((await worker.fetch(write("runtime-live", { kind: "session.event.v2", events }), env)).status).toBe(201);
    }
    const response = await worker.fetch(
        new Request(
            `https://recording.internal/v1/projects/${projectId}/runtimes/runtime-live/sessions/live-session/events`,
        ),
        env,
    );
    expect(decodeSessionRecordingHistory(await response.text()).events).toEqual([first, third, second]);
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
    /** A page query from the start of the Recording, or after a page cursor. */
    function pageQuery(cursor: string | null, limit: number): string {
        return cursor === null ? `?limit=${limit}` : `?after=${encodeURIComponent(cursor)}&limit=${limit}`;
    }
    it("Given recorded batches, When a caller reads after a mid-history cursor, Then only later events are returned with page cursors", async () => {
        for (const batch of [numberedEvents(3, 0), numberedEvents(3, 3)]) {
            expect(
                (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: batch }), env)).status,
            ).toBe(201);
        }
        const response = await worker.fetch(read("?after=v2:2:3"), env);
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
        const response = await worker.fetch(read("?after=v2:1:1&limit=2"), env);
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
        const response = await worker.fetch(read("?after=v2:1:1"), env);
        expect(response.status).toBe(200);
        const page = decodeSessionRecordingHistoryPage(await response.text());
        expect(page.events).toEqual([]);
        expect(page.nextCursor).toBe(null);
        expect(page.tailCursor).toBe("v2:1:1");
        expect(page.truncated).toBe(false);
    });
    it("Given a boundary batch that starts before the cursor, When only its later half is new, Then decoding drops the delivered prefix", async () => {
        const spanning = numberedEvents(4, 0);
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: spanning }), env)).status,
        ).toBe(201);
        const page = decodeSessionRecordingHistoryPage(await (await worker.fetch(read("?after=v2:1:1"), env)).text());
        expect(page.events.map((candidate) => candidate.eventId)).toEqual(["event-2", "event-3"]);
    });
    it("Given recorded events, When a reconnected daemon sends some of them again followed by new ones, Then a caller reads each event once in order", async () => {
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: numberedEvents(3, 0) }), env))
                .status,
        ).toBe(201);
        const caughtUp = decodeSessionRecordingHistoryPage(await (await worker.fetch(read("?limit=10"), env)).text());
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: numberedEvents(4, 1) }), env))
                .status,
        ).toBe(201);

        const following = decodeSessionRecordingHistoryPage(
            await (await worker.fetch(read(`?after=${caughtUp.tailCursor}&limit=10`), env)).text(),
        );
        expect(following.events.map((candidate) => candidate.eventId)).toEqual(["event-3", "event-4"]);
        const page = decodeSessionRecordingHistoryPage(await (await worker.fetch(read("?limit=10"), env)).text());
        expect(page.events.map((candidate) => candidate.eventId)).toEqual([
            "event-0",
            "event-1",
            "event-2",
            "event-3",
            "event-4",
        ]);
    });
    it("Given a daemon reload creates a new Session generation, When a caller continues from an append cursor, Then restarted events are retained", async () => {
        const first = numberedEvents(3, 1);
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: first }), env)).status,
        ).toBe(201);
        const initial = decodeSessionRecordingHistoryPage(await (await worker.fetch(read("?limit=2"), env)).text());

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
        let cursor: string | null = null;
        let tailCursor = "";
        for (;;) {
            const page = decodeSessionRecordingHistoryPage(
                await (await worker.fetch(read(pageQuery(cursor, 50)), env)).text(),
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
            await (await worker.fetch(read("?after=v2:34:100&limit=4"), env)).text(),
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
        expect((await worker.fetch(read("?after=0&limit=10"), env)).status).toBe(400);
        expect((await worker.fetch(read("?limit=0"), env)).status).toBe(400);
        expect((await worker.fetch(read("?limit=99999"), env)).status).toBe(400);
    });
    it("Given a well-formed cursor that no longer resolves, When a caller reads incrementally, Then the read reports the cursor as expired so the caller can start over", async () => {
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: numberedEvents(1, 0) }), env))
                .status,
        ).toBe(201);
        // A cursor of valid shape whose batch is absent resolves to nothing inside the Durable Object.
        for (const query of [
            "?after=v2:999:1&limit=10",
            "?after=v2:1:7&limit=10",
            "?after=v2:999:1&limit=10&waitMs=1",
        ]) {
            const response = await worker.fetch(read(query), env);
            expect(response.status).toBe(410);
            expect(response.headers.get("content-type")).toContain("application/json");
            expect(await response.json()).toEqual({
                error: { code: "cursor_expired", message: "The Recording request could not be completed" },
            });
        }
    });

    it("Given a batch that repeats its last event, When a caller follows page cursors to the tail, Then it reads the event once and reaches an empty page", async () => {
        const [first, second] = numberedEvents(2, 1);
        expect(
            (
                await worker.fetch(
                    write("runtime-live", { kind: "session.event.v2", events: [first, second, second] }),
                    env,
                )
            ).status,
        ).toBe(201);
        const page = decodeSessionRecordingHistoryPage(await (await worker.fetch(read("?limit=10"), env)).text());
        expect(page.events.map((candidate) => candidate.eventId)).toEqual(["event-1", "event-2"]);

        const next = await worker.fetch(read(`?after=${page.nextCursor}&limit=10`), env);
        expect(decodeSessionRecordingHistoryPage(await next.text()).events).toEqual([]);
    });

    it("Given a stored batch that already repeats a position, When a caller continues from its tail, Then it reaches an empty page", async () => {
        const [first, second] = numberedEvents(2, 1);
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: [first] }), env)).status,
        ).toBe(201);
        // A batch recorded by an earlier deployment kept a repeated frame inside one stored row.
        await runInDurableObject(
            env.SESSION_RECORDING.getByName(JSON.stringify([projectId, "runtime-live", "live-session"])),
            (_instance, state) => {
                state.storage.sql.exec(
                    "INSERT INTO recorded_session_events_v2 (envelope_json, first_position, last_position, recorded_at, session_generation_id) VALUES (?, 2, 2, 0, ?)",
                    JSON.stringify({ kind: "session.event.v2", events: [second, second] }),
                    event.sessionGenerationId,
                );
            },
        );
        const page = decodeSessionRecordingHistoryPage(
            await (await worker.fetch(read("?after=v2:1:1&limit=10"), env)).text(),
        );
        expect(page.events.map((candidate) => candidate.eventId)).toEqual(["event-2", "event-2"]);
        expect(page.nextCursor).toBe("v2:2:2");

        const next = await worker.fetch(read(`?after=${page.nextCursor}&limit=10`), env);
        expect(decodeSessionRecordingHistoryPage(await next.text()).events).toEqual([]);
    });

    it("Given a stored batch that repeats a position around an unread event, When a caller pages through it at any page size, Then every stored event arrives once in order", async () => {
        const [first, a, b, c] = numberedEvents(4, 1).map((candidate, index) => ({
            ...candidate,
            eventId: ["first", "a", "b", "c"][index] ?? candidate.eventId,
        }));
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: [first] }), env)).status,
        ).toBe(201);
        // A batch recorded by an earlier deployment repeated a frame with an unread event between the copies.
        await runInDurableObject(
            env.SESSION_RECORDING.getByName(JSON.stringify([projectId, "runtime-live", "live-session"])),
            (_instance, state) => {
                state.storage.sql.exec(
                    "INSERT INTO recorded_session_events_v2 (envelope_json, first_position, last_position, recorded_at, session_generation_id) VALUES (?, 2, 4, 0, ?)",
                    JSON.stringify({ kind: "session.event.v2", events: [a, b, a, c] }),
                    event.sessionGenerationId,
                );
            },
        );

        for (const limit of [1, 2, 3, 10]) {
            const received: string[] = [];
            let cursor = "v2:1:1";
            for (let attempt = 0; attempt < 10; attempt += 1) {
                const page = decodeSessionRecordingHistoryPage(
                    await (await worker.fetch(read(`?after=${cursor}&limit=${limit}`), env)).text(),
                );
                received.push(...page.events.map((candidate) => candidate.eventId));
                if (page.nextCursor === null) {
                    break;
                }
                cursor = page.nextCursor;
            }
            expect(received, `limit ${limit}`).toEqual(["a", "b", "a", "c"]);
        }
    });

    it("Given batches recorded before their bounds were stored, When a caller follows page cursors through them, Then every event arrives once in order", async () => {
        const [first, ...later] = numberedEvents(6, 1);
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: [first] }), env)).status,
        ).toBe(201);
        // Rows written before the position and generation columns existed carry only their envelope.
        await runInDurableObject(
            env.SESSION_RECORDING.getByName(JSON.stringify([projectId, "runtime-live", "live-session"])),
            (_instance, state) => {
                for (const events of [later.slice(0, 3), later.slice(3)]) {
                    state.storage.sql.exec(
                        "INSERT INTO recorded_session_events_v2 (envelope_json, recorded_at) VALUES (?, 0)",
                        JSON.stringify({ kind: "session.event.v2", events }),
                    );
                }
            },
        );

        for (const limit of [1, 2, 10]) {
            const received: string[] = [];
            let cursor = "v2:1:1";
            let tailCursor = "";
            for (let attempt = 0; attempt < 10; attempt += 1) {
                const page = decodeSessionRecordingHistoryPage(
                    await (await worker.fetch(read(`?after=${cursor}&limit=${limit}`), env)).text(),
                );
                received.push(...page.events.map((candidate) => candidate.eventId));
                tailCursor = page.tailCursor;
                if (page.nextCursor === null) {
                    break;
                }
                cursor = page.nextCursor;
            }
            expect(received, `limit ${limit}`).toEqual(later.map((candidate) => candidate.eventId));
            const caughtUp = await worker.fetch(read(`?after=${tailCursor}&limit=${limit}`), env);
            expect(decodeSessionRecordingHistoryPage(await caughtUp.text()).events).toEqual([]);
        }
    });

    it("Given one generation that later restarts, When a caller pages from the start, Then only a page carrying the new generation asks it to reset", async () => {
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: numberedEvents(2, 1) }), env))
                .status,
        ).toBe(201);
        const first = decodeSessionRecordingHistoryPage(await (await worker.fetch(read("?limit=1"), env)).text());
        expect(first).toMatchObject({ generationReset: false, truncated: true });

        const restarted = numberedEvents(2, 1).map((candidate) => ({
            ...candidate,
            eventId: `reloaded-${candidate.eventId}`,
            sessionGenerationId: "session-generation-reloaded",
        }));
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: restarted }), env)).status,
        ).toBe(201);
        // This page stops before the restarted generation, so the caller still appends it.
        const beforeRestart = decodeSessionRecordingHistoryPage(
            await (await worker.fetch(read(`?after=${first.nextCursor}&limit=1`), env)).text(),
        );
        expect(beforeRestart.events.map((candidate) => candidate.eventId)).toEqual(["event-2"]);
        expect(beforeRestart).toMatchObject({ generationReset: false, truncated: true });

        const afterRestart = decodeSessionRecordingHistoryPage(
            await (await worker.fetch(read(`?after=${beforeRestart.nextCursor}&limit=10`), env)).text(),
        );
        expect(afterRestart.events.map((candidate) => candidate.eventId)).toEqual([
            "reloaded-event-1",
            "reloaded-event-2",
        ]);
        expect(afterRestart.generationReset).toBe(true);
    });

    it("Given an event larger than a stored Recording batch holds, When it is recorded, Then its Session write fails and earlier history stays readable", async () => {
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: numberedEvents(1, 1) }), env))
                .status,
        ).toBe(201);
        const [base] = numberedEvents(1, 2);
        // Each of these characters takes three bytes, so the event is larger than one stored row allows.
        const oversized = {
            ...base,
            payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "€".repeat(700_000) } },
        };

        const response = await worker.fetch(
            write("runtime-live", { kind: "session.event.v2", events: [oversized] }),
            env,
        );

        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({
            results: [{ sessionId: event.sessionId, kind: "failed", code: "write_failed" }],
        });
        const page = decodeSessionRecordingHistoryPage(await (await worker.fetch(read("?limit=10"), env)).text());
        expect(page.events.map((candidate) => candidate.eventId)).toEqual(["event-1"]);
    });

    it("Given events that together exceed a stored Recording batch, When they are recorded in one batch, Then every event is readable in order", async () => {
        const large = numberedEvents(2, 1).map((candidate) => ({
            ...candidate,
            payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "€".repeat(333_000) } },
        }));
        expect(
            (await worker.fetch(write("runtime-live", { kind: "session.event.v2", events: large }), env)).status,
        ).toBe(201);

        const received: string[] = [];
        let cursor: string | null = null;
        for (;;) {
            const page = decodeSessionRecordingHistoryPage(
                await (await worker.fetch(read(pageQuery(cursor, 1)), env)).text(),
            );
            received.push(...page.events.map((candidate) => candidate.eventId));
            if (page.nextCursor === null) {
                break;
            }
            cursor = page.nextCursor;
        }
        expect(received).toEqual(["event-1", "event-2"]);
    });
});
