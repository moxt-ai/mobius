import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    AGENT_ACTIVITY_KIND,
    AGENT_INSTALL_PROGRESS_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    decodeAgentInstallProgressEvent,
    decodeCommittedSessionEvent,
    decodeNativeSessionCommand,
    decodeNativeSessionResult,
    decodeRecordedSessionEvent,
    decodeRuntimeStatusEvent,
    decodeServiceToDaemonMessage,
    decodeSessionEventAcknowledgement,
    decodeSessionEventDeferred,
    decodeSessionEventRejection,
    decodeSessionFailedEvent,
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    encodeAgentInstallProgressEvent,
    encodeNativeSessionCommand,
    encodeNativeSessionResult,
    encodeSessionEventEnvelope,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    type NativeSessionResult,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_REJECTED_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_STARTED_KIND,
    SessionEventRejectionCode,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMobiusApp } from "../../../tests/infra/app.ts";
import { RuntimeRelay } from "../src/durable-objects.ts";
import { STANDALONE_NAMESPACE_PREFIX } from "../src/standalone-namespace.ts";
import { createStandaloneGateways } from "../src/worker.ts";
import { testBindings } from "./infra/bindings.ts";
import {
    RecordingDeliveryProbeTransport,
    runtimeWithTransport,
    SuspendedDisconnectTransport,
} from "./runtime-recovery-transport.ts";

import {
    commit,
    commitBatch,
    completeTurn,
    createSessionRequests,
    envelope,
    isRecord,
    preparation,
    prompt,
    receiveMessageBeforeClose,
    relayOrigin,
    submitPrompt,
    verifiedAgentCapabilities,
} from "./worker-test-support.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T00:00:00.000Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

describe.sequential("Cloudflare session deployment: Session recovery and concurrency", () => {
    it("Given an Agent titled a prepared session, When the browser reconnects and prepares it again, Then the same session resumes without closing the channel", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket } = createSessionRequests(app);
        const pairing = await pairChannel();
        const { channelId } = pairing.created;
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const firstHost = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await firstHost.messages.next()).online).toBe(true);

        const firstPreparation = preparation("reconnected-session", "prepare-1");
        firstHost.socket.send(encodeSessionPrepareCommand(firstPreparation));
        expect(decodeSessionPrepareCommand(await daemon.messages.next())).toEqual(firstPreparation);
        expect(decodeSessionPrepareCommand(await firstHost.messages.next())).toEqual(firstPreparation);

        await commit(
            firstHost,
            daemon,
            envelope("reconnected-session", "generated-title", {
                kind: SESSION_INFO_UPDATED_KIND,
                sessionId: "reconnected-session",
                title: "Generated session title",
                updatedAt: "2026-09-06T00:00:00.000Z",
            }),
        );
        firstHost.socket.close(1000, "Browser reload");

        const secondHost = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await secondHost.messages.next()).online).toBe(true);

        try {
            const resumedPreparation = preparation("reconnected-session", "prepare-2");
            secondHost.socket.send(encodeSessionPrepareCommand(resumedPreparation));
            expect(decodeSessionPrepareCommand(await daemon.messages.next())).toEqual(resumedPreparation);
            expect(decodeSessionPrepareCommand(await secondHost.messages.next())).toEqual(resumedPreparation);
        } finally {
            secondHost.socket.close(1000, "Worker integration complete");
            daemon.socket.close(1000, "Worker integration complete");
        }
    });

    it("Given a prepared Session has no accepted Turn, When the browser changes its Agent and workspace, Then the new default binding is used without closing the channel", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization } = createSessionRequests(app);
        const pairing = await pairChannel();
        const { channelId } = pairing.created;
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(true);

        const firstPreparation = preparation("selectable-session", "prepare-codex");
        host.socket.send(encodeSessionPrepareCommand(firstPreparation));
        expect(decodeSessionPrepareCommand(await daemon.messages.next())).toEqual(firstPreparation);
        expect(decodeSessionPrepareCommand(await host.messages.next())).toEqual(firstPreparation);

        const changedPreparation = {
            ...preparation("selectable-session", "prepare-claude"),
            agentId: "claude-code",
            directoryId: "workspace-b",
        };
        host.socket.send(encodeSessionPrepareCommand(changedPreparation));
        expect(decodeSessionPrepareCommand(await daemon.messages.next())).toEqual(changedPreparation);
        expect(decodeSessionPrepareCommand(await host.messages.next())).toEqual(changedPreparation);

        const response = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/selectable-session`,
            { headers: authorization(pairing.created) },
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            agentId: "claude-code",
            defaultBinding: {
                agentRef: "claude-code",
                workspaceRef: "workspace-b",
            },
        });

        host.socket.close(1000, "Worker integration complete");
        daemon.socket.close(1000, "Worker integration complete");
    });

    it("Given an existing Session uses a workspace alias, When its native session reopens with the resolved workspace identity, Then the Relay returns the existing Session without dropping the daemon", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization } = createSessionRequests(app);
        const pairing = await pairChannel();
        const { channelId } = pairing.created;
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(true);

        try {
            const existingPreparation = preparation("existing-native-session", "prepare-existing-native");
            host.socket.send(encodeSessionPrepareCommand(existingPreparation));
            expect(decodeSessionPrepareCommand(await daemon.messages.next())).toEqual(existingPreparation);
            expect(decodeSessionPrepareCommand(await host.messages.next())).toEqual(existingPreparation);

            const command = {
                action: "import",
                additionalDirectoryIds: [],
                agentId: "codex",
                bindingId: "workspace",
                directoryId: "path-resolved-workspace",
                entryId: "existing-native-entry",
                kind: "native.session.request",
                requestId: "open-existing-native",
                sessionId: "native-session-browser",
                targetSessionId: "provisional-native-session",
            } as const;
            host.socket.send(encodeNativeSessionCommand(command));
            expect(decodeNativeSessionCommand(await daemon.messages.next())).toEqual(command);
            expect(decodeNativeSessionCommand(await host.messages.next())).toEqual(command);

            const result = {
                action: "import",
                history: {
                    coveredCommandIds: [],
                    coveredMessageIds: [],
                    messages: [
                        { role: "user", text: "Persist this native question" },
                        { role: "assistant", text: "Persist this native answer" },
                    ],
                    status: "available",
                    truncated: false,
                },
                kind: "native.session.result",
                ready: {
                    additionalDirectories: [],
                    agentId: "codex",
                    agentName: "Codex",
                    agentVersion: "test",
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
                    directoryId: "path-resolved-workspace",
                    directoryLabel: "/resolved/workspace",
                    kind: "session.ready",
                    requestId: "open-existing-native",
                    restored: true,
                    sessionId: "existing-native-session",
                },
                requestId: "open-existing-native",
                sessionId: "native-session-browser",
                targetSessionId: "provisional-native-session",
                title: "Existing native session",
            } satisfies NativeSessionResult;
            daemon.socket.send(encodeNativeSessionResult(result));
            expect(decodeNativeSessionResult(await host.messages.next())).toEqual(result);

            const existing = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/existing-native-session`,
                { headers: authorization(pairing.created) },
            );
            expect(existing.status).toBe(200);
            await expect(existing.json()).resolves.toMatchObject({
                hasNativeHistory: true,
                title: "Existing native session",
            });
            const nativeHistory = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/existing-native-session/native-history`,
                { headers: authorization(pairing.created) },
            );
            expect(nativeHistory.status).toBe(200);
            await expect(nativeHistory.json()).resolves.toEqual({ ...result.history, nextCursor: null });
            const exported = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/existing-native-session/export`,
                { headers: authorization(pairing.created) },
            );
            expect(exported.status).toBe(200);
            await expect(exported.json()).resolves.toMatchObject({
                formatVersion: "1",
                session: {
                    nativeHistory: result.history,
                    session: { hasNativeHistory: true },
                },
            });
            const provisional = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/provisional-native-session`,
                { headers: authorization(pairing.created) },
            );
            expect(provisional.status).toBe(410);
        } finally {
            host.socket.close(1000, "Worker integration complete");
            daemon.socket.close(1000, "Worker integration complete");
        }
    });

    it("Given a native fork is still being registered, When its Agent emits an event first, Then the Relay defers and later commits the event without dropping the daemon", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket } = createSessionRequests(app);
        const pairing = await pairChannel();
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(true);

        try {
            const command = {
                action: "fork",
                additionalDirectoryIds: [],
                agentId: "codex",
                bindingId: "workspace",
                directoryId: "workspace",
                entryId: "active-native-entry",
                kind: "native.session.request",
                requestId: "fork-active-native",
                sessionId: "native-session-browser",
                targetSessionId: "forked-native-session",
            } as const;
            host.socket.send(encodeNativeSessionCommand(command));
            expect(decodeNativeSessionCommand(await daemon.messages.next())).toEqual(command);
            expect(decodeNativeSessionCommand(await host.messages.next())).toEqual(command);

            const earlyEvent = envelope(command.targetSessionId, "forked-native-ready-event", {
                kind: SESSION_INFO_UPDATED_KIND,
                sessionId: command.targetSessionId,
                title: "Forked native session",
                updatedAt: "2026-09-16T00:00:00.000Z",
            });
            daemon.socket.send(encodeSessionEventEnvelope(earlyEvent));
            expect(decodeSessionEventDeferred(await daemon.messages.next())).toMatchObject({
                eventId: earlyEvent.eventId,
                sessionId: command.targetSessionId,
            });

            const result = {
                action: "fork",
                history: {
                    coveredCommandIds: [],
                    coveredMessageIds: [],
                    messages: [],
                    status: "available",
                    truncated: false,
                },
                kind: "native.session.result",
                ready: {
                    additionalDirectories: [],
                    agentId: command.agentId,
                    agentName: "Codex",
                    agentVersion: "test",
                    capabilities: { ...verifiedAgentCapabilities, unstableForkSession: true },
                    commands: [],
                    configOptions: [],
                    directoryId: command.directoryId,
                    directoryLabel: "/workspace",
                    kind: "session.ready",
                    requestId: command.requestId,
                    restored: true,
                    sessionId: command.targetSessionId,
                },
                requestId: command.requestId,
                sessionId: command.sessionId,
                targetSessionId: command.targetSessionId,
                title: "Forked native session",
            } satisfies NativeSessionResult;
            daemon.socket.send(encodeNativeSessionResult(result));
            expect(decodeNativeSessionResult(await host.messages.next())).toEqual(result);

            daemon.socket.send(encodeSessionEventEnvelope(earlyEvent));
            expect(decodeSessionEventAcknowledgement(await daemon.messages.next())).toMatchObject({
                eventId: earlyEvent.eventId,
                sessionId: command.targetSessionId,
            });
            expect(decodeCommittedSessionEvent(await host.messages.next())).toMatchObject({
                eventId: earlyEvent.eventId,
                sessionId: command.targetSessionId,
            });
            expect(daemon.socket.readyState).toBe(WebSocket.OPEN);
        } finally {
            host.socket.close(1000, "Native fork ordering test complete");
            daemon.socket.close(1000, "Native fork ordering test complete");
        }
    });

    it("Given an Attempt is running, When its daemon disconnects and restarts, Then the indeterminate outcome is retained until explicit reconciliation", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "daemon-restart-session";
        expect((await createSession(pairing.created, sessionId)).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(true);

        const interrupted = prompt(sessionId, "interrupted-command", "run until disconnected");
        await submitPrompt(host, daemon, interrupted);
        await commit(
            host,
            daemon,
            envelope(sessionId, "interrupted-started", {
                commandId: interrupted.commandId,
                kind: SESSION_STARTED_KIND,
                attemptId: "interrupted-attempt",
                sessionId,
            }),
        );
        daemon.socket.close(1000, "Daemon restart");
        expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(false);

        const interruptedHistory = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${sessionId}/messages`,
            { headers: authorization(pairing.created) },
        );
        await expect(interruptedHistory.json()).resolves.toMatchObject({
            messages: [
                {
                    attempt: {
                        kind: "indeterminate",
                        attemptId: "interrupted-attempt",
                    },
                    commandId: interrupted.commandId,
                },
            ],
        });

        const replacement = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(true);
        try {
            const deniedReconciliation = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/sessions/${sessionId}/attempts/interrupted-attempt/reconciliation?token=${encodeURIComponent(pairing.created.hostToken)}`,
                {
                    body: JSON.stringify({ outcome: { kind: "cancelled" } }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                },
            );
            expect(deniedReconciliation.status).toBe(401);
            await expect(deniedReconciliation.json()).resolves.toEqual({
                error: {
                    code: "unauthorized",
                    message: "A valid pairing or channel credential is required",
                },
            });

            const reconciliation = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/sessions/${sessionId}/attempts/interrupted-attempt/reconciliation?token=${encodeURIComponent(pairing.claimed.daemonToken)}`,
                {
                    body: JSON.stringify({
                        outcome: {
                            error: {
                                code: "runtime_restarted",
                                message: "The replacement Runtime confirmed execution stopped",
                                retryable: true,
                            },
                            kind: "failed",
                        },
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                },
            );
            expect(reconciliation.status).toBe(200);
            await expect(reconciliation.json()).resolves.toMatchObject({
                attemptId: "interrupted-attempt",
                state: { kind: "failed" },
            });
            const recovered = prompt(sessionId, "recovered-command", "continue after restart");
            await completeTurn(host, replacement, recovered, "recovered response");
            const recoveredHistory = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${sessionId}/messages`,
                { headers: authorization(pairing.created) },
            );
            await expect(recoveredHistory.json()).resolves.toMatchObject({
                messages: [
                    {
                        attempt: { kind: "succeeded" },
                        commandId: recovered.commandId,
                        response: "recovered response",
                    },
                    {
                        attempt: { kind: "failed" },
                        commandId: interrupted.commandId,
                    },
                ],
            });
        } finally {
            host.socket.close(1000, "Worker integration complete");
            replacement.socket.close(1000, "Worker integration complete");
        }
    });

    it("Given an owning Runtime has an already-running Attempt, When reconnection confirms the same running outcome, Then reconciliation succeeds without changing the Attempt", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "already-running-reconciliation-session";
        expect((await createSession(pairing.created, sessionId)).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(true);

        try {
            const active = prompt(sessionId, "already-running-reconciliation-command", "continue the active execution");
            await submitPrompt(host, daemon, active);
            await commit(
                host,
                daemon,
                envelope(sessionId, "already-running-reconciliation-started", {
                    commandId: active.commandId,
                    kind: SESSION_STARTED_KIND,
                    attemptId: "already-running-reconciliation-attempt",
                    sessionId,
                }),
            );

            const reconciliation = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/sessions/${sessionId}/attempts/already-running-reconciliation-attempt/reconciliation?token=${encodeURIComponent(pairing.claimed.daemonToken)}`,
                {
                    body: JSON.stringify({ outcome: { kind: "running" } }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                },
            );

            expect(reconciliation.status).toBe(200);
            await expect(reconciliation.json()).resolves.toMatchObject({
                attemptId: "already-running-reconciliation-attempt",
                state: { kind: "running" },
            });
            expect(daemon.socket.readyState).toBe(WebSocket.OPEN);
        } finally {
            host.socket.close(1000, "Worker integration complete");
            daemon.socket.close(1000, "Worker integration complete");
        }
    });

    it("Given a large tool record in the free deployment profile, When archive recovery and restart run, Then full details remain readable without external object storage", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "large-session";
        expect(
            (
                await createSession(pairing.created, sessionId, {
                    contentLimitBytes: 2_000_000,
                })
            ).status,
        ).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        await host.messages.next();

        try {
            const command = prompt(sessionId, "large-command", "run verbose tool");
            await submitPrompt(host, daemon, command);
            await commit(
                host,
                daemon,
                envelope(sessionId, "large-started", {
                    commandId: command.commandId,
                    kind: SESSION_STARTED_KIND,
                    attemptId: "large-attempt",
                    sessionId,
                }),
            );
            const fullOutput = `begin-${"large output line\n".repeat(100_000)}-end`;
            const activityEnvelope = envelope(sessionId, "large-activity", {
                activityId: "activity-large",
                activityType: "tool",
                commandId: command.commandId,
                content: [],
                detail: {
                    content: [],
                    input: "{}",
                    kind: "recorded",
                    output: fullOutput,
                },
                input: "{}",
                kind: AGENT_ACTIVITY_KIND,
                locations: [],
                name: "terminal",
                output: fullOutput.slice(0, 24_000),
                sequence: 0,
                sessionId,
                status: "completed",
                title: "Run terminal command",
                toolKind: "execute",
            });
            const committed = await commit(host, daemon, activityEnvelope);
            const recorded = decodeRecordedSessionEvent(committed.payload);
            expect(recorded).toMatchObject({
                detail: { kind: "available" },
                output: fullOutput.slice(0, 24_000),
            });

            const artifactId = "activity-large-activity";
            const stub = env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(
                    `${STANDALONE_NAMESPACE_PREFIX}:${pairing.created.projectId}:${sessionId}`,
                ),
            );
            await runInDurableObject(stub, async (_instance, state) => {
                expect(
                    state.storage.sql
                        .exec(
                            `SELECT hot_detail
                               FROM tool_call_views
                              WHERE session_id = ? AND activity_id = ?`,
                            sessionId,
                            "activity-large",
                        )
                        .one(),
                ).toEqual({ hot_detail: null });
                expect(
                    state.storage.sql
                        .exec(
                            `SELECT COUNT(*) AS count
                               FROM session_content_chunks
                              WHERE session_id = ? AND content_id = ?`,
                            sessionId,
                            artifactId,
                        )
                        .one(),
                ).toEqual({ count: 2 });
                const contentChunks = state.storage.sql
                    .exec<{ byte_length: number }>(
                        `SELECT byte_length
                           FROM session_content_chunks
                          WHERE session_id = ? AND content_id = ?
                          ORDER BY chunk_index`,
                        sessionId,
                        artifactId,
                    )
                    .toArray();
                expect(contentChunks).toHaveLength(2);
                expect(contentChunks.every((chunk) => chunk.byte_length <= 1_536 * 1024)).toBe(true);
                expect(
                    state.storage.sql
                        .exec(
                            `SELECT state FROM artifacts
                              WHERE session_id = ? AND artifact_id = ?`,
                            sessionId,
                            artifactId,
                        )
                        .one(),
                ).toEqual({ state: "uploading" });
                expect(
                    state.storage.sql
                        .exec(
                            `SELECT hot_payload FROM archive_work
                              WHERE session_id = ? AND target_id = ?`,
                            sessionId,
                            artifactId,
                        )
                        .one(),
                ).toEqual({ hot_payload: "" });
                await state.storage.deleteAlarm();
            });
            const detailPath = `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${sessionId}/attempts/large-attempt/tool-calls/activity-large`;
            const availableBeforeRecovery = await app.request(detailPath, {
                headers: authorization(pairing.created),
            });
            await expect(availableBeforeRecovery.json()).resolves.toMatchObject({
                kind: "available",
                output: fullOutput,
            });
            await evictDurableObject(stub);
            const chunkSizes = await runInDurableObject(stub, async (instance, state) => {
                if (instance.alarm === undefined) {
                    throw new Error("Expected the Session Durable Object alarm handler");
                }
                await instance.alarm();
                return state.storage.sql
                    .exec<{ byte_length: number }>(
                        `SELECT length(bytes) AS byte_length
             FROM immutable_content
             ORDER BY object_key`,
                    )
                    .toArray()
                    .map((row) => row.byte_length);
            });
            const archived = await app.request(detailPath, {
                headers: authorization(pairing.created),
            });
            await expect(archived.json()).resolves.toMatchObject({
                kind: "available",
                output: fullOutput,
                storage: "archive",
            });
            expect(chunkSizes.length).toBeGreaterThan(1);
            expect(chunkSizes.every((size) => size <= 192 * 1024)).toBe(true);
        } finally {
            host.socket.close(1000, "Worker integration complete");
            daemon.socket.close(1000, "Worker integration complete");
        }
    });

    it("Given an active Turn has a running compressed tool record, When the ToolCall completes and exceeds the archive quota, Then updates coalesce before archiving and a typed quota error preserves the final detail", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "quota-session";
        expect(
            (
                await createSession(pairing.created, sessionId, {
                    contentLimitBytes: 500_000,
                })
            ).status,
        ).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        await host.messages.next();

        try {
            const command = prompt(sessionId, "quota-command", "run noisy tool");
            await submitPrompt(host, daemon, command);
            await commit(
                host,
                daemon,
                envelope(sessionId, "quota-started", {
                    commandId: command.commandId,
                    kind: SESSION_STARTED_KIND,
                    attemptId: "quota-attempt",
                    sessionId,
                }),
            );
            let generatorState = 0x12345678;
            let fullOutput = "";
            for (let index = 0; index < 24_000; index += 1) {
                generatorState = (Math.imul(generatorState, 1_664_525) + 1_013_904_223) >>> 0;
                fullOutput += generatorState.toString(16).padStart(8, "0");
            }
            await commit(
                host,
                daemon,
                envelope(sessionId, "quota-activity-running", {
                    activityId: "activity-quota",
                    activityType: "tool",
                    commandId: command.commandId,
                    content: [],
                    detail: {
                        content: [],
                        input: "{}",
                        kind: "recorded",
                        output: fullOutput,
                    },
                    input: "{}",
                    kind: AGENT_ACTIVITY_KIND,
                    locations: [],
                    name: "terminal",
                    output: fullOutput.slice(0, 24_000),
                    sequence: 0,
                    sessionId,
                    status: "running",
                    title: "Run terminal command",
                    toolKind: "execute",
                }),
            );

            const stub = env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(
                    `${STANDALONE_NAMESPACE_PREFIX}:${pairing.created.projectId}:${sessionId}`,
                ),
            );
            await runInDurableObject(stub, async (_instance, state) => {
                expect(
                    state.storage.sql
                        .exec(
                            `SELECT COUNT(*) AS count
                             FROM archive_work
                             WHERE session_id = ? AND archive_kind = 'activity'`,
                            sessionId,
                        )
                        .one(),
                ).toEqual({ count: 0 });
            });
            const activeDetail = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${sessionId}/attempts/quota-attempt/tool-calls/activity-quota`,
                { headers: authorization(pairing.created) },
            );
            await expect(activeDetail.json()).resolves.toMatchObject({
                kind: "available",
                output: fullOutput,
                storage: "hot",
            });
            await commit(
                host,
                daemon,
                envelope(sessionId, "quota-activity", {
                    activityId: "activity-quota",
                    activityType: "tool",
                    commandId: command.commandId,
                    content: [],
                    detail: {
                        content: [],
                        input: "{}",
                        kind: "recorded",
                        output: fullOutput,
                    },
                    input: "{}",
                    kind: AGENT_ACTIVITY_KIND,
                    locations: [],
                    name: "terminal",
                    output: fullOutput.slice(0, 24_000),
                    sequence: 1,
                    sessionId,
                    status: "completed",
                    title: "Run terminal command",
                    toolKind: "execute",
                }),
            );
            await runInDurableObject(stub, async (_instance, state) => {
                expect(
                    state.storage.sql
                        .exec(
                            `SELECT COUNT(*) AS count
                             FROM archive_work
                             WHERE session_id = ? AND archive_kind = 'activity'`,
                            sessionId,
                        )
                        .one(),
                ).toEqual({ count: 1 });
            });
            const archiveResponse = await runInDurableObject(stub, async (instance) => {
                if (instance.fetch === undefined) {
                    throw new Error("Expected the Session Durable Object fetch handler");
                }
                return await instance.fetch(
                    new Request("https://session.internal/internal/sessions/archive", {
                        body: JSON.stringify({
                            scope: {
                                projectId: pairing.created.projectId,
                            },
                            sessionId,
                        }),
                        method: "POST",
                    }),
                );
            });
            expect(archiveResponse.status).toBe(429);
            await expect(archiveResponse.json()).resolves.toEqual({
                error: {
                    code: "session_quota_exceeded",
                    message: "The session archive quota is exhausted",
                },
            });

            const detail = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${sessionId}/attempts/quota-attempt/tool-calls/activity-quota`,
                { headers: authorization(pairing.created) },
            );
            await expect(detail.json()).resolves.toMatchObject({
                kind: "available",
                output: fullOutput,
                storage: "hot",
            });
        } finally {
            host.socket.close(1000, "Worker integration complete");
            daemon.socket.close(1000, "Worker integration complete");
        }
    });

    it("Given sessions in different project scopes and bounded retention, When callers export, import, delete, and expire data, Then isolation and availability outcomes are explicit", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, authorization, createSession } = createSessionRequests(app);
        const source = await pairChannel();
        const destination = await pairChannel();
        const sessionId = "lifecycle-session";
        expect((await createSession(source.created, sessionId)).status).toBe(201);

        const unauthorized = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${source.created.projectId}/sessions`,
            { headers: authorization(destination.created) },
        );
        expect(unauthorized.status).toBe(403);
        const invisible = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${destination.created.projectId}/sessions/${sessionId}`,
            { headers: authorization(destination.created) },
        );
        expect(invisible.status).toBe(404);

        const exportedResponse = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${source.created.projectId}/sessions/${sessionId}/export`,
            { headers: authorization(source.created) },
        );
        expect(exportedResponse.status).toBe(200);
        const exported: unknown = await exportedResponse.json();
        if (!isRecord(exported)) {
            throw new Error("Expected a Session export envelope");
        }
        const imported = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${destination.created.projectId}/session-imports`,
            {
                body: JSON.stringify({
                    formatVersion: exported["formatVersion"],
                    session: exported["session"],
                    targetBinding: {
                        agentRef: "codex",
                        bindingId: "imported-workspace",
                        configRevision: 1,
                        runtimeId: destination.created.runtimeId,
                        workspaceRef: "root",
                    },
                }),
                headers: {
                    ...authorization(destination.created),
                    "content-type": "application/json",
                },
                method: "POST",
            },
        );
        expect(imported.status).toBe(201);
        const importedResource = await imported.json();
        expect(isRecord(importedResource) && Object.hasOwn(importedResource, "tenantId")).toBe(false);
        expect(importedResource).toMatchObject({
            projectId: destination.created.projectId,
            sessionId,
        });

        const deleted = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${destination.created.projectId}/sessions/${sessionId}`,
            {
                headers: authorization(destination.created),
                method: "DELETE",
            },
        );
        expect(deleted.status).toBe(200);
        await expect(deleted.json()).resolves.toMatchObject({ kind: "deleted" });
        const afterDelete = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${destination.created.projectId}/sessions/${sessionId}/messages`,
            { headers: authorization(destination.created) },
        );
        expect(afterDelete.status).toBe(410);

        const expiringId = "retention-session";
        expect(
            (
                await createSession(source.created, expiringId, {
                    retentionMilliseconds: 60_000,
                })
            ).status,
        ).toBe(201);
        vi.setSystemTime(new Date("2026-09-06T00:01:00.000Z"));
        const expired = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${source.created.projectId}/sessions/${expiringId}`,
            { headers: authorization(source.created) },
        );
        expect(expired.status).toBe(410);
        await expect(expired.json()).resolves.toMatchObject({
            error: { code: "session_deleted" },
        });
    });

    it("Given a deleted Session and a live Session share one daemon, When stale and valid events arrive, Then only the stale event is rejected and the Channel stays online", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const deletedSessionId = "deleted-event-session";
        const liveSessionId = "live-event-session";
        expect((await createSession(pairing.created, deletedSessionId)).status).toBe(201);
        expect((await createSession(pairing.created, liveSessionId)).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(true);

        try {
            const deleted = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${deletedSessionId}`,
                {
                    headers: authorization(pairing.created),
                    method: "DELETE",
                },
            );
            expect(deleted.status).toBe(200);
            await expect(deleted.json()).resolves.toMatchObject({ kind: "deleted" });

            const staleEnvelope = envelope(deletedSessionId, "stale-event", {
                kind: SESSION_INFO_UPDATED_KIND,
                sessionId: deletedSessionId,
                title: "Too late",
                updatedAt: "2026-09-06T00:00:00.000Z",
            });
            const rejectionMessage = receiveMessageBeforeClose(daemon.socket);
            daemon.socket.send(encodeSessionEventEnvelope(staleEnvelope));
            expect(decodeSessionEventRejection(await rejectionMessage)).toEqual({
                code: SessionEventRejectionCode.SessionDeleted,
                eventId: staleEnvelope.eventId,
                kind: SESSION_EVENT_REJECTED_KIND,
                sessionId: staleEnvelope.sessionId,
            });
            await daemon.messages.next();
            expect(daemon.socket.readyState).toBe(WebSocket.OPEN);

            await commit(
                host,
                daemon,
                envelope(liveSessionId, "live-event", {
                    kind: SESSION_INFO_UPDATED_KIND,
                    sessionId: liveSessionId,
                    title: "Still live",
                    updatedAt: "2026-09-06T00:00:01.000Z",
                }),
            );
            expect(daemon.socket.readyState).toBe(WebSocket.OPEN);
        } finally {
            host.socket.close(1000, "Worker integration complete");
            daemon.socket.close(1000, "Worker integration complete");
        }
    });

    it("Given one Host has an active Turn, When a second Host submits another Turn to the same Session, Then only that request fails and both Host connections stay open", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "busy-session";
        expect((await createSession(pairing.created, sessionId)).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const firstHost = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        const secondHost = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        await Promise.all([firstHost.messages.next(), secondHost.messages.next()]);
        try {
            const first = prompt(sessionId, "busy-first", "run first");
            firstHost.socket.send(encodeSessionPromptCommand(first));
            expect(decodeSessionPromptCommand(await daemon.messages.next())).toEqual(first);
            expect(decodeSessionPromptCommand(await firstHost.messages.next())).toEqual(first);
            expect(decodeSessionPromptCommand(await secondHost.messages.next())).toEqual(first);

            const secondOutcome = new Promise<
                | { readonly encoded: string; readonly kind: "message" }
                | { readonly code: number; readonly kind: "closed" }
            >((resolve) => {
                const receive = (event: MessageEvent): void => {
                    cleanup();
                    resolve({
                        encoded: typeof event.data === "string" ? event.data : "invalid-binary",
                        kind: "message",
                    });
                };
                const close = (event: CloseEvent): void => {
                    cleanup();
                    resolve({ code: event.code, kind: "closed" });
                };
                const cleanup = (): void => {
                    secondHost.socket.removeEventListener("message", receive);
                    secondHost.socket.removeEventListener("close", close);
                };
                secondHost.socket.addEventListener("message", receive, { once: true });
                secondHost.socket.addEventListener("close", close, { once: true });
            });
            const second = prompt(sessionId, "busy-second", "run second");
            secondHost.socket.send(encodeSessionPromptCommand(second));
            const outcome = await secondOutcome;
            expect(outcome.kind).toBe("message");
            if (outcome.kind !== "message") {
                throw new Error(`Host connection closed with code ${outcome.code}`);
            }
            expect(decodeSessionFailedEvent(outcome.encoded)).toMatchObject({
                code: "session_busy",
                commandId: second.commandId,
                sessionId,
            });
            expect(firstHost.socket.readyState).toBe(WebSocket.OPEN);
            expect(secondHost.socket.readyState).toBe(WebSocket.OPEN);
        } finally {
            daemon.socket.close(1000, "Test complete");
            firstHost.socket.close(1000, "Test complete");
            secondHost.socket.close(1000, "Test complete");
        }
    });

    it("Given a Turn is running, When a capable Host queues a follow-up, Then the Relay preserves it until the running Turn completes and dispatches it next", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "queued-follow-up-session";
        expect((await createSession(pairing.created, sessionId)).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        await host.messages.next();
        try {
            const running = prompt(sessionId, "queue-running", "run first");
            await submitPrompt(host, daemon, running);
            await commit(
                host,
                daemon,
                envelope(sessionId, "queue-running-started", {
                    attemptId: "queue-running-attempt",
                    commandId: running.commandId,
                    kind: SESSION_STARTED_KIND,
                    sessionId,
                }),
            );

            const queued: SessionPromptCommand = {
                ...prompt(sessionId, "queue-follow-up", "run next"),
                disposition: SessionPromptDisposition.Queue,
                targetCommandId: running.commandId,
            };
            host.socket.send(encodeSessionPromptCommand(queued));
            expect(decodeSessionPromptCommand(await host.messages.next())).toEqual(queued);
            expect(daemon.messages.available()).toBe(0);

            await commit(
                host,
                daemon,
                envelope(sessionId, "queue-running-completed", {
                    commandId: running.commandId,
                    kind: SESSION_COMPLETED_KIND,
                    sessionId,
                    stopReason: "end_turn",
                }),
            );
            expect(decodeSessionPromptCommand(await daemon.messages.next())).toEqual(queued);
        } finally {
            daemon.socket.close(1000, "Test complete");
            host.socket.close(1000, "Test complete");
        }
    });

    it("Given a Turn is running, When a capable Host steers that exact Turn, Then the Relay dispatches the targeted follow-up immediately", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "steered-follow-up-session";
        expect((await createSession(pairing.created, sessionId)).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        await host.messages.next();
        try {
            const running = prompt(sessionId, "steer-running", "run first");
            await submitPrompt(host, daemon, running);
            await commit(
                host,
                daemon,
                envelope(sessionId, "steer-running-started", {
                    attemptId: "steer-running-attempt",
                    commandId: running.commandId,
                    kind: SESSION_STARTED_KIND,
                    sessionId,
                }),
            );
            const steered: SessionPromptCommand = {
                ...prompt(sessionId, "steer-follow-up", "change direction"),
                disposition: SessionPromptDisposition.Steer,
                targetCommandId: running.commandId,
            };

            host.socket.send(encodeSessionPromptCommand(steered));
            expect(decodeSessionPromptCommand(await daemon.messages.next())).toEqual(steered);
            expect(decodeSessionPromptCommand(await host.messages.next())).toEqual(steered);
        } finally {
            daemon.socket.close(1000, "Test complete");
            host.socket.close(1000, "Test complete");
        }
    });

    it("Given an active Turn, When its daemon sends a large event and completion without waiting between frames, Then the Relay commits both events in source order and keeps the connection open", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "ordered-burst-session";
        expect((await createSession(pairing.created, sessionId)).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        await host.messages.next();
        try {
            const command = prompt(sessionId, "ordered-burst-command", "run once");
            await submitPrompt(host, daemon, command);
            await commit(
                host,
                daemon,
                envelope(sessionId, "ordered-burst-started", {
                    commandId: command.commandId,
                    kind: SESSION_STARTED_KIND,
                    attemptId: "ordered-burst-attempt",
                    sessionId,
                }),
            );
            const fullOutput = "x".repeat(3_500_000);
            await commitBatch(host, daemon, [
                envelope(sessionId, "ordered-burst-activity", {
                    activityId: "ordered-burst-activity",
                    activityType: "tool",
                    commandId: command.commandId,
                    content: [],
                    detail: {
                        content: [],
                        input: "{}",
                        kind: "recorded",
                        output: fullOutput,
                    },
                    input: "{}",
                    kind: AGENT_ACTIVITY_KIND,
                    locations: [],
                    name: "terminal",
                    output: fullOutput.slice(0, 24_000),
                    sequence: 0,
                    sessionId,
                    status: "completed",
                    title: "Run terminal command",
                    toolKind: "execute",
                }),
                envelope(sessionId, "ordered-burst-completed", {
                    commandId: command.commandId,
                    kind: SESSION_COMPLETED_KIND,
                    sessionId,
                    stopReason: "end_turn",
                }),
            ]);
            expect(daemon.socket.readyState).toBe(WebSocket.OPEN);
        } finally {
            daemon.socket.close(1000, "Test complete");
            host.socket.close(1000, "Test complete");
        }
    });

    it("Given an active Turn with queued daemon events, When the daemon closes immediately after completion, Then its prior frames commit before disconnect recovery", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "ordered-close-session";
        expect((await createSession(pairing.created, sessionId)).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        await host.messages.next();
        const command = prompt(sessionId, "ordered-close-command", "run once");
        await submitPrompt(host, daemon, command);
        await commit(
            host,
            daemon,
            envelope(sessionId, "ordered-close-started", {
                commandId: command.commandId,
                kind: SESSION_STARTED_KIND,
                attemptId: "ordered-close-attempt",
                sessionId,
            }),
        );
        const activity = envelope(sessionId, "ordered-close-activity", {
            activityId: "ordered-close-activity",
            activityType: "tool",
            commandId: command.commandId,
            content: [],
            detail: {
                content: [],
                input: "{}",
                kind: "recorded",
                output: "x".repeat(3_500_000),
            },
            input: "{}",
            kind: AGENT_ACTIVITY_KIND,
            locations: [],
            name: "terminal",
            output: "large terminal output",
            sequence: 0,
            sessionId,
            status: "completed",
            title: "Run terminal command",
            toolKind: "execute",
        });
        const completed = envelope(sessionId, "ordered-close-completed", {
            commandId: command.commandId,
            kind: SESSION_COMPLETED_KIND,
            sessionId,
            stopReason: "end_turn",
        });
        const outcomes = Promise.all([host.messages.next(), host.messages.next(), host.messages.next()]);
        daemon.socket.send(encodeSessionEventEnvelope(activity));
        daemon.socket.send(encodeSessionEventEnvelope(completed));
        daemon.socket.close(1000, "Execution complete");
        try {
            const [activityMessage, completedMessage, offlineMessage] = await outcomes;
            expect(decodeCommittedSessionEvent(activityMessage).eventId).toBe(activity.eventId);
            expect(decodeCommittedSessionEvent(completedMessage).eventId).toBe(completed.eventId);
            expect(decodeRuntimeStatusEvent(offlineMessage).online).toBe(false);
            const history = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${sessionId}/messages`,
                { headers: authorization(pairing.created) },
            );
            await expect(history.json()).resolves.toMatchObject({
                messages: [
                    {
                        attempt: { kind: "succeeded" },
                        commandId: command.commandId,
                    },
                ],
            });
        } finally {
            host.socket.close(1000, "Test complete");
        }
    });

    it("Given an active turn, When disconnect cleanup times out and the relay wakes again, Then its alarm recovers the interrupted turn", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization, createSession } = createSessionRequests(app);
        vi.setSystemTime(new Date("2030-09-06T00:00:00.000Z"));
        const pairing = await pairChannel();
        const sessionId = "disconnect-recovery-session";
        expect((await createSession(pairing.created, sessionId)).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        await host.messages.next();
        const command = prompt(sessionId, "disconnect-recovery-command", "recover this turn");
        await submitPrompt(host, daemon, command);
        await commit(
            host,
            daemon,
            envelope(sessionId, "disconnect-recovery-started", {
                commandId: command.commandId,
                kind: SESSION_STARTED_KIND,
                attemptId: "disconnect-recovery-attempt",
                sessionId,
            }),
        );
        const stub = env.RUNTIME_RELAY.get(env.RUNTIME_RELAY.idFromName(pairing.created.channelId));
        try {
            await runInDurableObject(stub, async (instance, state) => {
                const socket = state.getWebSockets("daemon")[0];
                if (socket === undefined || instance.webSocketClose === undefined) {
                    throw new Error("Expected a connected runtime");
                }
                vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
                vi.setSystemTime(new Date("2030-09-06T00:00:00.000Z"));
                try {
                    const closing = instance.webSocketClose(socket, 1000, "Runtime stopped", true);
                    vi.advanceTimersByTime(30_000);
                    await expect(closing).rejects.toMatchObject({ name: "TimeoutError" });
                    expect(await state.storage.getAlarm()).not.toBeNull();
                } finally {
                    vi.useRealTimers();
                    vi.useFakeTimers({ toFake: ["Date"] });
                    vi.setSystemTime(new Date("2030-09-06T00:00:30.000Z"));
                }
            });
            await runInDurableObject(stub, async (_instance, state) => {
                await state.storage.deleteAlarm();
                await new RuntimeRelay(state, env).alarm();
            });
            const history = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${sessionId}/messages`,
                { headers: authorization(pairing.created) },
            );
            await expect(history.json()).resolves.toMatchObject({
                messages: [{ commandId: command.commandId, attempt: { kind: "indeterminate" } }],
            });
        } finally {
            host.socket.close(1000, "Test complete");
            daemon.socket.close(1000, "Test complete");
        }
    });

    it("Given disconnect cleanup has recovered one of two turns, When its deadline expires and the daemon reconnects, Then only unfinished recovery resumes and later alarms preserve running work", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization, createSession } = createSessionRequests(app);
        vi.setSystemTime(new Date("2030-09-06T00:00:00.000Z"));
        const pairing = await pairChannel();
        const sessionIds = ["checkpoint-session-a", "checkpoint-session-b"];
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        await host.messages.next();
        for (const sessionId of sessionIds) {
            expect((await createSession(pairing.created, sessionId)).status).toBe(201);
            const command = prompt(sessionId, `${sessionId}-command`, "recover independently");
            await submitPrompt(host, daemon, command);
            await commit(
                host,
                daemon,
                envelope(sessionId, `${sessionId}-started`, {
                    commandId: command.commandId,
                    kind: SESSION_STARTED_KIND,
                    attemptId: `${sessionId}-attempt`,
                    sessionId,
                }),
            );
        }
        const stub = env.RUNTIME_RELAY.get(env.RUNTIME_RELAY.idFromName(pairing.created.channelId));
        try {
            const completedSessionId = await runInDurableObject(stub, async (_instance, state) => {
                const socket = state.getWebSockets("daemon")[0];
                if (socket === undefined) {
                    throw new Error("Expected a connected runtime");
                }
                const transport = new SuspendedDisconnectTransport();
                vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
                vi.setSystemTime(new Date("2030-09-06T00:00:00.000Z"));
                try {
                    const closing = runtimeWithTransport(state, transport).webSocketClose(socket);
                    const rejected = expect(closing).rejects.toMatchObject({ name: "TimeoutError" });
                    const completed = await transport.suspended;
                    vi.advanceTimersByTime(30_000);
                    await rejected;
                    expect(await state.storage.getAlarm()).not.toBeNull();
                    return completed;
                } finally {
                    vi.useRealTimers();
                    vi.useFakeTimers({ toFake: ["Date"] });
                    vi.setSystemTime(new Date("2030-09-06T00:00:30.000Z"));
                }
            });
            // The completed session is reconciled through the daemon's supported HTTP boundary.
            // Replaying that session's disconnect after restart would regress it to indeterminate.
            const reconcile = async (sessionId: string) =>
                app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/sessions/${sessionId}/attempts/${sessionId}-attempt/reconciliation?token=${encodeURIComponent(pairing.claimed.daemonToken)}`,
                    {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ outcome: { kind: "running" } }),
                    },
                );
            expect((await reconcile(completedSessionId)).status).toBe(200);
            // Close the transport after the timed-out callback; the durable connection is
            // already offline, so this duplicate platform notification cannot finish the job.
            daemon.socket.close(1000, "Restarting runtime");
            const replacement = await openChannelSocket(
                `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
            );
            try {
                for (const sessionId of sessionIds) {
                    const history = await app.request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${sessionId}/messages`,
                        { headers: authorization(pairing.created) },
                    );
                    await expect(history.json()).resolves.toMatchObject({
                        messages: [
                            { attempt: { kind: sessionId === completedSessionId ? "running" : "indeterminate" } },
                        ],
                    });
                    expect((await reconcile(sessionId)).status).toBe(200);
                }
                await runInDurableObject(stub, async (_instance, state) => {
                    await state.storage.deleteAlarm();
                    await new RuntimeRelay(state, env).alarm();
                });
                for (const sessionId of sessionIds) {
                    const history = await app.request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${sessionId}/messages`,
                        { headers: authorization(pairing.created) },
                    );
                    await expect(history.json()).resolves.toMatchObject({
                        messages: [{ attempt: { kind: "running" } }],
                    });
                }
            } finally {
                replacement.socket.close(1000, "Test complete");
            }
        } finally {
            host.socket.close(1000, "Test complete");
            daemon.socket.close(1000, "Test complete");
        }
    });

    it.each(["replacement", "reconnect"])(
        "Given a %s is waiting for disconnect cleanup, When its runtime is revoked, Then pending and future connections remain forbidden",
        async (mode) => {
            const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
            const { pairChannel, openChannelSocket, createSession } = createSessionRequests(app);
            vi.setSystemTime(new Date("2030-09-06T00:00:00.000Z"));
            const pairing = await pairChannel();
            for (const suffix of ["a", "b"]) {
                expect((await createSession(pairing.created, `revocation-race-${mode}-${suffix}`)).status).toBe(201);
            }
            const daemon = await openChannelSocket(
                `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
            );
            const stub = env.RUNTIME_RELAY.get(env.RUNTIME_RELAY.idFromName(pairing.created.channelId));
            try {
                await runInDurableObject(stub, async (_instance, state) => {
                    const transport = new SuspendedDisconnectTransport();
                    const runtime = runtimeWithTransport(state, transport);
                    const headers = {
                        "x-mobius-channel-id": pairing.created.channelId,
                        "x-mobius-runtime-id": pairing.created.runtimeId,
                    };
                    const connect = () =>
                        new Request(`https://runtime.internal/projects/${pairing.created.projectId}/daemon`, {
                            headers: { ...headers, Upgrade: "websocket" },
                        });
                    let closing: Promise<void> = Promise.resolve();
                    if (mode === "reconnect") {
                        const socket = state.getWebSockets("daemon")[0];
                        if (socket === undefined) {
                            throw new Error("Expected connected daemon");
                        }
                        closing = runtime.webSocketClose(socket);
                        await transport.suspended;
                    }
                    const pending = runtime.fetch(connect());
                    await transport.suspended;
                    const queued = runtime.fetch(connect());
                    const revoked = runtime.fetch(
                        new Request(`https://runtime.internal/projects/${pairing.created.projectId}/runtime/revoke`, {
                            method: "DELETE",
                            headers,
                        }),
                    );
                    try {
                        // Revocation must complete while session cleanup is still suspended.
                        expect((await revoked).status).toBe(204);
                    } finally {
                        transport.resume();
                    }
                    await closing;
                    for (const response of await Promise.all([pending, queued])) {
                        if (response.webSocket !== null) {
                            response.webSocket.accept();
                            response.webSocket.close(1000, "Test complete");
                        }
                        expect(response.status).toBe(401);
                        await expect(response.json()).resolves.toMatchObject({ error: { code: "runtime_revoked" } });
                    }
                    const restored = new RuntimeRelay(state, env);
                    await restored.alarm();
                    const status = await restored.fetch(
                        new Request(`https://runtime.internal/projects/${pairing.created.projectId}/runtime-status`, {
                            headers,
                        }),
                    );
                    await expect(status.json()).resolves.toEqual({ online: false });
                    const future = await restored.fetch(connect());
                    expect(future.status).toBe(401);
                    await expect(future.json()).resolves.toMatchObject({ error: { code: "runtime_revoked" } });
                    const host = await restored.fetch(
                        new Request(`https://runtime.internal/projects/${pairing.created.projectId}/host`, {
                            headers: {
                                ...headers,
                                Upgrade: "websocket",
                                "x-mobius-host-credential-id": "verified-host",
                            },
                        }),
                    );
                    expect(host.status).toBe(401);
                    await expect(host.json()).resolves.toMatchObject({ error: { code: "runtime_revoked" } });
                });
            } finally {
                daemon.socket.close(1000, "Test complete");
            }
        },
    );

    it("Given a completed Turn, When a client resumes from its old cursor and retransmits the terminal event, Then the cursor expires while message recovery and terminal deduplication remain complete", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const sessionId = "cursor-session";
        expect((await createSession(pairing.created, sessionId)).status).toBe(201);
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const host = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
        );
        await host.messages.next();
        try {
            const command = prompt(sessionId, "cursor-command", "stream output");
            await submitPrompt(host, daemon, command);
            const startedEnvelope = envelope(sessionId, "cursor-started", {
                commandId: command.commandId,
                kind: SESSION_STARTED_KIND,
                attemptId: "cursor-attempt",
                sessionId,
            });
            const first = await commit(host, daemon, startedEnvelope);
            const deltas = Array.from({ length: 40 }, (_, index) =>
                envelope(sessionId, `cursor-delta-${index.toString()}`, {
                    commandId: command.commandId,
                    kind: AGENT_MESSAGE_DELTA_KIND,
                    messageId: `agent-message-${index.toString()}`,
                    sessionId,
                    text: index.toString(),
                }),
            );
            const completedEnvelope = envelope(sessionId, "cursor-completed", {
                commandId: command.commandId,
                kind: SESSION_COMPLETED_KIND,
                sessionId,
                stopReason: "end_turn",
            });
            for (let offset = 0; offset < deltas.length; offset += 10) {
                await commitBatch(host, daemon, deltas.slice(offset, offset + 10));
            }
            const sessionStub = env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(
                    `${STANDALONE_NAMESPACE_PREFIX}:${pairing.created.projectId}:${sessionId}`,
                ),
            );
            await runInDurableObject(sessionStub, async (_instance, state) => {
                expect(
                    state.storage.sql
                        .exec(
                            `SELECT COUNT(*) AS count
                               FROM session_streams
                              WHERE session_id = ?`,
                            sessionId,
                        )
                        .one(),
                ).toEqual({ count: 1 });
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
                               FROM session_events
                              WHERE session_id = ? AND payload IS NULL`,
                            sessionId,
                        )
                        .one(),
                ).toEqual({ count: deltas.length });
            });
            await commit(host, daemon, completedEnvelope);
            await runInDurableObject(sessionStub, async (instance, state) => {
                if (instance.alarm === undefined) {
                    throw new Error("Expected the Session Durable Object alarm handler");
                }
                await state.storage.deleteAlarm();
                await instance.alarm();
                expect(
                    state.storage.sql
                        .exec("SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?", sessionId)
                        .one(),
                ).toEqual({ count: 0 });
                expect(
                    state.storage.sql
                        .exec("SELECT event_id, source_seq FROM session_event_receipts WHERE session_id = ?", sessionId)
                        .one(),
                ).toMatchObject({ event_id: "cursor-completed", source_seq: "42" });
                expect(
                    state.storage.sql
                        .exec(
                            `SELECT role, content, content_chunks
                               FROM session_messages
                              WHERE session_id = ? AND role = 'assistant'`,
                            sessionId,
                        )
                        .one(),
                ).toEqual({
                    content: deltas.map((_event, index) => index.toString()).join(""),
                    content_chunks: 0,
                    role: "assistant",
                });
                expect(
                    state.storage.sql
                        .exec("SELECT COUNT(*) AS count FROM session_streams WHERE session_id = ?", sessionId)
                        .one(),
                ).toEqual({ count: 0 });
                expect(
                    state.storage.sql
                        .exec("SELECT COUNT(*) AS count FROM session_stream_blocks WHERE session_id = ?", sessionId)
                        .one(),
                ).toEqual({ count: 0 });
            });
            const resumed = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${sessionId}/events?cursor=${encodeURIComponent(first.cursor)}`,
                { headers: authorization(pairing.created) },
            );
            expect(resumed.status).toBe(410);
            await expect(resumed.json()).resolves.toMatchObject({ error: { code: "cursor_expired" } });
            const recoveredMessages = await app.request(
                relayOrigin +
                    MOBIUS_API_PREFIX +
                    "/projects/" +
                    pairing.created.projectId +
                    "/sessions/" +
                    sessionId +
                    "/messages",
                { headers: authorization(pairing.created) },
            );
            expect(recoveredMessages.status).toBe(200);
            await expect(recoveredMessages.json()).resolves.toMatchObject({
                messages: [{ response: deltas.map((_event, index) => index.toString()).join("") }],
            });
            daemon.socket.send(encodeSessionEventEnvelope(completedEnvelope));
            expect(decodeSessionEventAcknowledgement(await daemon.messages.next())).toMatchObject({
                duplicate: true,
                eventId: "cursor-completed",
            });

            const progress = encodeAgentInstallProgressEvent({
                agentId: "claude-code",
                kind: AGENT_INSTALL_PROGRESS_KIND,
                requestId: "bounded-control",
                stage: "checking_acp",
            });
            daemon.socket.send(progress);
            expect(decodeAgentInstallProgressEvent(await host.messages.next())).toEqual(
                decodeAgentInstallProgressEvent(progress),
            );
        } finally {
            host.socket.close(1000, "Worker integration complete");
            daemon.socket.close(1000, "Worker integration complete");
        }
    });

    it("Given a configured project session quota, When public callers exhaust and release it, Then admission returns an explicit retryable outcome", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, authorization, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        const invalidImport = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/session-imports`,
            {
                body: JSON.stringify({
                    formatVersion: "1",
                    session: { session: { sessionId: "invalid-import" } },
                    targetBinding: {
                        agentRef: "codex",
                        bindingId: "imported-workspace",
                        configRevision: 1,
                        runtimeId: pairing.created.runtimeId,
                        workspaceRef: "root",
                    },
                }),
                headers: {
                    ...authorization(pairing.created),
                    "content-type": "application/json",
                },
                method: "POST",
            },
        );
        expect(invalidImport.status).toBe(400);
        await expect(invalidImport.json()).resolves.toMatchObject({
            error: { code: "invalid_export" },
        });
        expect((await createSession(pairing.created, "quota-first")).status).toBe(201);
        expect((await createSession(pairing.created, "quota-second")).status).toBe(201);

        const exhausted = await createSession(pairing.created, "quota-third");
        expect(exhausted.status).toBe(429);
        await expect(exhausted.json()).resolves.toMatchObject({
            error: { code: "session_quota_exceeded" },
        });
        expect((await createSession(pairing.created, "quota-first")).status).toBe(201);

        const deleted = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/quota-first`,
            { headers: authorization(pairing.created), method: "DELETE" },
        );
        expect(deleted.status).toBe(200);
        expect((await createSession(pairing.created, "quota-third")).status).toBe(201);
    });

    it("Given a Project owns several Sessions, When its daemon attaches, Then the Relay probes their pending work concurrently instead of one Session at a time", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        for (const sessionId of ["fan-out-first", "fan-out-second"]) {
            expect((await createSession(pairing.created, sessionId)).status).toBe(201);
        }
        const stub = env.RUNTIME_RELAY.get(env.RUNTIME_RELAY.idFromName(pairing.created.channelId));
        const maximumConcurrentProbes = await runInDurableObject(stub, async (_instance, state) => {
            const transport = new RecordingDeliveryProbeTransport();
            const response = await runtimeWithTransport(state, transport).fetch(
                new Request(
                    `https://runtime.internal/projects/${encodeURIComponent(pairing.created.projectId)}/daemon?deliveryReceipts=1&liveness=1`,
                    {
                        headers: {
                            Upgrade: "websocket",
                            "x-mobius-channel-id": pairing.created.channelId,
                            "x-mobius-runtime-id": pairing.created.runtimeId,
                        },
                    },
                ),
            );
            expect(response.status).toBe(101);
            if (response.webSocket === null) {
                throw new Error("Expected the Runtime WebSocket");
            }
            const socket = response.webSocket;
            const ready = receiveMessageBeforeClose(socket);
            socket.accept();
            try {
                expect(decodeServiceToDaemonMessage(await ready)).toEqual({
                    kind: "runtime.liveness.ready",
                });
                return transport.maximumConcurrentProbes();
            } finally {
                socket.close(1000, "Concurrent attachment test complete");
            }
        });
        // Serial probing keeps this at 1 and lets a large Project's Session count push the attach past the
        // daemon's connection deadline; overlapping probes keep the attach bounded by concurrency, not count.
        expect(maximumConcurrentProbes).toBeGreaterThan(1);
    });
});
