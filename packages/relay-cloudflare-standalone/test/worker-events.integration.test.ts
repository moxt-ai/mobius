import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    AGENT_ACTIVITY_KIND,
    AGENT_INSTALL_REQUEST_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    type AgentDisplayContent,
    decodeAgentInstallRequestCommand,
    decodeCommittedSessionEvent,
    decodeMessageKind,
    decodeRuntimeDelivery,
    decodeRuntimeDeliveryCommitted,
    decodeRuntimeHeartbeatAckEvent,
    decodeRuntimeLivenessReadyEvent,
    decodeRuntimeStatusEvent,
    decodeSessionEventAcknowledgement,
    decodeSessionEventDeferred,
    decodeSessionEventRejection,
    decodeSessionPromptCommand,
    encodeAgentInstallRequestCommand,
    encodeRuntimeDeliveryReceived,
    encodeRuntimeHeartbeatEvent,
    encodeSessionEventEnvelope,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    type RecordedSessionEvent,
    RUNTIME_DELIVERY_COMMITTED_KIND,
    RUNTIME_DELIVERY_RECEIVED_KIND,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_DEFERRED_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_STARTED_KIND,
    type SessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMobiusApp } from "../../../tests/infra/app.ts";
import { STANDALONE_NAMESPACE_PREFIX } from "../src/standalone-namespace.ts";
import { createStandaloneGateways } from "../src/worker.ts";
import { testBindings } from "./infra/bindings.ts";
import {
    runtimeWithTransport,
    SuspendedEventCommitTransport,
    UnavailableEventCommitTransport,
} from "./runtime-recovery-transport.ts";

import {
    commit,
    commitBatch,
    completeTurn,
    createSessionRequests,
    envelope,
    isRecord,
    prompt,
    receiveMessageBeforeClose,
    relayOrigin,
    requiredString,
    sha256Hex,
    submitPrompt,
} from "./worker-test-support.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T00:00:00.000Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

describe.sequential("Cloudflare session deployment: event delivery and storage", () => {
    it("Given a stable Channel targets a distinct Runtime, When a daemon connection is replaced, Then its durable epoch advances and the stale connection is fenced", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket } = createSessionRequests(app);
        const pairing = await pairChannel();
        const first = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const staleClosed = new Promise<number>((resolve) => {
            first.socket.addEventListener("close", (event) => resolve(event.code), {
                once: true,
            });
        });
        const replacement = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        expect(await staleClosed).toBe(1012);

        const stub = env.RUNTIME_RELAY.get(env.RUNTIME_RELAY.idFromName(pairing.created.channelId));
        await runInDurableObject(stub, async (_instance, state) => {
            const rows = state.storage.sql
                .exec(
                    `SELECT connection_epoch, connection_id, runtime_id, state
           FROM runtime_connection_state WHERE singleton = 1`,
                )
                .toArray();
            expect(rows).toEqual([
                expect.objectContaining({
                    connection_epoch: 2,
                    connection_id: expect.stringMatching(/^cnn_/),
                    runtime_id: pairing.created.runtimeId,
                    state: "online",
                }),
            ]);
        });
        replacement.socket.close(1000, "Connection epoch test complete");
    });

    it("Given Relay has accepted a Turn but daemon receipt is interrupted, When a receipt-capable daemon reconnects, Then the same delivery is retried and completes only after its durable receipt", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, waitForSocketClose, openChannelSocket, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "reliable-delivery-session";
        expect((await createSession(pairing.created, sessionId)).status).toBe(201);
        const reliablePath = `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}&deliveryReceipts=1`;
        const firstDaemon = await openChannelSocket(reliablePath);
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(true);

        try {
            const command = prompt(sessionId, "reliable-delivery-command", "survive the interrupted send");
            host.socket.send(encodeSessionPromptCommand(command));
            const firstDelivery = decodeRuntimeDelivery(await firstDaemon.messages.next());
            expect(firstDelivery).toMatchObject({ payload: encodeSessionPromptCommand(command), sessionId });
            expect(decodeSessionPromptCommand(await host.messages.next())).toEqual(command);

            const staleClosed = waitForSocketClose(firstDaemon.socket);
            const replacement = await openChannelSocket(reliablePath);
            expect((await staleClosed).code).toBe(1012);
            try {
                const retried = decodeRuntimeDelivery(await replacement.messages.next());
                expect(retried).toEqual(firstDelivery);
                replacement.socket.send(
                    encodeRuntimeDeliveryReceived({
                        deliveryId: retried.deliveryId,
                        kind: RUNTIME_DELIVERY_RECEIVED_KIND,
                        sessionId: retried.sessionId,
                    }),
                );
                expect(decodeRuntimeDeliveryCommitted(await replacement.messages.next())).toEqual({
                    deliveryId: retried.deliveryId,
                    kind: RUNTIME_DELIVERY_COMMITTED_KIND,
                    sessionId: retried.sessionId,
                });

                const sessionStub = env.SESSION_RELAY.get(
                    env.SESSION_RELAY.idFromName(
                        `${STANDALONE_NAMESPACE_PREFIX}:${pairing.created.projectId}:${sessionId}`,
                    ),
                );
                await runInDurableObject(sessionStub, async (_instance, state) => {
                    expect(
                        state.storage.sql
                            .exec(
                                `SELECT state FROM pending_work
                                 WHERE session_id = ? AND work_id = ?`,
                                sessionId,
                                retried.deliveryId,
                            )
                            .one(),
                    ).toMatchObject({ state: "completed" });
                });
            } finally {
                replacement.socket.close(1000, "Reliable delivery test complete");
            }
        } finally {
            host.socket.close(1000, "Reliable delivery test complete");
            firstDaemon.socket.close(1000, "Reliable delivery test complete");
        }
    });

    it("Given session persistence is backlogged, When the daemon sends a heartbeat, Then liveness is acknowledged before the event backlog drains", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "heartbeat-backlog-session";
        expect((await createSession(pairing.created, sessionId)).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}&liveness=1`,
        );
        expect(decodeRuntimeLivenessReadyEvent(await daemon.messages.next())).toEqual({
            kind: RUNTIME_LIVENESS_READY_KIND,
        });
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(true);

        try {
            const command = prompt(sessionId, "heartbeat-backlog-command", "stream a busy response");
            await submitPrompt(host, daemon, command);
            await commit(
                host,
                daemon,
                envelope(sessionId, "heartbeat-backlog-started", {
                    attemptId: "heartbeat-backlog-attempt",
                    commandId: command.commandId,
                    kind: SESSION_STARTED_KIND,
                    sessionId,
                }),
            );
            const bufferedEvents = Array.from({ length: 24 }, (_, index) =>
                envelope(sessionId, `heartbeat-backlog-activity-${index.toString()}`, {
                    activityId: "heartbeat-backlog-activity",
                    activityType: "tool",
                    commandId: command.commandId,
                    content: [],
                    detail: { kind: "unrecorded" },
                    input: "{}",
                    kind: AGENT_ACTIVITY_KIND,
                    locations: [],
                    name: "terminal",
                    output: `progress ${index.toString()}`,
                    sequence: index,
                    sessionId,
                    status: "running",
                    title: "Run terminal command",
                    toolKind: "execute",
                }),
            );
            for (const bufferedEvent of bufferedEvents) {
                daemon.socket.send(encodeSessionEventEnvelope(bufferedEvent));
            }
            const heartbeatId = "heartbeat-during-persistence-backlog";
            daemon.socket.send(
                encodeRuntimeHeartbeatEvent({
                    heartbeatId,
                    kind: RUNTIME_HEARTBEAT_KIND,
                }),
            );

            const acknowledgements = [];
            for (;;) {
                const daemonResponse = await daemon.messages.next();
                if (decodeMessageKind(daemonResponse) === RUNTIME_HEARTBEAT_ACK_KIND) {
                    expect(decodeRuntimeHeartbeatAckEvent(daemonResponse).heartbeatId).toBe(heartbeatId);
                    break;
                }
                acknowledgements.push(decodeSessionEventAcknowledgement(daemonResponse));
            }
            expect(acknowledgements.length).toBeLessThan(bufferedEvents.length);
            while (acknowledgements.length < bufferedEvents.length) {
                acknowledgements.push(decodeSessionEventAcknowledgement(await daemon.messages.next()));
            }
            const committedEvents = await Promise.all(
                bufferedEvents.map(async () => decodeCommittedSessionEvent(await host.messages.next())),
            );
            expect(new Set(acknowledgements.map(({ eventId }) => eventId))).toEqual(
                new Set(bufferedEvents.map(({ eventId }) => eventId)),
            );
            expect(new Set(committedEvents.map(({ eventId }) => eventId))).toEqual(
                new Set(bufferedEvents.map(({ eventId }) => eventId)),
            );
        } finally {
            host.socket.close(1000, "Heartbeat backlog test complete");
            daemon.socket.close(1000, "Heartbeat backlog test complete");
        }
    });

    it("Given a long Session has more pending archive rows than its hot window, When its next event arrives, Then the event commits without disconnecting the Runtime", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, createSession, openChannelSocket } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "long-session-count-backlog";
        expect((await createSession(pairing.created, sessionId, { hotEventLimit: 10 })).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(true);

        try {
            const sessionStub = env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(
                    `${STANDALONE_NAMESPACE_PREFIX}:${pairing.created.projectId}:${sessionId}`,
                ),
            );
            await runInDurableObject(sessionStub, async (_instance, state) => {
                for (let index = 0; index < 20; index += 1) {
                    state.storage.sql.exec(
                        `INSERT INTO archive_work (
                            scope_key, session_id, target_id, archive_kind, owner_id,
                            media_type, hot_payload
                         ) VALUES (?, ?, ?, 'activity', ?, 'application/json', ?)`,
                        pairing.created.projectId,
                        sessionId,
                        `long-session-pending-${index.toString()}`,
                        `long-session-owner-${index.toString()}`,
                        JSON.stringify({ index }),
                    );
                }
                await state.storage.deleteAlarm();
            });

            const nextEvent = envelope(sessionId, "long-session-next-event", {
                kind: SESSION_INFO_UPDATED_KIND,
                sessionId,
                title: "Still running",
                updatedAt: "2026-09-14T00:00:00.000Z",
            });
            const response = receiveMessageBeforeClose(daemon.socket);
            daemon.socket.send(encodeSessionEventEnvelope(nextEvent));
            expect(decodeSessionEventAcknowledgement(await response)).toMatchObject({
                eventId: nextEvent.eventId,
                sessionId,
            });
            expect(decodeCommittedSessionEvent(await host.messages.next())).toMatchObject({
                eventId: nextEvent.eventId,
                sessionId,
            });
            expect(daemon.socket.readyState).toBe(WebSocket.OPEN);
        } finally {
            host.socket.close(1000, "Long Session count backlog test complete");
            daemon.socket.close(1000, "Long Session count backlog test complete");
        }
    });

    it("Given an active Turn exceeds its former hot-event window, When it has not completed, Then every delta remains in a Durable Object stream block without an R2 archive", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, createSession, openChannelSocket, authorization } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "active-turn-hot-tail";
        expect((await createSession(pairing.created, sessionId, { hotEventLimit: 10 })).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(true);

        try {
            const command = prompt(sessionId, "active-turn-hot-tail-command", "stream past the former hot window");
            await submitPrompt(host, daemon, command);
            await commit(
                host,
                daemon,
                envelope(sessionId, "active-turn-hot-tail-started", {
                    attemptId: "active-turn-hot-tail-attempt",
                    commandId: command.commandId,
                    kind: SESSION_STARTED_KIND,
                    sessionId,
                }),
            );
            const deltaIds: string[] = [];
            for (let index = 0; index < 11; index += 1) {
                const eventId = `active-turn-hot-tail-delta-${index.toString()}`;
                deltaIds.push(eventId);
                await commit(
                    host,
                    daemon,
                    envelope(sessionId, eventId, {
                        commandId: command.commandId,
                        kind: AGENT_MESSAGE_DELTA_KIND,
                        messageId: "active-turn-hot-tail-message",
                        sessionId,
                        text: index.toString(),
                    }),
                );
            }

            const sessionStub = env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(
                    `${STANDALONE_NAMESPACE_PREFIX}:${pairing.created.projectId}:${sessionId}`,
                ),
            );
            await runInDurableObject(sessionStub, async (_instance, state) => {
                const rows = state.storage.sql
                    .exec(
                        `SELECT sequence_number, event_id, payload
                         FROM session_events
                         WHERE session_id = ?
                         ORDER BY sequence_number`,
                        sessionId,
                    )
                    .toArray();
                expect(rows).toEqual([
                    expect.objectContaining({ payload: expect.any(String), sequence_number: 1 }),
                    ...Array.from({ length: 11 }, (_, index) =>
                        expect.objectContaining({ payload: null, sequence_number: index + 2 }),
                    ),
                ]);
                expect(
                    state.storage.sql
                        .exec(
                            `SELECT COUNT(*) AS count
                               FROM session_stream_blocks
                              WHERE session_id = ?`,
                            sessionId,
                        )
                        .one(),
                ).toEqual({ count: 1 });
                expect(
                    state.storage.sql
                        .exec(
                            `SELECT COUNT(*) AS count
                               FROM session_stream_event_refs
                              WHERE session_id = ?`,
                            sessionId,
                        )
                        .one(),
                ).toEqual({ count: 11 });
                expect(
                    state.storage.sql
                        .exec("SELECT COUNT(*) AS count FROM archive_work WHERE session_id = ?", sessionId)
                        .one(),
                ).toEqual({ count: 0 });
            });

            const resumed = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${sessionId}/events?limit=100`,
                { headers: authorization(pairing.created) },
            );
            expect(resumed.status).toBe(200);
            const body: unknown = await resumed.json();
            if (!isRecord(body) || !Array.isArray(body["events"])) {
                throw new Error("Expected the active Turn event page");
            }
            expect(body["events"]).toMatchObject([
                { eventId: "active-turn-hot-tail-started" },
                ...deltaIds.map((eventId) => ({ eventId })),
            ]);
        } finally {
            host.socket.close(1000, "Active Turn hot tail test complete");
            daemon.socket.close(1000, "Active Turn hot tail test complete");
        }
    });

    it("Given a Session archive reaches its byte safety boundary, When a durable event is deferred and storage recovers, Then the same Runtime connection retries and commits it", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, createSession, openChannelSocket } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "long-session-byte-backpressure";
        expect(
            (
                await createSession(pairing.created, sessionId, {
                    contentLimitBytes: 1_024,
                    hotEventLimit: 10,
                })
            ).status,
        ).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(true);

        try {
            const sessionStub = env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(
                    `${STANDALONE_NAMESPACE_PREFIX}:${pairing.created.projectId}:${sessionId}`,
                ),
            );
            const backlogPayload = "x".repeat(128 * 1024);
            await runInDurableObject(sessionStub, async (_instance, state) => {
                for (let index = 0; index < 65; index += 1) {
                    state.storage.sql.exec(
                        `INSERT INTO archive_work (
                            scope_key, session_id, target_id, archive_kind, owner_id,
                            media_type, hot_payload
                         ) VALUES (?, ?, ?, 'activity', ?, 'application/json', ?)`,
                        pairing.created.projectId,
                        sessionId,
                        `long-session-byte-pending-${index.toString()}`,
                        `long-session-byte-owner-${index.toString()}`,
                        backlogPayload,
                    );
                }
                await state.storage.deleteAlarm();
            });

            const deferredEvents = Array.from({ length: 4 }, (_, index) =>
                envelope(sessionId, `long-session-deferred-event-${index.toString()}`, {
                    kind: SESSION_INFO_UPDATED_KIND,
                    sessionId,
                    title: `Backpressure recovered ${index.toString()}`,
                    updatedAt: "2026-09-14T00:00:00.000Z",
                }),
            );
            for (const event of deferredEvents) {
                daemon.socket.send(encodeSessionEventEnvelope(event));
            }
            for (const event of deferredEvents) {
                expect(decodeSessionEventDeferred(await daemon.messages.next())).toEqual({
                    eventId: event.eventId,
                    kind: SESSION_EVENT_DEFERRED_KIND,
                    retryAfterMilliseconds: 1_000,
                    sessionId,
                });
            }
            expect(daemon.socket.readyState).toBe(WebSocket.OPEN);

            await runInDurableObject(sessionStub, async (instance, state) => {
                if (instance.alarm === undefined) {
                    throw new Error("Expected the Session Durable Object alarm handler");
                }
                await state.storage.deleteAlarm();
                await instance.alarm();
                expect(
                    state.storage.sql
                        .exec(
                            `SELECT COUNT(*) AS count,
                                COALESCE(SUM(length(CAST(hot_payload AS BLOB))), 0) AS bytes
                             FROM archive_work
                             WHERE scope_key = ? AND session_id = ?`,
                            pairing.created.projectId,
                            sessionId,
                        )
                        .one(),
                ).toMatchObject({ bytes: 0, count: 0 });
            });

            for (const event of deferredEvents) {
                daemon.socket.send(encodeSessionEventEnvelope(event));
            }
            for (const event of deferredEvents) {
                expect(decodeSessionEventAcknowledgement(await daemon.messages.next())).toMatchObject({
                    eventId: event.eventId,
                    sessionId,
                });
                expect(decodeCommittedSessionEvent(await host.messages.next())).toMatchObject({
                    eventId: event.eventId,
                    sessionId,
                });
            }
            expect(daemon.socket.readyState).toBe(WebSocket.OPEN);
        } finally {
            host.socket.close(1000, "Long Session byte backpressure test complete");
            daemon.socket.close(1000, "Long Session byte backpressure test complete");
        }
    });

    it("Given one Session Durable Object is unavailable, When its daemon event is deferred, Then the channel socket remains available for another Session", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, createSession, openChannelSocket } = createSessionRequests(app);
        const pairing = await pairChannel();
        const unavailableSessionId = "unavailable-session";
        const healthySessionId = "healthy-session";
        expect((await createSession(pairing.created, unavailableSessionId)).status).toBe(201);
        expect((await createSession(pairing.created, healthySessionId)).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );

        try {
            const unavailableEvent = envelope(unavailableSessionId, "unavailable-session-event", {
                kind: SESSION_INFO_UPDATED_KIND,
                sessionId: unavailableSessionId,
                title: "Unavailable Session",
                updatedAt: "2026-09-19T00:00:00.000Z",
            });
            const healthyEvent = envelope(healthySessionId, "healthy-session-event", {
                kind: SESSION_INFO_UPDATED_KIND,
                sessionId: healthySessionId,
                title: "Healthy Session",
                updatedAt: "2026-09-19T00:00:00.000Z",
            });
            const runtimeStub = env.RUNTIME_RELAY.get(env.RUNTIME_RELAY.idFromName(pairing.created.channelId));
            await runInDurableObject(runtimeStub, async (_instance, state) => {
                const server = state.getWebSockets("daemon")[0];
                if (server === undefined) {
                    throw new Error("Expected a connected daemon");
                }
                const runtime = runtimeWithTransport(state, new UnavailableEventCommitTransport(unavailableSessionId));
                await runtime.webSocketMessage(server, encodeSessionEventEnvelope(unavailableEvent));
                await runtime.webSocketMessage(server, encodeSessionEventEnvelope(healthyEvent));
            });

            expect(decodeSessionEventDeferred(await daemon.messages.next())).toEqual({
                eventId: unavailableEvent.eventId,
                kind: SESSION_EVENT_DEFERRED_KIND,
                retryAfterMilliseconds: 1_000,
                sessionId: unavailableSessionId,
            });
            expect(decodeSessionEventAcknowledgement(await daemon.messages.next())).toMatchObject({
                eventId: healthyEvent.eventId,
                sessionId: healthySessionId,
            });
            expect(daemon.socket.readyState).toBe(WebSocket.OPEN);
        } finally {
            daemon.socket.close(1000, "Unavailable Session isolation test complete");
        }
    });

    it("Given a sustained Session has a deep archive queue, When recovery runs, Then it drains a production-sized batch and records the continuation alarm", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "long-session-archive-drain";
        expect((await createSession(pairing.created, sessionId)).status).toBe(201);
        const sessionStub = env.SESSION_RELAY.get(
            env.SESSION_RELAY.idFromName(`${STANDALONE_NAMESPACE_PREFIX}:${pairing.created.projectId}:${sessionId}`),
        );

        await runInDurableObject(sessionStub, async (instance, state) => {
            if (instance.alarm === undefined) {
                throw new Error("Expected the Session Durable Object alarm handler");
            }
            for (let index = 0; index < 300; index += 1) {
                state.storage.sql.exec(
                    `INSERT INTO archive_work (
                        scope_key, session_id, target_id, archive_kind, owner_id,
                        media_type, hot_payload
                     ) VALUES (?, ?, ?, 'activity', ?, 'application/json', ?)`,
                    pairing.created.projectId,
                    sessionId,
                    `archive-drain-${index.toString()}`,
                    `archive-drain-owner-${index.toString()}`,
                    JSON.stringify({ index }),
                );
            }
            await state.storage.deleteAlarm();
            await instance.alarm();
            expect(
                state.storage.sql
                    .exec(
                        `SELECT COUNT(*) AS count FROM archive_work
                         WHERE scope_key = ? AND session_id = ?`,
                        pairing.created.projectId,
                        sessionId,
                    )
                    .one(),
            ).toMatchObject({ count: 44 });
            await expect(state.storage.getAlarm()).resolves.not.toBeNull();

            await state.storage.deleteAlarm();
            await instance.alarm();
            expect(
                state.storage.sql
                    .exec(
                        `SELECT COUNT(*) AS count FROM archive_work
                         WHERE scope_key = ? AND session_id = ?`,
                        pairing.created.projectId,
                        sessionId,
                    )
                    .one(),
            ).toMatchObject({ count: 0 });
        });
    });

    it("Given a running Agent streams text deltas, When the browser receives the live events, Then the Session directory holds its start checkpoint until the terminal event arrives", async () => {
        vi.setSystemTime(new Date("2027-09-06T00:00:00.000Z"));
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "streaming-directory-session";
        expect((await createSession(pairing.created, sessionId)).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(true);

        try {
            const command = prompt(sessionId, "streaming-directory-command", "stream an answer");
            await submitPrompt(host, daemon, command);
            await commit(
                host,
                daemon,
                envelope(sessionId, "streaming-directory-started", {
                    attemptId: "streaming-directory-attempt",
                    commandId: command.commandId,
                    kind: SESSION_STARTED_KIND,
                    sessionId,
                }),
            );
            const deltas = Array.from({ length: 8 }, (_, index) =>
                envelope(sessionId, `streaming-directory-delta-${index.toString()}`, {
                    commandId: command.commandId,
                    kind: AGENT_MESSAGE_DELTA_KIND,
                    messageId: `streaming-directory-message-${index.toString()}`,
                    sessionId,
                    text: `part ${index.toString()}`,
                }),
            );
            await commitBatch(host, daemon, deltas);

            const sessionStub = env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(
                    `${STANDALONE_NAMESPACE_PREFIX}:${pairing.created.projectId}:${sessionId}`,
                ),
            );
            await runInDurableObject(sessionStub, async (_instance, state) => {
                await expect(state.storage.getAlarm()).resolves.toBe(Date.now() + 1_000);
            });

            const duringStream = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions?limit=1`,
                { headers: authorization(pairing.created) },
            );
            expect(duringStream.status).toBe(200);
            await expect(duringStream.json()).resolves.toMatchObject({
                sessions: [{ lastCommittedSeq: "1", sessionId }],
            });

            await commit(
                host,
                daemon,
                envelope(sessionId, "streaming-directory-completed", {
                    commandId: command.commandId,
                    kind: SESSION_COMPLETED_KIND,
                    sessionId,
                    stopReason: "end_turn",
                }),
            );
            const completed = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions?limit=1`,
                { headers: authorization(pairing.created) },
            );
            expect(completed.status).toBe(200);
            await expect(completed.json()).resolves.toMatchObject({
                sessions: [{ lastCommittedSeq: "10", sessionId }],
            });
        } finally {
            host.socket.close(1000, "Streaming directory test complete");
            daemon.socket.close(1000, "Streaming directory test complete");
        }
    });

    it("Given one Session sends a long ordered event burst, When another Session sends an event on the same Runtime connection, Then the second Session commits before the first burst drains", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const firstSessionId = "parallel-event-session-a";
        const secondSessionId = "parallel-event-session-b";
        const firstSession = await createSession(pairing.created, firstSessionId);
        const secondSession = await createSession(pairing.created, secondSessionId);
        expect(firstSession.status).toBe(201);
        expect(secondSession.status).toBe(201);
        const summaries = new Map<string, string>([
            [firstSessionId, JSON.stringify(await firstSession.json())],
            [secondSessionId, JSON.stringify(await secondSession.json())],
        ]);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );

        try {
            const firstSessionEvents = Array.from({ length: 24 }, (_, index) =>
                envelope(firstSessionId, `parallel-a-${index.toString()}`, {
                    kind: SESSION_INFO_UPDATED_KIND,
                    sessionId: firstSessionId,
                    title: `First ${index.toString()}`,
                    updatedAt: "2026-09-11T00:00:00.000Z",
                }),
            );
            const secondSessionEvent = envelope(secondSessionId, "parallel-b-1", {
                kind: SESSION_INFO_UPDATED_KIND,
                sessionId: secondSessionId,
                title: "Second",
                updatedAt: "2026-09-11T00:00:00.000Z",
            });
            const runtimeStub = env.RUNTIME_RELAY.get(env.RUNTIME_RELAY.idFromName(pairing.created.channelId));
            await runInDurableObject(runtimeStub, async (_instance, state) => {
                const server = state.getWebSockets("daemon")[0];
                const firstEvent = firstSessionEvents[0];
                if (server === undefined || firstEvent === undefined) {
                    throw new Error("Expected a connected daemon and an event burst");
                }
                const transport = new SuspendedEventCommitTransport(firstSessionId, secondSessionId, summaries);
                const runtime = runtimeWithTransport(state, transport);
                const pending = [runtime.webSocketMessage(server, encodeSessionEventEnvelope(firstEvent))];
                try {
                    await transport.suspended;
                    for (const event of firstSessionEvents.slice(1)) {
                        pending.push(runtime.webSocketMessage(server, encodeSessionEventEnvelope(event)));
                    }
                    pending.push(runtime.webSocketMessage(server, encodeSessionEventEnvelope(secondSessionEvent)));
                    expect(await transport.committed).toBe(secondSessionId);
                } finally {
                    transport.resume();
                    await Promise.all(pending);
                }
            });
        } finally {
            daemon.socket.close(1000, "Parallel Session event test complete");
        }
    });

    it("Given one Session sends a terminally invalid event, When another Session uses the same Runtime connection, Then only the invalid event is rejected and the other Session still commits", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const rejectedSessionId = "isolated-event-session-a";
        const healthySessionId = "isolated-event-session-b";
        expect((await createSession(pairing.created, rejectedSessionId)).status).toBe(201);
        expect((await createSession(pairing.created, healthySessionId)).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );

        try {
            const rejectedEvent: SessionEventEnvelope = {
                ...envelope(rejectedSessionId, "isolated-invalid-sequence", {
                    kind: SESSION_INFO_UPDATED_KIND,
                    sessionId: rejectedSessionId,
                    title: "Invalid source sequence",
                    updatedAt: "2026-09-11T00:00:00.000Z",
                }),
                source: { kind: "runtime", sourceSeq: "2" },
            };
            daemon.socket.send(encodeSessionEventEnvelope(rejectedEvent));
            expect(decodeSessionEventRejection(await daemon.messages.next())).toMatchObject({
                code: "session_rejected",
                eventId: rejectedEvent.eventId,
                sessionId: rejectedSessionId,
            });

            const healthyEvent = envelope(healthySessionId, "isolated-healthy-event", {
                kind: SESSION_INFO_UPDATED_KIND,
                sessionId: healthySessionId,
                title: "Healthy Session",
                updatedAt: "2026-09-11T00:00:00.000Z",
            });
            daemon.socket.send(encodeSessionEventEnvelope(healthyEvent));
            expect(decodeSessionEventAcknowledgement(await daemon.messages.next())).toMatchObject({
                eventId: healthyEvent.eventId,
                sessionId: healthySessionId,
            });
        } finally {
            daemon.socket.close(1000, "Session isolation test complete");
        }
    });

    it("Given independent sessions on one runtime, When history pages and a reconnect cursor are read, Then records stay ordered while duplicate delivery never reruns a command", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const { channelId } = pairing.created;
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await host.messages.next())).toMatchObject({
            online: true,
            runtimeId: pairing.created.runtimeId,
        });

        try {
            expect((await createSession(pairing.created, "session-a")).status).toBe(201);
            expect((await createSession(pairing.created, "session-b")).status).toBe(201);
            for (const [index, text] of ["first", "second", "third"].entries()) {
                vi.setSystemTime(new Date(`2026-09-06T00:00:0${index.toString()}.000Z`));
                const command = prompt("session-a", `command-a-${(index + 1).toString()}`, text);
                await completeTurn(
                    host,
                    daemon,
                    index === 0
                        ? {
                              ...command,
                              images: [
                                  {
                                      data: "aW1hZ2UtYnl0ZXM=",
                                      mimeType: "image/png",
                                      name: "diagram.png",
                                  },
                              ],
                              resources: [
                                  {
                                      mimeType: "text/plain",
                                      name: "notes.txt",
                                      text: "retained attachment",
                                      type: "embedded",
                                      uri: "file:///notes.txt",
                                  },
                              ],
                          }
                        : command,
                    `${text} response`,
                );
            }

            const running = prompt("session-b", "command-b-1", "keep running");
            await submitPrompt(host, daemon, running);
            const startedEnvelope = envelope("session-b", "b-started", {
                commandId: running.commandId,
                kind: SESSION_STARTED_KIND,
                attemptId: "attempt-b",
                sessionId: running.sessionId,
            });
            const firstLive = await commit(host, daemon, startedEnvelope);

            const messages = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/session-a/messages?limit=2`,
                { headers: authorization(pairing.created) },
            );
            expect(messages.status).toBe(200);
            const firstPage: unknown = await messages.json();
            expect(firstPage).toMatchObject({
                messages: [
                    { commandId: "command-a-3", response: "third response" },
                    { commandId: "command-a-2", response: "second response" },
                ],
                nextCursor: expect.any(String),
            });
            if (!isRecord(firstPage)) {
                throw new Error("Expected a message page");
            }
            const nextCursor = requiredString(firstPage, "nextCursor");
            const older = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/session-a/messages?limit=2&cursor=${encodeURIComponent(nextCursor)}`,
                { headers: authorization(pairing.created) },
            );
            await expect(older.json()).resolves.toMatchObject({
                messages: [
                    {
                        commandId: "command-a-1",
                        images: [
                            {
                                data: "aW1hZ2UtYnl0ZXM=",
                                mimeType: "image/png",
                                name: "diagram.png",
                            },
                        ],
                        resources: [
                            {
                                mimeType: "text/plain",
                                name: "notes.txt",
                                text: "retained attachment",
                                type: "embedded",
                                uri: "file:///notes.txt",
                            },
                        ],
                        response: "first response",
                    },
                ],
                nextCursor: null,
            });

            daemon.socket.send(encodeSessionEventEnvelope(startedEnvelope));
            expect(decodeSessionEventAcknowledgement(await daemon.messages.next())).toMatchObject({
                duplicate: true,
                eventId: "b-started",
            });
            const deltaEnvelope = envelope("session-b", "b-delta", {
                commandId: running.commandId,
                kind: AGENT_MESSAGE_DELTA_KIND,
                messageId: "",
                sessionId: running.sessionId,
                text: "still running",
            });
            const nextLive = await commit(host, daemon, deltaEnvelope);
            expect(BigInt(nextLive.sequence)).toBe(BigInt(firstLive.sequence) + 1n);

            const catchup = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/session-b/events?limit=10&cursor=${encodeURIComponent(firstLive.cursor)}`,
                { headers: authorization(pairing.created) },
            );
            await expect(catchup.json()).resolves.toMatchObject({
                events: [{ eventId: "b-delta", sequence: nextLive.sequence }],
                hasMore: false,
            });

            host.socket.send(encodeSessionPromptCommand(running));
            await expect(host.messages.next()).resolves.toContain("duplicate_running");
            const installRequest = encodeAgentInstallRequestCommand({
                agentId: "claude-code",
                kind: AGENT_INSTALL_REQUEST_KIND,
                requestId: "install-after-duplicate",
            });
            host.socket.send(installRequest);
            expect(decodeAgentInstallRequestCommand(await daemon.messages.next())).toEqual(
                decodeAgentInstallRequestCommand(installRequest),
            );

            const sessionStub = env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(`${STANDALONE_NAMESPACE_PREFIX}:${pairing.created.projectId}:session-a`),
            );
            await evictDurableObject(sessionStub);
            const recovered = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/session-a/messages?limit=1`,
                { headers: authorization(pairing.created) },
            );
            await expect(recovered.json()).resolves.toMatchObject({
                messages: [{ commandId: "command-a-3" }],
            });
        } finally {
            host.socket.close(1000, "Worker integration complete");
            daemon.socket.close(1000, "Worker integration complete");
        }
    });

    it("Given an Agent uploads and publishes media, When its completed Session message is read after event compaction, Then the stored media remains downloadable", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        await host.messages.next();

        try {
            expect((await createSession(pairing.created, "media-session")).status).toBe(201);
            const command = prompt("media-session", "media-command", "Create media");
            const bytes = new TextEncoder().encode("durable media bytes");
            const leaseResponse = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/sessions/${command.sessionId}/artifacts/uploads`,
                {
                    body: JSON.stringify({
                        byteLength: bytes.byteLength,
                        mediaType: "video/mp4",
                        name: "demo.mp4",
                        sha256: await sha256Hex(bytes),
                    }),
                    headers: {
                        authorization: `Bearer ${pairing.claimed.daemonToken}`,
                        "content-type": "application/json",
                    },
                    method: "POST",
                },
            );
            expect(leaseResponse.status).toBe(201);
            const lease = await leaseResponse.json();
            if (
                !isRecord(lease) ||
                typeof lease["artifactId"] !== "string" ||
                typeof lease["uploadToken"] !== "string"
            ) {
                throw new Error("Expected a media artifact upload lease");
            }
            const uploadResponse = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/sessions/${command.sessionId}/artifacts/${lease["artifactId"]}/content`,
                {
                    body: bytes,
                    headers: {
                        authorization: `Bearer ${pairing.claimed.daemonToken}`,
                        "content-type": "video/mp4",
                        "x-mobius-upload-token": lease["uploadToken"],
                    },
                    method: "PUT",
                },
            );
            expect(uploadResponse.status).toBe(200);
            const media: AgentDisplayContent = {
                artifactId: lease["artifactId"],
                data: "",
                mimeType: "video/mp4",
                name: "demo.mp4",
                newText: "",
                oldText: "",
                path: "",
                terminalId: "",
                text: "",
                type: "video",
                uri: "file:///demo.mp4",
            };
            await completeTurn(host, daemon, command, "Media ready", [
                {
                    commandId: command.commandId,
                    content: media,
                    contentId: "media-preview",
                    kind: "agent.content",
                    messageId: "assistant-media",
                    sessionId: command.sessionId,
                },
            ]);

            const response = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/media-session/messages`,
                { headers: authorization(pairing.created) },
            );
            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toMatchObject({
                messages: [{ commandId: command.commandId, contents: [media], response: "Media ready" }],
            });
            const download = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${command.sessionId}/artifacts/${lease["artifactId"]}/content`,
                { headers: authorization(pairing.created) },
            );
            expect(download.status).toBe(200);
            expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
        } finally {
            daemon.socket.close(1000, "Media projection test complete");
            host.socket.close(1000, "Media projection test complete");
        }
    });

    it("Given a Session has Turns with varied activities, content, and completion state, When a browser reads its message page, Then every Turn is fully and correctly assembled", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "batched-message-session";
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        await host.messages.next();

        try {
            expect((await createSession(pairing.created, sessionId)).status).toBe(201);

            const activity = (commandId: string, activityId: string, sequence: number): RecordedSessionEvent => ({
                activityId,
                activityType: "tool",
                commandId,
                content: [],
                detail: { kind: "unrecorded" },
                input: "{}",
                kind: AGENT_ACTIVITY_KIND,
                locations: [],
                name: "terminal",
                output: `output-${sequence.toString()}`,
                sequence,
                sessionId,
                status: "completed",
                title: "Run terminal command",
                toolKind: "execute",
            });
            const media: AgentDisplayContent = {
                artifactId: "",
                data: "",
                mimeType: "text/plain",
                name: "note.txt",
                newText: "",
                oldText: "",
                path: "",
                terminalId: "",
                text: "attached content",
                type: "text",
                uri: "",
            };

            const completedCommand = prompt(sessionId, "batched-completed", "Turn with activities and content");
            await completeTurn(host, daemon, completedCommand, "Completed response", [
                activity(completedCommand.commandId, "batched-completed-activity-1", 1),
                activity(completedCommand.commandId, "batched-completed-activity-2", 2),
                {
                    commandId: completedCommand.commandId,
                    content: media,
                    contentId: "batched-completed-content",
                    kind: "agent.content",
                    messageId: "batched-completed-message",
                    sessionId,
                },
            ]);

            const bareCommand = prompt(sessionId, "batched-bare", "Turn with no activities or content");
            await completeTurn(host, daemon, bareCommand, "Bare response");

            const streamingCommand = prompt(sessionId, "batched-streaming", "Turn still streaming its response");
            await submitPrompt(host, daemon, streamingCommand);
            await commit(
                host,
                daemon,
                envelope(sessionId, "batched-streaming-started", {
                    attemptId: "batched-streaming-attempt",
                    commandId: streamingCommand.commandId,
                    kind: SESSION_STARTED_KIND,
                    sessionId,
                }),
            );
            await commit(
                host,
                daemon,
                envelope(
                    sessionId,
                    "batched-streaming-activity",
                    activity(streamingCommand.commandId, "batched-streaming-activity-1", 1),
                ),
            );
            await commit(
                host,
                daemon,
                envelope(sessionId, "batched-streaming-delta-1", {
                    commandId: streamingCommand.commandId,
                    kind: AGENT_MESSAGE_DELTA_KIND,
                    messageId: "batched-streaming-message",
                    sessionId,
                    text: "Streaming ",
                }),
            );
            await commit(
                host,
                daemon,
                envelope(sessionId, "batched-streaming-delta-2", {
                    commandId: streamingCommand.commandId,
                    kind: AGENT_MESSAGE_DELTA_KIND,
                    messageId: "batched-streaming-message",
                    sessionId,
                    text: "response",
                }),
            );

            const response = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${sessionId}/messages`,
                { headers: authorization(pairing.created) },
            );
            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body).toMatchObject({
                messages: [
                    {
                        commandId: streamingCommand.commandId,
                        contents: [],
                        response: "Streaming response",
                    },
                    {
                        commandId: completedCommand.commandId,
                        contents: [media],
                        response: "Completed response",
                    },
                    {
                        activities: [],
                        commandId: bareCommand.commandId,
                        contents: [],
                        response: "Bare response",
                    },
                ],
            });
            if (
                !isRecord(body) ||
                !Array.isArray(body["messages"]) ||
                !isRecord(body["messages"][0]) ||
                !Array.isArray(body["messages"][0]["activities"]) ||
                !isRecord(body["messages"][1]) ||
                !Array.isArray(body["messages"][1]["activities"])
            ) {
                throw new Error("Expected the streaming and completed Turns to carry their activities arrays");
            }
            expect(body["messages"][0]["activities"]).toMatchObject([
                { output: "output-1", toolCallId: "batched-streaming-activity-1" },
            ]);
            const completedActivities = body["messages"][1]["activities"];
            expect(completedActivities).toHaveLength(2);
            expect(completedActivities).toMatchObject([
                { output: "output-1", toolCallId: "batched-completed-activity-1" },
                { output: "output-2", toolCallId: "batched-completed-activity-2" },
            ]);
        } finally {
            daemon.socket.close(1000, "Batched message projection test complete");
            host.socket.close(1000, "Batched message projection test complete");
        }
    });
});
