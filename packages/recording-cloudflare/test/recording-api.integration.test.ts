import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRecordingWorker } from "../src/worker.ts";

const worker = createRecordingWorker();
let testNumber = 0;
let projectId = "";

beforeEach(() => {
    projectId = `project-recording-api-${++testNumber}`;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T00:00:00.000Z"));
});

afterEach(() => vi.useRealTimers());

const context = {
    additionalDirectoryIds: ["docs"],
    agentId: "codex",
    directoryId: "workspace",
};

function event(
    position: string,
    eventId: string,
    recordedAt = "2026-10-12T00:00:00.000Z",
    sessionId = "recording-api-session",
) {
    return {
        eventId,
        position,
        provenance: { kind: "original" },
        recordedAt,
        sessionGenerationId: "session-generation-recording-api",
        sessionId,
        type: "lifecycle-metadata",
        payload: {
            kind: "prompt.requested",
            commandId: "command-recording-api",
            content: [{ type: "text", text: "Recording API request" }],
            context,
        },
    };
}

function write(events: readonly Record<string, unknown>[], runtimeId = "runtime-recording-api") {
    return new Request("https://recording.internal/v1/session-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            projectId,
            runtimeId,
            envelope: { kind: "session.event.v2", events },
        }),
    });
}

function request(path: string, init: RequestInit = {}) {
    return new Request(`https://recording.internal${path}`, init);
}

async function json(response: Response): Promise<Record<string, unknown>> {
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a JSON object");
    }
    return value as Record<string, unknown>;
}

it("Given a recorded Session, When a developer reads it by sessionId, Then metadata resolves its Project and Runtime without a lookup request", async () => {
    const writeResponse = await worker.fetch(write([event("0", "event-0")]), env);
    expect(writeResponse.status).toBe(201);

    const response = await worker.fetch(request("/v1/sessions/recording-api-session"), env);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
        projectId,
        runtimeId: "runtime-recording-api",
        sessionId: "recording-api-session",
        summary: {
            agentId: "codex",
            directoryId: "workspace",
            runtimeId: "runtime-recording-api",
            sessionId: "recording-api-session",
            status: "running",
        },
        recording: {
            state: "available",
            integrity: {
                kind: "complete",
                eventCount: 1,
                expectedEventCount: 1,
                firstPosition: "0",
                lastPosition: "0",
                missingPositions: [],
            },
            delivery: {
                kind: "recorded",
                recordedEventCount: 1,
            },
            retention: { kind: "permanent" },
        },
    });
});

it("Given an unscoped Session identifier, When a developer reads its events, Then Recording resolves the stored target and returns the history", async () => {
    const writeResponse = await worker.fetch(write([event("0", "event-0")]), env);
    expect(writeResponse.status).toBe(201);

    const response = await worker.fetch(request("/v1/sessions/recording-api-session/events"), env);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
        sessionId: "recording-api-session",
        events: [{ position: "0" }],
    });
});

it("Given recorded events with a missing position, When a developer reads status, Then the gap is explicit and machine-readable", async () => {
    const writeResponse = await worker.fetch(write([event("0", "event-0")]), env);
    expect(writeResponse.status).toBe(201);
    expect((await worker.fetch(write([event("2", "event-2")]), env)).status).toBe(201);

    const response = await worker.fetch(request("/v1/sessions/recording-api-session/status"), env);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
        integrity: {
            kind: "partial",
            eventCount: 2,
            expectedEventCount: 3,
            firstPosition: "0",
            lastPosition: "2",
            missingPositions: ["1"],
        },
    });
});

it("Given multiple recorded Sessions, When a developer pages and filters the directory, Then only matching Sessions are returned with an opaque cursor", async () => {
    for (const [index, title] of ["Alpha", "Beta"].entries()) {
        expect(
            (
                await worker.fetch(
                    write([
                        {
                            ...event(
                                String(index),
                                `event-${index}`,
                                "2026-10-12T00:00:00.000Z",
                                `recording-api-session-${index}`,
                            ),
                            payload: {
                                kind: "prompt.requested",
                                commandId: `command-${index}`,
                                content: [{ type: "text", text: title }],
                                context,
                            },
                            type: "lifecycle-metadata",
                        },
                    ]),
                    env,
                )
            ).status,
        ).toBe(201);
    }

    const first = await worker.fetch(
        request(`/v1/projects/${projectId}/runtimes/runtime-recording-api/sessions?limit=1`),
        env,
    );
    expect(first.status).toBe(200);
    const firstPage = await json(first);
    expect(firstPage["sessions"]).toHaveLength(1);
    expect(typeof firstPage["nextCursor"]).toBe("string");

    const filtered = await worker.fetch(
        request(`/v1/projects/${projectId}/runtimes/runtime-recording-api/sessions?limit=1&q=Alpha`),
        env,
    );
    expect(await json(filtered)).toMatchObject({ sessions: [{ title: "Alpha" }] });
});

it("Given a recorded Session, When a developer requests an export, Then it receives a bounded V2 Session export", async () => {
    const writeResponse = await worker.fetch(write([event("0", "event-0")]), env);
    expect(writeResponse.status).toBe(201);

    const response = await worker.fetch(request("/v1/sessions/recording-api-session/export"), env);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
        formatVersion: "2",
        session: {
            sessionId: "recording-api-session",
            binding: { runtimeId: "runtime-recording-api" },
            events: [{ position: "0" }],
            truncated: false,
        },
    });
});

it("Given a recorded Session, When a developer reads retention, Then permanent retention is explicit", async () => {
    const writeResponse = await worker.fetch(write([event("0", "event-0")]), env);
    expect(writeResponse.status).toBe(201);

    const read = await worker.fetch(request("/v1/sessions/recording-api-session/retention"), env);
    expect(read.status).toBe(200);
    expect(await json(read)).toEqual({ kind: "permanent" });
});

it("Given a recorded Session, When a developer reads delivery status, Then successful Recording delivery is explicit", async () => {
    const writeResponse = await worker.fetch(write([event("0", "event-0")]), env);
    expect(writeResponse.status).toBe(201);

    const response = await worker.fetch(request("/v1/sessions/recording-api-session/delivery"), env);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
        kind: "recorded",
        recordedEventCount: 1,
    });
});

it("Given a recorded Session, When a developer queries history sources, Then Recording is available and unobserved sources remain explicit", async () => {
    const writeResponse = await worker.fetch(write([event("0", "event-0")]), env);
    expect(writeResponse.status).toBe(201);

    const response = await worker.fetch(request("/v1/sessions/recording-api-session/history"), env);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
        sessionId: "recording-api-session",
        projectId,
        runtimeId: "runtime-recording-api",
        sources: [
            { kind: "recording", state: "available" },
            { kind: "runtime-live", state: "unknown" },
            { kind: "native", state: "unknown" },
        ],
        recommended: "recording",
    });
});

it("Given a recorded Session, When a developer deletes it, Then metadata, events, and retention disappear together", async () => {
    const writeResponse = await worker.fetch(write([event("0", "event-0")]), env);
    expect(writeResponse.status).toBe(201);

    const deleted = await worker.fetch(request("/v1/sessions/recording-api-session", { method: "DELETE" }), env);
    expect(deleted.status).toBe(204);
    expect((await worker.fetch(request("/v1/sessions/recording-api-session"), env)).status).toBe(404);
    expect((await worker.fetch(request("/v1/sessions/recording-api-session/events"), env)).status).toBe(404);
    expect((await worker.fetch(request("/v1/sessions/recording-api-session/target"), env)).status).toBe(404);
});
