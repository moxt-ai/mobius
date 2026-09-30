import { env } from "cloudflare:workers";
import { encodeSessionRecordingWrite, SESSION_EVENT_KIND } from "@moxt-ai/mobius-protocol";
import { describe, expect, it, vi } from "vitest";
import { createRecordingWorker } from "../src/worker.ts";

const worker = createRecordingWorker();

function writeRequest(prompt: string, sessionId = "session-1"): Request {
    return writeEventRequest(
        {
            attemptId: "attempt-1",
            commandId: "command-1",
            epoch: "epoch-1",
            kind: "session.started",
            prompt,
            sequence: 0,
            sessionId,
        },
        "event-1",
        "1",
    );
}

function writeEventRequest(
    event: Readonly<Record<string, unknown>> & { readonly sessionId: string },
    eventId: string,
    sourceSeq: string,
    runtimeId = "runtime-1",
): Request {
    return new Request("https://recording.internal/v1/session-events", {
        body: encodeSessionRecordingWrite({
            envelope: {
                delivery: { eventId, kind: "reliable", sourceSeq, streamId: "stream-1" },
                kind: SESSION_EVENT_KIND,
                payload: JSON.stringify(event),
                sessionId: event.sessionId,
            },
            projectId: "standalone",
            runtimeId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });
}

describe("Recording Worker", () => {
    it("Given a recorded Session is forked after a terminal Turn, When parent and child continue independently, Then child history keeps only the parent prefix through that Turn", async () => {
        const runtimeId = "runtime-fork";
        const parentSessionId = "session-fork-parent";
        const childSessionId = "session-fork-child";
        const grandchildSessionId = "session-fork-grandchild";
        let sourceSequence = 100;
        const record = async (
            event: Readonly<Record<string, unknown>> & { readonly sessionId: string },
        ): Promise<Response> => {
            sourceSequence += 1;
            return await worker.fetch(
                writeEventRequest(
                    event,
                    `fork-event-${sourceSequence.toString()}`,
                    sourceSequence.toString(),
                    runtimeId,
                ),
                env,
            );
        };
        const ready = (sessionId: string) => ({
            additionalDirectories: [],
            agentId: "codex",
            agentName: "Codex",
            agentVersion: "1.0.0",
            capabilities: {
                additionalDirectories: true,
                audioPrompt: false,
                closeSession: true,
                deleteSession: true,
                embeddedContextPrompt: true,
                imagePrompt: true,
                listSessions: true,
                loadSession: true,
                promptQueueing: false,
                resumeSession: true,
                steering: false,
                unstableForkSession: true,
            },
            commands: [],
            configOptions: [],
            directoryId: "workspace",
            directoryLabel: "Workspace",
            kind: "session.ready",
            requestId: `ready-${sessionId}`,
            restored: sessionId !== parentSessionId,
            sessionId,
        });
        const turn = async (sessionId: string, commandId: string, prompt: string): Promise<void> => {
            expect(
                (
                    await record({
                        attemptId: `attempt-${commandId}`,
                        commandId,
                        epoch: `epoch-${commandId}`,
                        kind: "session.started",
                        prompt,
                        sequence: 0,
                        sessionId,
                    })
                ).status,
            ).toBe(201);
            expect(
                (await record({ commandId, kind: "session.completed", sessionId, stopReason: "end_turn" })).status,
            ).toBe(201);
        };

        // The Relay aggregates these segments to explain a slow delivery, so the header names are a contract.
        expect(
            (await record(ready(parentSessionId))).headers
                .get("x-mobius-recording-timing")
                ?.split(",")
                .map((segment) => segment.split(";dur=")[0]),
        ).toEqual([
            "recording-decode",
            "recording-session-write",
            "recording-session-claim",
            "recording-directory-write",
        ]);
        await turn(parentSessionId, "parent-command-1", "Parent turn one");
        expect((await record(ready(childSessionId))).status).toBe(201);
        expect(
            (
                await record({
                    kind: "session.forked",
                    sessionId: childSessionId,
                    sourceSessionId: parentSessionId,
                    throughCommandId: "parent-command-1",
                })
            ).status,
        ).toBe(201);

        const directory = await worker.fetch(
            new Request(`https://recording.internal/v1/projects/standalone/runtimes/${runtimeId}/sessions`),
            env,
        );
        expect(directory.status).toBe(200);
        const directoryBody = await directory.json<{ readonly sessions: readonly { readonly sessionId: string }[] }>();
        expect(directoryBody.sessions.map((session) => session.sessionId)).toContain(childSessionId);

        await turn(parentSessionId, "parent-command-2", "Parent turn two");
        await turn(childSessionId, "child-command-1", "Child turn one");

        const history = await worker.fetch(
            new Request(
                `https://recording.internal/v1/projects/standalone/runtimes/${runtimeId}/sessions/${childSessionId}/events`,
            ),
            env,
        );
        expect(history.status).toBe(200);
        const body = await history.json<{
            readonly segments: readonly {
                readonly entries: readonly { readonly envelope: { readonly payload: string } }[];
                readonly sessionId: string;
                readonly throughCommandId: string | null;
            }[];
        }>();
        expect(
            body.segments.map((segment) => ({
                commands: segment.entries
                    .map((entry) => JSON.parse(entry.envelope.payload) as { readonly commandId?: string })
                    .flatMap((event) => (event.commandId === undefined ? [] : [event.commandId])),
                sessionId: segment.sessionId,
                throughCommandId: segment.throughCommandId,
            })),
        ).toEqual([
            {
                commands: ["parent-command-1", "parent-command-1"],
                sessionId: parentSessionId,
                throughCommandId: "parent-command-1",
            },
            {
                commands: ["child-command-1", "child-command-1"],
                sessionId: childSessionId,
                throughCommandId: null,
            },
        ]);

        expect((await record(ready(grandchildSessionId))).status).toBe(201);
        expect(
            (
                await record({
                    kind: "session.forked",
                    sessionId: grandchildSessionId,
                    sourceSessionId: childSessionId,
                    throughCommandId: "child-command-1",
                })
            ).status,
        ).toBe(201);
        await turn(childSessionId, "child-command-2", "Child turn two");
        await turn(grandchildSessionId, "grandchild-command-1", "Grandchild turn one");

        const grandchildHistory = await worker.fetch(
            new Request(
                `https://recording.internal/v1/projects/standalone/runtimes/${runtimeId}/sessions/${grandchildSessionId}/events`,
            ),
            env,
        );
        expect(grandchildHistory.status).toBe(200);
        const grandchildBody = await grandchildHistory.json<typeof body>();
        expect(
            grandchildBody.segments.map((segment) => ({
                commands: segment.entries
                    .map((entry) => JSON.parse(entry.envelope.payload) as { readonly commandId?: string })
                    .flatMap((event) => (event.commandId === undefined ? [] : [event.commandId])),
                sessionId: segment.sessionId,
                throughCommandId: segment.throughCommandId,
            })),
        ).toEqual([
            {
                commands: ["parent-command-1", "parent-command-1"],
                sessionId: parentSessionId,
                throughCommandId: "parent-command-1",
            },
            {
                commands: ["child-command-1", "child-command-1"],
                sessionId: childSessionId,
                throughCommandId: "child-command-1",
            },
            {
                commands: ["grandchild-command-1", "grandchild-command-1"],
                sessionId: grandchildSessionId,
                throughCommandId: null,
            },
        ]);
    });

    it("Given a recorded Session is active, When content events and a terminal event arrive, Then only directory lifecycle events advance its recency", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            const sessionId = "session-directory-recency";
            vi.setSystemTime(new Date("2026-09-29T00:00:00.000Z"));
            expect(
                (
                    await worker.fetch(
                        writeEventRequest(
                            {
                                additionalDirectories: [],
                                agentId: "codex",
                                agentName: "Codex",
                                agentVersion: "1.0.0",
                                capabilities: {
                                    additionalDirectories: true,
                                    audioPrompt: false,
                                    closeSession: true,
                                    deleteSession: true,
                                    embeddedContextPrompt: true,
                                    imagePrompt: true,
                                    listSessions: true,
                                    loadSession: true,
                                    promptQueueing: false,
                                    resumeSession: true,
                                    steering: false,
                                    unstableForkSession: false,
                                },
                                commands: [],
                                configOptions: [],
                                directoryId: "workspace",
                                directoryLabel: "Workspace",
                                kind: "session.ready",
                                requestId: "request-recency",
                                restored: false,
                                sessionId,
                            },
                            "recency-event-1",
                            "20",
                            "runtime-recency",
                        ),
                        env,
                    )
                ).status,
            ).toBe(201);

            vi.setSystemTime(new Date("2026-09-29T00:01:00.000Z"));
            expect(
                (
                    await worker.fetch(
                        writeEventRequest(
                            {
                                attemptId: "attempt-recency",
                                commandId: "command-recency",
                                epoch: "epoch-recency",
                                kind: "session.started",
                                prompt: "Track meaningful activity",
                                sequence: 0,
                                sessionId,
                            },
                            "recency-event-2",
                            "21",
                            "runtime-recency",
                        ),
                        env,
                    )
                ).status,
            ).toBe(201);

            vi.setSystemTime(new Date("2026-09-29T00:02:00.000Z"));
            expect(
                (
                    await worker.fetch(
                        writeEventRequest(
                            {
                                commandId: "command-recency",
                                epoch: "epoch-recency",
                                kind: "agent.message.delta",
                                messageId: "message-recency",
                                sequence: 1,
                                sessionId,
                                text: "Streaming output",
                            },
                            "recency-event-3",
                            "22",
                            "runtime-recency",
                        ),
                        env,
                    )
                ).status,
            ).toBe(201);

            const directoryRequest = new Request(
                "https://recording.internal/v1/projects/standalone/runtimes/runtime-recency/sessions",
            );
            const afterDelta = await worker.fetch(directoryRequest, env);
            expect(afterDelta.status).toBe(200);
            expect(await afterDelta.json()).toMatchObject({
                sessions: [{ sessionId, updatedAt: "2026-09-29T00:01:00.000Z" }],
            });

            vi.setSystemTime(new Date("2026-09-29T00:03:00.000Z"));
            expect(
                (
                    await worker.fetch(
                        writeEventRequest(
                            {
                                commandId: "command-recency",
                                kind: "session.completed",
                                sessionId,
                                stopReason: "end_turn",
                            },
                            "recency-event-4",
                            "23",
                            "runtime-recency",
                        ),
                        env,
                    )
                ).status,
            ).toBe(201);

            const afterCompletion = await worker.fetch(directoryRequest, env);
            expect(afterCompletion.status).toBe(200);
            expect(await afterCompletion.json()).toMatchObject({
                sessions: [{ sessionId, updatedAt: "2026-09-29T00:03:00.000Z" }],
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it("Given a Session is ready and receives its first prompt, When Web reads the Runtime directory, Then Recording provides the Session without consulting the daemon", async () => {
        const sessionId = "session-directory";
        const ready = await worker.fetch(
            writeEventRequest(
                {
                    additionalDirectories: [{ directoryId: "docs", name: "Docs" }],
                    agentId: "codex",
                    agentName: "Codex",
                    agentVersion: "1.0.0",
                    capabilities: {
                        additionalDirectories: true,
                        audioPrompt: false,
                        closeSession: true,
                        deleteSession: true,
                        embeddedContextPrompt: true,
                        imagePrompt: true,
                        listSessions: true,
                        loadSession: true,
                        promptQueueing: false,
                        resumeSession: true,
                        steering: false,
                        unstableForkSession: false,
                    },
                    commands: [],
                    configOptions: [],
                    directoryId: "workspace",
                    directoryLabel: "Workspace",
                    kind: "session.ready",
                    requestId: "request-1",
                    restored: false,
                    sessionId,
                },
                "directory-event-1",
                "10",
            ),
            env,
        );
        expect(ready.status).toBe(201);
        expect(
            (
                await worker.fetch(
                    writeEventRequest(
                        {
                            attemptId: "attempt-directory",
                            commandId: "command-directory",
                            epoch: "epoch-directory",
                            kind: "session.started",
                            prompt: "Recorded directory title",
                            sequence: 0,
                            sessionId,
                        },
                        "directory-event-2",
                        "11",
                    ),
                    env,
                )
            ).status,
        ).toBe(201);

        const response = await worker.fetch(
            new Request("https://recording.internal/v1/projects/standalone/runtimes/runtime-1/sessions"),
            env,
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            sessions: [
                {
                    additionalDirectoryIds: ["docs"],
                    agentId: "codex",
                    directoryId: "workspace",
                    runtimeId: "runtime-1",
                    sessionId,
                    title: "Recorded directory title",
                },
            ],
        });
    });

    it("Given a malformed encoded target, When recorded history is requested, Then the Worker rejects it without throwing", async () => {
        const response = await worker.fetch(
            new Request("https://recording.internal/v1/projects/%E0%A4%A/runtimes/runtime-1/sessions/session-1/events"),
            env,
        );

        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    });

    it("Given a reliable Session event, When it is recorded and read twice, Then the write is idempotent and the durable history keeps one ordered event", async () => {
        const created = await worker.fetch(writeRequest("Remember this"), env);
        expect(created.status).toBe(201);
        const epoch = Reflect.get(await created.json<object>(), "recordingEpoch");
        expect(typeof epoch).toBe("string");

        const duplicate = await worker.fetch(writeRequest("Remember this"), env);
        expect(duplicate.status).toBe(200);
        expect(await duplicate.json()).toEqual({ recordingEpoch: epoch });

        const history = await worker.fetch(
            new Request(
                "https://recording.internal/v1/projects/standalone/runtimes/runtime-1/sessions/session-1/events",
            ),
            env,
        );
        expect(history.status).toBe(200);
        const body = await history.json<{
            readonly sessionId: string;
            readonly segments: readonly {
                readonly entries: readonly unknown[];
                readonly recordingEpoch: string;
                readonly sessionId: string;
                readonly throughCommandId: string | null;
            }[];
        }>();
        expect(body).toMatchObject({ sessionId: "session-1" });
        expect(body.segments).toEqual([
            {
                entries: expect.any(Array),
                recordingEpoch: epoch,
                sessionId: "session-1",
                throughCommandId: null,
            },
        ]);
        expect(body.segments[0]?.entries).toHaveLength(1);
    });

    it("Given an event identifier already belongs to another frame, When it is written again, Then Recording rejects the conflict", async () => {
        expect((await worker.fetch(writeRequest("First", "session-2"), env)).status).toBe(201);
        expect((await worker.fetch(writeRequest("Different", "session-2"), env)).status).toBe(409);
    });
});
