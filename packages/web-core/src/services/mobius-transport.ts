import {
    decodeAgentContentEvent,
    decodeSessionElicitationRequestedEvent,
    decodeSessionElicitationResolvedEvent,
    decodeSessionPermissionRequestedEvent,
    decodeSessionPermissionResolvedEvent,
    MobiusAgentActivityEvent,
    MobiusAgentMessageEvent,
    MobiusApiError,
    MobiusArtifactUploadRequest,
    MobiusAttemptEventSource,
    type MobiusBrowserCredential,
    MobiusBrowserCredentialRequest,
    MobiusCancelledTurnState,
    MobiusClient,
    MobiusControlEvent,
    MobiusElicitationResponseRequest,
    MobiusError,
    MobiusFailedTurnState,
    MobiusIndeterminateTurnState,
    MobiusPermissionResponseRequest,
    MobiusRecordingPolicy,
    type MobiusSession,
    MobiusSucceededTurnState,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
    MobiusTurnStartedEvent,
    mobiusApiUrl,
    type NativeSessionCommand,
    type NativeSessionResult,
    type PromptResource,
    type SessionConfigOption,
    type SessionConfigUpdatedEvent,
    type SessionReadyEvent,
    StaticMobiusCredentialProvider,
    type WorkspaceEntriesEvent,
} from "@moxt-ai/mobius-sdk";
import {
    type AgentInstallCancelRequest,
    type AgentInstallRequest,
    type CancelRequest,
    connectMobiusChannelClient,
    type ElicitationResponseRequest,
    type MobiusChannelClient,
    MobiusChannelError,
    type PermissionResponseRequest,
    type PromptRequest,
    type PromptResult,
    type SessionConfigureRequest,
    type SessionPrepareRequest,
    type WorkspaceListRequest,
} from "@moxt-ai/mobius-sdk/channel";
import { type ChannelConnection, RecordedActivity, RequestedAgentInstallationState } from "@/domain/channel";
import { DeletedSessionState, OfflineRuntimeState, OnlineRuntimeState, UnavailableRuntimeState } from "@/domain/chat";
import { readChannelConnection } from "@/services/pairing-api";
import { readSessionConfigPreferences, saveSessionConfigPreferences } from "@/services/session-config-preferences";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

function createRelayUrl(connection: ChannelConnection): string {
    const relayUrl = mobiusApiUrl(window.location.origin, `/channels/${encodeURIComponent(connection.channelId)}/host`);
    relayUrl.searchParams.set("token", connection.hostToken);
    relayUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return relayUrl.toString();
}

function failureMessage(error: unknown): string {
    const failure = boundaryFailure(error);
    return `${failure.code}: ${failure.message}`;
}

function isInterruptedChannelOperation(error: unknown): boolean {
    return (
        error instanceof MobiusChannelError && (error.code === "connection_closed" || error.code === "runtime_offline")
    );
}

function sessionConfigurationPriority(category: string): number {
    if (category === "model") {
        return 0;
    }
    if (category === "thought_level") {
        return 1;
    }
    if (category === "model_config") {
        return 2;
    }
    return 3;
}

interface BoundaryFailure {
    readonly code: string;
    readonly message: string;
}

function boundaryFailure(error: unknown): BoundaryFailure {
    return error instanceof MobiusChannelError || error instanceof MobiusError
        ? { code: error.code, message: error.message }
        : {
              code: "unexpected_error",
              message: "The request failed unexpectedly",
          };
}

const BROWSER_CREDENTIAL_LIFETIME_SECONDS = 5 * 60;
const BROWSER_CREDENTIAL_REFRESH_WINDOW_MILLISECONDS = 30_000;
const PUBLIC_SESSION_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const PUBLIC_SESSION_CONTENT_LIMIT_BYTES = 6_000_000;

class RefreshingBrowserCredentialProvider {
    readonly #owner: MobiusClient;
    #credential: MobiusBrowserCredential;

    constructor(owner: MobiusClient, credential: MobiusBrowserCredential) {
        this.#credential = credential;
        this.#owner = owner;
    }

    readonly credential = async (signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        if (Date.parse(this.#credential.expiresAt) - Date.now() <= BROWSER_CREDENTIAL_REFRESH_WINDOW_MILLISECONDS) {
            this.#credential = await this.#owner.credentials.issue(
                new MobiusBrowserCredentialRequest(BROWSER_CREDENTIAL_LIFETIME_SECONDS),
                signal,
            );
        }
        signal.throwIfAborted();
        return this.#credential.token;
    };
}

class BrowserServiceClients {
    readonly owner: MobiusClient;
    readonly scoped: MobiusClient;

    constructor(owner: MobiusClient, scoped: MobiusClient) {
        this.owner = owner;
        this.scoped = scoped;
    }

    readonly close = (): void => {
        this.scoped.close();
        this.owner.close();
    };
}

class UploadedPromptAttachments {
    readonly artifactIds: readonly string[];
    readonly resources: PromptRequest["resources"];

    constructor(artifactIds: readonly string[], resources: PromptRequest["resources"]) {
        this.artifactIds = artifactIds;
        this.resources = resources;
    }
}

function decodeImageBytes(data: string): Uint8Array {
    let binary: string;
    try {
        binary = atob(data);
    } catch (cause) {
        throw new MobiusChannelError("attachment_encoding_invalid", "The image attachment is not valid base64", {
            cause,
        });
    }
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
    signal.throwIfAborted();
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function connectBrowserServiceClients(connection: ChannelConnection): Promise<BrowserServiceClients> {
    const owner = new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider(connection.hostToken),
        endpoint: window.location.origin,
        projectId: connection.projectId,
    });
    const signal = AbortSignal.timeout(20_000);
    try {
        const credential = await owner.credentials.issue(
            new MobiusBrowserCredentialRequest(BROWSER_CREDENTIAL_LIFETIME_SECONDS),
            signal,
        );
        return new BrowserServiceClients(
            owner,
            new MobiusClient({
                credentialProvider: new RefreshingBrowserCredentialProvider(owner, credential),
                endpoint: window.location.origin,
                projectId: connection.projectId,
            }),
        );
    } catch (error) {
        owner.close();
        throw error;
    }
}

abstract class TransportConnection {
    abstract readonly nativeSession: (
        command: NativeSessionCommand,
        signal: AbortSignal,
    ) => Promise<NativeSessionResult>;
    abstract readonly cancelAgentInstallation: (request: AgentInstallCancelRequest) => Promise<void>;
    abstract readonly cancel: (request: CancelRequest) => Promise<void>;
    abstract readonly close: () => Promise<void>;
    abstract readonly configure: (
        request: SessionConfigureRequest,
        signal: AbortSignal,
    ) => Promise<SessionConfigUpdatedEvent>;
    abstract readonly elicit: (request: ElicitationResponseRequest) => Promise<void>;
    abstract readonly listWorkspace: (
        request: WorkspaceListRequest,
        signal: AbortSignal,
    ) => Promise<WorkspaceEntriesEvent>;
    abstract readonly permission: (request: PermissionResponseRequest) => Promise<void>;
    abstract readonly prepare: (request: SessionPrepareRequest, signal: AbortSignal) => Promise<SessionReadyEvent>;
    abstract readonly prompt: (request: PromptRequest) => Promise<PromptResult>;
    abstract readonly installAgent: (request: AgentInstallRequest) => Promise<void>;
}

class DisconnectedTransport extends TransportConnection {
    readonly nativeSession = (): Promise<NativeSessionResult> => this.notInitialized();
    readonly cancelAgentInstallation = (): Promise<void> => this.notInitialized();
    readonly cancel = (): Promise<void> =>
        Promise.reject(new MobiusChannelError("transport_not_initialized", "The channel transport is not initialized"));

    readonly close = (): Promise<void> => Promise.resolve();

    readonly configure = (): Promise<SessionConfigUpdatedEvent> => this.notInitialized();

    readonly elicit = (): Promise<void> => this.notInitialized();

    readonly listWorkspace = (): Promise<WorkspaceEntriesEvent> => this.notInitialized();

    readonly installAgent = (): Promise<void> => this.notInitialized();

    readonly permission = (): Promise<void> => this.notInitialized();

    readonly prepare = (): Promise<SessionReadyEvent> => this.notInitialized();

    readonly prompt = (): Promise<PromptResult> => this.notInitialized();

    private readonly notInitialized = <T>(): Promise<T> =>
        Promise.reject(new MobiusChannelError("transport_not_initialized", "The channel transport is not initialized"));
}

class ConnectedTransport extends TransportConnection {
    readonly #channelId: string;
    readonly #client: Promise<MobiusChannelClient>;
    readonly #connection: ChannelConnection;
    readonly #preparingRequestIds = new Set<string>();
    readonly #promptControllers = new Set<AbortController>();
    readonly #publicCommandIds = new Set<string>();
    readonly #serviceClients: Promise<BrowserServiceClients>;
    readonly #turnIds = new Map<string, string>();

    constructor(connection: ChannelConnection, onActivity: () => void) {
        super();
        this.#channelId = connection.channelId;
        this.#connection = connection;
        this.#serviceClients = connectBrowserServiceClients(connection);
        this.#client = connectMobiusChannelClient({
            onActivity,
            onCommands: (event) => {
                useChatStore.getState().applySessionCommands(event);
            },
            onConfig: (event) => {
                useChatStore.getState().applySessionConfig(event);
            },
            onContent: (event) => {
                if (!this.#publicCommandIds.has(event.commandId)) {
                    useChatStore.getState().recordAgentContent(event);
                }
            },
            onInstallCancelled: (event) => {
                useChatStore.getState().applyAgentInstallCancelled(event);
            },
            onInstallCompleted: (event) => {
                useChatStore.getState().applyAgentInstallCompleted(event);
                void this.#refreshAgentCatalog();
            },
            onInstallFailed: (event) => {
                useChatStore.getState().applyAgentInstallFailed(event);
                void this.#refreshAgentCatalog();
            },
            onInstallProgress: (event) => {
                useChatStore.getState().applyAgentInstallProgress(event);
            },
            onInstallStarted: (event) => {
                useChatStore.getState().applyAgentInstallStarted(event);
            },
            onElicitation: (event) => {
                if (!this.#publicCommandIds.has(event.commandId)) {
                    useChatStore.getState().applySessionElicitation(event);
                }
            },
            onElicitationResolved: (event) => {
                useChatStore.getState().resolveSessionElicitation(event);
            },
            onInfo: (event) => {
                useChatStore.getState().applySessionInfo(event);
            },
            onNativeSessionResult: (event) => {
                if (event.action === "delete") {
                    useChatStore.getState().applyNativeSessionDeletion(event.deletedSessionIds);
                }
            },
            onPermission: (event) => {
                if (!this.#publicCommandIds.has(event.commandId)) {
                    useChatStore.getState().applySessionPermission(event);
                }
            },
            onPermissionResolved: (event) => {
                useChatStore.getState().resolveSessionPermission(event.interactionId, event.sessionId);
            },
            onProtocolError: (error) => {
                useChatStore.getState().setErrorMessage(`${error.code}: ${error.message}`);
            },
            onStatus: (online) => {
                useChatStore.getState().setRuntime(online ? new OnlineRuntimeState() : new OfflineRuntimeState());
                if (online) {
                    void this.#refreshAgentCatalog();
                }
            },
            onReady: (event) => {
                if (!this.#preparingRequestIds.has(event.requestId)) {
                    useChatStore.getState().applySessionReady(event);
                }
            },
            onUsage: (event) => {
                useChatStore.getState().applySessionUsage(event);
            },
            relayUrl: createRelayUrl(connection),
        });

        void this.#client.catch((error: unknown) => {
            const store = useChatStore.getState();
            store.setRuntime(new UnavailableRuntimeState());
            store.setErrorMessage(failureMessage(error));
        });
        void this.#serviceClients.catch((error: unknown) => {
            useChatStore.getState().setErrorMessage(failureMessage(error));
        });
    }

    readonly close = async (): Promise<void> => {
        for (const controller of this.#promptControllers) {
            controller.abort(new Error("The Mobius transport closed"));
        }
        this.#promptControllers.clear();
        const channelClose = this.#client.then(
            (client) => client.close(),
            () => undefined,
        );
        const serviceClose = this.#serviceClients.then(
            (clients) => clients.close(),
            () => undefined,
        );
        await Promise.all([channelClose, serviceClose]);
    };

    readonly nativeSession = async (
        command: NativeSessionCommand,
        signal: AbortSignal,
    ): Promise<NativeSessionResult> => {
        signal.throwIfAborted();
        const client = await this.#client;
        signal.throwIfAborted();
        return await client.manageNativeSession(command, signal);
    };

    readonly cancel = async (request: CancelRequest): Promise<void> => {
        const clients = await this.#serviceClients;
        const turnId = this.#turnIds.get(this.turnKey(request.sessionId, request.commandId));
        if (turnId === undefined) {
            throw new MobiusChannelError("turn_not_found", "The active Turn is not available for cancellation");
        }
        await clients.scoped.turns.cancel(
            request.sessionId,
            turnId,
            { idempotencyKey: `cancel-${crypto.randomUUID()}` },
            AbortSignal.timeout(20_000),
        );
    };

    readonly cancelAgentInstallation = async (request: AgentInstallCancelRequest): Promise<void> => {
        const client = await this.#client;
        client.cancelAgentInstallation(request);
    };

    readonly configure = async (
        request: SessionConfigureRequest,
        signal: AbortSignal,
    ): Promise<SessionConfigUpdatedEvent> => {
        signal.throwIfAborted();
        const client = await this.#client;
        signal.throwIfAborted();
        const configured = await client.configureSession(request, signal);
        saveSessionConfigPreferences(this.#channelId, request.agentId, configured.configOptions);
        return configured;
    };

    readonly elicit = async (request: ElicitationResponseRequest): Promise<void> => {
        const clients = await this.#serviceClients;
        await clients.scoped.interactions.respond(
            request.sessionId,
            request.interactionId,
            new MobiusElicitationResponseRequest("mobius-web", request.action, request.content),
            AbortSignal.timeout(20_000),
        );
        useChatStore.getState().resolveSessionElicitation({
            action: request.action,
            interactionId: request.interactionId,
            kind: "session.elicitation.resolved",
            sessionId: request.sessionId,
        });
    };

    readonly listWorkspace = async (
        request: WorkspaceListRequest,
        signal: AbortSignal,
    ): Promise<WorkspaceEntriesEvent> => {
        signal.throwIfAborted();
        const client = await this.#client;
        signal.throwIfAborted();
        return await client.listWorkspace(request, signal);
    };

    readonly installAgent = async (request: AgentInstallRequest): Promise<void> => {
        const client = await this.#client;
        await client.installAgent(request);
    };

    readonly permission = async (request: PermissionResponseRequest): Promise<void> => {
        const clients = await this.#serviceClients;
        await clients.scoped.interactions.respond(
            request.sessionId,
            request.interactionId,
            new MobiusPermissionResponseRequest("mobius-web", request.outcome, request.optionId),
            AbortSignal.timeout(20_000),
        );
        useChatStore.getState().resolveSessionPermission(request.interactionId, request.sessionId);
    };

    readonly prepare = async (request: SessionPrepareRequest, signal: AbortSignal): Promise<SessionReadyEvent> => {
        signal.throwIfAborted();
        const requestId = request.requestId ?? crypto.randomUUID();
        this.#preparingRequestIds.add(requestId);
        try {
            const client = await this.#client;
            signal.throwIfAborted();
            const ready = await client.prepareSession({ ...request, requestId }, signal);
            if (ready.restored) {
                return ready;
            }
            const preferenceOrder = new Map(
                ready.configOptions.map((option) => [option.id, sessionConfigurationPriority(option.category)]),
            );
            const preferences = readSessionConfigPreferences(this.#channelId, request.agentId).toSorted(
                (left, right) => (preferenceOrder.get(left.configId) ?? 3) - (preferenceOrder.get(right.configId) ?? 3),
            );
            let bindingId = request.bindingId;
            let configOptions = ready.configOptions;
            for (const preference of preferences) {
                const option = configOptions.find((candidate) => candidate.id === preference.configId);
                if (option === undefined || option.type !== preference.valueType) {
                    continue;
                }
                if (option.type === "select") {
                    if (
                        option.currentValue === preference.value ||
                        !option.values.some((candidate) => candidate.value === preference.value)
                    ) {
                        continue;
                    }
                } else if (option.booleanValue === preference.booleanValue) {
                    continue;
                }
                const configured = await client.configureSession(
                    {
                        ...request,
                        bindingId,
                        booleanValue: preference.booleanValue,
                        configId: option.id,
                        value: preference.value,
                        valueType: option.type,
                    },
                    signal,
                );
                bindingId = configured.requestId;
                configOptions = configured.configOptions;
                saveSessionConfigPreferences(this.#channelId, request.agentId, configOptions);
            }
            return configOptions === ready.configOptions ? ready : { ...ready, configOptions };
        } finally {
            this.#preparingRequestIds.delete(requestId);
        }
    };

    readonly prompt = async (request: PromptRequest): Promise<PromptResult> => {
        const controller = new AbortController();
        this.#promptControllers.add(controller);
        try {
            return await this.runPrompt(request, controller.signal);
        } finally {
            this.#promptControllers.delete(controller);
        }
    };

    private readonly runPrompt = async (request: PromptRequest, signal: AbortSignal): Promise<PromptResult> => {
        const clients = await this.#serviceClients;
        const sessionId = request.sessionId ?? crypto.randomUUID();
        const commandId = request.commandId ?? crypto.randomUUID();
        await this.ensureSession(clients.scoped, request, sessionId, signal);
        const attachments = await this.uploadAttachments(clients.scoped, sessionId, request, signal);
        let attemptId = "";
        let failureCode = "";
        let failureMessage = "";
        let stopReason = "";
        const subscription = await clients.scoped.events.subscribe(
            sessionId,
            "",
            {
                receive: async (event) => {
                    const payload = event.payload;
                    if (!("commandId" in payload) || payload.commandId !== commandId) {
                        return true;
                    }
                    if (payload instanceof MobiusTurnStartedEvent) {
                        attemptId = payload.attemptId;
                        request.observer?.onStarted?.(payload.attemptId);
                        return true;
                    }
                    if (payload instanceof MobiusAgentMessageEvent) {
                        request.observer?.onDelta?.(payload.text, event.sequence);
                        return true;
                    }
                    if (payload instanceof MobiusAgentActivityEvent) {
                        const sourceAttemptId =
                            event.source instanceof MobiusAttemptEventSource ? event.source.attemptId : attemptId;
                        request.observer?.onActivity?.({
                            activityId: payload.activityId,
                            activityType: payload.activityType,
                            commandId: payload.commandId,
                            content: payload.content,
                            detail: payload.detail,
                            input: payload.input,
                            kind: payload.kind,
                            locations: payload.locations,
                            name: payload.name,
                            output: payload.output,
                            sequence: payload.sequence,
                            sessionId: payload.sessionId,
                            status: payload.status,
                            title: payload.title,
                            toolKind: payload.toolKind,
                        });
                        if (attemptId.length === 0) {
                            attemptId = sourceAttemptId;
                        }
                        return true;
                    }
                    if (payload instanceof MobiusControlEvent) {
                        this.applyPublicControlEvent(payload);
                        return true;
                    }
                    if (payload instanceof MobiusTurnCompletedEvent) {
                        stopReason = payload.stopReason;
                        return false;
                    }
                    if (payload instanceof MobiusTurnFailedEvent) {
                        failureCode = payload.code;
                        failureMessage = payload.message;
                        return false;
                    }
                    return true;
                },
            },
            signal,
        );
        this.#publicCommandIds.add(commandId);
        let acceptedTurnId = "";
        try {
            const accepted = await clients.scoped.turns.submit(
                sessionId,
                {
                    additionalDirectoryIds: request.additionalDirectoryIds ?? [],
                    artifactIds: attachments.artifactIds,
                    content: request.prompt,
                    idempotencyKey: commandId,
                    images: [],
                    resources: attachments.resources ?? [],
                },
                signal,
            );
            acceptedTurnId = accepted.turnId;
            this.#turnIds.set(this.turnKey(sessionId, commandId), accepted.turnId);
            try {
                await subscription.completed;
            } catch (streamError) {
                const outcome = await clients.scoped.turns.read(sessionId, accepted.turnId, signal);
                if (outcome.state instanceof MobiusSucceededTurnState) {
                    stopReason = outcome.state.stopReason;
                } else if (outcome.state instanceof MobiusCancelledTurnState) {
                    stopReason = "cancelled";
                } else if (outcome.state instanceof MobiusFailedTurnState) {
                    failureCode = outcome.state.code;
                    failureMessage = outcome.state.message;
                } else if (outcome.state instanceof MobiusIndeterminateTurnState) {
                    throw new MobiusChannelError("turn_indeterminate", outcome.state.reason, { cause: streamError });
                } else {
                    throw streamError;
                }
            }
            if (failureCode.length > 0) {
                throw new MobiusChannelError(failureCode, failureMessage);
            }
            if (stopReason.length === 0) {
                throw new MobiusChannelError("turn_outcome_unavailable", "The Turn ended without a terminal outcome");
            }
            return { sessionId, stopReason };
        } finally {
            subscription.close();
            if (acceptedTurnId.length > 0) {
                this.#turnIds.delete(this.turnKey(sessionId, commandId));
            }
            this.#publicCommandIds.delete(commandId);
        }
    };

    private readonly applyPublicControlEvent = (event: MobiusControlEvent): void => {
        const store = useChatStore.getState();
        if (event.kind === "agent.content") {
            store.recordAgentContent(decodeAgentContentEvent(event.encodedPayload));
            return;
        }
        if (event.kind === "session.permission.requested") {
            store.applySessionPermission(decodeSessionPermissionRequestedEvent(event.encodedPayload));
            return;
        }
        if (event.kind === "session.permission.resolved") {
            const resolved = decodeSessionPermissionResolvedEvent(event.encodedPayload);
            store.resolveSessionPermission(resolved.interactionId, resolved.sessionId);
            return;
        }
        if (event.kind === "session.elicitation.requested") {
            store.applySessionElicitation(decodeSessionElicitationRequestedEvent(event.encodedPayload));
            return;
        }
        if (event.kind === "session.elicitation.resolved") {
            store.resolveSessionElicitation(decodeSessionElicitationResolvedEvent(event.encodedPayload));
        }
    };

    private readonly ensureSession = async (
        client: MobiusClient,
        request: PromptRequest,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        let session: MobiusSession;
        try {
            session = await client.sessions.read(sessionId, signal);
        } catch (error) {
            if (!(error instanceof MobiusApiError) || error.code !== "session_not_found") {
                throw error;
            }
            await client.sessions.create(
                {
                    agentId: request.agentId,
                    bindingId: request.bindingId,
                    directoryId: request.directoryId ?? "default",
                    policy: new MobiusRecordingPolicy(
                        "full",
                        PUBLIC_SESSION_RETENTION_MILLISECONDS,
                        1_000,
                        PUBLIC_SESSION_CONTENT_LIMIT_BYTES,
                    ),
                    runtimeId: this.#connection.runtimeId,
                    sessionId,
                    title: "",
                },
                signal,
            );
            return;
        }
        const directoryId = request.directoryId ?? "default";
        if (session.runtimeId !== this.#connection.runtimeId || session.agentId !== request.agentId) {
            throw new MobiusChannelError(
                "session_binding_conflict",
                "The Session is bound to another Runtime or Agent",
            );
        }
        if (
            session.defaultBinding.bindingId !== request.bindingId ||
            session.defaultBinding.agentRef !== request.agentId ||
            session.defaultBinding.workspaceRef !== directoryId
        ) {
            await client.sessions.configure(
                sessionId,
                {
                    agentRef: request.agentId,
                    bindingId: request.bindingId,
                    configRevision: session.defaultBinding.configRevision + 1,
                    runtimeId: this.#connection.runtimeId,
                    workspaceRef: directoryId,
                },
                signal,
            );
        }
    };

    private readonly uploadAttachments = async (
        client: MobiusClient,
        sessionId: string,
        request: PromptRequest,
        signal: AbortSignal,
    ): Promise<UploadedPromptAttachments> => {
        const artifactIds: string[] = [];
        const resources: PromptResource[] = [];
        for (const image of request.images ?? []) {
            const bytes = decodeImageBytes(image.data);
            artifactIds.push(await this.uploadAttachment(client, sessionId, image.name, image.mimeType, bytes, signal));
        }
        for (const resource of request.resources ?? []) {
            if (resource.type !== "embedded") {
                resources.push(resource);
                continue;
            }
            artifactIds.push(
                await this.uploadAttachment(
                    client,
                    sessionId,
                    resource.name,
                    resource.mimeType,
                    new TextEncoder().encode(resource.text),
                    signal,
                ),
            );
        }
        return new UploadedPromptAttachments(artifactIds, resources);
    };

    private readonly uploadAttachment = async (
        client: MobiusClient,
        sessionId: string,
        name: string,
        mediaType: string,
        bytes: Uint8Array,
        signal: AbortSignal,
    ): Promise<string> => {
        if (bytes.byteLength === 0) {
            throw new MobiusChannelError("attachment_empty", "An empty attachment cannot be uploaded");
        }
        const upload = await client.artifacts.createUpload(
            sessionId,
            new MobiusArtifactUploadRequest(name, mediaType, bytes.byteLength, await sha256(bytes, signal)),
            signal,
        );
        await client.artifacts.uploadContent(sessionId, upload, bytes, signal);
        return upload.artifactId;
    };

    private readonly turnKey = (sessionId: string, commandId: string): string => `${sessionId}\u0000${commandId}`;

    readonly #refreshAgentCatalog = async (): Promise<void> => {
        try {
            const connection = await readChannelConnection(this.#channelId);
            useChatStore.getState().refreshChannelConnection(connection);
        } catch (error) {
            useChatStore.getState().setErrorMessage(failureMessage(error));
        }
    };
}

let transport: TransportConnection = new DisconnectedTransport();

export function initializeMobiusTransport(connection: ChannelConnection, onActivity: () => void): void {
    void transport.close();
    transport = new ConnectedTransport(connection, onActivity);
}

export async function prepareActiveSession(expectedSessionId = ""): Promise<void> {
    const initialStore = useChatStore.getState();
    const conversation = selectActiveConversation(initialStore);
    if (
        (expectedSessionId.length > 0 && conversation.sessionId !== expectedSessionId) ||
        !initialStore.runtime.canSend ||
        conversation.session instanceof DeletedSessionState ||
        conversation.session.isReady ||
        conversation.session.isPreparing
    ) {
        return;
    }
    initialStore.setSessionPreparing(conversation.sessionId);
    try {
        const ready = await transport.prepare(
            {
                additionalDirectoryIds: conversation.additionalDirectories.map((directory) => directory.directoryId),
                agentId: conversation.agentId,
                bindingId: conversation.bindingId,
                directoryId: conversation.directoryId,
                sessionId: conversation.sessionId,
            },
            AbortSignal.timeout(120_000),
        );
        useChatStore.getState().applySessionReady(ready);
    } catch (error) {
        const store = useChatStore.getState();
        const additionalDirectoryIds = conversation.additionalDirectories.map((directory) => directory.directoryId);
        if (isInterruptedChannelOperation(error)) {
            store.setSessionPreparationInterrupted(
                conversation.sessionId,
                conversation.agentId,
                conversation.directoryId,
                additionalDirectoryIds,
                failureMessage(error),
            );
        } else {
            store.setSessionPreparationFailed(
                conversation.sessionId,
                conversation.agentId,
                conversation.directoryId,
                additionalDirectoryIds,
                failureMessage(error),
            );
        }
    }
}

export async function listWorkspace(
    directoryId: string,
    signal: AbortSignal = AbortSignal.timeout(120_000),
): Promise<WorkspaceEntriesEvent> {
    return await transport.listWorkspace(
        {
            bindingId: "workspace",
            directoryId,
        },
        signal,
    );
}

export async function prepareConversationSession(
    request: SessionPrepareRequest,
    signal: AbortSignal,
): Promise<SessionReadyEvent> {
    return await transport.prepare(request, signal);
}

export async function configureConversationSession(
    request: SessionConfigureRequest,
    signal: AbortSignal,
): Promise<SessionConfigUpdatedEvent> {
    return await transport.configure(request, signal);
}

type NativeSessionAction =
    | { readonly action: "list"; readonly cursor: string | null }
    | {
          readonly action: "fork" | "import";
          readonly directoryId: string;
          readonly entryId: string;
      }
    | {
          readonly action: "delete";
          readonly directoryId: string;
          readonly entryId: string;
      };

export interface NativeSessionScope {
    readonly agentId: string;
    readonly directoryId: string;
    readonly sessionId: string;
}

export async function manageNativeSession(
    scope: NativeSessionScope,
    action: NativeSessionAction,
    signal: AbortSignal,
): Promise<NativeSessionResult> {
    const identity = {
        additionalDirectoryIds: [],
        agentId: scope.agentId,
        bindingId: "workspace",
        directoryId: action.action === "list" ? scope.directoryId : action.directoryId,
        sessionId: scope.sessionId,
        requestId: crypto.randomUUID(),
        kind: "native.session.request",
    } satisfies Omit<NativeSessionCommand, "action">;
    switch (action.action) {
        case "import":
        case "fork":
            return await transport.nativeSession(
                { ...identity, ...action, targetSessionId: crypto.randomUUID() },
                signal,
            );
        case "list":
        case "delete":
            return await transport.nativeSession({ ...identity, ...action }, signal);
    }
}

export type SessionConfigurationResult =
    | { readonly kind: "applied" }
    | { readonly kind: "ignored" }
    | {
          readonly code: string;
          readonly kind: "failed";
          readonly message: string;
      };

export async function configureSessionOption(
    expectedAgentId: string,
    expectedSessionId: string,
    expectedDirectoryId: string,
    expectedAdditionalDirectoryIds: readonly string[],
    option: SessionConfigOption,
    value: string,
    booleanValue: boolean,
): Promise<SessionConfigurationResult> {
    const store = useChatStore.getState();
    const conversation = selectActiveConversation(store);
    if (
        !store.runtime.canSend ||
        !conversation.session.isReady ||
        !conversation.matchesPreparation(
            expectedAgentId,
            expectedSessionId,
            expectedDirectoryId,
            expectedAdditionalDirectoryIds,
        )
    ) {
        return { kind: "ignored" };
    }
    const currentOption = conversation.session.configOptions.find((candidate) => candidate.id === option.id);
    if (currentOption === undefined || currentOption.type !== option.type) {
        return { kind: "ignored" };
    }
    if (
        currentOption.type === "select" &&
        (currentOption.currentValue === value || !currentOption.values.some((candidate) => candidate.value === value))
    ) {
        return { kind: "ignored" };
    }
    if (currentOption.type === "boolean" && currentOption.booleanValue === booleanValue) {
        return { kind: "ignored" };
    }
    try {
        await transport.configure(
            {
                additionalDirectoryIds: conversation.additionalDirectories.map((directory) => directory.directoryId),
                agentId: conversation.agentId,
                bindingId: conversation.bindingId,
                booleanValue,
                configId: currentOption.id,
                directoryId: conversation.directoryId,
                sessionId: conversation.sessionId,
                value,
                valueType: currentOption.type,
            },
            AbortSignal.timeout(120_000),
        );
        const latestStore = useChatStore.getState();
        if (
            selectActiveConversation(latestStore).matchesPreparation(
                expectedAgentId,
                expectedSessionId,
                expectedDirectoryId,
                expectedAdditionalDirectoryIds,
            )
        ) {
            latestStore.setErrorMessage("");
        }
        return { kind: "applied" };
    } catch (error) {
        const failure = boundaryFailure(error);
        const latestStore = useChatStore.getState();
        if (
            selectActiveConversation(latestStore).matchesPreparation(
                expectedAgentId,
                expectedSessionId,
                expectedDirectoryId,
                expectedAdditionalDirectoryIds,
            )
        ) {
            latestStore.setErrorMessage(`${failure.code}: ${failure.message}`);
        }
        return { ...failure, kind: "failed" };
    }
}

export async function respondToPermission(request: PermissionResponseRequest): Promise<void> {
    try {
        await transport.permission(request);
        useChatStore.getState().setErrorMessage("");
    } catch (error) {
        useChatStore.getState().setErrorMessage(failureMessage(error));
    }
}

export async function respondToElicitation(request: ElicitationResponseRequest): Promise<void> {
    try {
        await transport.elicit(request);
        useChatStore.getState().setErrorMessage("");
    } catch (error) {
        useChatStore.getState().setErrorMessage(failureMessage(error));
    }
}

export async function sendPrompt(prompt: string): Promise<void> {
    const normalizedPrompt = prompt.trim();
    await prepareActiveSession();
    const initialStore = useChatStore.getState();
    const conversation = selectActiveConversation(initialStore);
    const hasAttachments = conversation.draftImages.length > 0 || conversation.draftResources.length > 0;
    if (
        (normalizedPrompt.length === 0 && !hasAttachments) ||
        conversation.isRunning ||
        !initialStore.runtime.canSend ||
        !conversation.session.isReady
    ) {
        return;
    }

    const turn = initialStore.beginTurn(normalizedPrompt);
    let attemptId = "Pending";

    try {
        const result = await transport.prompt({
            additionalDirectoryIds: conversation.additionalDirectories.map((directory) => directory.directoryId),
            agentId: turn.agentId,
            bindingId: conversation.bindingId,
            commandId: turn.commandId,
            directoryId: conversation.directoryId,
            images: conversation.draftImages,
            observer: {
                onActivity: (activity) => {
                    useChatStore
                        .getState()
                        .recordAgentActivity(
                            turn,
                            new RecordedActivity(
                                activity.activityId,
                                attemptId,
                                activity.activityType,
                                activity.input,
                                activity.locations,
                                activity.name,
                                activity.output,
                                activity.sequence,
                                activity.status,
                                activity.title,
                                activity.toolKind,
                                activity.content,
                                activity.detail.kind === "recorded" ? "inline" : activity.detail.kind,
                            ),
                        );
                },
                onDelta: (text, committedSequence) => {
                    useChatStore.getState().appendAgentText(turn, text, committedSequence);
                },
                onStarted: (startedAttemptId) => {
                    attemptId = startedAttemptId;
                    useChatStore.getState().startAgentTurn(turn, startedAttemptId);
                },
            },
            prompt: normalizedPrompt,
            resources: conversation.draftResources,
            sessionId: turn.sessionId,
        });
        useChatStore.getState().completeTurn(turn, attemptId, result.stopReason);
    } catch (error) {
        useChatStore.getState().failTurn(turn, failureMessage(error));
    }
}

export async function stopActiveTurn(): Promise<void> {
    const initialStore = useChatStore.getState();
    const conversation = selectActiveConversation(initialStore);
    if (!conversation.canStop) {
        return;
    }
    const turn = conversation.runningTurn();

    try {
        await transport.cancel({
            commandId: turn.commandId,
            sessionId: turn.sessionId,
        });
        useChatStore.getState().requestStop(turn);
        useChatStore.getState().setErrorMessage("");
    } catch (error) {
        useChatStore.getState().setErrorMessage(failureMessage(error));
    }
}

export async function installLocalAgent(agentId: string): Promise<void> {
    const state = useChatStore.getState();
    if (!state.installableAgents.some((agent) => agent.id === agentId)) {
        return;
    }
    const installation = state.agentInstallations.find((candidate) => candidate.agentId === agentId);
    if (installation?.canCancel === true) {
        return;
    }
    const requestId = crypto.randomUUID();
    state.beginAgentInstallation(agentId, requestId);
    try {
        await transport.installAgent({ agentId, requestId });
    } catch (error) {
        const failure =
            error instanceof MobiusChannelError
                ? error
                : new MobiusChannelError("unexpected_error", "The Agent integration installation failed unexpectedly");
        if (failure.code === "installation_cancelled") {
            return;
        }
        useChatStore.getState().applyAgentInstallFailed({
            agentId,
            code: failure.code,
            kind: "agent.integration.install.failed",
            message: failure.message,
            requestId,
        });
    }
}

export async function cancelLocalAgentInstallation(agentId: string): Promise<void> {
    const state = useChatStore.getState();
    const installation = state.agentInstallations.find((candidate) => candidate.agentId === agentId);
    if (!(installation instanceof RequestedAgentInstallationState) || !installation.canCancel) {
        return;
    }
    try {
        await transport.cancelAgentInstallation({
            requestId: installation.requestId,
        });
    } catch (error) {
        state.setErrorMessage(failureMessage(error));
    }
}

export async function closeMobiusTransport(): Promise<void> {
    const previous = transport;
    transport = new DisconnectedTransport();
    await previous.close();
}
