import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
    AGENT_ACTIVITY_KIND,
    AGENT_INSTALL_PROGRESS_KIND,
    AGENT_INSTALL_REQUEST_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    decodeAgentInstallProgressEvent,
    decodeAgentInstallRequestCommand,
    decodeCommittedSessionEvent,
    decodeMessageKind,
    decodeNativeSessionCommand,
    decodeNativeSessionResult,
    decodeRecordedSessionEvent,
    decodeRuntimeHeartbeatAckEvent,
    decodeRuntimeLivenessReadyEvent,
    decodeRuntimeStatusEvent,
    decodeSessionEventAcknowledgement,
    decodeSessionEventRejection,
    decodeSessionFailedEvent,
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    encodeAgentInstallProgressEvent,
    encodeAgentInstallRequestCommand,
    encodeNativeSessionCommand,
    encodeNativeSessionResult,
    encodeRuntimeHeartbeatEvent,
    encodeSessionEventEnvelope,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    type NativeSessionResult,
    type RecordedSessionEvent,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_KIND,
    SESSION_EVENT_REJECTED_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    SESSION_STARTED_KIND,
    type SessionEventEnvelope,
    SessionEventRejectionCode,
    type SessionPrepareCommand,
    type SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import { MobiusArtifactUploadRequest, MobiusClient, MobiusRecordingPolicy } from "@moxt-ai/mobius-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const relayOrigin = "https://relay.test";
const verifiedAgentCapabilities = {
    additionalDirectories: true,
    audioPrompt: false,
    closeSession: true,
    deleteSession: true,
    embeddedContextPrompt: true,
    imagePrompt: true,
    listSessions: true,
    loadSession: true,
    resumeSession: true,
    unstableForkSession: false,
};
const readyAgents = [
    {
        agentPath: "/usr/local/bin/codex",
        agentVersion: "codex 0.153.0",
        capabilities: verifiedAgentCapabilities,
        id: "codex",
        label: "Codex",
    },
];
const installableAgents = [
    {
        id: "claude-code",
        label: "Claude Code",
        status: "agent_not_installed",
    },
];
const attemptIdsBySession = new Map<string, string>();
const sourceSequences = new Map<string, number>();

interface CreatedPairingResponse {
    readonly channelId: string;
    readonly expiresAt: string;
    readonly hostToken: string;
    readonly pairingCode: string;
    readonly pairingId: string;
    readonly pollToken: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly tenantId: string;
}

interface ClaimedPairingResponse {
    readonly channelId: string;
    readonly daemonToken: string;
    readonly runtimeId: string;
}

interface PairedChannel {
    readonly claimed: ClaimedPairingResponse;
    readonly created: CreatedPairingResponse;
}

interface PairingRecord {
    readonly channel_id: string;
    readonly daemon_token_hash: string;
    readonly project_id: string;
    readonly runtime_id: string;
    readonly tenant_id: string;
}

interface HostCredentialRecord {
    readonly authority: string;
    readonly channel_id: string;
    readonly credential_id: string;
    readonly token_hash: string;
}

interface CreatedAccessGrantResponse {
    readonly expiresAt: string;
    readonly grantId: string;
    readonly grantSecret: string;
}

interface RedeemedAccessGrantResponse {
    readonly channelId: string;
    readonly hostToken: string;
    readonly projectId: string;
    readonly tenantId: string;
}

interface AccessGrantRecord {
    readonly grant_id: string;
    readonly secret_hash: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0) {
        throw new Error(`Expected ${key}`);
    }
    return field;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeCreatedPairing(value: unknown): CreatedPairingResponse {
    if (!isRecord(value)) {
        throw new Error("Expected a pairing response object");
    }
    return {
        channelId: requiredString(value, "channelId"),
        expiresAt: requiredString(value, "expiresAt"),
        hostToken: requiredString(value, "hostToken"),
        pairingCode: requiredString(value, "pairingCode"),
        pairingId: requiredString(value, "pairingId"),
        pollToken: requiredString(value, "pollToken"),
        projectId: requiredString(value, "projectId"),
        runtimeId: requiredString(value, "runtimeId"),
        tenantId: requiredString(value, "tenantId"),
    };
}

function decodeClaimedPairing(value: unknown): ClaimedPairingResponse {
    if (!isRecord(value)) {
        throw new Error("Expected a claimed pairing response object");
    }
    return {
        channelId: requiredString(value, "channelId"),
        daemonToken: requiredString(value, "daemonToken"),
        runtimeId: requiredString(value, "runtimeId"),
    };
}

function decodeCreatedAccessGrant(value: unknown): CreatedAccessGrantResponse {
    if (!isRecord(value)) {
        throw new Error("Expected an access grant response object");
    }
    return {
        expiresAt: requiredString(value, "expiresAt"),
        grantId: requiredString(value, "grantId"),
        grantSecret: requiredString(value, "grantSecret"),
    };
}

function decodeRedeemedAccessGrant(value: unknown): RedeemedAccessGrantResponse {
    if (!isRecord(value)) {
        throw new Error("Expected a redeemed access grant response object");
    }
    return {
        channelId: requiredString(value, "channelId"),
        hostToken: requiredString(value, "hostToken"),
        projectId: requiredString(value, "projectId"),
        tenantId: requiredString(value, "tenantId"),
    };
}

class SocketMessages {
    readonly #messages: string[] = [];
    readonly #resolvers: ((message: string) => void)[] = [];

    constructor(socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") {
                throw new Error("Expected a text WebSocket message");
            }
            const resolve = this.#resolvers.shift();
            if (resolve === undefined) {
                this.#messages.push(event.data);
            } else {
                resolve(event.data);
            }
        });
    }

    readonly next = (): Promise<string> => {
        const message = this.#messages.shift();
        if (message !== undefined) {
            return Promise.resolve(message);
        }
        return new Promise((resolve) => this.#resolvers.push(resolve));
    };
}

function receiveMessageBeforeClose(socket: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
        const receive = (event: MessageEvent): void => {
            cleanup();
            if (typeof event.data !== "string") {
                reject(new Error("Expected a text WebSocket message"));
                return;
            }
            resolve(event.data);
        };
        const close = (event: CloseEvent): void => {
            cleanup();
            reject(new Error(`Daemon connection closed with code ${event.code.toString()}`));
        };
        const cleanup = (): void => {
            socket.removeEventListener("message", receive);
            socket.removeEventListener("close", close);
        };
        socket.addEventListener("message", receive, { once: true });
        socket.addEventListener("close", close, { once: true });
    });
}

interface OpenSocket {
    readonly messages: SocketMessages;
    readonly socket: WebSocket;
}

async function createPairing(): Promise<CreatedPairingResponse> {
    const response = await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings`, {
        method: "POST",
    });
    expect(response.status).toBe(201);
    return decodeCreatedPairing(await response.json());
}

async function claimPairing(created: CreatedPairingResponse): Promise<ClaimedPairingResponse> {
    const response = await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings/claim`, {
        body: JSON.stringify({
            agents: readyAgents,
            installableAgents,
            machineName: "Developer Mac",
            pairingCode: created.pairingCode,
            workspaceName: "mobius",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });
    expect(response.status).toBe(200);
    return decodeClaimedPairing(await response.json());
}

async function pairChannel(): Promise<PairedChannel> {
    const created = await createPairing();
    return { claimed: await claimPairing(created), created };
}

function requireWebSocket(response: Response): WebSocket {
    const socket = response.webSocket;
    if (socket === null || socket === undefined) {
        throw new Error("Expected a WebSocket upgrade response");
    }
    return socket;
}

async function openChannelSocket(path: string): Promise<OpenSocket> {
    const response = await exports.default.fetch(`${relayOrigin}${path}`, {
        headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = requireWebSocket(response);
    const messages = new SocketMessages(socket);
    socket.accept();
    return { messages, socket };
}

function authorization(pairing: CreatedPairingResponse): HeadersInit {
    return { authorization: `Bearer ${pairing.hostToken}` };
}

async function createSession(
    pairing: CreatedPairingResponse,
    sessionId: string,
    options: {
        readonly contentLimitBytes?: number;
        readonly hotEventLimit?: number;
        readonly retentionMilliseconds?: number;
    } = {},
): Promise<Response> {
    return await exports.default.fetch(`${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.projectId}/sessions`, {
        body: JSON.stringify({
            agentId: "codex",
            bindingId: "workspace",
            directoryId: "root",
            policy: {
                contentLimitBytes: options.contentLimitBytes ?? 2_000_000,
                hotEventLimit: options.hotEventLimit ?? 100,
                idempotencyRetentionMilliseconds: options.retentionMilliseconds ?? 86_400_000,
                level: "full",
                retentionMilliseconds: options.retentionMilliseconds ?? 86_400_000,
            },
            runtimeId: pairing.runtimeId,
            sessionId,
            title: `Session ${sessionId}`,
        }),
        headers: {
            ...authorization(pairing),
            "content-type": "application/json",
        },
        method: "POST",
    });
}

function prompt(sessionId: string, commandId: string, text: string): SessionPromptCommand {
    return {
        additionalDirectoryIds: [],
        agentId: "codex",
        bindingId: "workspace",
        commandId,
        directoryId: "root",
        images: [],
        kind: SESSION_PROMPT_KIND,
        prompt: text,
        resources: [],
        sessionId,
    };
}

function preparation(sessionId: string, requestId: string): SessionPrepareCommand {
    return {
        additionalDirectoryIds: [],
        agentId: "codex",
        bindingId: "workspace",
        directoryId: "root",
        kind: SESSION_PREPARE_KIND,
        requestId,
        sessionId,
    };
}

function envelope(sessionId: string, eventId: string, event: RecordedSessionEvent): SessionEventEnvelope {
    const attemptId =
        event.kind === SESSION_STARTED_KIND
            ? event.attemptId
            : "commandId" in event
              ? attemptIdsBySession.get(sessionId)
              : undefined;
    if (event.kind === SESSION_STARTED_KIND) {
        attemptIdsBySession.set(sessionId, event.attemptId);
    }
    if ("commandId" in event && attemptId === undefined) {
        throw new Error("An execution event has no Attempt source identity");
    }
    const sourceKey = attemptId === undefined ? `runtime:${sessionId}` : `attempt:${sessionId}:${attemptId}`;
    const sourceSequence = (sourceSequences.get(sourceKey) ?? 0) + 1;
    sourceSequences.set(sourceKey, sourceSequence);
    return {
        eventId,
        kind: SESSION_EVENT_KIND,
        payload: JSON.stringify(event),
        sessionId,
        source:
            attemptId === undefined
                ? { kind: "runtime", sourceSeq: sourceSequence.toString() }
                : {
                      attemptId,
                      kind: "attempt",
                      sourceSeq: sourceSequence.toString(),
                  },
    };
}

async function submitPrompt(host: OpenSocket, daemon: OpenSocket, command: SessionPromptCommand): Promise<void> {
    host.socket.send(encodeSessionPromptCommand(command));
    expect(decodeSessionPromptCommand(await daemon.messages.next())).toEqual(command);
    expect(decodeSessionPromptCommand(await host.messages.next())).toEqual(command);
}

async function commit(
    host: OpenSocket,
    daemon: OpenSocket,
    eventEnvelope: SessionEventEnvelope,
): Promise<ReturnType<typeof decodeCommittedSessionEvent>> {
    daemon.socket.send(encodeSessionEventEnvelope(eventEnvelope));
    const [acknowledgement, committed] = await Promise.all([
        daemon.messages.next().then(decodeSessionEventAcknowledgement),
        host.messages.next().then(decodeCommittedSessionEvent),
    ]);
    expect(acknowledgement).toMatchObject({
        duplicate: false,
        eventId: eventEnvelope.eventId,
        sessionId: eventEnvelope.sessionId,
    });
    expect(committed.eventId).toBe(eventEnvelope.eventId);
    return committed;
}

async function commitBatch(
    host: OpenSocket,
    daemon: OpenSocket,
    eventEnvelopes: readonly SessionEventEnvelope[],
): Promise<void> {
    const acknowledgementsPromise = Promise.all(
        eventEnvelopes.map(async () => decodeSessionEventAcknowledgement(await daemon.messages.next())),
    );
    const committedPromise = Promise.all(
        eventEnvelopes.map(async () => decodeCommittedSessionEvent(await host.messages.next())),
    );
    for (const eventEnvelope of eventEnvelopes) {
        daemon.socket.send(encodeSessionEventEnvelope(eventEnvelope));
    }
    const [acknowledgements, committedEvents] = await Promise.all([acknowledgementsPromise, committedPromise]);
    const acknowledgementsByEvent = new Map(
        acknowledgements.map((acknowledgement) => [acknowledgement.eventId, acknowledgement]),
    );
    const committedByEvent = new Map(committedEvents.map((committed) => [committed.eventId, committed]));
    expect(acknowledgementsByEvent.size).toBe(eventEnvelopes.length);
    expect(committedByEvent.size).toBe(eventEnvelopes.length);
    for (const eventEnvelope of eventEnvelopes) {
        expect(acknowledgementsByEvent.get(eventEnvelope.eventId)).toMatchObject({
            duplicate: false,
            eventId: eventEnvelope.eventId,
            sessionId: eventEnvelope.sessionId,
        });
        expect(committedByEvent.get(eventEnvelope.eventId)).toMatchObject({
            eventId: eventEnvelope.eventId,
            sessionId: eventEnvelope.sessionId,
        });
    }
}

async function completeTurn(
    host: OpenSocket,
    daemon: OpenSocket,
    command: SessionPromptCommand,
    response: string,
): Promise<void> {
    await submitPrompt(host, daemon, command);
    await commit(
        host,
        daemon,
        envelope(command.sessionId, `${command.commandId}-started`, {
            commandId: command.commandId,
            kind: SESSION_STARTED_KIND,
            attemptId: `${command.commandId}-attempt`,
            sessionId: command.sessionId,
        }),
    );
    await commit(
        host,
        daemon,
        envelope(command.sessionId, `${command.commandId}-delta`, {
            commandId: command.commandId,
            kind: AGENT_MESSAGE_DELTA_KIND,
            sessionId: command.sessionId,
            text: response,
        }),
    );
    await commit(
        host,
        daemon,
        envelope(command.sessionId, `${command.commandId}-completed`, {
            commandId: command.commandId,
            kind: SESSION_COMPLETED_KIND,
            sessionId: command.sessionId,
            stopReason: "end_turn",
        }),
    );
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T00:00:00.000Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

describe.sequential("Cloudflare session deployment", () => {
    it("Given a browser pairing, When clients use channel and project resources, Then verified credentials derive one tenant and project scope", async () => {
        const created = await createPairing();
        const pending = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/pairings/${created.pairingId}?token=${created.pollToken}`,
        );
        await expect(pending.json()).resolves.toEqual({
            expiresAt: created.expiresAt,
            status: "pending",
        });

        const claimed = await claimPairing(created);
        expect(claimed.channelId).toBe(created.channelId);
        expect(claimed.runtimeId).toBe(created.runtimeId);
        expect(created.runtimeId).not.toBe(created.channelId);
        const paired = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/pairings/${created.pairingId}?token=${created.pollToken}`,
        );
        await expect(paired.json()).resolves.toMatchObject({
            channelId: created.channelId,
            projectId: created.projectId,
            runtimeId: created.runtimeId,
            status: "paired",
            tenantId: created.tenantId,
        });

        const channel = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${created.channelId}`,
            { headers: authorization(created) },
        );
        expect(channel.status).toBe(200);
        await expect(channel.json()).resolves.toMatchObject({
            channelId: created.channelId,
            projectId: created.projectId,
            runtimeId: created.runtimeId,
            tenantId: created.tenantId,
        });
        const unauthorizedHost = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${created.channelId}/host?token=${"x".repeat(43)}`,
            { headers: { Upgrade: "websocket" } },
        );
        expect(unauthorizedHost.status).toBe(401);

        const record = await env.DIRECTORY_DATABASE.prepare(
            `SELECT channel_id, daemon_token_hash, project_id, runtime_id, tenant_id
       FROM pairing_channels WHERE pairing_id = ?`,
        )
            .bind(created.pairingId)
            .first<PairingRecord>();
        expect(record).toMatchObject({
            channel_id: created.channelId,
            daemon_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
            project_id: created.projectId,
            runtime_id: created.runtimeId,
            tenant_id: created.tenantId,
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

    it("Given an owner app credential, When a browser uses a short-lived project credential through the SDK, Then Runtime discovery and every Session request enforce expiry, refresh, and revocation", async () => {
        const pairing = await pairChannel();
        const issueCredential = async (): Promise<Readonly<Record<string, unknown>>> => {
            const response = await exports.default.fetch(
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
                fetch: async (request) => await exports.default.fetch(request),
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

            const revokeResponse = await exports.default.fetch(
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

    it("Given a persisted catalog predates verified capabilities and Web-confirmed installation, When its Channel is read, Then capabilities are conservative and obsolete approval metadata is omitted", async () => {
        const pairing = await pairChannel();
        await env.DIRECTORY_DATABASE.prepare(
            `UPDATE pairing_channels
       SET agents_json = ?, installable_agents_json = ?
       WHERE channel_id = ?`,
        )
            .bind(
                JSON.stringify([{ id: "codex", label: "Codex" }]),
                JSON.stringify([
                    {
                        id: "claude-code",
                        label: "Claude Code",
                        requiresLocalApproval: true,
                    },
                ]),
                pairing.created.channelId,
            )
            .run();

        const response = await exports.default.fetch(
            `${relayOrigin}/mobius/api/channels/${pairing.created.channelId}`,
            { headers: authorization(pairing.created) },
        );
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
                        resumeSession: false,
                        unstableForkSession: false,
                    },
                    id: "codex",
                    label: "Codex",
                },
            ],
            installableAgents,
        });
        expect(JSON.stringify(descriptor)).not.toContain("requiresLocalApproval");
    });

    it("Given an owned Channel, When a one-time access grant is redeemed, Then the linked credential is independently authorized and revocable", async () => {
        const pairing = await pairChannel();
        const createGrantResponse = await exports.default.fetch(
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

        const wrongSecretResponse = await exports.default.fetch(
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

        const redeemResponse = await exports.default.fetch(
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
            tenantId: pairing.created.tenantId,
        });
        expect(redeemed.hostToken).not.toBe(pairing.created.hostToken);
        expect(redeemed.hostToken).not.toBe(grant.grantSecret);

        const replayResponse = await exports.default.fetch(
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
        const linkedChannel = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}`,
            { headers: linkedAuthorization },
        );
        expect(linkedChannel.status).toBe(200);
        const linkedProject = await exports.default.fetch(
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
        const delegationAttempt = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/access-grants`,
            { headers: linkedAuthorization, method: "POST" },
        );
        expect(delegationAttempt.status).toBe(403);
        await expect(delegationAttempt.json()).resolves.toMatchObject({
            error: { code: "owner_access_required" },
        });

        const devicePageResponse = await exports.default.fetch(
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

        const revokeResponse = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/linked-devices/${linkedCredentialId}`,
            { headers: authorization(pairing.created), method: "DELETE" },
        );
        expect(revokeResponse.status).toBe(204);
        expect(await linkedHostClosed).toBe(1008);
        const revokedChannel = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}`,
            { headers: linkedAuthorization },
        );
        expect(revokedChannel.status).toBe(401);
        const ownerChannel = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}`,
            { headers: authorization(pairing.created) },
        );
        expect(ownerChannel.status).toBe(200);

        const expiringGrantResponse = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.created.channelId}/access-grants`,
            { headers: authorization(pairing.created), method: "POST" },
        );
        const expiringGrant = decodeCreatedAccessGrant(await expiringGrantResponse.json());
        vi.setSystemTime(Date.parse(expiringGrant.expiresAt));
        const expiredResponse = await exports.default.fetch(
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

    it("Given a stable Channel targets a distinct Runtime, When a daemon connection is replaced, Then its durable epoch advances and the stale connection is fenced", async () => {
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

    it("Given session persistence is backlogged, When the daemon sends a heartbeat, Then liveness is acknowledged before the event backlog drains", async () => {
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

    it("Given independent sessions on one runtime, When history pages and a reconnect cursor are read, Then records stay ordered while duplicate delivery never reruns a command", async () => {
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

            const messages = await exports.default.fetch(
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
            const older = await exports.default.fetch(
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
                sessionId: running.sessionId,
                text: "still running",
            });
            const nextLive = await commit(host, daemon, deltaEnvelope);
            expect(BigInt(nextLive.sequence)).toBe(BigInt(firstLive.sequence) + 1n);

            const catchup = await exports.default.fetch(
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
                env.SESSION_RELAY.idFromName(`${pairing.created.tenantId}:${pairing.created.projectId}:session-a`),
            );
            await evictDurableObject(sessionStub);
            const recovered = await exports.default.fetch(
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

    it("Given an Agent titled a prepared session, When the browser reconnects and prepares it again, Then the same session resumes without closing the channel", async () => {
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

        const response = await exports.default.fetch(
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
                        resumeSession: true,
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

            const existing = await exports.default.fetch(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/existing-native-session`,
                { headers: authorization(pairing.created) },
            );
            expect(existing.status).toBe(200);
            await expect(existing.json()).resolves.toMatchObject({
                hasNativeHistory: true,
                title: "Existing native session",
            });
            const nativeHistory = await exports.default.fetch(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/existing-native-session/native-history`,
                { headers: authorization(pairing.created) },
            );
            expect(nativeHistory.status).toBe(200);
            await expect(nativeHistory.json()).resolves.toEqual(result.history);
            const exported = await exports.default.fetch(
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
            const provisional = await exports.default.fetch(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/provisional-native-session`,
                { headers: authorization(pairing.created) },
            );
            expect(provisional.status).toBe(410);
        } finally {
            host.socket.close(1000, "Worker integration complete");
            daemon.socket.close(1000, "Worker integration complete");
        }
    });

    it("Given an Attempt is running, When its daemon disconnects and restarts, Then the indeterminate outcome is retained until explicit reconciliation", async () => {
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

        const interruptedHistory = await exports.default.fetch(
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
            const deniedReconciliation = await exports.default.fetch(
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
                    message: "A valid channel token is required",
                },
            });

            const reconciliation = await exports.default.fetch(
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
            const recoveredHistory = await exports.default.fetch(
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

            const reconciliation = await exports.default.fetch(
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
            const fullOutput = `begin-${"large output line\n".repeat(35_000)}-end`;
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
            const detailPayload = JSON.stringify({
                content: [],
                input: "{}",
                output: fullOutput,
            });
            const stub = env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(`${pairing.created.tenantId}:${pairing.created.projectId}:${sessionId}`),
            );
            await runInDurableObject(stub, async (_instance, state) => {
                await state.storage.deleteAlarm();
                state.storage.transactionSync(() => {
                    state.storage.sql.exec(
                        `UPDATE artifacts
             SET state = 'uploading', sha256 = '', chunks_json = NULL
             WHERE session_id = ? AND artifact_id = ?`,
                        sessionId,
                        artifactId,
                    );
                    state.storage.sql.exec(
                        `UPDATE tool_call_views SET hot_detail = ?
             WHERE session_id = ? AND activity_id = ?`,
                        detailPayload,
                        sessionId,
                        "activity-large",
                    );
                    state.storage.sql.exec(
                        `INSERT OR REPLACE INTO archive_work (
               scope_key, session_id, target_id, archive_kind, owner_id,
               media_type, hot_payload, attempts, last_error
             ) VALUES (?, ?, ?, 'activity', ?, 'application/json', ?, 0, '')`,
                        `${pairing.created.tenantId}:${pairing.created.projectId}`,
                        sessionId,
                        artifactId,
                        "activity-large",
                        detailPayload,
                    );
                });
            });
            const detailPath = `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${sessionId}/attempts/large-attempt/tool-calls/activity-large`;
            const availableBeforeRecovery = await exports.default.fetch(detailPath, {
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
            const archived = await exports.default.fetch(detailPath, {
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

    it("Given the free deployment archive quota, When a compressed tool record exceeds it, Then the archive reports a typed quota error and preserves the hot detail", async () => {
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
                    sequence: 0,
                    sessionId,
                    status: "completed",
                    title: "Run terminal command",
                    toolKind: "execute",
                }),
            );

            const stub = env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(`${pairing.created.tenantId}:${pairing.created.projectId}:${sessionId}`),
            );
            const archiveResponse = await runInDurableObject(stub, async (instance) => {
                if (instance.fetch === undefined) {
                    throw new Error("Expected the Session Durable Object fetch handler");
                }
                return await instance.fetch(
                    new Request("https://session.internal/internal/sessions/archive", {
                        body: JSON.stringify({
                            scope: {
                                projectId: pairing.created.projectId,
                                tenantId: pairing.created.tenantId,
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

            const detail = await exports.default.fetch(
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

    it("Given sessions in different tenant scopes and bounded retention, When callers export, import, delete, and expire data, Then isolation and availability outcomes are explicit", async () => {
        const source = await pairChannel();
        const destination = await pairChannel();
        const sessionId = "lifecycle-session";
        expect((await createSession(source.created, sessionId)).status).toBe(201);

        const unauthorized = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${source.created.projectId}/sessions`,
            { headers: authorization(destination.created) },
        );
        expect(unauthorized.status).toBe(401);
        const invisible = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${destination.created.projectId}/sessions/${sessionId}`,
            { headers: authorization(destination.created) },
        );
        expect(invisible.status).toBe(404);

        const exportedResponse = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${source.created.projectId}/sessions/${sessionId}/export`,
            { headers: authorization(source.created) },
        );
        expect(exportedResponse.status).toBe(200);
        const exported: unknown = await exportedResponse.json();
        if (!isRecord(exported)) {
            throw new Error("Expected a Session export envelope");
        }
        const imported = await exports.default.fetch(
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
        await expect(imported.json()).resolves.toMatchObject({
            projectId: destination.created.projectId,
            sessionId,
            tenantId: destination.created.tenantId,
        });

        const deleted = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${destination.created.projectId}/sessions/${sessionId}`,
            {
                headers: authorization(destination.created),
                method: "DELETE",
            },
        );
        expect(deleted.status).toBe(200);
        await expect(deleted.json()).resolves.toMatchObject({ kind: "deleted" });
        const afterDelete = await exports.default.fetch(
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
        const expired = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${source.created.projectId}/sessions/${expiringId}`,
            { headers: authorization(source.created) },
        );
        expect(expired.status).toBe(410);
        await expect(expired.json()).resolves.toMatchObject({
            error: { code: "session_deleted" },
        });
    });

    it("Given a deleted Session and a live Session share one daemon, When stale and valid events arrive, Then only the stale event is rejected and the Channel stays online", async () => {
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
            const deleted = await exports.default.fetch(
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

    it("Given an active Turn, When its daemon sends a large event and completion without waiting between frames, Then the Relay commits both events in source order and keeps the connection open", async () => {
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
            const history = await exports.default.fetch(
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

    it("Given an archived event window, When a client resumes from an old durable cursor and retransmits an archived event, Then catch-up and deduplication remain complete", async () => {
        const pairing = await pairChannel();
        const sessionId = "cursor-session";
        expect(
            (
                await createSession(pairing.created, sessionId, {
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
            const events = [
                ...Array.from({ length: 40 }, (_, index) =>
                    envelope(sessionId, `cursor-delta-${index.toString()}`, {
                        commandId: command.commandId,
                        kind: AGENT_MESSAGE_DELTA_KIND,
                        sessionId,
                        text: index.toString(),
                    }),
                ),
                envelope(sessionId, "cursor-completed", {
                    commandId: command.commandId,
                    kind: SESSION_COMPLETED_KIND,
                    sessionId,
                    stopReason: "end_turn",
                }),
            ];
            for (let offset = 0; offset < events.length; offset += 10) {
                await commitBatch(host, daemon, events.slice(offset, offset + 10));
            }
            const sessionStub = env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(`${pairing.created.tenantId}:${pairing.created.projectId}:${sessionId}`),
            );
            await runInDurableObject(sessionStub, async (instance, state) => {
                if (instance.alarm === undefined) {
                    throw new Error("Expected the Session Durable Object alarm handler");
                }
                await state.storage.deleteAlarm();
                await instance.alarm();
            });
            const resumed = await exports.default.fetch(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/${sessionId}/events?cursor=${encodeURIComponent(first.cursor)}`,
                { headers: authorization(pairing.created) },
            );
            expect(resumed.status).toBe(200);
            const resumedBody: unknown = await resumed.json();
            if (!isRecord(resumedBody) || !Array.isArray(resumedBody["events"])) {
                throw new Error("Expected a durable event catch-up page");
            }
            expect(resumedBody["hasMore"]).toBe(false);
            expect(resumedBody["events"]).toHaveLength(41);
            expect(resumedBody["events"].slice(0, 2)).toMatchObject([
                { eventId: "cursor-delta-0", sequence: "2" },
                { eventId: "cursor-delta-1", sequence: "3" },
            ]);
            daemon.socket.send(encodeSessionEventEnvelope(startedEnvelope));
            expect(decodeSessionEventAcknowledgement(await daemon.messages.next())).toMatchObject({
                duplicate: true,
                eventId: "cursor-started",
                sequence: "1",
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
        const pairing = await pairChannel();
        const invalidImport = await exports.default.fetch(
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

        const deleted = await exports.default.fetch(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.created.projectId}/sessions/quota-first`,
            { headers: authorization(pairing.created), method: "DELETE" },
        );
        expect(deleted.status).toBe(200);
        expect((await createSession(pairing.created, "quota-third")).status).toBe(201);
    });
});
