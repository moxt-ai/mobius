import {
    AGENT_MESSAGE_DELTA_KIND,
    decodeCommittedSessionEvent,
    decodeSessionEventAcknowledgement,
    decodeSessionPromptCommand,
    encodeSessionEventEnvelope,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    type RecordedSessionEvent,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    SESSION_STARTED_KIND,
    type SessionEventEnvelope,
    type SessionPrepareCommand,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect } from "vitest";
import type { createTestMobiusApp } from "../../../tests/infra/app.ts";

export const relayOrigin = "https://relay.test";
export const verifiedAgentCapabilities = {
    additionalDirectories: true,
    audioPrompt: false,
    closeSession: true,
    deleteSession: true,
    embeddedContextPrompt: true,
    imagePrompt: true,
    listSessions: true,
    loadSession: true,
    promptQueueing: true,
    resumeSession: true,
    steering: true,
    unstableForkSession: false,
};
export const readyAgents = [
    {
        agentSettingsDiscovery: true,
        agentPath: "/usr/local/bin/codex",
        agentVersion: "codex 0.153.0",
        capabilities: verifiedAgentCapabilities,
        id: "codex",
        label: "Codex",
        sessionTurnConfiguration: true,
    },
];
export const installableAgents = [
    {
        id: "claude-code",
        label: "Claude Code",
        status: "agent_not_installed",
    },
];
export const buildAgents = [
    {
        agentPath: "/opt/mobius/bin/build-agent",
        agentVersion: "build-agent 2.0.0",
        capabilities: verifiedAgentCapabilities,
        id: "build-agent",
        label: "Build Agent",
    },
];
const attemptIdsBySession = new Map<string, string>();
const sourceSequences = new Map<string, number>();

export interface CreatedPairingResponse {
    readonly channelId: string;
    readonly expiresAt: string;
    readonly hostToken: string;
    readonly pairingCode: string;
    readonly pairingId: string;
    readonly pollToken: string;
    readonly projectId: string;
    readonly runtimeId: string;
}

export interface ClaimedPairingResponse {
    readonly channelId: string;
    readonly daemonToken: string;
    readonly runtimeId: string;
}

export interface CreatedRuntimePairingResponse {
    readonly channelId: string;
    readonly expiresAt: string;
    readonly pairingCode: string;
    readonly pairingId: string;
    readonly pollToken: string;
    readonly projectId: string;
    readonly runtimeId: string;
}

export interface PairedChannel {
    readonly claimed: ClaimedPairingResponse;
    readonly created: CreatedPairingResponse;
}

export interface PairingRecord {
    readonly channel_id: string;
    readonly daemon_token_hash: string;
    readonly project_id: string;
    readonly runtime_id: string;
}

export interface HostCredentialRecord {
    readonly authority: string;
    readonly channel_id: string;
    readonly credential_id: string;
    readonly token_hash: string;
}

export interface CreatedAccessGrantResponse {
    readonly expiresAt: string;
    readonly grantId: string;
    readonly grantSecret: string;
}

export interface RedeemedAccessGrantResponse {
    readonly channelId: string;
    readonly hostToken: string;
    readonly projectId: string;
}

export interface AccessGrantRecord {
    readonly grant_id: string;
    readonly secret_hash: string;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredString(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0) {
        throw new Error(`Expected ${key}`);
    }
    return field;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeCreatedPairing(value: unknown): CreatedPairingResponse {
    if (!isRecord(value)) {
        throw new Error("Expected a pairing response object");
    }
    if (Object.hasOwn(value, "tenantId")) {
        throw new Error("Standalone exposed its internal tenant placement");
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

function decodeCreatedRuntimePairing(value: unknown): CreatedRuntimePairingResponse {
    if (!isRecord(value)) {
        throw new Error("Expected a Runtime pairing response object");
    }
    return {
        channelId: requiredString(value, "channelId"),
        expiresAt: requiredString(value, "expiresAt"),
        pairingCode: requiredString(value, "pairingCode"),
        pairingId: requiredString(value, "pairingId"),
        pollToken: requiredString(value, "pollToken"),
        projectId: requiredString(value, "projectId"),
        runtimeId: requiredString(value, "runtimeId"),
    };
}

export function decodeCreatedAccessGrant(value: unknown): CreatedAccessGrantResponse {
    if (!isRecord(value)) {
        throw new Error("Expected an access grant response object");
    }
    return {
        expiresAt: requiredString(value, "expiresAt"),
        grantId: requiredString(value, "grantId"),
        grantSecret: requiredString(value, "grantSecret"),
    };
}

export function decodeRedeemedAccessGrant(value: unknown): RedeemedAccessGrantResponse {
    if (!isRecord(value)) {
        throw new Error("Expected a redeemed access grant response object");
    }
    if (Object.hasOwn(value, "tenantId")) {
        throw new Error("Standalone exposed its internal tenant placement");
    }
    return {
        channelId: requiredString(value, "channelId"),
        hostToken: requiredString(value, "hostToken"),
        projectId: requiredString(value, "projectId"),
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

    readonly available = (): number => this.#messages.length;
}

export function receiveMessageBeforeClose(socket: WebSocket): Promise<string> {
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

export interface OpenSocket {
    readonly messages: SocketMessages;
    readonly socket: WebSocket;
}

export function createSessionRequests(app: ReturnType<typeof createTestMobiusApp>) {
    async function createPairing(): Promise<CreatedPairingResponse> {
        const response = await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings`, {
            method: "POST",
        });
        expect(response.status).toBe(201);
        return decodeCreatedPairing(await response.json());
    }

    async function claimPairing(
        created: CreatedPairingResponse,
        agents: readonly Readonly<Record<string, unknown>>[] = readyAgents,
        availableInstallableAgents: readonly Readonly<Record<string, unknown>>[] = installableAgents,
    ): Promise<ClaimedPairingResponse> {
        const response = await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings/claim`, {
            body: JSON.stringify({
                agents,
                installableAgents: availableInstallableAgents,
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

    async function createProjectRuntimePairing(
        project: CreatedPairingResponse,
        idempotencyKey: string,
    ): Promise<CreatedRuntimePairingResponse> {
        const response = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${project.projectId}/runtime-pairings`,
            {
                body: JSON.stringify({ idempotencyKey }),
                headers: {
                    ...authorization(project),
                    "content-type": "application/json",
                },
                method: "POST",
            },
        );
        expect(response.status).toBe(201);
        return decodeCreatedRuntimePairing(await response.json());
    }

    async function claimProjectRuntimePairing(
        created: CreatedRuntimePairingResponse,
        machineName: string,
        workspaceName: string,
        agents: readonly Readonly<Record<string, unknown>>[],
        availableInstallableAgents: readonly Readonly<Record<string, unknown>>[],
    ): Promise<ClaimedPairingResponse> {
        const response = await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings/claim`, {
            body: JSON.stringify({
                agents,
                installableAgents: availableInstallableAgents,
                machineName,
                pairingCode: created.pairingCode,
                workspaceName,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });
        expect(response.status).toBe(200);
        return decodeClaimedPairing(await response.json());
    }

    function waitForSocketClose(socket: WebSocket): Promise<CloseEvent> {
        return new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
    }

    function requireWebSocket(response: Response): WebSocket {
        const socket = response.webSocket;
        if (socket === null || socket === undefined) {
            throw new Error("Expected a WebSocket upgrade response");
        }
        return socket;
    }

    async function openChannelSocket(path: string): Promise<OpenSocket> {
        const response = await app.request(`${relayOrigin}${path}`, {
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
        return await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.projectId}/sessions`, {
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

    return {
        createPairing,
        claimPairing,
        pairChannel,
        createProjectRuntimePairing,
        claimProjectRuntimePairing,
        waitForSocketClose,
        openChannelSocket,
        authorization,
        createSession,
    };
}

export function prompt(sessionId: string, commandId: string, text: string): SessionPromptCommand {
    return {
        additionalDirectoryIds: [],
        agentId: "codex",
        bindingId: "workspace",
        commandId,
        directoryId: "root",
        disposition: SessionPromptDisposition.Reject,
        images: [],
        kind: SESSION_PROMPT_KIND,
        prompt: text,
        resources: [],
        sessionId,
        targetCommandId: "",
    };
}

export function preparation(sessionId: string, requestId: string): SessionPrepareCommand {
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

export function envelope(sessionId: string, eventId: string, event: RecordedSessionEvent): SessionEventEnvelope {
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

export async function submitPrompt(host: OpenSocket, daemon: OpenSocket, command: SessionPromptCommand): Promise<void> {
    host.socket.send(encodeSessionPromptCommand(command));
    expect(decodeSessionPromptCommand(await daemon.messages.next())).toEqual(command);
    expect(decodeSessionPromptCommand(await host.messages.next())).toEqual(command);
}

export async function commit(
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

export async function commitBatch(
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

export async function completeTurn(
    host: OpenSocket,
    daemon: OpenSocket,
    command: SessionPromptCommand,
    response: string,
    contents: readonly RecordedSessionEvent[] = [],
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
    for (const [index, content] of contents.entries()) {
        await commit(
            host,
            daemon,
            envelope(command.sessionId, `${command.commandId}-content-${index.toString()}`, content),
        );
    }
    await commit(
        host,
        daemon,
        envelope(command.sessionId, `${command.commandId}-delta`, {
            commandId: command.commandId,
            kind: AGENT_MESSAGE_DELTA_KIND,
            messageId: "",
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
