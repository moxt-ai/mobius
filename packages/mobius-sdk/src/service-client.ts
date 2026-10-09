import {
    type AgentSettingsDiscoveredEvent,
    type Attempt,
    decodeAgentSettingsDiscoveredEvent,
    decodeMobiusSessionExportV2,
    decodeNativeSessionEventsV2,
    decodeNativeSessionResult,
    decodeSessionConfigUpdatedEvent,
    decodeSessionEventBatchV2,
    decodeSessionEventLogPageV2,
    decodeSessionReadyEvent,
    decodeSessionsListedEvent,
    decodeSessionsQueriedEvent,
    decodeWorkspaceEntriesEvent,
    type ExternalAudioContentBlockV2,
    type ExternalImageContentBlockV2,
    type ExternalResourceContentBlockV2,
    type Interaction,
    isIdentifier,
    MOBIUS_API_PREFIX,
    type MobiusSessionExportV2,
    type NativeEventPageRequestV2,
    type NativeSessionEventsV2,
    type NativeSessionRequest,
    type NativeSessionResult,
    type SessionConfigureCommand,
    type SessionEventBatchV2,
    type SessionEventLogPageV2,
    SessionPromptDisposition,
    type WorkspaceEntriesEvent,
} from "@moxt-ai/mobius-protocol";

import {
    MobiusApiError,
    MobiusCancellationError,
    MobiusConnectionError,
    MobiusError,
    MobiusProtocolError,
    MobiusTimeoutError,
    MobiusValidationError,
} from "./errors.ts";
import { MobiusPublicRequestExecutor } from "./public-request.ts";
import {
    type CancelMobiusTurnRequest,
    type ConfigureMobiusSessionRequest,
    type CreateMobiusSessionRequest,
    decodeMobiusAttempt,
    decodeMobiusBrowserCredential,
    decodeMobiusChannelAccessGrant,
    decodeMobiusChannelDescriptor,
    decodeMobiusInteraction,
    decodeMobiusInteractionList,
    decodeMobiusLinkedChannelDeviceList,
    decodeMobiusMessagePage,
    decodeMobiusRedeemedChannelCredential,
    decodeMobiusRuntimeList,
    decodeMobiusRuntimePairing,
    decodeMobiusRuntimePairingStatus,
    decodeMobiusServiceCapabilities,
    decodeMobiusSession,
    decodeMobiusSessionExport,
    decodeMobiusSessionPage,
    decodeMobiusSessionState,
    decodeMobiusToolCallDetail,
    decodeMobiusTurn,
    decodeRuntimeDescriptor,
    type MobiusBrowserCredential,
    type MobiusBrowserCredentialRequest,
    type MobiusChannelAccessGrant,
    type MobiusChannelDescriptor,
    type MobiusInteractionResponseRequest,
    type MobiusLinkedChannelDevice,
    type MobiusMessagePage,
    type MobiusPageRequest,
    MobiusPairedRuntimePairingStatus,
    type MobiusRedeemedChannelCredential,
    type MobiusRuntimeDescriptor,
    type MobiusRuntimePairing,
    MobiusRuntimePairingLifecycle,
    type MobiusRuntimePairingRequest,
    type MobiusRuntimePairingStatus,
    type MobiusRuntimePairingWaitOptions,
    type MobiusServiceCapabilities,
    type MobiusSession,
    MobiusSessionAccess,
    type MobiusSessionExport,
    type MobiusSessionImportBinding,
    type MobiusSessionPage,
    type MobiusSessionState,
    type MobiusToolCallDetail,
    type MobiusTurn,
    type SubmitMobiusTurnRequest,
} from "./resources.ts";

import {
    HttpTransport,
    isMobiusLiveEventTransport,
    type MobiusHttpTransport,
    type MobiusTransportSessionEvent,
} from "./transport/http-transport.ts";

const DEFAULT_OPERATION_TIMEOUT_MILLISECONDS = 20_000;
const DEFAULT_STREAM_CONNECTION_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_STREAM_LIVENESS_TIMEOUT_MILLISECONDS = 45_000;
const DEFAULT_STREAM_RECONNECT_ATTEMPTS = 4;

export interface MobiusCredentialProvider {
    readonly credential: (signal: AbortSignal) => Promise<string>;
}

export interface DiscoverMobiusAgentSettingsRequest {
    readonly model?: string;
}

export type MobiusExternalContentBlock =
    | ExternalImageContentBlockV2
    | ExternalAudioContentBlockV2
    | ExternalResourceContentBlockV2;

export function externalContentPath(content: MobiusExternalContentBlock): string {
    let kind: "audio" | "image" | "resource";
    let key: string;
    switch (content.type) {
        case "external_image":
            kind = "image";
            key = content.imageKey;
            break;
        case "external_audio":
            kind = "audio";
            key = content.audioKey;
            break;
        case "external_resource":
            kind = "resource";
            key = content.resourceKey;
            break;
        default:
            throw new MobiusValidationError("The external content reference is invalid");
    }
    if (!/^[a-f0-9]{64}$/u.test(key)) {
        throw new MobiusValidationError("The external content key is invalid");
    }
    return `mobius-content:${kind}:${key}`;
}

export class StaticMobiusCredentialProvider implements MobiusCredentialProvider {
    readonly #token: string;

    constructor(token: string) {
        this.#token = validateCredential(token);
    }

    readonly credential = async (signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        return this.#token;
    };
}

function validateCredential(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length < 1 ||
        value.length > 4_096 ||
        value.includes("\r") ||
        value.includes("\n")
    ) {
        throw new MobiusValidationError("The Mobius credential is invalid");
    }
    return value;
}

export interface MobiusResponseMetadata {
    readonly serverTiming: string | null;
    readonly status: number;
}

export interface MobiusEndpointOptions {
    readonly authenticationProviderId?: string;
    readonly credentialProvider: MobiusCredentialProvider;
    readonly endpoint: string;
    readonly maxStreamReconnectAttempts?: number;
    readonly observeResponse?: (metadata: MobiusResponseMetadata) => void;
    readonly operationTimeoutMilliseconds?: number;
    readonly streamConnectionTimeoutMilliseconds?: number;
    readonly streamLivenessTimeoutMilliseconds?: number;
    readonly transport?: MobiusHttpTransport;
}

export interface MobiusClientOptions extends MobiusEndpointOptions {
    readonly projectId: string;
}

function validatePositiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new MobiusValidationError(`The ${name} is invalid`);
    }
    return value;
}

function normalizeEndpoint(value: string): URL {
    let endpoint: URL;
    try {
        endpoint = new URL(value);
    } catch (cause) {
        throw new MobiusValidationError("The Mobius endpoint is invalid", {
            cause,
        });
    }
    if (
        (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
        endpoint.username.length > 0 ||
        endpoint.password.length > 0 ||
        endpoint.search.length > 0 ||
        endpoint.hash.length > 0
    ) {
        throw new MobiusValidationError("The Mobius endpoint is invalid");
    }
    if (endpoint.pathname === "/") {
        endpoint.pathname = `${MOBIUS_API_PREFIX}/`;
    } else if (!endpoint.pathname.endsWith("/")) {
        endpoint.pathname = `${endpoint.pathname}/`;
    }
    return endpoint;
}

function projectPath(projectId: string, resourcePath: string): string {
    if (!isIdentifier(projectId)) {
        throw new MobiusValidationError("The Mobius project identifier is invalid");
    }
    return `v1/projects/${encodeURIComponent(projectId)}/${resourcePath}`;
}

function sessionPath(projectId: string, sessionId: string, resourcePath: string): string {
    if (!isIdentifier(sessionId)) {
        throw new MobiusValidationError("The Mobius Session identifier is invalid");
    }
    return projectPath(projectId, `sessions/${encodeURIComponent(sessionId)}/${resourcePath}`);
}

function requestUrl(endpoint: URL, path: string): URL {
    return new URL(path, endpoint);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
        throw new MobiusProtocolError("The service returned an invalid error response");
    }
    return value;
}

async function responseValue(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch (cause) {
        throw new MobiusProtocolError("The service returned invalid JSON", {
            cause,
        });
    }
}

async function throwApiError(response: Response): Promise<never> {
    const value = record(await responseValue(response));
    const error = record(value["error"]);
    const code = error["code"];
    const message = error["message"];
    if (typeof code !== "string" || typeof message !== "string") {
        throw new MobiusProtocolError("The service returned an invalid error response");
    }
    throw new MobiusApiError(code, message, response.status);
}

class RequestDeadline {
    readonly #controller = new AbortController();
    readonly #requestSignal: AbortSignal;
    readonly #timeoutId: ReturnType<typeof globalThis.setTimeout>;
    #timedOut = false;

    constructor(requestSignal: AbortSignal, timeoutMilliseconds: number) {
        this.#requestSignal = requestSignal;
        if (requestSignal.aborted) {
            this.#controller.abort(requestSignal.reason);
        } else {
            requestSignal.addEventListener("abort", this.abortFromRequest, {
                once: true,
            });
        }
        this.#timeoutId = globalThis.setTimeout(this.abortFromTimeout, timeoutMilliseconds);
    }

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    readonly finish = (): void => {
        globalThis.clearTimeout(this.#timeoutId);
        this.#requestSignal.removeEventListener("abort", this.abortFromRequest);
    };

    readonly translate = (cause: unknown): never => {
        if (this.#requestSignal.aborted) {
            throw new MobiusCancellationError({ cause });
        }
        if (this.#timedOut) {
            throw new MobiusTimeoutError({ cause });
        }
        if (cause instanceof MobiusError) {
            throw cause;
        }
        throw new MobiusConnectionError("The Mobius service could not be reached", {
            cause,
        });
    };

    private readonly abortFromRequest = (): void => {
        this.#controller.abort(this.#requestSignal.reason);
    };

    private readonly abortFromTimeout = (): void => {
        this.#timedOut = true;
        this.#controller.abort(new Error("The Mobius operation timed out"));
    };
}

class LiveEventConnection {
    readonly events: ReadableStream<MobiusTransportSessionEvent>;
    readonly #controller: AbortController;
    readonly #release: () => void;
    #closed = false;

    constructor(events: ReadableStream<MobiusTransportSessionEvent>, controller: AbortController, release: () => void) {
        this.events = events;
        this.#controller = controller;
        this.#release = release;
    }

    readonly close = (): void => {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#controller.abort(new Error("The live Session event connection closed"));
        this.#release();
    };
}

export class MobiusRequestExecutor {
    readonly #authenticationProviderId: string;
    readonly #credentialProvider: MobiusCredentialProvider;
    readonly #endpoint: URL;
    readonly #operationTimeoutMilliseconds: number;
    readonly #observeResponse: ((metadata: MobiusResponseMetadata) => void) | undefined;
    readonly #streamConnectionTimeoutMilliseconds: number;
    readonly #streamLivenessTimeoutMilliseconds: number;
    readonly #transport: MobiusHttpTransport;

    constructor(options: MobiusEndpointOptions) {
        const authenticationProviderId = options.authenticationProviderId ?? "";
        if (
            authenticationProviderId.length > 128 ||
            authenticationProviderId.includes("\r") ||
            authenticationProviderId.includes("\n")
        ) {
            throw new MobiusValidationError("The Mobius authentication provider identifier is invalid");
        }
        this.#authenticationProviderId = authenticationProviderId;
        this.#credentialProvider = options.credentialProvider;
        this.#endpoint = normalizeEndpoint(options.endpoint);
        this.#operationTimeoutMilliseconds = validatePositiveInteger(
            options.operationTimeoutMilliseconds ?? DEFAULT_OPERATION_TIMEOUT_MILLISECONDS,
            "operation timeout",
        );
        this.#observeResponse = options.observeResponse;
        this.#streamConnectionTimeoutMilliseconds = validatePositiveInteger(
            options.streamConnectionTimeoutMilliseconds ?? DEFAULT_STREAM_CONNECTION_TIMEOUT_MILLISECONDS,
            "stream connection timeout",
        );
        this.#streamLivenessTimeoutMilliseconds = validatePositiveInteger(
            options.streamLivenessTimeoutMilliseconds ?? DEFAULT_STREAM_LIVENESS_TIMEOUT_MILLISECONDS,
            "stream liveness timeout",
        );
        this.#transport = options.transport ?? new HttpTransport();
    }

    readonly get = async (path: string, signal: AbortSignal): Promise<unknown> =>
        await this.request(path, "GET", "", false, signal);

    readonly getFile = async (
        path: string,
        maximumBytes: number,
        signal: AbortSignal,
    ): Promise<{
        readonly bytes: Uint8Array;
        readonly mediaType: string;
        readonly modifiedAt: string;
        readonly name: string;
    }> => {
        const deadline = new RequestDeadline(signal, this.#operationTimeoutMilliseconds);
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(deadline.signal));
            const response = await this.#transport.fetch(
                new Request(requestUrl(this.#endpoint, path), {
                    headers: this.authenticationHeaders(credential, "application/octet-stream"),
                    signal: deadline.signal,
                }),
            );
            this.#observeResponse?.({
                serverTiming: response.headers.get("server-timing"),
                status: response.status,
            });
            if (!response.ok) {
                await throwApiError(response);
            }
            const mediaType = response.headers.get("content-type") ?? "";
            const modifiedAt = response.headers.get("last-modified") ?? "";
            const encodedName = response.headers.get("x-mobius-file-name") ?? "";
            const encodedLength = response.headers.get("x-mobius-byte-length") ?? "";
            if (
                mediaType.length === 0 ||
                mediaType.length > 255 ||
                modifiedAt.length === 0 ||
                !/^\d+$/.test(encodedLength)
            ) {
                throw new MobiusProtocolError("The service returned invalid file metadata");
            }
            const byteLength = Number(encodedLength);
            if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > maximumBytes) {
                throw new MobiusProtocolError("The service returned an invalid file size");
            }
            let name: string;
            try {
                name = decodeURIComponent(encodedName);
            } catch (cause) {
                throw new MobiusProtocolError("The service returned an invalid file name", { cause });
            }
            return {
                bytes: await readExactResponseBytes(response, byteLength, deadline.signal, false),
                mediaType,
                modifiedAt,
                name,
            };
        } catch (cause) {
            return deadline.translate(cause);
        } finally {
            deadline.finish();
        }
    };

    readonly post = async (path: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
        const encoded = JSON.stringify(body);
        if (typeof encoded !== "string") {
            throw new MobiusValidationError("The Mobius request body is invalid");
        }
        return await this.request(path, "POST", encoded, true, signal);
    };

    readonly put = async (path: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
        const encoded = JSON.stringify(body);
        if (typeof encoded !== "string") {
            throw new MobiusValidationError("The Mobius request body is invalid");
        }
        return await this.request(path, "PUT", encoded, true, signal);
    };

    readonly delete = async (path: string, signal: AbortSignal): Promise<unknown> =>
        await this.request(path, "DELETE", "", false, signal);

    readonly deleteEmpty = async (path: string, signal: AbortSignal): Promise<void> => {
        await this.requestEmpty(path, "DELETE", signal);
    };

    readonly openLiveEventStream = async (path: string, signal: AbortSignal): Promise<LiveEventConnection> => {
        if (!isMobiusLiveEventTransport(this.#transport)) {
            throw new MobiusValidationError("The configured transport does not support live Session events");
        }
        const controller = new AbortController();
        const abort = (): void => controller.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        const timeoutId = globalThis.setTimeout(
            () => controller.abort(new Error("The live Session event connection timed out")),
            this.#streamConnectionTimeoutMilliseconds,
        );
        const release = (): void => {
            globalThis.clearTimeout(timeoutId);
            signal.removeEventListener("abort", abort);
        };
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(controller.signal));
            const events = await this.#transport.openLiveSessionEvents(
                new Request(requestUrl(this.#endpoint, path), {
                    headers: this.authenticationHeaders(credential, "application/json"),
                    signal: controller.signal,
                }),
            );
            globalThis.clearTimeout(timeoutId);
            return new LiveEventConnection(events, controller, release);
        } catch (cause) {
            release();
            if (signal.aborted) {
                throw new MobiusCancellationError({ cause });
            }
            if (cause instanceof MobiusError) {
                throw cause;
            }
            throw new MobiusConnectionError("The live Session event stream could not connect", { cause });
        }
    };

    private readonly request = async (
        path: string,
        method: string,
        body: string,
        hasBody: boolean,
        signal: AbortSignal,
    ): Promise<unknown> => {
        const deadline = new RequestDeadline(signal, this.#operationTimeoutMilliseconds);
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(deadline.signal));
            const headers = this.authenticationHeaders(credential, "application/json");
            if (hasBody) {
                headers.set("content-type", "application/json");
            }
            const response = await this.#transport.fetch(
                new Request(requestUrl(this.#endpoint, path), {
                    body: hasBody ? body : null,
                    headers,
                    method,
                    signal: deadline.signal,
                }),
            );
            this.#observeResponse?.({
                serverTiming: response.headers.get("server-timing"),
                status: response.status,
            });
            if (!response.ok) {
                await throwApiError(response);
            }
            return await responseValue(response);
        } catch (cause) {
            return deadline.translate(cause);
        } finally {
            deadline.finish();
        }
    };

    private readonly requestEmpty = async (path: string, method: string, signal: AbortSignal): Promise<void> => {
        const deadline = new RequestDeadline(signal, this.#operationTimeoutMilliseconds);
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(deadline.signal));
            const response = await this.#transport.fetch(
                new Request(requestUrl(this.#endpoint, path), {
                    headers: this.authenticationHeaders(credential, "application/json"),
                    method,
                    signal: deadline.signal,
                }),
            );
            this.#observeResponse?.({
                serverTiming: response.headers.get("server-timing"),
                status: response.status,
            });
            if (!response.ok) {
                await throwApiError(response);
            }
            if (response.status !== 204) {
                throw new MobiusProtocolError("The service returned an invalid empty response");
            }
        } catch (cause) {
            return deadline.translate(cause);
        } finally {
            deadline.finish();
        }
    };

    private readonly authenticationHeaders = (credential: string, accept: string): Headers => {
        const headers = new Headers({ accept, authorization: `Bearer ${credential}` });
        if (this.#authenticationProviderId.length > 0) {
            headers.set("x-mobius-oidc-provider", this.#authenticationProviderId);
        }
        return headers;
    };
}

export async function readExactResponseBytes(
    response: Response,
    expectedByteLength: number,
    signal: AbortSignal,
    verifyDigest = true,
): Promise<Uint8Array> {
    const declaredLength = response.headers.get("content-length");
    if (
        declaredLength !== null &&
        (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) !== expectedByteLength)
    ) {
        throw new MobiusProtocolError("The service returned an invalid artifact length");
    }
    const reader = response.body?.getReader();
    if (reader === undefined) {
        throw new MobiusProtocolError("The service returned no artifact content");
    }
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) {
                break;
            }
            byteLength += chunk.value.byteLength;
            if (byteLength > expectedByteLength) {
                await reader.cancel("Artifact response exceeded its metadata");
                throw new MobiusProtocolError("The service returned an oversized artifact");
            }
            chunks.push(chunk.value);
        }
    } finally {
        reader.releaseLock();
    }
    if (byteLength !== expectedByteLength) {
        throw new MobiusProtocolError("The service returned an incomplete artifact");
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    if (verifyDigest) {
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        signal.throwIfAborted();
        const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        if (sha256 !== response.headers.get("x-mobius-sha256")) {
            throw new MobiusProtocolError("The service returned artifact content with an invalid digest");
        }
    }
    return bytes;
}

export class MobiusCapabilityResources {
    readonly #executor: MobiusRequestExecutor;

    constructor(executor: MobiusRequestExecutor) {
        this.#executor = executor;
    }

    readonly read = async (signal: AbortSignal): Promise<MobiusServiceCapabilities> =>
        decodeMobiusServiceCapabilities(await this.#executor.get("capabilities", signal));
}

export class MobiusCredentialResources {
    readonly #executor: MobiusRequestExecutor;
    readonly #projectId: string;

    constructor(executor: MobiusRequestExecutor, projectId: string) {
        this.#executor = executor;
        this.#projectId = projectId;
    }

    readonly issue = async (
        request: MobiusBrowserCredentialRequest,
        signal: AbortSignal,
    ): Promise<MobiusBrowserCredential> =>
        decodeMobiusBrowserCredential(
            await this.#executor.post(projectPath(this.#projectId, "browser-credentials"), request, signal),
        );

    readonly revoke = async (credentialId: string, signal: AbortSignal): Promise<void> => {
        if (!isIdentifier(credentialId)) {
            throw new MobiusValidationError("The browser credential identifier is invalid");
        }
        await this.#executor.deleteEmpty(
            projectPath(this.#projectId, `browser-credentials/${encodeURIComponent(credentialId)}`),
            signal,
        );
    };
}

export class MobiusChannelResources {
    readonly #executor: MobiusRequestExecutor;

    constructor(executor: MobiusRequestExecutor) {
        this.#executor = executor;
    }

    readonly createAccessGrant = async (channelId: string, signal: AbortSignal): Promise<MobiusChannelAccessGrant> => {
        if (!isIdentifier(channelId)) {
            throw new MobiusValidationError("The channel identifier is invalid");
        }
        return decodeMobiusChannelAccessGrant(
            await this.#executor.post(`channels/${encodeURIComponent(channelId)}/access-grants`, {}, signal),
        );
    };

    readonly listLinkedDevices = async (
        channelId: string,
        signal: AbortSignal,
    ): Promise<readonly MobiusLinkedChannelDevice[]> => {
        if (!isIdentifier(channelId)) {
            throw new MobiusValidationError("The channel identifier is invalid");
        }
        return decodeMobiusLinkedChannelDeviceList(
            await this.#executor.get(`channels/${encodeURIComponent(channelId)}/linked-devices`, signal),
        );
    };

    readonly read = async (channelId: string, signal: AbortSignal): Promise<MobiusChannelDescriptor> => {
        if (!isIdentifier(channelId)) {
            throw new MobiusValidationError("The channel identifier is invalid");
        }
        return decodeMobiusChannelDescriptor(
            await this.#executor.get(`channels/${encodeURIComponent(channelId)}`, signal),
        );
    };

    readonly revokeLinkedDevice = async (
        channelId: string,
        credentialId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        if (!isIdentifier(channelId) || !isIdentifier(credentialId)) {
            throw new MobiusValidationError("The linked channel device identifier is invalid");
        }
        await this.#executor.deleteEmpty(
            `channels/${encodeURIComponent(channelId)}/linked-devices/${encodeURIComponent(credentialId)}`,
            signal,
        );
    };
}

export interface MobiusChannelAccessClientOptions {
    readonly endpoint: string;
    readonly observeResponse?: (metadata: MobiusResponseMetadata) => void;
    readonly operationTimeoutMilliseconds?: number;
    readonly transport?: MobiusHttpTransport;
}

export class MobiusChannelAccessClient {
    readonly #requests: MobiusPublicRequestExecutor;

    constructor(options: MobiusChannelAccessClientOptions) {
        this.#requests = new MobiusPublicRequestExecutor(options);
    }

    readonly redeem = async (
        channelId: string,
        grantId: string,
        grantSecret: string,
        signal: AbortSignal,
    ): Promise<MobiusRedeemedChannelCredential> => {
        if (!isIdentifier(channelId) || !isIdentifier(grantId) || !/^[a-zA-Z0-9_-]{32,256}$/.test(grantSecret)) {
            throw new MobiusValidationError("The channel access grant is invalid");
        }
        const credential = decodeMobiusRedeemedChannelCredential(
            await this.#requests.post(
                `channels/${encodeURIComponent(channelId)}/access-grants/${encodeURIComponent(grantId)}/redeem`,
                { grantSecret },
                signal,
            ),
        );
        if (credential.channelId !== channelId) {
            throw new MobiusProtocolError("The service returned a credential for another channel");
        }
        return credential;
    };
}

export class MobiusRuntimeResources {
    readonly #executor: MobiusRequestExecutor;
    readonly #projectId: string;

    constructor(executor: MobiusRequestExecutor, projectId: string) {
        this.#executor = executor;
        this.#projectId = projectId;
    }

    readonly list = async (signal: AbortSignal): Promise<readonly MobiusRuntimeDescriptor[]> =>
        decodeMobiusRuntimeList(await this.#executor.get(projectPath(this.#projectId, "runtimes"), signal));

    readonly getAgents = async (runtimeId: string, signal: AbortSignal) =>
        decodeRuntimeDescriptor(
            await this.#executor.get(
                projectPath(this.#projectId, `runtimes/${encodeURIComponent(runtimeId)}/agents`),
                signal,
            ),
        ).agents;

    readonly listWorkspace = async (
        runtimeId: string,
        directoryId: string,
        signal: AbortSignal,
    ): Promise<WorkspaceEntriesEvent> =>
        decodeWorkspaceEntriesEvent(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(this.#projectId, `runtimes/${encodeURIComponent(runtimeId)}/workspace`),
                    { directoryId },
                    signal,
                ),
            ),
        );

    readonly discoverAgentSettings = async (
        runtimeId: string,
        agentId: string,
        request: DiscoverMobiusAgentSettingsRequest,
        signal: AbortSignal,
    ): Promise<AgentSettingsDiscoveredEvent> =>
        decodeAgentSettingsDiscoveredEvent(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(
                        this.#projectId,
                        `runtimes/${encodeURIComponent(runtimeId)}/agents/${encodeURIComponent(agentId)}/settings`,
                    ),
                    request,
                    signal,
                ),
            ),
        );

    readonly nativeSessions = async (
        runtimeId: string,
        request:
            | (Omit<
                  Extract<NativeSessionRequest, { readonly action: "list" }>,
                  "kind" | "requestId" | "sessionId" | "bindingId"
              > & { readonly discoveryId: string | null })
            | (Omit<
                  Extract<NativeSessionRequest, { readonly action: "import" | "fork" }>,
                  "kind" | "requestId" | "sessionId" | "targetSessionId" | "bindingId" | "action"
              > & { readonly action: "import" | "fork"; readonly discoveryId: string }),
        signal: AbortSignal,
    ) =>
        decodeNativeSessionResult(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(this.#projectId, `runtimes/${encodeURIComponent(runtimeId)}/native-sessions`),
                    request,
                    signal,
                ),
            ),
        );

    readonly querySessions = async (runtimeId: string, sessionIds: readonly string[], signal: AbortSignal) =>
        decodeSessionsQueriedEvent(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(this.#projectId, `runtimes/${encodeURIComponent(runtimeId)}/sessions/query`),
                    { sessionIds },
                    signal,
                ),
            ),
        ).entries;

    readonly listSessions = async (runtimeId: string, limit: number, signal: AbortSignal) => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
            throw new MobiusValidationError("The Runtime Session list limit is invalid");
        }
        const path = requestUrl(
            new URL("https://mobius.invalid/"),
            projectPath(this.#projectId, `runtimes/${encodeURIComponent(runtimeId)}/sessions`),
        );
        path.searchParams.set("limit", limit.toString());
        return decodeSessionsListedEvent(
            JSON.stringify(await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal)),
        ).entries;
    };

    readonly findNativeSessionByNativeSessionId = async (
        runtimeId: string,
        request: Omit<
            Extract<NativeSessionRequest, { readonly action: "find" }>,
            "kind" | "requestId" | "sessionId" | "bindingId" | "action"
        >,
        signal: AbortSignal,
    ) => {
        const result = decodeNativeSessionResult(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(this.#projectId, `runtimes/${encodeURIComponent(runtimeId)}/native-sessions`),
                    { ...request, action: "find" },
                    signal,
                ),
            ),
        );
        if (result.action !== "find") {
            throw new MobiusProtocolError("The service returned an invalid native Session lookup");
        }
        return result;
    };

    readonly revoke = async (runtimeId: string, signal: AbortSignal): Promise<void> => {
        if (!isIdentifier(runtimeId)) {
            throw new MobiusValidationError("The Runtime identifier is invalid");
        }
        await this.#executor.deleteEmpty(
            projectPath(this.#projectId, `runtimes/${encodeURIComponent(runtimeId)}`),
            signal,
        );
    };
}

export class MobiusRuntimePairingResources {
    readonly #executor: MobiusRequestExecutor;
    readonly #projectId: string;

    constructor(executor: MobiusRequestExecutor, projectId: string) {
        this.#executor = executor;
        this.#projectId = projectId;
    }

    readonly create = async (
        request: MobiusRuntimePairingRequest,
        signal: AbortSignal,
    ): Promise<MobiusRuntimePairing> =>
        decodeMobiusRuntimePairing(
            await this.#executor.post(projectPath(this.#projectId, "runtime-pairings"), request, signal),
        );

    readonly read = async (pairingId: string, signal: AbortSignal): Promise<MobiusRuntimePairingStatus> => {
        if (!isIdentifier(pairingId)) {
            throw new MobiusValidationError("The Runtime pairing identifier is invalid");
        }
        return decodeMobiusRuntimePairingStatus(
            await this.#executor.get(
                projectPath(this.#projectId, `runtime-pairings/${encodeURIComponent(pairingId)}`),
                signal,
            ),
        );
    };

    readonly waitUntilPaired = async (
        pairingId: string,
        options: MobiusRuntimePairingWaitOptions,
        signal: AbortSignal,
    ): Promise<MobiusPairedRuntimePairingStatus> => {
        const deadline = Date.now() + options.timeoutMilliseconds;
        while (true) {
            if (signal.aborted) {
                throw new MobiusCancellationError({ cause: signal.reason });
            }
            const status = await this.read(pairingId, signal);
            if (status instanceof MobiusPairedRuntimePairingStatus) {
                return status;
            }
            if (status.status === MobiusRuntimePairingLifecycle.Expired) {
                throw new MobiusApiError("runtime_pairing_expired", "The Runtime pairing expired", 410);
            }
            if (status.status === MobiusRuntimePairingLifecycle.Revoked) {
                throw new MobiusApiError("runtime_pairing_revoked", "The Runtime pairing was revoked", 410);
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new MobiusTimeoutError();
            }
            await waitForPairingPoll(Math.min(options.pollIntervalMilliseconds, remaining), signal);
        }
    };
}

function waitForPairingPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.reject(new MobiusCancellationError({ cause: signal.reason }));
    }
    return new Promise((resolve, reject) => {
        const timeout = globalThis.setTimeout(() => {
            signal.removeEventListener("abort", cancel);
            resolve();
        }, milliseconds);
        const cancel = (): void => {
            globalThis.clearTimeout(timeout);
            reject(new MobiusCancellationError({ cause: signal.reason }));
        };
        signal.addEventListener("abort", cancel, { once: true });
    });
}

export class MobiusSessionResources {
    readonly #executor: MobiusRequestExecutor;
    readonly #projectId: string;

    constructor(executor: MobiusRequestExecutor, projectId: string) {
        this.#executor = executor;
        this.#projectId = projectId;
    }

    readonly create = async (request: CreateMobiusSessionRequest, signal: AbortSignal) =>
        decodeSessionReadyEvent(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(this.#projectId, `runtimes/${encodeURIComponent(request.runtimeId)}/sessions`),
                    request,
                    signal,
                ),
            ),
        );

    readonly createAccess = async (
        runtimeId: string,
        sessionId: string,
        expiresInSeconds: number,
        signal: AbortSignal,
    ) =>
        new MobiusSessionAccess(
            await this.#executor.post(
                sessionPath(this.#projectId, sessionId, "access-credentials"),
                { expiresInSeconds, runtimeId },
                signal,
            ),
        );

    readonly load = async (
        runtimeId: string,
        sessionId: string,
        request: {
            readonly additionalDirectoryIds: readonly string[];
            readonly agentId: string;
            readonly directoryId: string;
        },
        signal: AbortSignal,
    ) =>
        decodeSessionReadyEvent(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(
                        this.#projectId,
                        `runtimes/${encodeURIComponent(runtimeId)}/sessions/${encodeURIComponent(sessionId)}/load`,
                    ),
                    request,
                    signal,
                ),
            ),
        );

    readonly updateConfiguration = async (
        ...operation:
            | readonly [
                  runtimeId: string,
                  sessionId: string,
                  request: Omit<SessionConfigureCommand, "bindingId" | "kind" | "requestId" | "sessionId">,
                  signal: AbortSignal,
              ]
            | readonly [
                  sessionId: string,
                  request: Pick<
                      SessionConfigureCommand,
                      | "additionalDirectoryIds"
                      | "agentId"
                      | "booleanValue"
                      | "configId"
                      | "directoryId"
                      | "value"
                      | "valueType"
                  >,
                  signal: AbortSignal,
              ]
    ) => {
        const result =
            operation.length === 3
                ? await this.#executor.post(
                      sessionPath(this.#projectId, operation[0], "configuration"),
                      operation[1],
                      operation[2],
                  )
                : await this.#executor.post(
                      projectPath(
                          this.#projectId,
                          `runtimes/${encodeURIComponent(operation[0])}/sessions/${encodeURIComponent(operation[1])}/configuration`,
                      ),
                      operation[2],
                      operation[3],
                  );
        return decodeSessionConfigUpdatedEvent(JSON.stringify(result));
    };

    readonly configure = async (
        sessionId: string,
        request: ConfigureMobiusSessionRequest,
        signal: AbortSignal,
    ): Promise<MobiusSession> =>
        decodeMobiusSession(
            await this.#executor.put(sessionPath(this.#projectId, sessionId, "binding"), request, signal),
        );

    readonly delete = async (sessionId: string, signal: AbortSignal): Promise<MobiusSessionState> =>
        decodeMobiusSessionState(
            await this.#executor.delete(sessionPath(this.#projectId, sessionId, "").slice(0, -1), signal),
        );

    readonly export = async (sessionId: string, signal: AbortSignal): Promise<MobiusSessionExport> =>
        decodeMobiusSessionExport(await this.#executor.get(sessionPath(this.#projectId, sessionId, "export"), signal));

    readonly exportV2 = async (sessionId: string, signal: AbortSignal): Promise<MobiusSessionExportV2> =>
        decodeMobiusSessionExportV2(
            await this.#executor.get(sessionPath(this.#projectId, sessionId, "export-v2"), signal),
        );

    readonly import = async (
        exported: MobiusSessionExport,
        targetBinding: MobiusSessionImportBinding,
        signal: AbortSignal,
    ): Promise<MobiusSession> =>
        decodeMobiusSession(
            await this.#executor.post(
                projectPath(this.#projectId, "session-imports"),
                {
                    formatVersion: exported.formatVersion,
                    session: exported.session,
                    targetBinding,
                },
                signal,
            ),
        );

    readonly importV2 = async (
        exported: MobiusSessionExportV2,
        targetBinding: MobiusSessionImportBinding,
        signal: AbortSignal,
    ): Promise<MobiusSession> => {
        const validated = decodeMobiusSessionExportV2(exported);
        return decodeMobiusSession(
            await this.#executor.post(
                projectPath(this.#projectId, "session-imports-v2"),
                { ...validated, targetBinding },
                signal,
            ),
        );
    };

    readonly forkRecordedV2 = async (
        sessionId: string,
        request: {
            readonly throughEventId: string;
            readonly targetBinding: MobiusSessionImportBinding;
        },
        signal: AbortSignal,
    ): Promise<MobiusSession> =>
        decodeMobiusSession(
            await this.#executor.post(sessionPath(this.#projectId, sessionId, "forks-v2"), request, signal),
        );

    readonly read = async (sessionId: string, signal: AbortSignal): Promise<MobiusSession> =>
        decodeMobiusSession(await this.#executor.get(sessionPath(this.#projectId, sessionId, "").slice(0, -1), signal));

    readonly readFile = async (
        sessionId: string,
        path: string,
        signal: AbortSignal,
        maximumBytes = 32 * 1024 * 1024,
    ): Promise<{
        readonly bytes: Uint8Array;
        readonly mediaType: string;
        readonly modifiedAt: string;
        readonly name: string;
    }> => {
        if (path.length === 0 || path.length > 4_096) {
            throw new MobiusValidationError("The file path is invalid");
        }
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 128 * 1024 * 1024) {
            throw new MobiusValidationError("The file size limit is invalid");
        }
        const query = new URLSearchParams({ maxBytes: maximumBytes.toString(), path });
        return await this.#executor.getFile(
            `${sessionPath(this.#projectId, sessionId, "files/content")}?${query.toString()}`,
            maximumBytes,
            signal,
        );
    };

    readonly readExternalContent = async (
        sessionId: string,
        content: MobiusExternalContentBlock,
        signal: AbortSignal,
        maximumBytes = content.byteLength,
    ): ReturnType<MobiusSessionResources["readFile"]> =>
        await this.readFile(sessionId, externalContentPath(content), signal, maximumBytes);

    readonly list = async (page: MobiusPageRequest, signal: AbortSignal): Promise<MobiusSessionPage> => {
        const path = requestUrl(new URL("https://mobius.invalid/"), projectPath(this.#projectId, "sessions"));
        path.searchParams.set("limit", page.limit.toString());
        if (page.cursor.length > 0) {
            path.searchParams.set("cursor", page.cursor);
        }
        return decodeMobiusSessionPage(await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal));
    };

    readonly readMessages = async (
        sessionId: string,
        page: MobiusPageRequest,
        signal: AbortSignal,
    ): Promise<MobiusMessagePage> => {
        const path = requestUrl(
            new URL("https://mobius.invalid/"),
            sessionPath(this.#projectId, sessionId, "messages"),
        );
        path.searchParams.set("limit", page.limit.toString());
        if (page.cursor.length > 0) {
            path.searchParams.set("cursor", page.cursor);
        }
        return decodeMobiusMessagePage(await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal));
    };

    readonly queryRuntimeNativeEventsV2 = async (
        runtimeId: string,
        sessionId: string,
        identity: {
            readonly additionalDirectoryIds: readonly string[];
            readonly agentId: string;
            readonly directoryId: string;
        },
        page: NativeEventPageRequestV2,
        signal: AbortSignal,
    ): Promise<NativeSessionEventsV2> => {
        const result = await this.#executor.post(
            projectPath(
                this.#projectId,
                `runtimes/${encodeURIComponent(runtimeId)}/sessions/${encodeURIComponent(sessionId)}/native-events-v2`,
            ),
            { ...identity, cursor: page.cursor, eventLimit: page.eventLimit },
            signal,
        );
        return decodeNativeSessionEventsV2(result);
    };

    readonly querySessionNativeEventsV2 = async (
        sessionId: string,
        identity: {
            readonly additionalDirectoryIds: readonly string[];
            readonly agentId: string;
            readonly directoryId: string;
        },
        page: NativeEventPageRequestV2,
        signal: AbortSignal,
    ): Promise<NativeSessionEventsV2> => {
        const path = requestUrl(
            new URL("https://mobius.invalid/"),
            sessionPath(this.#projectId, sessionId, "native-events-v2"),
        );
        path.searchParams.set("agentId", identity.agentId);
        path.searchParams.set("directoryId", identity.directoryId);
        path.searchParams.set("eventLimit", page.eventLimit.toString());
        if (page.cursor !== null) {
            path.searchParams.set("cursor", page.cursor);
        }
        for (const directoryId of identity.additionalDirectoryIds) {
            path.searchParams.append("additionalDirectoryId", directoryId);
        }
        return decodeNativeSessionEventsV2(await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal));
    };

    readonly readSessionExecution = async (
        sessionId: string,
        identity: {
            readonly additionalDirectoryIds: readonly string[];
            readonly agentId: string;
            readonly directoryId: string;
        },
        signal: AbortSignal,
    ): Promise<Pick<Extract<NativeSessionResult, { readonly action: "active-turn" }>, "turn" | "queued">> => {
        const path = requestUrl(
            new URL("https://mobius.invalid/"),
            sessionPath(this.#projectId, sessionId, "active-turn"),
        );
        path.searchParams.set("agentId", identity.agentId);
        path.searchParams.set("directoryId", identity.directoryId);
        for (const directoryId of identity.additionalDirectoryIds) {
            path.searchParams.append("additionalDirectoryId", directoryId);
        }
        const result = decodeNativeSessionResult(
            JSON.stringify(await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal)),
        );
        if (result.action !== "active-turn" || result.targetSessionId !== sessionId) {
            throw new MobiusProtocolError("The service returned an invalid active Turn");
        }
        return { turn: result.turn, queued: result.queued };
    };

    readonly readRuntimeSessionExecution = async (
        runtimeId: string,
        sessionId: string,
        identity: {
            readonly additionalDirectoryIds: readonly string[];
            readonly agentId: string;
            readonly directoryId: string;
        },
        signal: AbortSignal,
    ): Promise<Pick<Extract<NativeSessionResult, { readonly action: "active-turn" }>, "turn" | "queued">> => {
        const result = decodeNativeSessionResult(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(
                        this.#projectId,
                        `runtimes/${encodeURIComponent(runtimeId)}/sessions/${encodeURIComponent(sessionId)}/active-turn`,
                    ),
                    identity,
                    signal,
                ),
            ),
        );
        if (result.action !== "active-turn" || result.targetSessionId !== sessionId) {
            throw new MobiusProtocolError("The service returned an invalid active Turn");
        }
        return { turn: result.turn, queued: result.queued };
    };
}

export class MobiusTurnResources {
    readonly #executor: MobiusRequestExecutor;
    readonly #projectId: string;

    constructor(executor: MobiusRequestExecutor, projectId: string) {
        this.#executor = executor;
        this.#projectId = projectId;
    }

    readonly submit = async (
        sessionId: string,
        request: SubmitMobiusTurnRequest & { readonly agentId?: string; readonly directoryId?: string },
        signal: AbortSignal,
    ): Promise<MobiusTurn> =>
        decodeMobiusTurn(await this.#executor.post(sessionPath(this.#projectId, sessionId, "turns"), request, signal));

    readonly submitToRuntime = async (
        runtimeId: string,
        sessionId: string,
        request: SubmitMobiusTurnRequest & { readonly agentId: string; readonly directoryId: string },
        signal: AbortSignal,
    ): Promise<{ readonly turnId: string }> => {
        const result = await this.#executor.post(
            projectPath(
                this.#projectId,
                `runtimes/${encodeURIComponent(runtimeId)}/sessions/${encodeURIComponent(sessionId)}/turns`,
            ),
            {
                ...request,
                disposition: request.disposition ?? "reject",
                sessionConfigurations: request.sessionConfigurations ?? [],
                targetCommandId: request.targetCommandId ?? "",
            },
            signal,
        );
        if (typeof result !== "object" || result === null || !("turnId" in result)) {
            throw new MobiusProtocolError("The service returned an invalid Turn");
        }
        const turnId = Reflect.get(result, "turnId");
        if (typeof turnId !== "string") {
            throw new MobiusProtocolError("The service returned an invalid Turn");
        }
        return { turnId };
    };

    readonly read = async (sessionId: string, turnId: string, signal: AbortSignal): Promise<MobiusTurn> =>
        decodeMobiusTurn(
            await this.#executor.get(
                sessionPath(this.#projectId, sessionId, `turns/${encodeURIComponent(turnId)}`),
                signal,
            ),
        );

    readonly cancel = async (
        sessionId: string,
        turnId: string,
        request: CancelMobiusTurnRequest,
        signal: AbortSignal,
    ): Promise<MobiusTurn> =>
        decodeMobiusTurn(
            await this.#executor.post(
                sessionPath(this.#projectId, sessionId, `turns/${encodeURIComponent(turnId)}/cancel`),
                request,
                signal,
            ),
        );

    readonly steer = async (
        sessionId: string,
        turnId: string,
        signal: AbortSignal,
    ): Promise<{ readonly turnId: string }> => {
        const result = await this.#executor.put(
            sessionPath(this.#projectId, sessionId, `turns/${encodeURIComponent(turnId)}/disposition`),
            { disposition: SessionPromptDisposition.Steer },
            signal,
        );
        if (typeof result !== "object" || result === null || Reflect.get(result, "turnId") !== turnId) {
            throw new MobiusProtocolError("The service returned an invalid steered Turn");
        }
        return { turnId };
    };
}

export class MobiusAttemptResources {
    readonly #executor: MobiusRequestExecutor;
    readonly #projectId: string;

    constructor(executor: MobiusRequestExecutor, projectId: string) {
        this.#executor = executor;
        this.#projectId = projectId;
    }

    readonly read = async (sessionId: string, attemptId: string, signal: AbortSignal): Promise<Attempt> =>
        decodeMobiusAttempt(
            await this.#executor.get(
                sessionPath(this.#projectId, sessionId, `attempts/${encodeURIComponent(attemptId)}`),
                signal,
            ),
        );
}

export class MobiusToolCallResources {
    readonly #executor: MobiusRequestExecutor;
    readonly #projectId: string;

    constructor(executor: MobiusRequestExecutor, projectId: string) {
        this.#executor = executor;
        this.#projectId = projectId;
    }

    readonly readDetail = async (
        sessionId: string,
        attemptId: string,
        toolCallId: string,
        signal: AbortSignal,
    ): Promise<MobiusToolCallDetail> =>
        decodeMobiusToolCallDetail(
            await this.#executor.get(
                sessionPath(
                    this.#projectId,
                    sessionId,
                    `attempts/${encodeURIComponent(attemptId)}/tool-calls/${encodeURIComponent(toolCallId)}`,
                ),
                signal,
            ),
        );
}

export class MobiusInteractionResources {
    readonly #executor: MobiusRequestExecutor;
    readonly #projectId: string;

    constructor(executor: MobiusRequestExecutor, projectId: string) {
        this.#executor = executor;
        this.#projectId = projectId;
    }

    readonly listPending = async (sessionId: string, signal: AbortSignal): Promise<readonly Interaction[]> =>
        decodeMobiusInteractionList(
            await this.#executor.get(sessionPath(this.#projectId, sessionId, "interactions"), signal),
        );

    readonly read = async (sessionId: string, interactionId: string, signal: AbortSignal): Promise<Interaction> =>
        decodeMobiusInteraction(
            await this.#executor.get(
                sessionPath(this.#projectId, sessionId, `interactions/${encodeURIComponent(interactionId)}`),
                signal,
            ),
        );

    readonly respond = async (
        sessionId: string,
        interactionId: string,
        request: MobiusInteractionResponseRequest,
        signal: AbortSignal,
    ): Promise<void> => {
        const result = await this.#executor.post(
            sessionPath(this.#projectId, sessionId, `interactions/${encodeURIComponent(interactionId)}/responses`),
            request,
            signal,
        );
        if (
            typeof result !== "object" ||
            result === null ||
            !("accepted" in result) ||
            Reflect.get(result, "accepted") !== true
        ) {
            throw new MobiusProtocolError("The service returned an invalid Interaction response");
        }
    };
}

export type MobiusLiveSessionConnection = { readonly kind: "initial" } | { readonly kind: "reconnected" };

export interface MobiusLiveSessionEventObserverV2 {
    readonly receive: (events: SessionEventBatchV2) => Promise<boolean>;
    readonly reconcile: (connection: MobiusLiveSessionConnection) => Promise<void>;
}

export class MobiusLiveEventSubscriptionV2 {
    readonly #controller = new AbortController();
    readonly #executor: MobiusRequestExecutor;
    readonly #maximumReconnectAttempts: number;
    readonly #observer: MobiusLiveSessionEventObserverV2;
    readonly #path: string;
    #closed = false;
    readonly connected: Promise<void>;
    readonly completed: Promise<void>;

    constructor(
        executor: MobiusRequestExecutor,
        path: string,
        observer: MobiusLiveSessionEventObserverV2,
        signal: AbortSignal,
        maximumReconnectAttempts: number,
    ) {
        this.#executor = executor;
        this.#maximumReconnectAttempts = maximumReconnectAttempts;
        this.#observer = observer;
        this.#path = path;
        const abort = (): void => this.#controller.abort(signal.reason);
        if (signal.aborted) {
            abort();
        } else {
            signal.addEventListener("abort", abort, { once: true });
        }
        let resolveConnected = (): void => undefined;
        let rejectConnected = (_cause: unknown): void => undefined;
        this.connected = new Promise<void>((resolve, reject) => {
            resolveConnected = resolve;
            rejectConnected = reject;
        });
        this.completed = this.run(resolveConnected, rejectConnected).finally(() =>
            signal.removeEventListener("abort", abort),
        );
    }

    readonly close = (): void => {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#controller.abort(new Error("The live V2 Session event subscription closed"));
    };

    private readonly run = async (
        resolveConnected: () => void,
        rejectConnected: (cause: unknown) => void,
    ): Promise<void> => {
        let attempts = 0;
        let connectionState: MobiusLiveSessionConnection = { kind: "initial" };
        while (!this.#closed) {
            let connection: LiveEventConnection | null = null;
            try {
                connection = await this.#executor.openLiveEventStream(this.#path, this.#controller.signal);
                await this.#observer.reconcile(connectionState);
                if (connectionState.kind === "initial") {
                    resolveConnected();
                    connectionState = { kind: "reconnected" };
                }
                attempts = 0;
                const reader = connection.events.getReader();
                try {
                    while (!this.#closed) {
                        const result = await reader.read();
                        if (result.done) {
                            throw new MobiusConnectionError("The live V2 Session event stream disconnected");
                        }
                        let value: unknown;
                        try {
                            value = JSON.parse(result.value.data);
                        } catch (cause) {
                            throw new MobiusProtocolError("The live V2 Session event stream contains invalid JSON", {
                                cause,
                            });
                        }
                        const events = decodeSessionEventBatchV2(value);
                        if (!(await this.#observer.receive(events))) {
                            this.close();
                        }
                    }
                } finally {
                    reader.releaseLock();
                }
            } catch (cause) {
                if (this.#closed || this.#controller.signal.aborted) {
                    if (connectionState.kind === "initial") {
                        rejectConnected(new MobiusCancellationError({ cause }));
                    }
                    return;
                }
                if (
                    cause instanceof MobiusProtocolError ||
                    (cause instanceof MobiusApiError && cause.status < 500) ||
                    (cause instanceof MobiusError &&
                        !(cause instanceof MobiusConnectionError) &&
                        !(cause instanceof MobiusTimeoutError) &&
                        !(cause instanceof MobiusApiError))
                ) {
                    if (connectionState.kind === "initial") {
                        rejectConnected(cause);
                    }
                    throw cause;
                }
                attempts += 1;
                if (attempts > this.#maximumReconnectAttempts) {
                    const failure = new MobiusConnectionError("The live V2 Session event stream could not recover", {
                        cause,
                    });
                    if (connectionState.kind === "initial") {
                        rejectConnected(failure);
                    }
                    throw failure;
                }
                await this.reconnectDelay(attempts);
            } finally {
                connection?.close();
            }
        }
    };

    private readonly reconnectDelay = async (attempt: number): Promise<void> => {
        const delayMilliseconds = Math.min(250 * 2 ** (attempt - 1), 2_000);
        await new Promise<void>((resolve, reject) => {
            const timeoutId = globalThis.setTimeout(() => {
                this.#controller.signal.removeEventListener("abort", abort);
                resolve();
            }, delayMilliseconds);
            const abort = (): void => {
                globalThis.clearTimeout(timeoutId);
                reject(new MobiusCancellationError());
            };
            this.#controller.signal.addEventListener("abort", abort, { once: true });
        });
    };
}

export class MobiusEventResources {
    readonly #executor: MobiusRequestExecutor;
    readonly #maximumReconnectAttempts: number;
    readonly #projectId: string;
    readonly #liveSubscriptionsV2 = new Set<MobiusLiveEventSubscriptionV2>();

    constructor(executor: MobiusRequestExecutor, projectId: string, maximumReconnectAttempts: number) {
        this.#executor = executor;
        this.#maximumReconnectAttempts = maximumReconnectAttempts;
        this.#projectId = projectId;
    }

    readonly subscribeLiveV2 = async (
        sessionId: string,
        observer: MobiusLiveSessionEventObserverV2,
        signal: AbortSignal,
    ): Promise<MobiusLiveEventSubscriptionV2> => {
        const subscription = new MobiusLiveEventSubscriptionV2(
            this.#executor,
            sessionPath(this.#projectId, sessionId, "events-v2"),
            observer,
            signal,
            this.#maximumReconnectAttempts,
        );
        this.#liveSubscriptionsV2.add(subscription);
        void subscription.completed
            .finally(() => this.#liveSubscriptionsV2.delete(subscription))
            .catch(() => undefined);
        await subscription.connected;
        return subscription;
    };

    readonly listV2 = async (
        sessionId: string,
        page: MobiusPageRequest,
        signal: AbortSignal,
    ): Promise<SessionEventLogPageV2> => {
        const path = requestUrl(
            new URL("https://mobius.invalid/"),
            sessionPath(this.#projectId, sessionId, "events-v2"),
        );
        path.searchParams.set("limit", page.limit.toString());
        if (page.cursor.length > 0) {
            path.searchParams.set("cursor", page.cursor);
        }
        return decodeSessionEventLogPageV2(await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal));
    };

    readonly close = (): void => {
        for (const subscription of this.#liveSubscriptionsV2) {
            subscription.close();
        }
        this.#liveSubscriptionsV2.clear();
    };
}

export class MobiusClient {
    readonly attempts: MobiusAttemptResources;
    readonly capabilities: MobiusCapabilityResources;
    readonly channels: MobiusChannelResources;
    readonly credentials: MobiusCredentialResources;
    readonly events: MobiusEventResources;
    readonly interactions: MobiusInteractionResources;
    readonly runtimePairings: MobiusRuntimePairingResources;
    readonly runtimes: MobiusRuntimeResources;
    readonly sessions: MobiusSessionResources;
    readonly turns: MobiusTurnResources;
    readonly toolCalls: MobiusToolCallResources;

    constructor(options: MobiusClientOptions) {
        const executor = new MobiusRequestExecutor(options);
        const reconnectAttempts = validatePositiveInteger(
            options.maxStreamReconnectAttempts ?? DEFAULT_STREAM_RECONNECT_ATTEMPTS,
            "stream reconnect attempt limit",
        );
        this.attempts = new MobiusAttemptResources(executor, options.projectId);
        this.capabilities = new MobiusCapabilityResources(executor);
        this.channels = new MobiusChannelResources(executor);
        this.credentials = new MobiusCredentialResources(executor, options.projectId);
        this.events = new MobiusEventResources(executor, options.projectId, reconnectAttempts);
        this.interactions = new MobiusInteractionResources(executor, options.projectId);
        this.runtimePairings = new MobiusRuntimePairingResources(executor, options.projectId);
        this.runtimes = new MobiusRuntimeResources(executor, options.projectId);
        this.sessions = new MobiusSessionResources(executor, options.projectId);
        this.turns = new MobiusTurnResources(executor, options.projectId);
        this.toolCalls = new MobiusToolCallResources(executor, options.projectId);
    }

    readonly close = (): void => {
        this.events.close();
    };
}
