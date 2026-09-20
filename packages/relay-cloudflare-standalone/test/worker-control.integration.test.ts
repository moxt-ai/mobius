import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    AGENT_CATALOG_REFRESH_KIND,
    AGENT_SETTINGS_DISCOVER_KIND,
    decodeAgentCatalogRefreshCommand,
    decodeAgentSettingsDiscoverCommand,
    decodeSessionEventAcknowledgement,
    decodeSessionPromptCommand,
    decodeWorkspaceListCommand,
    encodeAgentCatalogRefreshedEvent,
    encodeAgentSettingsDiscoveredEvent,
    encodeSessionEventEnvelope,
    encodeWorkspaceEntriesEvent,
    MOBIUS_API_PREFIX,
    SESSION_COMPLETED_KIND,
    SESSION_STARTED_KIND,
    type SessionConfigurationSelection,
    WORKSPACE_ENTRIES_KIND,
} from "@moxt-ai/mobius-protocol";
import {
    MobiusArtifactUploadRequest,
    MobiusClient,
    MobiusExpiredRuntimePairingStatus,
    MobiusPageRequest,
    MobiusPairedRuntimePairingStatus,
    MobiusPendingRuntimePairingStatus,
    MobiusRecordingPolicy,
    MobiusRevokedRuntimePairingStatus,
    MobiusRuntimePairingRequest,
} from "@moxt-ai/mobius-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMobiusApp } from "../../../tests/infra/app.ts";
import { createStandaloneGateways } from "../src/worker.ts";
import { testBindings } from "./infra/bindings.ts";

import {
    type AccessGrantRecord,
    buildAgents,
    type CreatedRuntimePairingResponse,
    completeReadyAgentDirectory,
    createSessionRequests,
    decodeCreatedAccessGrant,
    decodeRedeemedAccessGrant,
    envelope,
    type HostCredentialRecord,
    installableAgents,
    isRecord,
    type OpenSocket,
    type PairingRecord,
    readyAgents,
    relayOrigin,
    requiredString,
    sha256Hex,
} from "./worker-test-support.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T00:00:00.000Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

describe.sequential("Cloudflare session deployment: control and public API", () => {
    it("Given a Session-only Relay, When a client reaches a retired Bot endpoint, Then the Worker reports that it is unavailable", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);

        const response = await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/retired-project/bots`, {
            headers: { authorization: "Bearer retired-credential" },
        });

        expect(response.status).toBe(404);
    });

    it("Given all eleven supported local Agents are ready, When the machine claims its pairing, Then the Relay accepts the complete bounded directory", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { createPairing, claimPairing } = createSessionRequests(app);
        const created = await createPairing();

        await expect(claimPairing(created, completeReadyAgentDirectory, [])).resolves.toMatchObject({
            channelId: created.channelId,
            runtimeId: created.runtimeId,
        });
    });

    it("Given a paired local Agent, When a project owner discovers its settings, Then the live snapshot is returned without creating a Session", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { openChannelSocket, pairChannel } = createSessionRequests(app);
        const pairing = await pairChannel();
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const client = new MobiusClient({
            credentialProvider: {
                credential: async (signal) => {
                    signal.throwIfAborted();
                    return pairing.created.hostToken;
                },
            },
            endpoint: relayOrigin,
            projectId: pairing.created.projectId,
            transport: { fetch: async (request) => await app.request(request) },
        });
        const signal = new AbortController().signal;
        try {
            const baseDiscovery = client.runtimes.discoverAgentSettings(pairing.created.runtimeId, "codex", {}, signal);
            const baseCommand = decodeAgentSettingsDiscoverCommand(await daemon.messages.next());
            expect(baseCommand).toMatchObject({
                agentId: "codex",
                kind: AGENT_SETTINGS_DISCOVER_KIND,
            });
            expect(baseCommand).not.toHaveProperty("model");
            daemon.socket.send(
                encodeAgentSettingsDiscoveredEvent({
                    agentId: "codex",
                    agentName: "Codex",
                    agentVersion: "codex 0.153.0",
                    kind: "agent.settings.discovered",
                    modelEffort: {
                        effortSettingId: "reasoning_effort",
                        modelSettingId: "model",
                        resolution: "complete",
                        valuesByModel: {
                            "codex-mini": [],
                        },
                    },
                    requestId: baseCommand.requestId,
                    settings: [
                        {
                            booleanValue: false,
                            category: "model",
                            defaultValue: "codex-mini",
                            description: "Select a coding model.",
                            id: "model",
                            name: "Model",
                            type: "select",
                            values: [
                                {
                                    description: "Fast coding model.",
                                    groupId: "",
                                    groupName: "",
                                    name: "Codex Mini",
                                    value: "codex-mini",
                                },
                            ],
                        },
                    ],
                    settingsRevision: "a".repeat(64),
                }),
            );
            await expect(baseDiscovery).resolves.toMatchObject({
                agentId: "codex",
                settings: [expect.objectContaining({ defaultValue: "codex-mini", id: "model" })],
            });

            const discovery = client.runtimes.discoverAgentSettings(
                pairing.created.runtimeId,
                "codex",
                {
                    model: "codex-mini",
                },
                signal,
            );
            const command = decodeAgentSettingsDiscoverCommand(await daemon.messages.next());
            expect(command).toMatchObject({
                agentId: "codex",
                kind: AGENT_SETTINGS_DISCOVER_KIND,
                model: "codex-mini",
            });
            expect(command).not.toHaveProperty("additionalDirectoryIds");
            expect(command).not.toHaveProperty("directoryId");
            expect(command).not.toHaveProperty("botId");
            expect(command).not.toHaveProperty("sessionId");
            const runtimeStub = env.RUNTIME_RELAY.get(env.RUNTIME_RELAY.idFromName(pairing.created.channelId));
            await evictDurableObject(runtimeStub);
            daemon.socket.send(
                encodeAgentSettingsDiscoveredEvent({
                    agentId: "codex",
                    agentName: "Codex",
                    agentVersion: "codex 0.153.0",
                    kind: "agent.settings.discovered",
                    modelEffort: {
                        effortSettingId: "reasoning_effort",
                        modelSettingId: "model",
                        resolution: "complete",
                        valuesByModel: {
                            "codex-mini": [],
                        },
                    },
                    requestId: command.requestId,
                    settings: [
                        {
                            booleanValue: false,
                            category: "model",
                            defaultValue: "codex-mini",
                            description: "Select a coding model.",
                            id: "model",
                            name: "Model",
                            type: "select",
                            values: [
                                {
                                    description: "Fast coding model.",
                                    groupId: "",
                                    groupName: "",
                                    name: "Codex Mini",
                                    value: "codex-mini",
                                },
                            ],
                        },
                    ],
                    settingsRevision: "a".repeat(64),
                }),
            );
            const snapshot = await discovery;
            expect(snapshot).toMatchObject({
                agentId: "codex",
                settings: [expect.objectContaining({ defaultValue: "codex-mini", id: "model" })],
            });
            expect(snapshot).not.toHaveProperty("botId");
            expect(snapshot).not.toHaveProperty("sessionId");
            await expect(client.sessions.list({ cursor: "", limit: 10 }, signal)).resolves.toMatchObject({
                sessions: [],
            });
        } finally {
            client.close();
            daemon.socket.close(1000, "Agent settings discovery test complete");
        }
    });

    it("Given a paired Runtime, When a project owner refreshes its local Agent catalog, Then the Runtime confirms the refreshed catalog without creating a Session", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { openChannelSocket, pairChannel } = createSessionRequests(app);
        const pairing = await pairChannel();
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        try {
            const refresh = app.request(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/runtimes/${pairing.created.runtimeId}/agent-catalog/refresh`,
                    {
                        body: "{}",
                        headers: {
                            Authorization: `Bearer ${pairing.created.hostToken}`,
                            "Content-Type": "application/json",
                        },
                        method: "POST",
                    },
                ),
            );
            const command = decodeAgentCatalogRefreshCommand(await daemon.messages.next());
            expect(command).toMatchObject({
                kind: AGENT_CATALOG_REFRESH_KIND,
            });
            expect(command).not.toHaveProperty("agentId");
            expect(command).not.toHaveProperty("directoryId");
            expect(command).not.toHaveProperty("sessionId");
            const runtimeStub = env.RUNTIME_RELAY.get(env.RUNTIME_RELAY.idFromName(pairing.created.channelId));
            await evictDurableObject(runtimeStub);
            daemon.socket.send(
                encodeAgentCatalogRefreshedEvent({
                    kind: "agent.catalog.refreshed",
                    requestId: command.requestId,
                }),
            );
            const response = await refresh;
            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toStrictEqual({ ok: true });
        } finally {
            daemon.socket.close(1000, "Agent catalog refresh test complete");
        }
    });

    it("Given a paired Runtime, When a project owner lists a workspace after Relay hibernation, Then the Runtime directory entries return to the requesting control connection", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { openChannelSocket, pairChannel } = createSessionRequests(app);
        const pairing = await pairChannel();
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        try {
            const listing = app.request(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/runtimes/${pairing.created.runtimeId}/workspace`,
                    {
                        body: JSON.stringify({ directoryId: "workspace" }),
                        headers: {
                            Authorization: `Bearer ${pairing.created.hostToken}`,
                            "Content-Type": "application/json",
                        },
                        method: "POST",
                    },
                ),
            );
            const command = decodeWorkspaceListCommand(await daemon.messages.next());
            expect(command).toMatchObject({
                directoryId: "workspace",
                kind: "workspace.list",
            });
            const runtimeStub = env.RUNTIME_RELAY.get(env.RUNTIME_RELAY.idFromName(pairing.created.channelId));
            await evictDurableObject(runtimeStub);
            daemon.socket.send(
                encodeWorkspaceEntriesEvent({
                    bindingId: command.bindingId,
                    directoryId: command.directoryId,
                    directoryLabel: "/workspace",
                    entries: [],
                    kind: WORKSPACE_ENTRIES_KIND,
                    parentDirectoryId: "",
                    requestId: command.requestId,
                }),
            );
            const response = await listing;
            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toMatchObject({
                directoryId: "workspace",
                entries: [],
            });
        } finally {
            daemon.socket.close(1000, "Workspace listing test complete");
        }
    });

    it("Given a configuration-capable Session has no new events, When a client submits a snapshotted Turn and waits, Then Relay persists the snapshot and wakes the bounded event read", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket } = createSessionRequests(app);
        const pairing = await pairChannel();
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        const signal = new AbortController().signal;
        const client = new MobiusClient({
            credentialProvider: {
                credential: async (credentialSignal) => {
                    credentialSignal.throwIfAborted();
                    return pairing.created.hostToken;
                },
            },
            endpoint: relayOrigin,
            projectId: pairing.created.projectId,
            transport: { fetch: async (request) => await app.request(request) },
        });
        const fastModeConfiguration: SessionConfigurationSelection = {
            booleanValue: true,
            configId: "fast_mode",
            value: "",
            valueType: "boolean",
        };
        const modelConfiguration: SessionConfigurationSelection = {
            booleanValue: false,
            configId: "model",
            value: "test-large",
            valueType: "select",
        };
        const sessionConfigurations: readonly SessionConfigurationSelection[] = [
            fastModeConfiguration,
            modelConfiguration,
        ];

        try {
            const session = await client.sessions.create(
                {
                    agentId: "codex",
                    bindingId: "workspace",
                    directoryId: "root",
                    policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                    runtimeId: pairing.created.runtimeId,
                    sessionId: "snapshotted-session",
                    title: "Snapshotted Session",
                },
                signal,
            );
            const turn = await client.turns.submit(
                session.sessionId,
                {
                    additionalDirectoryIds: [],
                    artifactIds: [],
                    content: "Run with this exact model",
                    idempotencyKey: "snapshotted-turn",
                    images: [],
                    resources: [],
                    sessionConfigurations,
                },
                signal,
            );
            expect(turn.sessionConfigurations).toEqual(sessionConfigurations);
            const command = decodeSessionPromptCommand(await daemon.messages.next());
            expect(command.sessionConfigurations).toEqual(sessionConfigurations);
            await expect(client.turns.read(session.sessionId, turn.turnId, signal)).resolves.toMatchObject({
                sessionConfigurations,
            });

            const waiting = client.events.wait(session.sessionId, new MobiusPageRequest(10, ""), 10_000, signal);
            const started = envelope(session.sessionId, "snapshotted-turn-started", {
                attemptId: "snapshotted-attempt",
                commandId: command.commandId,
                kind: SESSION_STARTED_KIND,
                sessionId: session.sessionId,
            });
            daemon.socket.send(encodeSessionEventEnvelope(started));
            expect(decodeSessionEventAcknowledgement(await daemon.messages.next())).toMatchObject({
                eventId: started.eventId,
            });
            await expect(waiting).resolves.toMatchObject({
                events: [expect.objectContaining({ eventId: started.eventId })],
            });

            await expect(
                client.turns.submit(
                    session.sessionId,
                    {
                        additionalDirectoryIds: [],
                        artifactIds: [],
                        content: "Run with this exact model",
                        idempotencyKey: "snapshotted-turn",
                        images: [],
                        resources: [],
                        sessionConfigurations: sessionConfigurations.toReversed(),
                    },
                    signal,
                ),
            ).resolves.toMatchObject({ turnId: turn.turnId });

            await expect(
                client.turns.submit(
                    session.sessionId,
                    {
                        additionalDirectoryIds: [],
                        artifactIds: [],
                        content: "Run with this exact model",
                        idempotencyKey: "snapshotted-turn",
                        images: [],
                        resources: [],
                        sessionConfigurations: [
                            fastModeConfiguration,
                            {
                                ...modelConfiguration,
                                value: "test-small",
                            },
                        ],
                    },
                    signal,
                ),
            ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
        } finally {
            client.close();
            daemon.socket.close(1000, "Snapshot integration complete");
        }
    });

    it("Given a Runtime predates Session Turn configuration, When a client submits a snapshot, Then Relay rejects it before dispatch", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { createPairing, claimPairing, createSession } = createSessionRequests(app);
        const created = await createPairing();
        await claimPairing(
            created,
            readyAgents.map(({ sessionTurnConfiguration: _unsupported, ...agent }) => agent),
            [],
        );
        expect((await createSession(created, "legacy-runtime-session")).status).toBe(201);

        const response = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${created.projectId}/sessions/legacy-runtime-session/turns`,
            {
                body: JSON.stringify({
                    additionalDirectoryIds: [],
                    artifactIds: [],
                    content: "Require a snapshot",
                    idempotencyKey: "unsupported-snapshot",
                    images: [],
                    resources: [],
                    sessionConfigurations: [],
                }),
                headers: { ...createSessionRequests(app).authorization(created), "content-type": "application/json" },
                method: "POST",
            },
        );

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
            error: { code: "session_turn_configuration_unsupported" },
        });
    });

    it("Given a ready Session with no recorded events, When a browser opens its event stream, Then the Relay immediately sends a connection frame before the first Turn", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, authorization, createSession } = createSessionRequests(app);
        const pairing = await pairChannel();
        expect(await createSession(pairing.created, "empty-event-stream-session")).toMatchObject({ status: 201 });

        const response = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/empty-event-stream-session/events`,
            {
                headers: {
                    ...authorization(pairing.created),
                    accept: "text/event-stream",
                },
            },
        );
        expect(response.status).toBe(200);
        if (response.body === null) {
            throw new Error("Expected a Session event stream body");
        }
        const reader = response.body.getReader();
        try {
            const first = await reader.read();
            expect(first.done).toBe(false);
            expect(new TextDecoder().decode(first.value)).toBe(": connected\n\n");
        } finally {
            await reader.cancel();
        }
    });

    it("Given an existing Project owner, When a second Runtime is paired, used, and revoked through the SDK, Then retries are idempotent and only that Runtime becomes unavailable", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, claimProjectRuntimePairing, waitForSocketClose, openChannelSocket } =
            createSessionRequests(app);
        const bootstrap = await pairChannel();
        const signal = new AbortController().signal;
        const client = new MobiusClient({
            credentialProvider: {
                credential: async (credentialSignal) => {
                    credentialSignal.throwIfAborted();
                    return bootstrap.created.hostToken;
                },
            },
            endpoint: relayOrigin,
            projectId: bootstrap.created.projectId,
            transport: { fetch: async (request) => await app.request(request) },
        });
        const request = new MobiusRuntimePairingRequest("second-runtime-request");
        expect((await client.capabilities.read(signal)).resources.runtimePairings).toBe(true);
        const additional = await client.runtimePairings.create(request, signal);
        const retried = await client.runtimePairings.create(request, signal);
        expect(retried).toEqual(additional);
        expect(await client.runtimePairings.read(additional.pairingId, signal)).toEqual(
            new MobiusPendingRuntimePairingStatus(additional.expiresAt),
        );
        const claimed = await claimProjectRuntimePairing(additional, "Build Mac", "mobius-build", buildAgents, []);
        const replay = await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings/claim`, {
            body: JSON.stringify({
                agents: buildAgents,
                installableAgents: [],
                machineName: "Replay Mac",
                pairingCode: additional.pairingCode,
                workspaceName: "replay",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });
        expect(replay.status).toBe(400);
        await expect(replay.json()).resolves.toMatchObject({ error: { code: "invalid_pairing_code" } });
        const runtimeCannotPair = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${bootstrap.created.projectId}/runtime-pairings`,
            {
                body: JSON.stringify({ idempotencyKey: "runtime-authority-escalation" }),
                headers: {
                    authorization: `Bearer ${claimed.daemonToken}`,
                    "content-type": "application/json",
                },
                method: "POST",
            },
        );
        expect(runtimeCannotPair.status).toBe(401);
        await expect(runtimeCannotPair.json()).resolves.toMatchObject({
            error: { code: "project_credential_invalid" },
        });
        const ownerCredentials = await env.DIRECTORY_DATABASE.prepare(
            `SELECT COUNT(*) AS credential_count FROM project_owner_credentials WHERE project_id = ?`,
        )
            .bind(bootstrap.created.projectId)
            .first<{ readonly credential_count: number }>();
        const additionalHostCredentials = await env.DIRECTORY_DATABASE.prepare(
            `SELECT COUNT(*) AS credential_count FROM channel_host_credentials WHERE channel_id = ?`,
        )
            .bind(additional.channelId)
            .first<{ readonly credential_count: number }>();
        expect(ownerCredentials?.credential_count).toBe(1);
        expect(additionalHostCredentials?.credential_count).toBe(0);

        const bootstrapDaemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${bootstrap.created.channelId}/daemon?token=${bootstrap.claimed.daemonToken}`,
        );
        const additionalDaemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${additional.channelId}/daemon?token=${claimed.daemonToken}`,
        );
        try {
            expect(additional.projectId).toBe(bootstrap.created.projectId);
            expect(additional.runtimeId).not.toBe(bootstrap.created.runtimeId);
            expect(additional.channelId).not.toBe(bootstrap.created.channelId);
            expect(claimed.daemonToken).not.toBe(bootstrap.claimed.daemonToken);
            expect(await client.runtimePairings.read(additional.pairingId, signal)).toBeInstanceOf(
                MobiusPairedRuntimePairingStatus,
            );

            await expect(client.runtimes.list(signal)).resolves.toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        agents: readyAgents,
                        channelId: bootstrap.created.channelId,
                        installableAgents,
                        machineName: "Developer Mac",
                        online: true,
                        runtimeId: bootstrap.created.runtimeId,
                    }),
                    expect.objectContaining({
                        agents: buildAgents,
                        channelId: additional.channelId,
                        installableAgents: [],
                        machineName: "Build Mac",
                        online: true,
                        runtimeId: additional.runtimeId,
                    }),
                ]),
            );

            const policy = new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000);
            const [bootstrapSession, additionalSession] = await Promise.all([
                client.sessions.create(
                    {
                        agentId: "codex",
                        bindingId: "bootstrap-workspace",
                        directoryId: "root",
                        policy,
                        runtimeId: bootstrap.created.runtimeId,
                        sessionId: "bootstrap-runtime-session",
                        title: "Bootstrap Runtime",
                    },
                    signal,
                ),
                client.sessions.create(
                    {
                        agentId: "build-agent",
                        bindingId: "build-workspace",
                        directoryId: "root",
                        policy,
                        runtimeId: additional.runtimeId,
                        sessionId: "additional-runtime-session",
                        title: "Additional Runtime",
                    },
                    signal,
                ),
            ]);
            await Promise.all([
                client.turns.submit(
                    bootstrapSession.sessionId,
                    {
                        additionalDirectoryIds: [],
                        artifactIds: [],
                        content: "Run on bootstrap",
                        idempotencyKey: "bootstrap-turn",
                        images: [],
                        resources: [],
                    },
                    signal,
                ),
                client.turns.submit(
                    additionalSession.sessionId,
                    {
                        additionalDirectoryIds: [],
                        artifactIds: [],
                        content: "Run on build",
                        idempotencyKey: "build-turn",
                        images: [],
                        resources: [],
                    },
                    signal,
                ),
            ]);
            const bootstrapCommand = decodeSessionPromptCommand(await bootstrapDaemon.messages.next());
            expect(bootstrapCommand).toMatchObject({
                agentId: "codex",
                sessionId: bootstrapSession.sessionId,
            });
            expect(decodeSessionPromptCommand(await additionalDaemon.messages.next())).toMatchObject({
                agentId: "build-agent",
                sessionId: additionalSession.sessionId,
            });
            const started = envelope(bootstrapSession.sessionId, "bootstrap-turn-started", {
                attemptId: "bootstrap-turn-attempt",
                commandId: bootstrapCommand.commandId,
                kind: SESSION_STARTED_KIND,
                sessionId: bootstrapSession.sessionId,
            });
            bootstrapDaemon.socket.send(encodeSessionEventEnvelope(started));
            expect(decodeSessionEventAcknowledgement(await bootstrapDaemon.messages.next())).toMatchObject({
                eventId: started.eventId,
            });
            const completed = envelope(bootstrapSession.sessionId, "bootstrap-turn-completed", {
                commandId: bootstrapCommand.commandId,
                kind: SESSION_COMPLETED_KIND,
                sessionId: bootstrapSession.sessionId,
                stopReason: "end_turn",
            });
            bootstrapDaemon.socket.send(encodeSessionEventEnvelope(completed));
            expect(decodeSessionEventAcknowledgement(await bootstrapDaemon.messages.next())).toMatchObject({
                eventId: completed.eventId,
            });

            const closed = waitForSocketClose(additionalDaemon.socket);
            await client.runtimes.revoke(additional.runtimeId, signal);
            await expect(closed).resolves.toMatchObject({ code: 1008, reason: "Runtime revoked" });
            await client.runtimes.revoke(additional.runtimeId, signal);
            expect(bootstrapDaemon.socket.readyState).toBe(WebSocket.OPEN);
            expect(await client.runtimePairings.read(additional.pairingId, signal)).toBeInstanceOf(
                MobiusRevokedRuntimePairingStatus,
            );
            await expect(client.runtimes.list(signal)).resolves.toEqual([
                expect.objectContaining({
                    online: true,
                    runtimeId: bootstrap.created.runtimeId,
                }),
            ]);
            await expect(
                client.turns.submit(
                    additionalSession.sessionId,
                    {
                        additionalDirectoryIds: [],
                        artifactIds: [],
                        content: "Do not fail over",
                        idempotencyKey: "revoked-runtime-turn",
                        images: [],
                        resources: [],
                    },
                    signal,
                ),
            ).rejects.toMatchObject({ code: "runtime_unavailable", status: 409 });
            await client.turns.submit(
                bootstrapSession.sessionId,
                {
                    additionalDirectoryIds: [],
                    artifactIds: [],
                    content: "Bootstrap remains executable",
                    idempotencyKey: "bootstrap-after-revoke",
                    images: [],
                    resources: [],
                },
                signal,
            );
            expect(decodeSessionPromptCommand(await bootstrapDaemon.messages.next())).toMatchObject({
                commandId: "bootstrap-after-revoke",
                sessionId: bootstrapSession.sessionId,
            });
            const deniedReconnect = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${additional.channelId}/daemon?token=${claimed.daemonToken}`,
                { headers: { Upgrade: "websocket" } },
            );
            expect(deniedReconnect.status).toBe(401);
            await expect(
                client.runtimePairings.create(new MobiusRuntimePairingRequest("replacement"), signal),
            ).resolves.toMatchObject({ projectId: bootstrap.created.projectId });

            const audit = await env.DIRECTORY_DATABASE.prepare(
                `SELECT action FROM runtime_pairing_audit_events WHERE pairing_id = ? ORDER BY recorded_at, action`,
            )
                .bind(additional.pairingId)
                .all<{ readonly action: string }>();
            expect(audit.results.map((row) => row.action)).toEqual(
                expect.arrayContaining([
                    "runtime_pairing.claimed",
                    "runtime_pairing.rejected",
                    "runtime_pairing.requested",
                    "runtime_pairing.revoked",
                ]),
            );
        } finally {
            client.close();
            bootstrapDaemon.socket.close(1000, "Test complete");
            additionalDaemon.socket.close(1000, "Test complete");
        }
    });

    it("Given the Project Runtime quota and an expiring pairing, When an owner exceeds the quota and later retries after expiry, Then the request is rejected, audited, and the expired slot is reusable", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, createProjectRuntimePairing, authorization } = createSessionRequests(app);
        const project = await pairChannel();
        const pending: CreatedRuntimePairingResponse[] = [];
        for (let index = 1; index < 8; index += 1) {
            pending.push(await createProjectRuntimePairing(project.created, `quota-runtime-${index.toString()}`));
        }
        const quotaResponse = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${project.created.projectId}/runtime-pairings`,
            {
                body: JSON.stringify({ idempotencyKey: "quota-runtime-overflow" }),
                headers: {
                    ...authorization(project.created),
                    "content-type": "application/json",
                },
                method: "POST",
            },
        );
        expect(quotaResponse.status).toBe(429);
        await expect(quotaResponse.json()).resolves.toMatchObject({
            error: { code: "runtime_quota_exceeded" },
        });

        const browserCredentialResponse = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${project.created.projectId}/browser-credentials`,
            {
                body: JSON.stringify({ expiresInSeconds: 120 }),
                headers: {
                    ...authorization(project.created),
                    "content-type": "application/json",
                },
                method: "POST",
            },
        );
        expect(browserCredentialResponse.status).toBe(201);
        const browserCredential = await browserCredentialResponse.json();
        if (!isRecord(browserCredential)) {
            throw new Error("Expected a browser credential");
        }
        const browserDenied = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${project.created.projectId}/runtime-pairings`,
            {
                body: JSON.stringify({ idempotencyKey: "browser-cannot-pair" }),
                headers: {
                    authorization: `Bearer ${requiredString(browserCredential, "token")}`,
                    "content-type": "application/json",
                },
                method: "POST",
            },
        );
        expect(browserDenied.status).toBe(403);
        await expect(browserDenied.json()).resolves.toMatchObject({ error: { code: "project_permission_denied" } });

        vi.setSystemTime(Date.now() + 600_001);
        const expiring = pending.at(0);
        if (expiring === undefined) {
            throw new Error("Expected an expiring Runtime pairing");
        }
        const client = new MobiusClient({
            credentialProvider: {
                credential: async (signal) => {
                    signal.throwIfAborted();
                    return project.created.hostToken;
                },
            },
            endpoint: relayOrigin,
            projectId: project.created.projectId,
            transport: { fetch: async (request) => await app.request(request) },
        });
        const signal = new AbortController().signal;
        try {
            expect(await client.runtimePairings.read(expiring.pairingId, signal)).toBeInstanceOf(
                MobiusExpiredRuntimePairingStatus,
            );
            const expiredClaim = await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings/claim`, {
                body: JSON.stringify({
                    agents: buildAgents,
                    installableAgents: [],
                    machineName: "Expired Runtime",
                    pairingCode: expiring.pairingCode,
                    workspaceName: "expired",
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            });
            expect(expiredClaim.status).toBe(400);
            await expect(expiredClaim.json()).resolves.toMatchObject({ error: { code: "invalid_pairing_code" } });
            await expect(
                client.runtimePairings.create(new MobiusRuntimePairingRequest("quota-runtime-replacement"), signal),
            ).resolves.toMatchObject({ projectId: project.created.projectId });

            const lifecycleAudit = await env.DIRECTORY_DATABASE.prepare(
                `SELECT action FROM runtime_pairing_audit_events WHERE pairing_id = ? ORDER BY recorded_at, action`,
            )
                .bind(expiring.pairingId)
                .all<{ readonly action: string }>();
            expect(lifecycleAudit.results.map((row) => row.action)).toEqual([
                "runtime_pairing.requested",
                "runtime_pairing.expired",
                "runtime_pairing.rejected",
            ]);
            const rejectedQuota = await env.DIRECTORY_DATABASE.prepare(
                `SELECT details_json FROM runtime_pairing_audit_events
                  WHERE project_id = ? AND action = 'runtime_pairing.rejected'`,
            )
                .bind(project.created.projectId)
                .all<{ readonly details_json: string }>();
            expect(rejectedQuota.results.map((row) => row.details_json)).toContain(
                JSON.stringify({ code: "runtime_quota_exceeded" }),
            );
        } finally {
            client.close();
        }
    });

    it("Given a Standalone deployment, When two machines pair and create sessions, Then tenant placement remains internal while Project credentials stay isolated", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, authorization, createSession } = createSessionRequests(app);
        const first = await pairChannel();
        const second = await pairChannel();
        expect(first.created.projectId).not.toBe(second.created.projectId);
        const session = await createSession(first.created, "existing-tenant-session");
        expect(session.status).toBe(201);
        const firstSession = await session.json();
        expect(isRecord(firstSession) && Object.hasOwn(firstSession, "tenantId")).toBe(false);
        const secondSession = await createSession(second.created, "existing-tenant-second-session");
        expect(secondSession.status).toBe(201);
        const secondSessionResource = await secondSession.json();
        expect(isRecord(secondSessionResource) && Object.hasOwn(secondSessionResource, "tenantId")).toBe(false);
        const crossProjectRuntime = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${first.created.projectId}/sessions`,
            {
                body: JSON.stringify({
                    agentId: "codex",
                    bindingId: "foreign-runtime",
                    directoryId: "root",
                    policy: {
                        contentLimitBytes: 2_000_000,
                        hotEventLimit: 100,
                        idempotencyRetentionMilliseconds: 86_400_000,
                        level: "full",
                        retentionMilliseconds: 86_400_000,
                    },
                    runtimeId: second.created.runtimeId,
                    sessionId: "cross-project-runtime-session",
                    title: "Cross-project Runtime",
                }),
                headers: {
                    ...authorization(first.created),
                    "content-type": "application/json",
                },
                method: "POST",
            },
        );
        expect(crossProjectRuntime.status).toBe(403);
        await expect(crossProjectRuntime.json()).resolves.toMatchObject({
            error: { code: "runtime_access_denied" },
        });
        const denied = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${first.created.projectId}/sessions/existing-tenant-session`,
            { headers: authorization(second.created) },
        );
        expect(denied.status).toBe(403);
    });

    it("Given a browser pairing, When clients use channel and project resources, Then verified credentials derive one tenant and project scope", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { createPairing, claimPairing, authorization } = createSessionRequests(app);
        const created = await createPairing();
        const pending = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/pairings/${created.pairingId}?token=${created.pollToken}`,
        );
        await expect(pending.json()).resolves.toEqual({
            expiresAt: created.expiresAt,
            status: "pending",
        });
        const ownerPending = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${created.projectId}/runtime-pairings/${created.pairingId}`,
            { headers: authorization(created) },
        );
        expect(ownerPending.status).toBe(200);
        await expect(ownerPending.json()).resolves.toEqual({
            expiresAt: created.expiresAt,
            status: "pending",
        });

        const claimed = await claimPairing(created);
        expect(claimed.channelId).toBe(created.channelId);
        expect(claimed.runtimeId).toBe(created.runtimeId);
        expect(created.runtimeId).not.toBe(created.channelId);
        const paired = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/pairings/${created.pairingId}?token=${created.pollToken}`,
        );
        const pairedResource = await paired.json();
        expect(isRecord(pairedResource) && Object.hasOwn(pairedResource, "tenantId")).toBe(false);
        expect(pairedResource).toMatchObject({
            channelId: created.channelId,
            projectId: created.projectId,
            runtimeId: created.runtimeId,
            status: "paired",
        });
        const ownerPaired = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${created.projectId}/runtime-pairings/${created.pairingId}`,
            { headers: authorization(created) },
        );
        expect(ownerPaired.status).toBe(200);
        await expect(ownerPaired.json()).resolves.toMatchObject({
            channelId: created.channelId,
            runtimeId: created.runtimeId,
            status: "paired",
        });

        const channel = await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/channels/${created.channelId}`, {
            headers: authorization(created),
        });
        expect(channel.status).toBe(200);
        const channelResource = await channel.json();
        expect(isRecord(channelResource) && Object.hasOwn(channelResource, "tenantId")).toBe(false);
        expect(channelResource).toMatchObject({
            channelId: created.channelId,
            projectId: created.projectId,
            runtimeId: created.runtimeId,
        });
        const unauthorizedHost = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${created.channelId}/host?token=${"x".repeat(43)}`,
            { headers: { Upgrade: "websocket" } },
        );
        expect(unauthorizedHost.status).toBe(401);

        const record = await env.DIRECTORY_DATABASE.prepare(
            `SELECT channel_id, daemon_token_hash, project_id, runtime_id
       FROM pairing_channels WHERE pairing_id = ?`,
        )
            .bind(created.pairingId)
            .first<PairingRecord>();
        expect(record).toMatchObject({
            channel_id: created.channelId,
            daemon_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
            project_id: created.projectId,
            runtime_id: created.runtimeId,
        });
        const ownerCredential = await env.DIRECTORY_DATABASE.prepare(
            `SELECT credential_id, channel_id, token_hash, authority
       FROM channel_host_credentials
       WHERE channel_id = ? AND authority = 'owner'`,
        )
            .bind(created.channelId)
            .first<HostCredentialRecord>();
        expect(ownerCredential).toMatchObject({
            authority: "owner",
            channel_id: created.channelId,
            credential_id: expect.stringMatching(/^hcr_/),
            token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(record?.daemon_token_hash).not.toBe(claimed.daemonToken);
        expect(ownerCredential?.token_hash).not.toBe(created.hostToken);
    });

    it("Given an owner credential, When a browser uses a short-lived project credential through the SDK, Then Runtime discovery and every Session request enforce expiry, refresh, and revocation", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization } = createSessionRequests(app);
        const pairing = await pairChannel();
        const issueCredential = async (): Promise<Readonly<Record<string, unknown>>> => {
            const response = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/browser-credentials`,
                {
                    body: JSON.stringify({ expiresInSeconds: 120 }),
                    headers: {
                        ...authorization(pairing.created),
                        "content-type": "application/json",
                    },
                    method: "POST",
                },
            );
            expect(response.status).toBe(201);
            const value: unknown = await response.json();
            if (!isRecord(value)) {
                throw new Error("Expected a browser credential");
            }
            return value;
        };
        const firstCredential = await issueCredential();
        let browserToken = requiredString(firstCredential, "token");
        expect(browserToken).not.toBe(pairing.created.hostToken);
        expect(Date.parse(requiredString(firstCredential, "expiresAt")) - Date.now()).toBe(120_000);
        const client = new MobiusClient({
            credentialProvider: {
                credential: async (signal) => {
                    signal.throwIfAborted();
                    return browserToken;
                },
            },
            endpoint: relayOrigin,
            projectId: pairing.created.projectId,
            transport: {
                fetch: async (request) => await app.request(request),
            },
        });

        const signal = new AbortController().signal;
        const daemonSockets: OpenSocket[] = [];
        try {
            await expect(client.runtimes.list(signal)).resolves.toEqual([
                expect.objectContaining({
                    agents: readyAgents,
                    online: false,
                    runtimeId: pairing.created.runtimeId,
                }),
            ]);
            const daemon = await openChannelSocket(
                `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
            );
            daemonSockets.push(daemon);
            await expect(client.runtimes.list(signal)).resolves.toEqual([
                expect.objectContaining({
                    online: true,
                    runtimeId: pairing.created.runtimeId,
                }),
            ]);
            const session = await client.sessions.create(
                {
                    agentId: "codex",
                    bindingId: "workspace",
                    directoryId: "root",
                    policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                    runtimeId: pairing.created.runtimeId,
                    sessionId: "browser-credential-session",
                    title: "Browser credential session",
                },
                signal,
            );
            const artifactBytes = new TextEncoder().encode("browser artifact");
            const upload = await client.artifacts.createUpload(
                session.sessionId,
                new MobiusArtifactUploadRequest(
                    "browser-artifact.txt",
                    "text/plain",
                    artifactBytes.byteLength,
                    await sha256Hex(artifactBytes),
                ),
                signal,
            );
            await expect(
                client.artifacts.uploadContent(session.sessionId, upload, artifactBytes, signal),
            ).resolves.toMatchObject({
                artifactId: upload.artifactId,
                state: "available",
            });
            await expect(
                client.artifacts.download(session.sessionId, upload.artifactId, signal),
            ).resolves.toMatchObject({
                artifact: expect.objectContaining({ artifactId: upload.artifactId }),
                bytes: artifactBytes,
            });

            vi.setSystemTime(Date.now() + 120_001);
            await expect(client.sessions.read(session.sessionId, signal)).rejects.toMatchObject({
                code: "credential_expired",
                status: 401,
            });

            const refreshedCredential = await issueCredential();
            browserToken = requiredString(refreshedCredential, "token");
            await expect(client.sessions.read(session.sessionId, signal)).resolves.toMatchObject({
                sessionId: session.sessionId,
            });

            const revokeResponse = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/browser-credentials/${requiredString(refreshedCredential, "credentialId")}`,
                {
                    headers: authorization(pairing.created),
                    method: "DELETE",
                },
            );
            expect(revokeResponse.status).toBe(204);
            await expect(client.sessions.read(session.sessionId, signal)).rejects.toMatchObject({
                code: "credential_revoked",
                status: 401,
            });
        } finally {
            client.close();
            for (const openSocket of daemonSockets) {
                openSocket.socket.close(1000, "Test complete");
            }
        }
    });

    it("Given a paired Runtime, When it requests an artifact upload lease and PUTs matching bytes, Then the Session stores the content for authorized download", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket } = createSessionRequests(app);
        const pairing = await pairChannel();
        const client = new MobiusClient({
            credentialProvider: {
                credential: async (signal) => {
                    signal.throwIfAborted();
                    return pairing.created.hostToken;
                },
            },
            endpoint: relayOrigin,
            projectId: pairing.created.projectId,
            transport: {
                fetch: async (request) => await app.request(request),
            },
        });
        const signal = new AbortController().signal;
        const daemon = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
        );
        try {
            const session = await client.sessions.create(
                {
                    agentId: "codex",
                    bindingId: "workspace",
                    directoryId: "root",
                    policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                    runtimeId: pairing.created.runtimeId,
                    sessionId: "runtime-upload-session",
                    title: "Runtime upload session",
                },
                signal,
            );
            const bytes = new TextEncoder().encode("runtime raster");
            const digest = await sha256Hex(bytes);
            const leaseResponse = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/sessions/${session.sessionId}/artifacts/uploads`,
                {
                    body: JSON.stringify({
                        byteLength: bytes.byteLength,
                        mediaType: "image/png",
                        name: "preview.png",
                        sha256: digest,
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
                throw new Error("Expected a runtime upload lease");
            }
            const putResponse = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/sessions/${session.sessionId}/artifacts/${lease["artifactId"]}/content`,
                {
                    body: bytes,
                    headers: {
                        authorization: `Bearer ${pairing.claimed.daemonToken}`,
                        "content-type": "image/png",
                        "x-mobius-upload-token": lease["uploadToken"],
                    },
                    method: "PUT",
                },
            );
            expect(putResponse.status).toBe(200);
            await expect(
                client.artifacts.download(session.sessionId, lease["artifactId"], signal),
            ).resolves.toMatchObject({
                artifact: expect.objectContaining({ artifactId: lease["artifactId"] }),
                bytes,
            });
        } finally {
            client.close();
            daemon.socket.close(1000, "Test complete");
        }
    });

    it("Given a persisted catalog predates verified capabilities and Web-confirmed installation, When its Channel is read, Then capabilities are conservative", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, authorization } = createSessionRequests(app);
        const pairing = await pairChannel();
        await env.DIRECTORY_DATABASE.prepare(
            `UPDATE pairing_channels
       SET agents_json = ?, installable_agents_json = ?
       WHERE channel_id = ?`,
        )
            .bind(
                JSON.stringify([{ id: "codex", label: "Codex" }]),
                JSON.stringify([{ id: "claude-code", label: "Claude Code" }]),
                pairing.created.channelId,
            )
            .run();

        const response = await app.request(`${relayOrigin}/mobius/api/channels/${pairing.created.channelId}`, {
            headers: authorization(pairing.created),
        });
        expect(response.status).toBe(200);
        const descriptor: unknown = await response.json();
        expect(descriptor).toMatchObject({
            agents: [
                {
                    agentPath: "Not reported",
                    agentVersion: "Not reported",
                    capabilities: {
                        additionalDirectories: false,
                        audioPrompt: false,
                        closeSession: false,
                        deleteSession: false,
                        embeddedContextPrompt: false,
                        imagePrompt: false,
                        listSessions: false,
                        loadSession: false,
                        promptQueueing: false,
                        resumeSession: false,
                        steering: false,
                        unstableForkSession: false,
                    },
                    id: "codex",
                    label: "Codex",
                },
            ],
            installableAgents,
        });
    });

    it("Given a persisted Agent catalog carries the removed Bot configuration flag, When project Runtimes are listed, Then the released catalog remains readable", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, authorization } = createSessionRequests(app);
        const pairing = await pairChannel();
        await env.DIRECTORY_DATABASE.prepare(
            `UPDATE pairing_channels
       SET agents_json = ?
       WHERE channel_id = ?`,
        )
            .bind(
                JSON.stringify(
                    readyAgents.map((agent) => ({
                        ...agent,
                        botSessionConfiguration: true,
                    })),
                ),
                pairing.created.channelId,
            )
            .run();
        await env.DIRECTORY_DATABASE.batch(
            env.TEST_LEGACY_AGENT_CATALOG_MIGRATION.map((query) => env.DIRECTORY_DATABASE.prepare(query)),
        );

        const response = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/runtimes`,
            { headers: authorization(pairing.created) },
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            runtimes: [
                expect.objectContaining({
                    agents: readyAgents,
                    runtimeId: pairing.created.runtimeId,
                }),
            ],
        });
    });

    it("Given a Session directory predates cloud-retention policy, When the exact storage migration runs, Then existing Sessions default to cloud retention", async () => {
        const projectId = "legacy-retention-project";
        const sessionId = "legacy-retention-session";
        const runtimeId = "legacy-retention-runtime";
        await env.DIRECTORY_DATABASE.prepare("ALTER TABLE session_directory DROP COLUMN cloud_retention").run();
        await env.DIRECTORY_DATABASE.prepare(
            `INSERT INTO session_directory (
                project_id, session_id, runtime_id, lifecycle, updated_at, summary_json
             ) VALUES (?, ?, ?, 'ready', ?, ?)`,
        )
            .bind(projectId, sessionId, runtimeId, Date.now(), JSON.stringify({ projectId, runtimeId, sessionId }))
            .run();

        await env.DIRECTORY_DATABASE.batch(
            env.TEST_SESSION_CLOUD_RETENTION_MIGRATION.map((query) => env.DIRECTORY_DATABASE.prepare(query)),
        );

        const row = await env.DIRECTORY_DATABASE.prepare(
            "SELECT cloud_retention FROM session_directory WHERE project_id = ? AND session_id = ?",
        )
            .bind(projectId, sessionId)
            .first<{ readonly cloud_retention: number }>();
        expect(row?.cloud_retention).toBe(1);
    });

    it("Given an owned Channel, When a one-time access grant is redeemed, Then the linked credential is independently authorized and revocable", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const { pairChannel, openChannelSocket, authorization } = createSessionRequests(app);
        const pairing = await pairChannel();
        const createGrantResponse = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/access-grants`,
            { headers: authorization(pairing.created), method: "POST" },
        );
        expect(createGrantResponse.status).toBe(201);
        const grant = decodeCreatedAccessGrant(await createGrantResponse.json());
        expect(Date.parse(grant.expiresAt) - Date.now()).toBe(10 * 60 * 1_000);
        expect(grant.grantSecret).not.toBe(pairing.created.hostToken);
        const storedGrant = await env.DIRECTORY_DATABASE.prepare(
            `SELECT grant_id, secret_hash
       FROM channel_access_grants
       WHERE grant_id = ? AND channel_id = ?`,
        )
            .bind(grant.grantId, pairing.created.channelId)
            .first<AccessGrantRecord>();
        expect(storedGrant).toMatchObject({
            grant_id: grant.grantId,
            secret_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(storedGrant?.secret_hash).not.toBe(grant.grantSecret);

        const wrongSecretResponse = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/access-grants/${grant.grantId}/redeem`,
            {
                body: JSON.stringify({ grantSecret: "x".repeat(43) }),
                headers: { "content-type": "application/json" },
                method: "POST",
            },
        );
        expect(wrongSecretResponse.status).toBe(404);
        await expect(wrongSecretResponse.json()).resolves.toMatchObject({
            error: { code: "access_grant_invalid" },
        });

        const redeemResponse = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/access-grants/${grant.grantId}/redeem`,
            {
                body: JSON.stringify({ grantSecret: grant.grantSecret }),
                headers: { "content-type": "application/json" },
                method: "POST",
            },
        );
        expect(redeemResponse.status).toBe(200);
        const redeemed = decodeRedeemedAccessGrant(await redeemResponse.json());
        expect(redeemed).toMatchObject({
            channelId: pairing.created.channelId,
            projectId: pairing.created.projectId,
        });
        expect(redeemed.hostToken).not.toBe(pairing.created.hostToken);
        expect(redeemed.hostToken).not.toBe(grant.grantSecret);

        const replayResponse = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/access-grants/${grant.grantId}/redeem`,
            {
                body: JSON.stringify({ grantSecret: grant.grantSecret }),
                headers: { "content-type": "application/json" },
                method: "POST",
            },
        );
        expect(replayResponse.status).toBe(409);
        await expect(replayResponse.json()).resolves.toMatchObject({
            error: { code: "access_grant_redeemed" },
        });

        const linkedAuthorization = {
            authorization: `Bearer ${redeemed.hostToken}`,
        };
        const linkedChannel = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}`,
            { headers: linkedAuthorization },
        );
        expect(linkedChannel.status).toBe(200);
        const linkedProject = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions`,
            { headers: linkedAuthorization },
        );
        expect(linkedProject.status).toBe(200);
        const linkedHost = await openChannelSocket(
            `${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/host?token=${redeemed.hostToken}`,
        );
        const linkedHostClosed = new Promise<number>((resolve) => {
            linkedHost.socket.addEventListener("close", (event) => resolve(event.code), { once: true });
        });
        const delegationAttempt = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/access-grants`,
            { headers: linkedAuthorization, method: "POST" },
        );
        expect(delegationAttempt.status).toBe(403);
        await expect(delegationAttempt.json()).resolves.toMatchObject({
            error: { code: "owner_access_required" },
        });

        const devicePageResponse = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/linked-devices`,
            { headers: authorization(pairing.created) },
        );
        expect(devicePageResponse.status).toBe(200);
        const devicePage: unknown = await devicePageResponse.json();
        if (
            !isRecord(devicePage) ||
            !Array.isArray(devicePage["devices"]) ||
            devicePage["devices"].length !== 1 ||
            !isRecord(devicePage["devices"][0])
        ) {
            throw new Error("Expected one linked device");
        }
        const linkedCredentialId = requiredString(devicePage["devices"][0], "credentialId");

        const revokeResponse = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/linked-devices/${linkedCredentialId}`,
            { headers: authorization(pairing.created), method: "DELETE" },
        );
        expect(revokeResponse.status).toBe(204);
        expect(await linkedHostClosed).toBe(1008);
        const revokedChannel = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}`,
            { headers: linkedAuthorization },
        );
        expect(revokedChannel.status).toBe(401);
        const ownerChannel = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}`,
            { headers: authorization(pairing.created) },
        );
        expect(ownerChannel.status).toBe(200);

        const expiringGrantResponse = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/access-grants`,
            { headers: authorization(pairing.created), method: "POST" },
        );
        const expiringGrant = decodeCreatedAccessGrant(await expiringGrantResponse.json());
        vi.setSystemTime(Date.parse(expiringGrant.expiresAt));
        const expiredResponse = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/access-grants/${expiringGrant.grantId}/redeem`,
            {
                body: JSON.stringify({ grantSecret: expiringGrant.grantSecret }),
                headers: { "content-type": "application/json" },
                method: "POST",
            },
        );
        expect(expiredResponse.status).toBe(410);
        await expect(expiredResponse.json()).resolves.toMatchObject({
            error: { code: "access_grant_expired" },
        });
    });
});
