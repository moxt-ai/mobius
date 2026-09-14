import {
    decodePromptImagesValue,
    decodePromptResourcesValue,
    decodeSessionConfigUpdatedEvent,
    type Interaction,
    type PromptImage,
    type PromptResource,
    type SessionConfigOption,
} from "@moxt-ai/mobius-protocol";

import { MobiusApiError, MobiusProtocolError, MobiusValidationError } from "./errors.ts";
import {
    decodeMobiusArtifact,
    decodeMobiusArtifactUpload,
    decodeMobiusAvailableArtifact,
    decodeMobiusInteraction,
    decodeMobiusInteractionList,
    decodeMobiusMessagePage,
    decodeMobiusSession,
    decodeMobiusTurn,
    type MobiusArtifact,
    MobiusArtifactDownload,
    type MobiusArtifactUpload,
    type MobiusArtifactUploadRequest,
    MobiusAvailableArtifact,
    type MobiusEventPage,
    type MobiusMessagePage,
    type MobiusPageRequest,
    type MobiusSession,
    type MobiusTurn,
} from "./resources.ts";
import {
    type MobiusEndpointOptions,
    MobiusFixedSessionEventResources,
    type MobiusHttpTransport,
    MobiusRequestExecutor,
    StaticMobiusCredentialProvider,
} from "./service-client.ts";

export {
    MobiusApiError,
    MobiusCancellationError,
    MobiusConnectionError,
    MobiusError,
    MobiusProtocolError,
    MobiusTimeoutError,
    MobiusValidationError,
} from "./errors.ts";
export type { MobiusArtifact, MobiusArtifactUpload } from "./resources.ts";
export {
    MobiusArtifactDownload,
    MobiusArtifactUploadRequest,
    MobiusAvailableArtifact,
    MobiusEventPage,
    MobiusMessagePage,
    MobiusPageRequest,
    MobiusSession,
    MobiusTurn,
} from "./resources.ts";
export type {
    MobiusCredentialProvider,
    MobiusEventSubscription,
    MobiusHttpTransport,
    MobiusSessionEventObserver,
} from "./service-client.ts";
export { MobiusClient } from "./service-client.ts";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CONVERSATION_CREDENTIAL_PATTERN = /^mconv_[a-zA-Z0-9_-]{22}_[a-zA-Z0-9_-]{43}$/;

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new MobiusProtocolError(`The browser service returned an invalid ${name}`);
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function string(value: Readonly<Record<string, unknown>>, field: string, maximum: number): string {
    const candidate = value[field];
    if (typeof candidate !== "string" || candidate.length > maximum) {
        throw new MobiusProtocolError(`The browser service returned an invalid ${field}`);
    }
    return candidate;
}

function identifier(value: Readonly<Record<string, unknown>>, field: string): string {
    const candidate = string(value, field, 128);
    if (!IDENTIFIER_PATTERN.test(candidate)) {
        throw new MobiusProtocolError(`The browser service returned an invalid ${field}`);
    }
    return candidate;
}

function requestedIdentifier(value: string, name: string): string {
    if (!IDENTIFIER_PATTERN.test(value)) {
        throw new MobiusValidationError(`The ${name} is invalid`);
    }
    return value;
}

function timestamp(value: Readonly<Record<string, unknown>>, field: string): string {
    const candidate = string(value, field, 128);
    if (Number.isNaN(Date.parse(candidate))) {
        throw new MobiusProtocolError(`The browser service returned an invalid ${field}`);
    }
    return candidate;
}

function integer(value: Readonly<Record<string, unknown>>, field: string): number {
    const candidate = value[field];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
        throw new MobiusProtocolError(`The browser service returned an invalid ${field}`);
    }
    return candidate;
}

function strings(value: Readonly<Record<string, unknown>>, field: string): readonly string[] {
    const candidate = value[field];
    if (!Array.isArray(candidate) || candidate.length > 64 || candidate.some((entry) => typeof entry !== "string")) {
        throw new MobiusProtocolError(`The browser service returned an invalid ${field}`);
    }
    return Object.freeze(candidate.filter((entry) => typeof entry === "string"));
}

function pagePath(path: string, page: MobiusPageRequest): string {
    const query = new URLSearchParams({ limit: page.limit.toString() });
    if (page.cursor.length > 0) {
        query.set("cursor", page.cursor);
    }
    return `${path}?${query.toString()}`;
}

function decodeBrowserTurn(value: unknown): MobiusTurn {
    const response = record(value, "Turn acceptance");
    return decodeMobiusTurn(response["turn"] ?? response);
}

export class MobiusBrowserCredentialProvider extends StaticMobiusCredentialProvider {
    constructor(credential: string) {
        if (!CONVERSATION_CREDENTIAL_PATTERN.test(credential)) {
            throw new MobiusValidationError("The ConversationAccessCredential is invalid");
        }
        super(credential);
    }
}

export class MobiusBrowserAccessToken {
    readonly credential: string;
    readonly expiresAt: string;
    readonly expiresAtEpochMilliseconds: number;

    constructor(credential: string, expiresAt: string) {
        if (!CONVERSATION_CREDENTIAL_PATTERN.test(credential)) {
            throw new MobiusValidationError("The ConversationAccessCredential is invalid");
        }
        const expiresAtEpochMilliseconds = Date.parse(expiresAt);
        if (!Number.isSafeInteger(expiresAtEpochMilliseconds) || expiresAtEpochMilliseconds < 0) {
            throw new MobiusValidationError("The ConversationAccessCredential expiry is invalid");
        }
        this.credential = credential;
        this.expiresAt = new Date(expiresAtEpochMilliseconds).toISOString();
        this.expiresAtEpochMilliseconds = expiresAtEpochMilliseconds;
    }
}

export interface MobiusBrowserAccessTokenProvider {
    readonly accessToken: (signal: AbortSignal) => Promise<MobiusBrowserAccessToken>;
}

export class RefreshingMobiusBrowserCredentialProvider {
    readonly #accessTokenProvider: MobiusBrowserAccessTokenProvider;
    readonly #nowEpochMilliseconds: () => number;
    readonly #refreshWindowMilliseconds: number;
    readonly #refreshes: Promise<MobiusBrowserAccessToken>[] = [];
    readonly #tokens: MobiusBrowserAccessToken[] = [];

    constructor(
        accessTokenProvider: MobiusBrowserAccessTokenProvider,
        refreshWindowMilliseconds = 30_000,
        nowEpochMilliseconds: () => number = () => Date.now(),
    ) {
        if (!Number.isSafeInteger(refreshWindowMilliseconds) || refreshWindowMilliseconds < 0) {
            throw new MobiusValidationError("The browser token refresh window is invalid");
        }
        this.#accessTokenProvider = accessTokenProvider;
        this.#nowEpochMilliseconds = nowEpochMilliseconds;
        this.#refreshWindowMilliseconds = refreshWindowMilliseconds;
    }

    readonly credential = async (signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        const cached = this.#tokens.at(-1);
        if (
            cached !== undefined &&
            cached.expiresAtEpochMilliseconds - this.#refreshWindowMilliseconds > this.#nowEpochMilliseconds()
        ) {
            return cached.credential;
        }
        const active = this.#refreshes.at(0);
        if (active !== undefined) {
            return (await active).credential;
        }
        const refresh = this.#accessTokenProvider.accessToken(signal);
        this.#refreshes.push(refresh);
        try {
            const token = await refresh;
            signal.throwIfAborted();
            if (token.expiresAtEpochMilliseconds <= this.#nowEpochMilliseconds()) {
                throw new MobiusValidationError("The refreshed ConversationAccessCredential is expired");
            }
            this.#tokens.splice(0, this.#tokens.length, token);
            return token.credential;
        } finally {
            this.#refreshes.splice(0, this.#refreshes.length);
        }
    };
}

export class MobiusBrowserSessionAccess {
    readonly actorRef: string;
    readonly conversationId: string;
    readonly credentialId: string;
    readonly expiresAt: string;
    readonly permissions: readonly string[];

    constructor(value: Readonly<Record<string, unknown>>) {
        this.actorRef = string(value, "actorRef", 200);
        this.conversationId = identifier(value, "conversationId");
        this.credentialId = identifier(value, "credentialId");
        this.expiresAt = timestamp(value, "expiresAt");
        this.permissions = strings(value, "permissions");
    }
}

export class MobiusBrowserSessionSnapshot {
    readonly access: MobiusBrowserSessionAccess;
    readonly session: MobiusSession;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.access = new MobiusBrowserSessionAccess(record(value["access"], "Session access"));
        this.session = decodeMobiusSession(value["session"]);
    }
}

export interface MobiusSubmitBrowserTurnRequest {
    readonly additionalDirectoryIds: readonly string[];
    readonly artifactIds: readonly string[];
    readonly content: string;
    readonly idempotencyKey: string;
    readonly images: readonly PromptImage[];
    readonly resources: readonly PromptResource[];
}

export interface MobiusCreateBrowserMessageRequest {
    readonly artifactIds: readonly string[];
    readonly content: string;
    readonly idempotencyKey: string;
    readonly images: readonly PromptImage[];
    readonly resources: readonly PromptResource[];
}

export class MobiusAcceptedBrowserMessage {
    readonly actorRef: string;
    readonly artifactIds: readonly string[];
    readonly content: string;
    readonly conversationId: string;
    readonly createdAt: string;
    readonly images: readonly PromptImage[];
    readonly messageId: string;
    readonly resources: readonly PromptResource[];
    readonly sessionId: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.actorRef = string(value, "actorRef", 200);
        this.artifactIds = strings(value, "artifactIds");
        this.content = string(value, "content", 100_000);
        this.conversationId = identifier(value, "conversationId");
        this.createdAt = timestamp(value, "createdAt");
        try {
            this.images = decodePromptImagesValue(value["images"]);
            this.resources = decodePromptResourcesValue(value["resources"]);
        } catch (cause) {
            throw new MobiusProtocolError("The browser service returned an invalid accepted message", { cause });
        }
        this.messageId = identifier(value, "messageId");
        this.sessionId = identifier(value, "sessionId");
    }
}

export class MobiusBrowserHistory {
    readonly acceptedMessages: readonly MobiusAcceptedBrowserMessage[];
    readonly lastCommittedSeq: string;
    readonly nextCursor: string;
    readonly turns: MobiusMessagePage["messages"];

    constructor(value: Readonly<Record<string, unknown>>) {
        const acceptedMessages = value["acceptedMessages"];
        const turns = value["turns"];
        const nextCursor = value["nextCursor"];
        if (
            !Array.isArray(acceptedMessages) ||
            !Array.isArray(turns) ||
            (nextCursor !== null && typeof nextCursor !== "string")
        ) {
            throw new MobiusProtocolError("The browser service returned an invalid Session history");
        }
        this.acceptedMessages = Object.freeze(
            acceptedMessages.map((message) => new MobiusAcceptedBrowserMessage(record(message, "accepted message"))),
        );
        this.lastCommittedSeq = string(value, "lastCommittedSeq", 40);
        this.nextCursor = nextCursor ?? "";
        this.turns = decodeMobiusMessagePage({
            lastCommittedSeq: this.lastCommittedSeq,
            messages: turns,
            nextCursor: null,
        }).messages;
    }
}

export class MobiusBrowserMessageResources {
    readonly #executor: MobiusRequestExecutor;

    constructor(executor: MobiusRequestExecutor) {
        this.#executor = executor;
    }

    readonly create = async (
        request: MobiusCreateBrowserMessageRequest,
        signal: AbortSignal,
    ): Promise<MobiusAcceptedBrowserMessage> =>
        new MobiusAcceptedBrowserMessage(
            record(
                await this.#executor.post(
                    "v1/client/session/messages",
                    {
                        artifactIds: request.artifactIds.map((artifactId) =>
                            requestedIdentifier(artifactId, "artifact identifier"),
                        ),
                        content: request.content,
                        idempotencyKey: requestedIdentifier(request.idempotencyKey, "message idempotency key"),
                        images: request.images,
                        resources: request.resources,
                    },
                    signal,
                ),
                "accepted message",
            ),
        );

    readonly run = async (messageId: string, signal: AbortSignal): Promise<MobiusTurn> =>
        decodeBrowserTurn(
            await this.#executor.post(
                "v1/client/session/turns",
                { messageId: requestedIdentifier(messageId, "message identifier") },
                signal,
            ),
        );
}

export class MobiusBrowserHistoryResources {
    readonly #executor: MobiusRequestExecutor;

    constructor(executor: MobiusRequestExecutor) {
        this.#executor = executor;
    }

    readonly read = async (page: MobiusPageRequest, signal: AbortSignal): Promise<MobiusBrowserHistory> =>
        new MobiusBrowserHistory(
            record(await this.#executor.get(pagePath("v1/client/session/history", page), signal), "Session history"),
        );
}

export class MobiusBrowserConfiguration {
    readonly options: readonly SessionConfigOption[];
    readonly revision: number;
    readonly updatedAt: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        try {
            const event = decodeSessionConfigUpdatedEvent(
                JSON.stringify({
                    configOptions: value["options"],
                    kind: "session.config.updated",
                    requestId: "browser-configuration",
                    sessionId: "browser-session",
                }),
            );
            this.options = event.configOptions;
        } catch (cause) {
            throw new MobiusProtocolError("The browser service returned an invalid Session configuration", { cause });
        }
        this.revision = integer(value, "revision");
        this.updatedAt = timestamp(value, "updatedAt");
    }
}

export class MobiusBrowserConfigurationAcceptance {
    readonly duplicate: boolean;
    readonly requestId: string;
    readonly status: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        if (typeof value["duplicate"] !== "boolean" || value["status"] !== "accepted") {
            throw new MobiusProtocolError("The browser service returned an invalid configuration acceptance");
        }
        this.duplicate = value["duplicate"];
        this.requestId = identifier(value, "requestId");
        this.status = value["status"];
    }
}

export interface MobiusUpdateBrowserConfigurationRequest {
    readonly additionalDirectoryIds: readonly string[];
    readonly booleanValue: boolean;
    readonly configId: string;
    readonly idempotencyKey: string;
    readonly value: string;
    readonly valueType: string;
}

export class MobiusBrowserConfigurationResources {
    readonly #executor: MobiusRequestExecutor;

    constructor(executor: MobiusRequestExecutor) {
        this.#executor = executor;
    }

    readonly read = async (signal: AbortSignal): Promise<MobiusBrowserConfiguration> =>
        new MobiusBrowserConfiguration(
            record(await this.#executor.get("v1/client/session/configuration", signal), "Session configuration"),
        );

    readonly update = async (
        request: MobiusUpdateBrowserConfigurationRequest,
        signal: AbortSignal,
    ): Promise<MobiusBrowserConfigurationAcceptance> =>
        new MobiusBrowserConfigurationAcceptance(
            record(
                await this.#executor.post(
                    "v1/client/session/configuration",
                    {
                        additionalDirectoryIds: request.additionalDirectoryIds.map((directoryId) =>
                            requestedIdentifier(directoryId, "additional directory identifier"),
                        ),
                        booleanValue: request.booleanValue,
                        configId: requestedIdentifier(request.configId, "configuration identifier"),
                        idempotencyKey: requestedIdentifier(request.idempotencyKey, "configuration idempotency key"),
                        value: request.value,
                        valueType: request.valueType,
                    },
                    signal,
                ),
                "configuration acceptance",
            ),
        );
}

export class MobiusBrowserSessionResources {
    readonly #executor: MobiusRequestExecutor;

    constructor(executor: MobiusRequestExecutor) {
        this.#executor = executor;
    }

    readonly read = async (signal: AbortSignal): Promise<MobiusBrowserSessionSnapshot> =>
        new MobiusBrowserSessionSnapshot(
            record(await this.#executor.get("v1/client/session", signal), "Session snapshot"),
        );

    readonly readMessages = async (page: MobiusPageRequest, signal: AbortSignal): Promise<MobiusMessagePage> =>
        decodeMobiusMessagePage(await this.#executor.get(pagePath("v1/client/session/messages", page), signal));
}

export class MobiusBrowserTurnResources {
    readonly #executor: MobiusRequestExecutor;

    constructor(executor: MobiusRequestExecutor) {
        this.#executor = executor;
    }

    readonly submit = async (request: MobiusSubmitBrowserTurnRequest, signal: AbortSignal): Promise<MobiusTurn> =>
        decodeBrowserTurn(
            await this.#executor.post(
                "v1/client/session/turns",
                {
                    additionalDirectoryIds: request.additionalDirectoryIds,
                    artifactIds: request.artifactIds,
                    content: request.content,
                    idempotencyKey: requestedIdentifier(request.idempotencyKey, "turn idempotency key"),
                    images: request.images,
                    resources: request.resources,
                },
                signal,
            ),
        );

    readonly read = async (turnId: string, signal: AbortSignal): Promise<MobiusTurn> =>
        decodeMobiusTurn(
            await this.#executor.get(
                `v1/client/session/turns/${encodeURIComponent(requestedIdentifier(turnId, "Turn identifier"))}`,
                signal,
            ),
        );

    readonly cancel = async (turnId: string, idempotencyKey: string, signal: AbortSignal): Promise<MobiusTurn> =>
        decodeMobiusTurn(
            await this.#executor.post(
                `v1/client/session/turns/${encodeURIComponent(requestedIdentifier(turnId, "Turn identifier"))}/cancel`,
                { idempotencyKey: requestedIdentifier(idempotencyKey, "turn cancellation idempotency key") },
                signal,
            ),
        );

    readonly promote = async (turnId: string, signal: AbortSignal): Promise<MobiusTurn> =>
        decodeMobiusTurn(
            await this.#executor.post(
                `v1/client/session/turns/${encodeURIComponent(requestedIdentifier(turnId, "Turn identifier"))}/promote`,
                {},
                signal,
            ),
        );
}

export class MobiusBrowserInteractionResources {
    readonly #executor: MobiusRequestExecutor;

    constructor(executor: MobiusRequestExecutor) {
        this.#executor = executor;
    }

    readonly listPending = async (signal: AbortSignal): Promise<readonly Interaction[]> =>
        decodeMobiusInteractionList(await this.#executor.get("v1/client/session/interactions", signal));

    readonly read = async (interactionId: string, signal: AbortSignal): Promise<Interaction> =>
        decodeMobiusInteraction(
            await this.#executor.get(
                `v1/client/session/interactions/${encodeURIComponent(requestedIdentifier(interactionId, "Interaction identifier"))}`,
                signal,
            ),
        );

    readonly respondPermission = async (
        interactionId: string,
        outcome: string,
        optionId: string,
        signal: AbortSignal,
    ): Promise<Interaction> =>
        decodeMobiusInteraction(
            await this.#executor.post(
                `v1/client/session/interactions/${encodeURIComponent(requestedIdentifier(interactionId, "Interaction identifier"))}/response`,
                { kind: "permission", optionId, outcome },
                signal,
            ),
        );

    readonly respondElicitation = async (
        interactionId: string,
        action: string,
        content: string,
        signal: AbortSignal,
    ): Promise<Interaction> =>
        decodeMobiusInteraction(
            await this.#executor.post(
                `v1/client/session/interactions/${encodeURIComponent(requestedIdentifier(interactionId, "Interaction identifier"))}/response`,
                { action, content, kind: "elicitation" },
                signal,
            ),
        );
}

export class MobiusBrowserArtifactResources {
    readonly #executor: MobiusRequestExecutor;

    constructor(executor: MobiusRequestExecutor) {
        this.#executor = executor;
    }

    readonly createUpload = async (
        request: MobiusArtifactUploadRequest,
        signal: AbortSignal,
    ): Promise<MobiusArtifactUpload> =>
        decodeMobiusArtifactUpload(await this.#executor.post("v1/client/session/artifacts", request, signal));

    readonly uploadContent = async (
        upload: MobiusArtifactUpload,
        bytes: Uint8Array,
        signal: AbortSignal,
    ): Promise<MobiusAvailableArtifact> => {
        if (bytes.byteLength !== upload.byteLength) {
            throw new MobiusValidationError("The artifact content does not match its upload authorization");
        }
        return decodeMobiusAvailableArtifact(
            await this.#executor.putBytes(
                `v1/client/session/artifacts/${encodeURIComponent(upload.artifactId)}/content`,
                bytes,
                upload.mediaType,
                upload.uploadToken,
                signal,
            ),
        );
    };

    readonly read = async (artifactId: string, signal: AbortSignal): Promise<MobiusArtifact> =>
        decodeMobiusArtifact(
            await this.#executor.get(
                `v1/client/session/artifacts/${encodeURIComponent(requestedIdentifier(artifactId, "Artifact identifier"))}`,
                signal,
            ),
        );

    readonly download = async (artifactId: string, signal: AbortSignal): Promise<MobiusArtifactDownload> => {
        const artifact = await this.read(artifactId, signal);
        if (!(artifact instanceof MobiusAvailableArtifact)) {
            throw new MobiusApiError("artifact_not_ready", "The artifact content is not available", 409);
        }
        const bytes = await this.#executor.getBytes(
            `v1/client/session/artifacts/${encodeURIComponent(requestedIdentifier(artifactId, "Artifact identifier"))}/content`,
            artifact,
            signal,
        );
        return new MobiusArtifactDownload(artifact, bytes);
    };
}

export interface MobiusBrowserClientOptions extends MobiusEndpointOptions {}

export interface MobiusConversationSessionOptions {
    readonly accessTokenProvider: MobiusBrowserAccessTokenProvider;
    readonly endpoint: string;
    readonly maxStreamReconnectAttempts?: number;
    readonly operationTimeoutMilliseconds?: number;
    readonly refreshWindowMilliseconds?: number;
    readonly streamConnectionTimeoutMilliseconds?: number;
    readonly streamLivenessTimeoutMilliseconds?: number;
    readonly transport?: MobiusHttpTransport;
}

export function createMobiusConversationSession(options: MobiusConversationSessionOptions): MobiusBrowserClient {
    return new MobiusBrowserClient({
        credentialProvider: new RefreshingMobiusBrowserCredentialProvider(
            options.accessTokenProvider,
            options.refreshWindowMilliseconds,
        ),
        endpoint: options.endpoint,
        ...(options.maxStreamReconnectAttempts === undefined
            ? {}
            : { maxStreamReconnectAttempts: options.maxStreamReconnectAttempts }),
        ...(options.operationTimeoutMilliseconds === undefined
            ? {}
            : { operationTimeoutMilliseconds: options.operationTimeoutMilliseconds }),
        ...(options.streamConnectionTimeoutMilliseconds === undefined
            ? {}
            : { streamConnectionTimeoutMilliseconds: options.streamConnectionTimeoutMilliseconds }),
        ...(options.streamLivenessTimeoutMilliseconds === undefined
            ? {}
            : { streamLivenessTimeoutMilliseconds: options.streamLivenessTimeoutMilliseconds }),
        ...(options.transport === undefined ? {} : { transport: options.transport }),
    });
}

export class MobiusBrowserClient {
    readonly artifacts: MobiusBrowserArtifactResources;
    readonly configuration: MobiusBrowserConfigurationResources;
    readonly events: MobiusFixedSessionEventResources;
    readonly history: MobiusBrowserHistoryResources;
    readonly interactions: MobiusBrowserInteractionResources;
    readonly messages: MobiusBrowserMessageResources;
    readonly session: MobiusBrowserSessionResources;
    readonly turns: MobiusBrowserTurnResources;

    constructor(options: MobiusBrowserClientOptions) {
        if (options.authenticationProviderId !== undefined) {
            throw new MobiusValidationError("Browser requests cannot select a developer authentication provider");
        }
        const executor = new MobiusRequestExecutor(options);
        this.artifacts = new MobiusBrowserArtifactResources(executor);
        this.configuration = new MobiusBrowserConfigurationResources(executor);
        this.events = new MobiusFixedSessionEventResources(executor, options.maxStreamReconnectAttempts);
        this.history = new MobiusBrowserHistoryResources(executor);
        this.interactions = new MobiusBrowserInteractionResources(executor);
        this.messages = new MobiusBrowserMessageResources(executor);
        this.session = new MobiusBrowserSessionResources(executor);
        this.turns = new MobiusBrowserTurnResources(executor);
    }

    readonly readEvents = async (page: MobiusPageRequest, signal: AbortSignal): Promise<MobiusEventPage> =>
        await this.events.list(page, signal);

    readonly close = (): void => this.events.close();
}
