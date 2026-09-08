import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    AGENT_ACTIVITY_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    decodeSessionCancelCommand,
    decodeSessionEventEnvelope,
    decodeSessionPermissionRespondCommand,
    decodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    MobiusApiConfigurationError,
    type RecordedSessionEvent,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PROMPT_KIND,
    SESSION_STARTED_KIND,
    type SessionEventEnvelope,
    type SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import {
    ChannelDescriptor,
    type ChannelRuntime,
    createMobiusApplication,
    type PairingDirectory,
    PairingDirectoryError,
    ProjectScope,
    ProjectScopeAccess,
    RuntimeStatus,
    type SessionRuntime,
    VerifiedChannelAccess,
} from "@moxt-ai/mobius-relay-core";
import {
    MobiusAgentActivityEvent,
    MobiusApiError,
    MobiusArtifactUploadRequest,
    MobiusCancellationError,
    MobiusCancelledTurnState,
    MobiusClient,
    type MobiusHttpTransport,
    MobiusPageRequest,
    MobiusPermissionResponseRequest,
    MobiusRecordingPolicy,
    MobiusRunningTurnState,
    type MobiusSessionEvent,
    MobiusSessionImportBinding,
    MobiusSucceededTurnState,
    MobiusTurnCompletedEvent,
    StaticMobiusCredentialProvider,
} from "@moxt-ai/mobius-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNodeRelay, type NodeRelay } from "../src/node-relay.ts";
import { NodeSessionRuntime } from "../src/node-session-runtime.ts";

const fixedTime = Date.parse("2026-09-06T00:00:00.000Z");
const token = "node-test-token-abcdefghijklmnopqrstuvwxyz";
const scope = new ProjectScope("tenant-node", "project-node");
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
const createdDirectories: string[] = [];
const attemptIdsBySession = new Map<string, string>();
const sourceSequences = new Map<string, number>();

class ScopedPairingDirectory implements PairingDirectory {
    readonly authorizeDaemon = async (): Promise<never> => {
        throw new PairingDirectoryError("unauthorized", "Not available in this scenario");
    };

    readonly authorizeHost = async (): Promise<never> => {
        throw new PairingDirectoryError("unauthorized", "Not available in this scenario");
    };

    readonly authorizeProject = async (
        projectId: string,
        candidateToken: string,
        signal: AbortSignal,
    ): Promise<ProjectScopeAccess> => {
        signal.throwIfAborted();
        if (projectId !== scope.projectId || candidateToken !== token) {
            throw new PairingDirectoryError("unauthorized", "Project access denied");
        }
        return new ProjectScopeAccess(scope.tenantId, scope.projectId);
    };

    readonly authorizeProjectRuntime = async (
        projectId: string,
        runtimeId: string,
        candidateToken: string,
        signal: AbortSignal,
    ): Promise<VerifiedChannelAccess> => {
        await this.authorizeProject(projectId, candidateToken, signal);
        if (runtimeId !== "runtime-node") {
            throw new PairingDirectoryError("unauthorized", "Runtime access denied");
        }
        return new VerifiedChannelAccess("channel-node", runtimeId, scope.tenantId, scope.projectId);
    };

    readonly claimPairing = async (): Promise<never> => {
        throw new PairingDirectoryError("invalid_request", "Not available in this scenario");
    };

    readonly createChannelAccessGrant = async (): Promise<never> => {
        throw new PairingDirectoryError("invalid_request", "Not available in this scenario");
    };

    readonly createBrowserCredential = async (): Promise<never> => {
        throw new PairingDirectoryError("invalid_request", "Not available in this scenario");
    };

    readonly createPairing = async (): Promise<never> => {
        throw new PairingDirectoryError("invalid_request", "Not available in this scenario");
    };

    readonly listLinkedChannelDevices = async (): Promise<never> => {
        throw new PairingDirectoryError("invalid_request", "Not available in this scenario");
    };

    readonly listProjectRuntimes = async (
        projectId: string,
        candidateToken: string,
        signal: AbortSignal,
    ): Promise<readonly ChannelDescriptor[]> => {
        await this.authorizeProject(projectId, candidateToken, signal);
        return [
            new ChannelDescriptor(
                [
                    {
                        agentPath: "/usr/local/bin/codex",
                        agentVersion: "codex 0.153.0",
                        capabilities: verifiedAgentCapabilities,
                        id: "codex",
                        label: "Codex",
                    },
                ],
                "channel-node",
                "Node machine",
                "mobius",
                scope.tenantId,
                scope.projectId,
                "runtime-node",
            ),
        ];
    };

    readonly readChannel = async (): Promise<never> => {
        throw new PairingDirectoryError("unauthorized", "Not available in this scenario");
    };

    readonly readPairingStatus = async (): Promise<never> => {
        throw new PairingDirectoryError("unauthorized", "Not available in this scenario");
    };

    readonly redeemChannelAccessGrant = async (): Promise<never> => {
        throw new PairingDirectoryError("invalid_request", "Not available in this scenario");
    };

    readonly revokeLinkedChannelDevice = async (): Promise<never> => {
        throw new PairingDirectoryError("invalid_request", "Not available in this scenario");
    };

    readonly revokeBrowserCredential = async (): Promise<never> => {
        throw new PairingDirectoryError("invalid_request", "Not available in this scenario");
    };

    readonly updateAgentCatalog = async (): Promise<never> => {
        throw new PairingDirectoryError("unauthorized", "Not available in this scenario");
    };
}

class InertChannelRuntime implements ChannelRuntime {
    readonly acceptDaemon = async (): Promise<Response> => new Response(null, { status: 501 });

    readonly acceptHost = async (): Promise<Response> => new Response(null, { status: 501 });

    readonly disconnectHost = async (): Promise<void> => {};

    readonly dispatchPending = async (): Promise<void> => {};

    readonly readRuntimeStatus = async (): Promise<RuntimeStatus> => new RuntimeStatus(false);
}

class ExecutingChannelRuntime implements ChannelRuntime {
    readonly #runtime: SessionRuntime;

    constructor(runtime: SessionRuntime) {
        this.#runtime = runtime;
    }

    readonly acceptDaemon = async (): Promise<Response> => new Response(null, { status: 501 });

    readonly acceptHost = async (): Promise<Response> => new Response(null, { status: 501 });

    readonly disconnectHost = async (): Promise<void> => {};

    readonly readRuntimeStatus = async (): Promise<RuntimeStatus> => new RuntimeStatus(true);

    readonly dispatchPending = async (access: VerifiedChannelAccess, signal: AbortSignal): Promise<void> => {
        const projectScope = new ProjectScope(access.tenantId, access.projectId);
        const deliveries = await this.#runtime.listPendingDaemonDeliveries(projectScope, access.runtimeId, 100, signal);
        for (const delivery of deliveries) {
            const command = decodeSessionPromptCommand(delivery.payload);
            const attemptId = `attempt-${command.commandId}`;
            await this.#runtime.markPendingWorkCompleted(
                projectScope,
                command.sessionId,
                delivery.pendingWork.workId,
                Date.now(),
                signal,
            );
            await this.commitAttemptEvent(
                projectScope,
                access.runtimeId,
                command.sessionId,
                attemptId,
                `started-${command.commandId}`,
                "1",
                {
                    attemptId,
                    commandId: command.commandId,
                    kind: SESSION_STARTED_KIND,
                    sessionId: command.sessionId,
                },
                signal,
            );
            await this.commitAttemptEvent(
                projectScope,
                access.runtimeId,
                command.sessionId,
                attemptId,
                `activity-${command.commandId}`,
                "2",
                {
                    activityId: `activity-${command.commandId}`,
                    activityType: "tool",
                    commandId: command.commandId,
                    content: [],
                    detail: {
                        content: [],
                        input: "{}",
                        kind: "recorded",
                        output: "inspected from the public SDK",
                    },
                    input: "{}",
                    kind: AGENT_ACTIVITY_KIND,
                    locations: [],
                    name: "inspect",
                    output: "inspection complete",
                    sequence: 0,
                    sessionId: command.sessionId,
                    status: "completed",
                    title: "Inspect workspace",
                    toolKind: "read",
                },
                signal,
            );
            await this.commitAttemptEvent(
                projectScope,
                access.runtimeId,
                command.sessionId,
                attemptId,
                `delta-${command.commandId}`,
                "3",
                {
                    commandId: command.commandId,
                    kind: AGENT_MESSAGE_DELTA_KIND,
                    sessionId: command.sessionId,
                    text: "Node SDK response",
                },
                signal,
            );
            await this.commitAttemptEvent(
                projectScope,
                access.runtimeId,
                command.sessionId,
                attemptId,
                `completed-${command.commandId}`,
                "4",
                {
                    commandId: command.commandId,
                    kind: SESSION_COMPLETED_KIND,
                    sessionId: command.sessionId,
                    stopReason: "end_turn",
                },
                signal,
            );
        }
    };

    private readonly commitAttemptEvent = async (
        projectScope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        attemptId: string,
        eventId: string,
        sourceSequence: string,
        payload: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#runtime.commitEvent(
            projectScope,
            runtimeId,
            decodeSessionEventEnvelope(
                JSON.stringify({
                    eventId,
                    kind: SESSION_EVENT_KIND,
                    payload: JSON.stringify(payload),
                    sessionId,
                    source: {
                        attemptId,
                        kind: "attempt",
                        sourceSeq: sourceSequence,
                    },
                }),
            ),
            Date.now(),
            signal,
        );
    };
}

class CapturingChannelRuntime implements ChannelRuntime {
    readonly #runtime: SessionRuntime;
    readonly deliveredPayloads: string[] = [];

    constructor(runtime: SessionRuntime) {
        this.#runtime = runtime;
    }

    readonly acceptDaemon = async (): Promise<Response> => new Response(null, { status: 501 });

    readonly acceptHost = async (): Promise<Response> => new Response(null, { status: 501 });

    readonly disconnectHost = async (): Promise<void> => {};

    readonly readRuntimeStatus = async (): Promise<RuntimeStatus> => new RuntimeStatus(true);

    readonly dispatchPending = async (access: VerifiedChannelAccess, signal: AbortSignal): Promise<void> => {
        const projectScope = new ProjectScope(access.tenantId, access.projectId);
        const deliveries = await this.#runtime.listPendingDaemonDeliveries(projectScope, access.runtimeId, 100, signal);
        for (const delivery of deliveries) {
            this.deliveredPayloads.push(delivery.payload);
            await this.#runtime.markPendingWorkCompleted(
                projectScope,
                delivery.pendingWork.sessionId,
                delivery.pendingWork.workId,
                Date.now(),
                signal,
            );
        }
    };
}

class ApplicationHttpTransport implements MobiusHttpTransport {
    readonly #fetch: (request: Request) => Promise<Response>;

    constructor(fetchApplication: (request: Request) => Promise<Response>) {
        this.#fetch = fetchApplication;
    }

    readonly fetch = async (request: Request): Promise<Response> => await this.#fetch(request);
}

class InterruptedApplicationHttpTransport implements MobiusHttpTransport {
    readonly #fetchApplication: (request: Request) => Promise<Response>;
    #hasInterrupted = false;
    readonly interrupted: Promise<void>;
    #resolveInterruption = (): void => {};
    #streamRequestCount = 0;

    constructor(fetchApplication: (request: Request) => Promise<Response>) {
        this.#fetchApplication = fetchApplication;
        this.interrupted = new Promise<void>((resolve) => {
            this.#resolveInterruption = resolve;
        });
    }

    get streamRequestCount(): number {
        return this.#streamRequestCount;
    }

    readonly fetch = async (request: Request): Promise<Response> => {
        const response = await this.#fetchApplication(request);
        if (request.headers.get("accept") === "text/event-stream") {
            this.#streamRequestCount += 1;
        }
        if (
            request.headers.get("accept") !== "text/event-stream" ||
            this.#hasInterrupted ||
            !response.ok ||
            response.body === null
        ) {
            return response;
        }
        this.#hasInterrupted = true;
        const reader = response.body.getReader();
        const interrupted = new ReadableStream<Uint8Array>({
            cancel: async (reason) => {
                await reader.cancel(reason);
            },
            pull: async (controller) => {
                const result = await reader.read();
                if (!result.done) {
                    controller.enqueue(result.value);
                }
                await reader.cancel(new Error("The test connection was interrupted"));
                controller.close();
                this.#resolveInterruption();
            },
        });
        return new Response(interrupted, {
            headers: response.headers,
            status: response.status,
            statusText: response.statusText,
        });
    };
}

function prompt(sessionId: string): SessionPromptCommand {
    return {
        additionalDirectoryIds: [],
        agentId: "codex",
        bindingId: "workspace",
        commandId: "node-command",
        directoryId: "root",
        images: [
            {
                data: "aW1hZ2UtYnl0ZXM=",
                mimeType: "image/png",
                name: "diagram.png",
            },
        ],
        kind: SESSION_PROMPT_KIND,
        prompt: "inspect the Node deployment",
        resources: [
            {
                mimeType: "text/plain",
                name: "notes.txt",
                text: "retained attachment",
                type: "embedded",
                uri: "file:///notes.txt",
            },
        ],
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

function authorized(path: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return new Request(`https://node.relay.test${path}`, { ...init, headers });
}

async function createSession(relay: NodeRelay, sessionId: string): Promise<Response> {
    return await relay.fetch(
        authorized(`${MOBIUS_API_PREFIX}/projects/${scope.projectId}/sessions`, {
            body: JSON.stringify({
                agentId: "codex",
                bindingId: "workspace",
                directoryId: "root",
                policy: {
                    contentLimitBytes: 100_000,
                    hotEventLimit: 10,
                    idempotencyRetentionMilliseconds: 86_400_000,
                    level: "full",
                    retentionMilliseconds: 86_400_000,
                },
                runtimeId: "runtime-node",
                sessionId,
                title: `Node ${sessionId}`,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
    );
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixedTime);
});

afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("Node public Relay API", () => {
    it("Given a configured public endpoint, When an integrator discovers capabilities, Then it declares the versioned Session event transport", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-node-capabilities-"));
        createdDirectories.push(directory);
        const sessionRuntime = new NodeSessionRuntime(join(directory, "relay.sqlite"), join(directory, "content"));
        const application = createMobiusApplication({
            channelRuntime: new InertChannelRuntime(),
            pairingDirectory: new ScopedPairingDirectory(),
            sessionRuntime,
        }).resolve("application");

        try {
            const response = await application.fetch(authorized(`${MOBIUS_API_PREFIX}/capabilities`));

            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toEqual({
                apiVersion: "1",
                artifacts: {
                    downloadTransport: "authorized-stream",
                    uploadProtocol: "two-stage",
                },
                authentication: {
                    browserCredentials: true,
                    maximumBrowserCredentialLifetimeSeconds: 3_600,
                    minimumBrowserCredentialLifetimeSeconds: 60,
                },
                portability: {
                    exportFormatVersion: "1",
                    nativeContextImport: false,
                    targetBindingRequired: true,
                },
                resources: {
                    artifacts: true,
                    attempts: true,
                    browserCredentials: true,
                    events: true,
                    interactions: true,
                    messages: true,
                    portability: true,
                    runtimes: true,
                    sessions: true,
                    toolCalls: true,
                    turns: true,
                },
                sessionEvents: {
                    eventName: "mobius.session-event.v1",
                    formatVersion: "1",
                    mediaType: "text/event-stream",
                    transport: "sse",
                },
            });
        } finally {
            sessionRuntime.close();
        }
    });

    it("Given an authorized Node Runtime and service endpoint, When the SDK creates a Session, submits a Turn, and subscribes, Then it receives tool and terminal events and can query the same history", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-node-sdk-"));
        createdDirectories.push(directory);
        const sessionRuntime = new NodeSessionRuntime(join(directory, "relay.sqlite"), join(directory, "content"));
        const application = createMobiusApplication({
            channelRuntime: new ExecutingChannelRuntime(sessionRuntime),
            pairingDirectory: new ScopedPairingDirectory(),
            sessionRuntime,
        }).resolve("application");
        const client = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider(token),
            endpoint: "https://node.relay.test",
            projectId: scope.projectId,
            transport: new ApplicationHttpTransport(async (request) => await application.fetch(request)),
        });
        const controller = new AbortController();
        const receivedEvents: MobiusSessionEvent[] = [];

        try {
            await expect(client.capabilities.read(controller.signal)).resolves.toMatchObject({
                apiVersion: "1",
                artifacts: { uploadProtocol: "two-stage" },
                portability: {
                    nativeContextImport: false,
                    targetBindingRequired: true,
                },
                resources: {
                    artifacts: true,
                    interactions: true,
                    runtimes: true,
                },
                sessionEvents: { transport: "sse" },
            });
            await expect(client.runtimes.list(controller.signal)).resolves.toEqual([
                expect.objectContaining({
                    agents: [
                        expect.objectContaining({
                            capabilities: verifiedAgentCapabilities,
                            id: "codex",
                        }),
                    ],
                    online: true,
                    runtimeId: "runtime-node",
                }),
            ]);
            const session = await client.sessions.create(
                {
                    agentId: "codex",
                    bindingId: "workspace",
                    directoryId: "root",
                    policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000, 60_000),
                    runtimeId: "runtime-node",
                    sessionId: "sdk-session",
                    title: "SDK session",
                },
                controller.signal,
            );
            expect(session.policy.idempotencyRetentionMilliseconds).toBe(60_000);
            const configured = await client.sessions.configure(
                session.sessionId,
                {
                    agentRef: "codex",
                    bindingId: "workspace-v2",
                    configRevision: 2,
                    runtimeId: "runtime-node",
                    workspaceRef: "root",
                },
                controller.signal,
            );
            expect(configured.defaultBinding.bindingId).toBe("workspace-v2");
            const subscription = await client.events.subscribe(
                session.sessionId,
                "",
                {
                    receive: async (event) => {
                        receivedEvents.push(event);
                        return !(event.payload instanceof MobiusTurnCompletedEvent);
                    },
                },
                controller.signal,
            );

            const submitted = await client.turns.submit(
                session.sessionId,
                {
                    additionalDirectoryIds: [],
                    artifactIds: [],
                    content: "Inspect the Node deployment",
                    idempotencyKey: "sdk-command",
                    images: [],
                    resources: [],
                },
                controller.signal,
            );
            await subscription.completed;

            expect(submitted.idempotencyKey).toBe("sdk-command");
            expect(submitted.bindingId).toBe("workspace-v2");
            expect(receivedEvents.some((event) => event.payload instanceof MobiusAgentActivityEvent)).toBe(true);
            expect(receivedEvents.some((event) => event.payload instanceof MobiusTurnCompletedEvent)).toBe(true);
            const completed = await client.turns.read(session.sessionId, submitted.turnId, controller.signal);
            expect(completed.state).toBeInstanceOf(MobiusSucceededTurnState);
            const messages = await client.sessions.readMessages(
                session.sessionId,
                new MobiusPageRequest(10, ""),
                controller.signal,
            );
            expect(messages.messages).toHaveLength(1);
            expect(messages.messages[0]).toMatchObject({
                prompt: "Inspect the Node deployment",
                response: "Node SDK response",
            });
            expect(messages.messages[0]?.activities[0]).toMatchObject({
                title: "Inspect workspace",
            });
            await expect(
                client.attempts.read(session.sessionId, "attempt-sdk-command", controller.signal),
            ).resolves.toMatchObject({ state: { kind: "succeeded" } });
            const eventPage = await client.events.list(
                session.sessionId,
                new MobiusPageRequest(2, ""),
                controller.signal,
            );
            expect(eventPage.events).toHaveLength(2);
            expect(eventPage.hasMore).toBe(true);
            await expect(
                client.toolCalls.readDetail(
                    session.sessionId,
                    "attempt-sdk-command",
                    "activity-sdk-command",
                    controller.signal,
                ),
            ).resolves.toMatchObject({
                kind: "available",
                output: "inspected from the public SDK",
            });
        } finally {
            client.close();
            sessionRuntime.close();
        }
    });

    it("Given an accepted Turn and a consumed event cursor, When the SDK connection is interrupted, Then it resumes without duplicating the Turn and rejects an invalid recovery cursor explicitly", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(fixedTime);
        const directory = await mkdtemp(join(tmpdir(), "mobius-node-recovery-"));
        createdDirectories.push(directory);
        const sessionRuntime = new NodeSessionRuntime(join(directory, "relay.sqlite"), join(directory, "content"));
        const application = createMobiusApplication({
            channelRuntime: new ExecutingChannelRuntime(sessionRuntime),
            pairingDirectory: new ScopedPairingDirectory(),
            sessionRuntime,
        }).resolve("application");
        const transport = new InterruptedApplicationHttpTransport(async (request) => await application.fetch(request));
        const client = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider(token),
            endpoint: "https://node.relay.test",
            projectId: scope.projectId,
            transport,
        });
        const controller = new AbortController();
        const receivedEvents: MobiusSessionEvent[] = [];

        try {
            const session = await client.sessions.create(
                {
                    agentId: "codex",
                    bindingId: "workspace",
                    directoryId: "root",
                    policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                    runtimeId: "runtime-node",
                    sessionId: "sdk-recovery-session",
                    title: "SDK recovery session",
                },
                controller.signal,
            );
            const subscription = await client.events.subscribe(
                session.sessionId,
                "",
                {
                    receive: async (event) => {
                        receivedEvents.push(event);
                        return !(event.payload instanceof MobiusTurnCompletedEvent);
                    },
                },
                controller.signal,
            );
            const submitted = await client.turns.submit(
                session.sessionId,
                {
                    additionalDirectoryIds: [],
                    artifactIds: [],
                    content: "Recover the event stream",
                    idempotencyKey: "sdk-recovery-command",
                    images: [],
                    resources: [],
                },
                controller.signal,
            );

            await transport.interrupted;
            await vi.advanceTimersByTimeAsync(250);
            await subscription.completed;
            const duplicate = await client.turns.submit(
                session.sessionId,
                {
                    additionalDirectoryIds: [],
                    artifactIds: [],
                    content: "Recover the event stream",
                    idempotencyKey: "sdk-recovery-command",
                    images: [],
                    resources: [],
                },
                controller.signal,
            );

            expect(duplicate.turnId).toBe(submitted.turnId);
            expect(transport.streamRequestCount).toBe(2);
            expect(receivedEvents.map((event) => event.sequence)).toEqual(["1", "2", "3", "4"]);
            expect(new Set(receivedEvents.map((event) => event.eventId)).size).toBe(receivedEvents.length);
            try {
                await client.events.subscribe(
                    session.sessionId,
                    "not-a-valid-cursor!",
                    { receive: async () => false },
                    controller.signal,
                );
                throw new Error("The invalid event cursor was accepted");
            } catch (error) {
                expect(error).toBeInstanceOf(MobiusApiError);
                if (!(error instanceof MobiusApiError)) {
                    throw error;
                }
                expect(error).toMatchObject({ code: "invalid_cursor", status: 400 });
            }
        } finally {
            client.close();
            sessionRuntime.close();
        }
    });

    it("Given an authorized Session, When the SDK obtains bounded upload authorization and transfers an attachment, Then the Turn carries only a validated artifact reference and the bytes can be downloaded", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-node-artifact-"));
        createdDirectories.push(directory);
        const sessionRuntime = new NodeSessionRuntime(join(directory, "relay.sqlite"), join(directory, "content"));
        const channelRuntime = new CapturingChannelRuntime(sessionRuntime);
        const application = createMobiusApplication({
            channelRuntime,
            pairingDirectory: new ScopedPairingDirectory(),
            sessionRuntime,
        }).resolve("application");
        const client = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider(token),
            endpoint: "https://node.relay.test",
            projectId: scope.projectId,
            transport: new ApplicationHttpTransport(async (request) => await application.fetch(request)),
        });
        const signal = new AbortController().signal;
        const bytes = new TextEncoder().encode("attachment content from the SDK");
        const digest = createHash("sha256").update(bytes).digest("hex");

        try {
            const session = await client.sessions.create(
                {
                    agentId: "codex",
                    bindingId: "workspace",
                    directoryId: "root",
                    policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                    runtimeId: "runtime-node",
                    sessionId: "sdk-artifact-session",
                    title: "SDK artifact session",
                },
                signal,
            );
            const upload = await client.artifacts.createUpload(
                session.sessionId,
                new MobiusArtifactUploadRequest("context.txt", "text/plain", bytes.byteLength, digest),
                signal,
            );
            expect(upload).toMatchObject({
                byteLength: bytes.byteLength,
                name: "context.txt",
                state: "uploading",
            });
            const available = await client.artifacts.uploadContent(session.sessionId, upload, bytes, signal);
            expect(available).toMatchObject({
                artifactId: upload.artifactId,
                state: "available",
            });
            const downloaded = await client.artifacts.download(session.sessionId, upload.artifactId, signal);
            expect(downloaded.artifact).toMatchObject({
                artifactId: upload.artifactId,
                sha256: digest,
            });
            expect(downloaded.bytes).toEqual(bytes);

            await client.turns.submit(
                session.sessionId,
                {
                    additionalDirectoryIds: [],
                    artifactIds: [upload.artifactId],
                    content: "Use the uploaded context",
                    idempotencyKey: "sdk-artifact-command",
                    images: [],
                    resources: [],
                },
                signal,
            );
            const delivered = decodeSessionPromptCommand(channelRuntime.deliveredPayloads[0] ?? "");
            expect(delivered.images).toEqual([]);
            expect(delivered.resources).toEqual([
                {
                    mimeType: "text/plain",
                    name: "context.txt",
                    text: "",
                    type: "link",
                    uri: `mobius-artifact:${upload.artifactId}?byteLength=${bytes.byteLength.toString()}&sha256=${digest}`,
                },
            ]);
            expect(channelRuntime.deliveredPayloads[0]?.includes("attachment content")).toBe(false);
        } finally {
            client.close();
            sessionRuntime.close();
        }
    });

    it("Given a running Turn, When a caller aborts a query, closes a subscription, and then requests remote cancellation, Then only the explicit cancellation reaches the Runtime and terminates the Turn", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-node-cancel-"));
        createdDirectories.push(directory);
        const sessionRuntime = new NodeSessionRuntime(join(directory, "relay.sqlite"), join(directory, "content"));
        const channelRuntime = new CapturingChannelRuntime(sessionRuntime);
        const application = createMobiusApplication({
            channelRuntime,
            pairingDirectory: new ScopedPairingDirectory(),
            sessionRuntime,
        }).resolve("application");
        const client = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider(token),
            endpoint: "https://node.relay.test",
            projectId: scope.projectId,
            transport: new ApplicationHttpTransport(async (request) => await application.fetch(request)),
        });
        const signal = new AbortController().signal;

        try {
            const session = await client.sessions.create(
                {
                    agentId: "codex",
                    bindingId: "workspace",
                    directoryId: "root",
                    policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                    runtimeId: "runtime-node",
                    sessionId: "sdk-cancel-session",
                    title: "SDK cancellation session",
                },
                signal,
            );
            const submitted = await client.turns.submit(
                session.sessionId,
                {
                    additionalDirectoryIds: [],
                    artifactIds: [],
                    content: "Keep working until explicitly cancelled",
                    idempotencyKey: "sdk-cancel-command",
                    images: [],
                    resources: [],
                },
                signal,
            );
            const attemptId = "attempt-sdk-cancel-command";
            await sessionRuntime.commitEvent(
                scope,
                "runtime-node",
                envelope(session.sessionId, "cancel-started", {
                    attemptId,
                    commandId: submitted.idempotencyKey,
                    kind: SESSION_STARTED_KIND,
                    sessionId: session.sessionId,
                }),
                fixedTime + 1,
                signal,
            );

            const subscription = await client.events.subscribe(
                session.sessionId,
                "",
                { receive: async () => true },
                signal,
            );
            const locallyCancelled = new AbortController();
            locallyCancelled.abort(new Error("The caller stopped waiting"));
            await expect(
                client.turns.read(session.sessionId, submitted.turnId, locallyCancelled.signal),
            ).rejects.toBeInstanceOf(MobiusCancellationError);
            expect((await client.turns.read(session.sessionId, submitted.turnId, signal)).state).toBeInstanceOf(
                MobiusRunningTurnState,
            );

            subscription.close();
            await subscription.completed;
            expect(channelRuntime.deliveredPayloads).toHaveLength(1);
            expect((await client.turns.read(session.sessionId, submitted.turnId, signal)).state).toBeInstanceOf(
                MobiusRunningTurnState,
            );

            await client.turns.cancel(
                session.sessionId,
                submitted.turnId,
                { idempotencyKey: "sdk-cancel-request" },
                signal,
            );
            await client.turns.cancel(
                session.sessionId,
                submitted.turnId,
                { idempotencyKey: "sdk-cancel-request" },
                signal,
            );
            expect(channelRuntime.deliveredPayloads).toHaveLength(2);
            expect(decodeSessionCancelCommand(channelRuntime.deliveredPayloads[1] ?? "")).toEqual({
                commandId: submitted.idempotencyKey,
                kind: "session.cancel",
                sessionId: session.sessionId,
            });

            await sessionRuntime.commitEvent(
                scope,
                "runtime-node",
                envelope(session.sessionId, "cancel-completed", {
                    commandId: submitted.idempotencyKey,
                    kind: SESSION_COMPLETED_KIND,
                    sessionId: session.sessionId,
                    stopReason: "cancelled",
                }),
                fixedTime + 2,
                signal,
            );
            expect((await client.turns.read(session.sessionId, submitted.turnId, signal)).state).toBeInstanceOf(
                MobiusCancelledTurnState,
            );
        } finally {
            client.close();
            sessionRuntime.close();
        }
    });

    it("Given a Runtime requests permission, When the SDK lists, reads, and responds to the Interaction, Then the authorized response is persisted and delivered exactly once", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-node-interaction-"));
        createdDirectories.push(directory);
        const sessionRuntime = new NodeSessionRuntime(join(directory, "relay.sqlite"), join(directory, "content"));
        const channelRuntime = new CapturingChannelRuntime(sessionRuntime);
        const application = createMobiusApplication({
            channelRuntime,
            pairingDirectory: new ScopedPairingDirectory(),
            sessionRuntime,
        }).resolve("application");
        const client = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider(token),
            endpoint: "https://node.relay.test",
            projectId: scope.projectId,
            transport: new ApplicationHttpTransport(async (request) => await application.fetch(request)),
        });
        const signal = new AbortController().signal;

        try {
            const session = await client.sessions.create(
                {
                    agentId: "codex",
                    bindingId: "workspace",
                    directoryId: "root",
                    policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                    runtimeId: "runtime-node",
                    sessionId: "sdk-interaction-session",
                    title: "SDK Interaction session",
                },
                signal,
            );
            const submitted = await client.turns.submit(
                session.sessionId,
                {
                    additionalDirectoryIds: [],
                    artifactIds: [],
                    content: "Ask before writing",
                    idempotencyKey: "sdk-interaction-command",
                    images: [],
                    resources: [],
                },
                signal,
            );
            const attemptId = "attempt-sdk-interaction-command";
            await sessionRuntime.commitEvent(
                scope,
                "runtime-node",
                envelope(session.sessionId, "interaction-started", {
                    attemptId,
                    commandId: submitted.idempotencyKey,
                    kind: SESSION_STARTED_KIND,
                    sessionId: session.sessionId,
                }),
                fixedTime + 1,
                signal,
            );
            await sessionRuntime.commitEvent(
                scope,
                "runtime-node",
                envelope(session.sessionId, "permission-requested", {
                    commandId: submitted.idempotencyKey,
                    interactionId: "permission-sdk-interaction",
                    kind: SESSION_PERMISSION_REQUESTED_KIND,
                    options: [{ kind: "allow_once", name: "Allow once", optionId: "approve" }],
                    sessionId: session.sessionId,
                    title: "Write the generated file?",
                    toolCallId: "write-file",
                    toolKind: "edit",
                }),
                fixedTime + 2,
                signal,
            );

            const pending = await client.interactions.listPending(session.sessionId, signal);
            expect(pending).toHaveLength(1);
            expect(pending[0]).toMatchObject({
                interactionId: "permission-sdk-interaction",
                request: { kind: "permission", title: "Write the generated file?" },
                state: { kind: "pending" },
            });
            await expect(
                client.interactions.read(session.sessionId, "permission-sdk-interaction", signal),
            ).resolves.toMatchObject({ attemptId, turnId: submitted.turnId });

            const response = new MobiusPermissionResponseRequest("browser-user", "selected", "approve");
            await client.interactions.respond(session.sessionId, "permission-sdk-interaction", response, signal);
            await client.interactions.respond(session.sessionId, "permission-sdk-interaction", response, signal);

            expect(channelRuntime.deliveredPayloads).toHaveLength(2);
            expect(decodeSessionPermissionRespondCommand(channelRuntime.deliveredPayloads[1] ?? "")).toEqual({
                interactionId: "permission-sdk-interaction",
                kind: "session.permission.respond",
                optionId: "approve",
                outcome: "selected",
                sessionId: session.sessionId,
            });
            await expect(
                client.interactions.read(session.sessionId, "permission-sdk-interaction", signal),
            ).resolves.toMatchObject({
                state: {
                    kind: "responded",
                    responderId: "browser-user",
                    response: { kind: "permission" },
                },
            });
        } finally {
            client.close();
            sessionRuntime.close();
        }
    });

    it("Given a host-provided API prefix, When the host resolves the application, Then it serves Relay requests below that prefix", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-node-application-"));
        createdDirectories.push(directory);
        const sessionRuntime = new NodeSessionRuntime(join(directory, "relay.sqlite"), join(directory, "content"));
        const injector = createMobiusApplication(
            {
                channelRuntime: new InertChannelRuntime(),
                pairingDirectory: new ScopedPairingDirectory(),
                sessionRuntime,
            },
            "/configured/api",
        );
        const application = injector.resolve("application");

        const response = await application.fetch(new Request("https://node.relay.test/configured/api/health"));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            service: "mobius-relay",
            status: "ok",
        });
        expect(
            (await application.fetch(new Request(`https://node.relay.test${MOBIUS_API_PREFIX}/health`))).status,
        ).toBe(404);
        sessionRuntime.close();
    });

    it("Given a completed Session export with uploaded content from one Node deployment, When another deployment imports it through the SDK, Then it restores history and content before deleting the imported Session", async () => {
        const sourceDirectory = await mkdtemp(join(tmpdir(), "mobius-export-"));
        const targetDirectory = await mkdtemp(join(tmpdir(), "mobius-import-"));
        createdDirectories.push(sourceDirectory, targetDirectory);
        const sourceRuntime = new NodeSessionRuntime(
            join(sourceDirectory, "relay.sqlite"),
            join(sourceDirectory, "content"),
        );
        const targetRuntime = new NodeSessionRuntime(
            join(targetDirectory, "relay.sqlite"),
            join(targetDirectory, "content"),
        );
        const sourceApplication = createMobiusApplication({
            channelRuntime: new ExecutingChannelRuntime(sourceRuntime),
            pairingDirectory: new ScopedPairingDirectory(),
            sessionRuntime: sourceRuntime,
        }).resolve("application");
        const targetApplication = createMobiusApplication({
            channelRuntime: new InertChannelRuntime(),
            pairingDirectory: new ScopedPairingDirectory(),
            sessionRuntime: targetRuntime,
        }).resolve("application");
        const sourceClient = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider(token),
            endpoint: "https://source.node.test",
            projectId: scope.projectId,
            transport: new ApplicationHttpTransport(async (request) => await sourceApplication.fetch(request)),
        });
        const targetClient = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider(token),
            endpoint: "https://target.node.test",
            projectId: scope.projectId,
            transport: new ApplicationHttpTransport(async (request) => await targetApplication.fetch(request)),
        });
        const signal = new AbortController().signal;

        try {
            const sourceSession = await sourceClient.sessions.create(
                {
                    agentId: "codex",
                    bindingId: "workspace",
                    directoryId: "root",
                    policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                    runtimeId: "runtime-node",
                    sessionId: "portable-sdk-session",
                    title: "Portable SDK session",
                },
                signal,
            );
            const sourceSubscription = await sourceClient.events.subscribe(
                sourceSession.sessionId,
                "",
                {
                    receive: async (event) => !(event.payload instanceof MobiusTurnCompletedEvent),
                },
                signal,
            );
            const attachmentBytes = new TextEncoder().encode("portable attachment content");
            const attachmentUpload = await sourceClient.artifacts.createUpload(
                sourceSession.sessionId,
                new MobiusArtifactUploadRequest(
                    "portable-context.txt",
                    "text/plain",
                    attachmentBytes.byteLength,
                    createHash("sha256").update(attachmentBytes).digest("hex"),
                ),
                signal,
            );
            await sourceClient.artifacts.uploadContent(
                sourceSession.sessionId,
                attachmentUpload,
                attachmentBytes,
                signal,
            );
            await sourceClient.turns.submit(
                sourceSession.sessionId,
                {
                    additionalDirectoryIds: [],
                    artifactIds: [],
                    content: "Preserve this history",
                    idempotencyKey: "portable-sdk-command",
                    images: [],
                    resources: [],
                },
                signal,
            );
            await sourceSubscription.completed;

            const exported = await sourceClient.sessions.export(sourceSession.sessionId, signal);
            expect(exported.formatVersion).toBe("1");
            const imported = await targetClient.sessions.import(
                exported,
                new MobiusSessionImportBinding("imported-workspace", "runtime-node", "codex", "root"),
                signal,
            );
            expect(imported.sessionId).toBe(sourceSession.sessionId);
            await expect(
                targetClient.sessions.readMessages(imported.sessionId, new MobiusPageRequest(10, ""), signal),
            ).resolves.toMatchObject({
                messages: [
                    {
                        prompt: "Preserve this history",
                        response: "Node SDK response",
                    },
                ],
            });
            await expect(
                targetClient.artifacts.download(imported.sessionId, attachmentUpload.artifactId, signal),
            ).resolves.toMatchObject({
                artifact: expect.objectContaining({
                    artifactId: attachmentUpload.artifactId,
                    name: "portable-context.txt",
                }),
                bytes: attachmentBytes,
            });
            await targetClient.sessions.delete(imported.sessionId, signal);
            await expect(targetClient.sessions.read(imported.sessionId, signal)).rejects.toMatchObject({
                code: "session_deleted",
                status: 410,
            });
        } finally {
            sourceClient.close();
            targetClient.close();
            sourceRuntime.close();
            targetRuntime.close();
        }
    });

    it("Given an invalid API prefix, When the host configures the application, Then it rejects the configuration before serving requests", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-node-application-"));
        createdDirectories.push(directory);
        const sessionRuntime = new NodeSessionRuntime(join(directory, "relay.sqlite"), join(directory, "content"));
        expect(() =>
            createMobiusApplication(
                {
                    channelRuntime: new InertChannelRuntime(),
                    pairingDirectory: new ScopedPairingDirectory(),
                    sessionRuntime,
                },
                "configured/api",
            ),
        ).toThrowError(MobiusApiConfigurationError);
        sessionRuntime.close();
    });

    it("Given the shared public API scenario, When it uses SQLite and filesystem storage, Then pagination, catch-up, archives, authorization, and lifecycle errors match the cloud contract", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-node-relay-"));
        createdDirectories.push(directory);
        const relay = createNodeRelay({
            channelRuntime: new InertChannelRuntime(),
            contentRoot: join(directory, "content"),
            databasePath: join(directory, "relay.sqlite"),
            pairingDirectory: new ScopedPairingDirectory(),
        });
        const signal = new AbortController().signal;
        const sessionId = "node-session-a";
        expect((await createSession(relay, sessionId)).status).toBe(201);
        expect((await createSession(relay, "node-session-b")).status).toBe(201);

        const command = prompt(sessionId);
        await relay.sessionRuntime.acceptTurn(scope, "runtime-node", command, fixedTime + 1, signal);
        const events: readonly SessionEventEnvelope[] = [
            envelope(sessionId, "node-started", {
                commandId: command.commandId,
                kind: SESSION_STARTED_KIND,
                attemptId: "node-attempt",
                sessionId,
            }),
            envelope(sessionId, "node-activity", {
                activityId: "node-activity",
                activityType: "tool",
                commandId: command.commandId,
                content: [],
                detail: {
                    content: [],
                    input: "{}",
                    kind: "recorded",
                    output: `begin-${"x".repeat(30_000)}-end`,
                },
                input: "{}",
                kind: AGENT_ACTIVITY_KIND,
                locations: [],
                name: "terminal",
                output: "Full output is available on demand",
                sequence: 0,
                sessionId,
                status: "completed",
                title: "Run command",
                toolKind: "execute",
            }),
            envelope(sessionId, "node-delta", {
                commandId: command.commandId,
                kind: AGENT_MESSAGE_DELTA_KIND,
                sessionId,
                text: "Node response",
            }),
            envelope(sessionId, "node-completed", {
                commandId: command.commandId,
                kind: SESSION_COMPLETED_KIND,
                sessionId,
                stopReason: "end_turn",
            }),
        ];
        for (const [index, event] of events.entries()) {
            await relay.sessionRuntime.commitEvent(scope, "runtime-node", event, fixedTime + index + 2, signal);
        }
        await relay.sessionRuntime.runArchiveWork(scope, sessionId, signal);

        const directoryPage = await relay.fetch(
            authorized(`${MOBIUS_API_PREFIX}/projects/${scope.projectId}/sessions?limit=1`),
        );
        await expect(directoryPage.json()).resolves.toMatchObject({
            nextCursor: expect.any(String),
            sessions: [{ sessionId: "node-session-a" }],
        });
        const messages = await relay.fetch(
            authorized(`${MOBIUS_API_PREFIX}/projects/${scope.projectId}/sessions/${sessionId}/messages?limit=1`),
        );
        await expect(messages.json()).resolves.toMatchObject({
            messages: [
                {
                    commandId: command.commandId,
                    images: command.images,
                    resources: command.resources,
                    response: "Node response",
                },
            ],
            nextCursor: null,
        });

        const firstEvents = await relay.fetch(
            authorized(`${MOBIUS_API_PREFIX}/projects/${scope.projectId}/sessions/${sessionId}/events?limit=1`),
        );
        const firstPage: unknown = await firstEvents.json();
        expect(firstPage).toMatchObject({
            events: [{ eventId: "node-started" }],
            hasMore: true,
        });
        if (
            typeof firstPage !== "object" ||
            firstPage === null ||
            !("cursor" in firstPage) ||
            typeof firstPage.cursor !== "string"
        ) {
            throw new Error("Expected an event cursor");
        }
        const catchup = await relay.fetch(
            authorized(
                `${MOBIUS_API_PREFIX}/projects/${scope.projectId}/sessions/${sessionId}/events?limit=10&cursor=${encodeURIComponent(firstPage.cursor)}`,
            ),
        );
        await expect(catchup.json()).resolves.toMatchObject({
            events: [{ eventId: "node-activity" }, { eventId: "node-delta" }, { eventId: "node-completed" }],
            hasMore: false,
        });
        const detail = await relay.fetch(
            authorized(
                `${MOBIUS_API_PREFIX}/projects/${scope.projectId}/sessions/${sessionId}/attempts/node-attempt/tool-calls/node-activity`,
            ),
        );
        await expect(detail.json()).resolves.toMatchObject({
            kind: "available",
            output: `begin-${"x".repeat(30_000)}-end`,
            storage: "archive",
        });

        const unauthorized = await relay.fetch(
            new Request(`https://node.relay.test${MOBIUS_API_PREFIX}/projects/${scope.projectId}/sessions`, {
                headers: { authorization: `Bearer ${"z".repeat(32)}` },
            }),
        );
        expect(unauthorized.status).toBe(401);
        const invalidCursor = await relay.fetch(
            authorized(`${MOBIUS_API_PREFIX}/projects/${scope.projectId}/sessions/${sessionId}/events?cursor=invalid`),
        );
        expect(invalidCursor.status).toBe(400);
        await expect(invalidCursor.json()).resolves.toMatchObject({
            error: { code: "invalid_cursor" },
        });
        const oversizedBody = await relay.fetch(
            authorized(`${MOBIUS_API_PREFIX}/projects/${scope.projectId}/sessions`, {
                body: JSON.stringify({ padding: "😀".repeat(5_000) }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
        expect(oversizedBody.status).toBe(400);
        await expect(oversizedBody.json()).resolves.toMatchObject({
            error: {
                code: "invalid_request",
                message: "The request body is too large",
            },
        });

        const deleted = await relay.fetch(
            authorized(`${MOBIUS_API_PREFIX}/projects/${scope.projectId}/sessions/${sessionId}`, {
                method: "DELETE",
            }),
        );
        expect(deleted.status).toBe(200);
        const afterDelete = await relay.fetch(
            authorized(`${MOBIUS_API_PREFIX}/projects/${scope.projectId}/sessions/${sessionId}/messages`),
        );
        expect(afterDelete.status).toBe(410);
        relay.close();
    });
});
