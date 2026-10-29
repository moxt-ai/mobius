import {
    type AgentSettingsDiscoveredEvent,
    CONTENT_WRITE_MAX_BYTES,
    decodeAgentSettingsDiscoveredEvent,
    decodeKnownNativeSessionEvents,
    decodeKnownSessionEventLogPage,
    decodeKnownSessionLiveEventBatch,
    decodeNativeSessionResult,
    decodePromptAttachment,
    decodeRuntimeDiagnosticsResult,
    decodeSessionClosedEvent,
    decodeSessionConfigReadResult,
    decodeSessionConfigUpdatedEvent,
    decodeSessionReadyEvent,
    decodeSessionRenamedEvent,
    decodeSessionRestoredEvent,
    decodeSessionsListedEvent,
    decodeSessionsQueriedEvent,
    decodeWorkspaceEntriesEvent,
    type ExternalAudioContentBlock,
    type ExternalImageContentBlock,
    type ExternalResourceContentBlock,
    isIdentifier,
    MOBIUS_API_PREFIX,
    type NativeEventPageRequest,
    type NativeSessionEvents,
    type NativeSessionRequest,
    type NativeSessionResult,
    type PromptAttachment,
    type RuntimeDiagnosticsResult,
    type SessionConfigureCommand,
    type SessionEventLogPage,
    type SessionLiveEventBatch,
    SessionPromptDisposition,
    type WorkspaceEntriesEvent,
} from "@moxt-ai/mobius-sdk/protocol";

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
    type CreateMobiusSessionRequest,
    decodeMobiusBrowserCredential,
    decodeMobiusChannelAccessGrant,
    decodeMobiusChannelDescriptor,
    decodeMobiusLinkedChannelDeviceList,
    decodeMobiusRedeemedChannelCredential,
    decodeMobiusRuntimeList,
    decodeMobiusRuntimePairing,
    decodeMobiusRuntimePairingStatus,
    decodeMobiusTurn,
    decodeRuntimeDescriptor,
    type MobiusBrowserCredential,
    type MobiusBrowserCredentialRequest,
    type MobiusChannelAccessGrant,
    type MobiusChannelDescriptor,
    type MobiusInteractionResponseRequest,
    type MobiusLinkedChannelDevice,
    type MobiusPageRequest,
    MobiusPairedRuntimePairingStatus,
    type MobiusRedeemedChannelCredential,
    type MobiusRuntimeDescriptor,
    type MobiusRuntimePairing,
    MobiusRuntimePairingLifecycle,
    type MobiusRuntimePairingRequest,
    type MobiusRuntimePairingStatus,
    type MobiusRuntimePairingWaitOptions,
    MobiusSessionAccess,
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
const DEFAULT_STREAM_RECONNECT_ATTEMPTS = 7;

function sanitizedConnectionCauseMessage(value: string): string {
    return Array.from(value, (character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? " " : character;
    })
        .join("")
        .trim()
        .slice(0, 1_024);
}

function connectionCauseMessages(cause: unknown): readonly string[] {
    const messages: string[] = [];
    const visited = new Set<unknown>();
    let current = cause;
    while (current instanceof Error && messages.length < 4 && !visited.has(current)) {
        visited.add(current);
        const message = sanitizedConnectionCauseMessage(current.message);
        if (message.length > 0) {
            messages.push(message);
        }
        current = current.cause;
    }
    return messages;
}

export interface MobiusCredentialProvider {
    readonly credential: (signal: AbortSignal) => Promise<string>;
}

export interface DiscoverMobiusAgentSettingsRequest {
    readonly model?: string;
}

export interface ForkMobiusNativeSessionRequest {
    readonly agentId: string;
    readonly nativeSessionId: string;
    readonly directoryId: string;
    readonly additionalDirectoryIds: readonly string[];
}

export type MobiusExternalContentBlock =
    | ExternalImageContentBlock
    | ExternalAudioContentBlock
    | ExternalResourceContentBlock;

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
    /** Set to zero when the caller owns live-stream recovery. */
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

    readonly putContent = async (
        path: string,
        bytes: Uint8Array,
        metadata: { readonly contentKind: "image" | "resource"; readonly mediaType: string; readonly name: string },
        signal: AbortSignal,
    ): Promise<unknown> => {
        const deadline = new RequestDeadline(signal, this.#operationTimeoutMilliseconds);
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(deadline.signal));
            const headers = this.authenticationHeaders(credential, "application/json");
            headers.set("content-type", metadata.mediaType);
            headers.set("x-mobius-byte-length", bytes.byteLength.toString());
            headers.set("x-mobius-content-kind", metadata.contentKind);
            headers.set("x-mobius-file-name", encodeURIComponent(metadata.name));
            const body = bytes.slice().buffer;
            const response = await this.#transport.fetch(
                new Request(requestUrl(this.#endpoint, path), {
                    body,
                    headers,
                    method: "PUT",
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
            const events = await this.#transport.openSessionLiveEvents(
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

    /**
     * Read the Runtime's own bounded local diagnostic log through the Relay, for a
     * bug report filed without shell access to the machine. Entries carry
     * correlation identifiers and failure codes only; free text and local paths
     * stay on that machine. Requires the Runtime to be online: an offline Runtime
     * has no log reader to answer, so this reports `runtime_unavailable`.
     */
    readonly readDiagnostics = async (runtimeId: string, signal: AbortSignal): Promise<RuntimeDiagnosticsResult> => {
        if (!isIdentifier(runtimeId)) {
            throw new MobiusValidationError("The Runtime identifier is invalid");
        }
        return decodeRuntimeDiagnosticsResult(
            JSON.stringify(
                await this.#executor.get(
                    projectPath(this.#projectId, `runtimes/${encodeURIComponent(runtimeId)}/diagnostics`),
                    signal,
                ),
            ),
        );
    };

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

    readonly describeWorkspace = async (
        runtimeId: string,
        directoryId: string,
        signal: AbortSignal,
    ): Promise<Pick<WorkspaceEntriesEvent, "directoryId" | "directoryLabel">> => {
        const listing = decodeWorkspaceEntriesEvent(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(this.#projectId, `runtimes/${encodeURIComponent(runtimeId)}/workspace`),
                    { directoryId, view: "metadata" },
                    signal,
                ),
            ),
        );
        return { directoryId: listing.directoryId, directoryLabel: listing.directoryLabel };
    };

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

    /**
     * Requires the Relay's nativeForkRecovery capability. Reuse an operationId and its inputs after an ambiguous
     * failure. This method never falls back to a legacy Fork; an unknown result must not create another Session.
     */
    readonly forkNativeSession = async (
        runtimeId: string,
        operationId: string,
        request: ForkMobiusNativeSessionRequest,
        signal: AbortSignal,
    ) => {
        const receipt = await this.#executor.post(
            projectPath(
                this.#projectId,
                `runtimes/${encodeURIComponent(runtimeId)}/native-session-forks/${encodeURIComponent(operationId)}`,
            ),
            request,
            signal,
        );
        if (typeof receipt !== "object" || receipt === null || !("result" in receipt) || !("source" in receipt)) {
            throw new MobiusProtocolError("The service returned an invalid Fork receipt");
        }
        const result = decodeNativeSessionResult(JSON.stringify(receipt.result));
        const source = decodeNativeSessionResult(JSON.stringify(receipt.source));
        if (result.action !== "fork" || result.ready.sessionId !== result.targetSessionId) {
            throw new MobiusProtocolError("The service returned an invalid native Fork");
        }
        if (source.action !== "find" || source.entry.nativeSessionId !== request.nativeSessionId) {
            throw new MobiusProtocolError("The service returned an invalid Fork source");
        }
        return { result, entry: source.entry };
    };

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

    readonly restore = async (runtimeId: string, sessionId: string, signal: AbortSignal) =>
        decodeSessionRestoredEvent(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(
                        this.#projectId,
                        `runtimes/${encodeURIComponent(runtimeId)}/sessions/${encodeURIComponent(sessionId)}/restore`,
                    ),
                    {},
                    signal,
                ),
            ),
        );

    readonly close = async (runtimeId: string, sessionId: string, signal: AbortSignal) =>
        decodeSessionClosedEvent(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(
                        this.#projectId,
                        `runtimes/${encodeURIComponent(runtimeId)}/sessions/${encodeURIComponent(sessionId)}/close`,
                    ),
                    {},
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
                      | "expectedConfigurationRevision"
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

    readonly readConfiguration = async (
        ...operation:
            | readonly [sessionId: string, signal: AbortSignal]
            | readonly [runtimeId: string, sessionId: string, signal: AbortSignal]
    ) => {
        const result =
            operation.length === 2
                ? await this.#executor.get(sessionPath(this.#projectId, operation[0], "configuration"), operation[1])
                : await this.#executor.get(
                      projectPath(
                          this.#projectId,
                          `runtimes/${encodeURIComponent(operation[0])}/sessions/${encodeURIComponent(operation[1])}/configuration`,
                      ),
                      operation[2],
                  );
        return decodeSessionConfigReadResult(JSON.stringify(result));
    };

    readonly rename = async (
        ...operation:
            | readonly [runtimeId: string, sessionId: string, title: string, signal: AbortSignal]
            | readonly [sessionId: string, title: string, signal: AbortSignal]
    ) => {
        const result =
            operation.length === 3
                ? await this.#executor.post(
                      sessionPath(this.#projectId, operation[0], "rename"),
                      { title: operation[1] },
                      operation[2],
                  )
                : await this.#executor.post(
                      projectPath(
                          this.#projectId,
                          `runtimes/${encodeURIComponent(operation[0])}/sessions/${encodeURIComponent(operation[1])}/rename`,
                      ),
                      { title: operation[2] },
                      operation[3],
                  );
        return decodeSessionRenamedEvent(JSON.stringify(result));
    };

    readonly uploadContent = async (
        sessionId: string,
        input: {
            readonly bytes: Uint8Array;
            readonly contentKey: string;
            readonly kind: "image" | "resource";
            readonly mediaType: string;
            readonly name: string;
            readonly uri: string;
        },
        signal: AbortSignal,
    ): Promise<PromptAttachment> => {
        if (!/^[a-f0-9]{64}$/u.test(input.contentKey)) {
            throw new MobiusValidationError("The content key is invalid");
        }
        if (input.bytes.byteLength < 1 || input.bytes.byteLength > CONTENT_WRITE_MAX_BYTES) {
            throw new MobiusValidationError("The content size is invalid");
        }
        const query = new URLSearchParams({ uri: input.uri });
        return decodePromptAttachment(
            await this.#executor.putContent(
                `${sessionPath(this.#projectId, sessionId, `content/${input.contentKey}`)}?${query.toString()}`,
                input.bytes,
                { contentKind: input.kind, mediaType: input.mediaType, name: input.name },
                signal,
            ),
        );
    };

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

    readonly previewRuntimeNativeEvents = async (
        runtimeId: string,
        sessionId: string,
        identity: {
            readonly additionalDirectoryIds: readonly string[];
            readonly agentId: string;
            readonly directoryId: string;
        },
        page: NativeEventPageRequest,
        signal: AbortSignal,
    ): Promise<NativeSessionEvents> => {
        const result = await this.#executor.post(
            projectPath(
                this.#projectId,
                `runtimes/${encodeURIComponent(runtimeId)}/sessions/${encodeURIComponent(sessionId)}/native-events-preview`,
            ),
            {
                ...identity,
                cursor: page.cursor,
                eventLimit: page.eventLimit,
            },
            signal,
        );
        return decodeKnownNativeSessionEvents(result);
    };

    readonly previewSessionNativeEvents = async (
        sessionId: string,
        identity: {
            readonly additionalDirectoryIds: readonly string[];
            readonly agentId: string;
            readonly directoryId: string;
        },
        page: NativeEventPageRequest,
        signal: AbortSignal,
    ): Promise<NativeSessionEvents> => {
        const path = requestUrl(
            new URL("https://mobius.invalid/"),
            sessionPath(this.#projectId, sessionId, "native-events-preview"),
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
        return decodeKnownNativeSessionEvents(
            await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal),
        );
    };

    /**
     * Reads the Session's execution. Naming a command also asks for that command's delivery;
     * `command` stays absent when the Relay or Runtime cannot report it, so the caller keeps
     * whatever it already knew about the submission. `lastTurn` reports how the last started
     * command ended when none runs, and is likewise absent from older peers.
     */
    readonly readSessionExecution = async (
        sessionId: string,
        identity: {
            readonly additionalDirectoryIds: readonly string[];
            readonly agentId: string;
            readonly directoryId: string;
        },
        signal: AbortSignal,
        commandId?: string,
    ): Promise<
        Pick<
            Extract<NativeSessionResult, { readonly action: "active-turn" }>,
            "turn" | "queued" | "command" | "lastTurn" | "queuedCancellation"
        >
    > => {
        const path = requestUrl(
            new URL("https://mobius.invalid/"),
            sessionPath(this.#projectId, sessionId, "active-turn"),
        );
        path.searchParams.set("agentId", identity.agentId);
        path.searchParams.set("directoryId", identity.directoryId);
        for (const directoryId of identity.additionalDirectoryIds) {
            path.searchParams.append("additionalDirectoryId", directoryId);
        }
        if (commandId !== undefined) {
            path.searchParams.set("commandId", commandId);
        }
        const result = decodeNativeSessionResult(
            JSON.stringify(await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal)),
        );
        if (result.action !== "active-turn" || result.targetSessionId !== sessionId) {
            throw new MobiusProtocolError("The service returned an invalid active Turn");
        }
        return {
            turn: result.turn,
            queued: result.queued,
            ...(result.command === undefined ? {} : { command: result.command }),
            ...(result.lastTurn === undefined ? {} : { lastTurn: result.lastTurn }),
            ...(result.queuedCancellation === undefined ? {} : { queuedCancellation: result.queuedCancellation }),
        };
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
    ): Promise<MobiusTurn> => {
        const turn = decodeMobiusTurn(
            await this.#executor.post(sessionPath(this.#projectId, sessionId, "turns"), request, signal),
        );
        if (turn === null) {
            throw new MobiusProtocolError("The service returned an invalid Turn");
        }
        return turn;
    };

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

    readonly cancel = async (
        sessionId: string,
        turnId: string,
        request: CancelMobiusTurnRequest,
        signal: AbortSignal,
    ): Promise<MobiusTurn> => {
        const turn = decodeMobiusTurn(
            await this.#executor.post(
                sessionPath(this.#projectId, sessionId, `turns/${encodeURIComponent(turnId)}/cancel`),
                request,
                signal,
            ),
        );
        if (turn === null) {
            throw new MobiusProtocolError("The service returned an invalid Turn");
        }
        return turn;
    };

    /** Withdraws a queued prompt only when the Runtime confirms it did not execute. */
    readonly cancelQueued = async (
        sessionId: string,
        turnId: string,
        request: CancelMobiusTurnRequest & {
            readonly additionalDirectoryIds: readonly string[];
            readonly agentId: string;
            readonly directoryId: string;
        },
        signal: AbortSignal,
    ): Promise<void> => {
        const { idempotencyKey, ...identity } = request;
        const sessions = new MobiusSessionResources(this.#executor, this.#projectId);
        const before = await sessions.readSessionExecution(sessionId, identity, signal, turnId);
        if (before.queuedCancellation === "before-start") {
            const result = await this.#executor.post(
                sessionPath(this.#projectId, sessionId, `turns/${encodeURIComponent(turnId)}/cancel-before-start`),
                { idempotencyKey },
                signal,
            );
            if (
                typeof result !== "object" ||
                result === null ||
                Reflect.get(result, "turnId") !== turnId ||
                Reflect.get(result, "idempotencyKey") !== idempotencyKey
            ) {
                throw new MobiusProtocolError("The service returned an invalid queued cancellation");
            }
            return;
        }
        // Older peers retain their existing cancellation path. The same FIFO head before and
        // after cancellation proves the queued prompt never acquired the execution slot.
        const head = before.turn;
        if (head === null || head.commandId === turnId || !before.queued.some((item) => item.commandId === turnId)) {
            throw new MobiusError(
                "turn_already_started",
                "The message is no longer queued and could not be withdrawn.",
            );
        }
        const cancelled = await this.cancel(sessionId, turnId, { idempotencyKey }, signal);
        const after = await sessions.readSessionExecution(sessionId, identity, signal, turnId);
        if (
            cancelled.state.kind !== "cancelled" ||
            after.turn?.commandId !== head.commandId ||
            after.queued.some((item) => item.commandId === turnId) ||
            (after.command !== undefined &&
                (after.command.state !== "completed" || after.command.stopReason !== "cancelled"))
        ) {
            throw new MobiusError(
                "queued_cancellation_unconfirmed",
                "The message may have started. Its withdrawal could not be confirmed, so it was not restored for editing.",
            );
        }
    };

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

export class MobiusInteractionResources {
    readonly #executor: MobiusRequestExecutor;
    readonly #projectId: string;

    constructor(executor: MobiusRequestExecutor, projectId: string) {
        this.#executor = executor;
        this.#projectId = projectId;
    }

    // The Platform serves no interaction read routes: pending interactions are derived from the
    // Session Recording lifecycle events. Only the response submission crosses the Platform API.
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

export type MobiusSessionLiveEventConnection = { readonly kind: "initial" } | { readonly kind: "reconnected" };

export interface MobiusSessionEventObserver {
    readonly receive: (events: SessionLiveEventBatch) => Promise<boolean>;
    readonly reconcile: (connection: MobiusSessionLiveEventConnection) => Promise<void>;
}

export class MobiusLiveEventSubscription {
    readonly #controller = new AbortController();
    readonly #executor: MobiusRequestExecutor;
    readonly #maximumReconnectAttempts: number;
    readonly #observer: MobiusSessionEventObserver;
    readonly #path: string;
    #closed = false;
    readonly connected: Promise<void>;
    readonly completed: Promise<void>;

    constructor(
        executor: MobiusRequestExecutor,
        path: string,
        observer: MobiusSessionEventObserver,
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
        this.#controller.abort(new Error("The live session event subscription closed"));
    };

    private readonly run = async (
        resolveConnected: () => void,
        rejectConnected: (cause: unknown) => void,
    ): Promise<void> => {
        let attempts = 0;
        let connectionState: MobiusSessionLiveEventConnection = { kind: "initial" };
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
                            throw new MobiusConnectionError("The live session event stream disconnected");
                        }
                        let value: unknown;
                        try {
                            value = JSON.parse(result.value.data);
                        } catch (cause) {
                            throw new MobiusProtocolError("The live session event stream contains invalid JSON", {
                                cause,
                            });
                        }
                        const events = decodeKnownSessionLiveEventBatch(value);
                        if (events.length === 0) {
                            continue;
                        }
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
                    const details = connectionCauseMessages(cause);
                    const message = `The live session event stream could not recover${
                        details.length > 0 ? `. Cause: ${details.join(". Caused by: ")}` : ""
                    }`;
                    const failure = new MobiusConnectionError(message, { cause });
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
    readonly #liveSubscriptions = new Set<MobiusLiveEventSubscription>();

    constructor(executor: MobiusRequestExecutor, projectId: string, maximumReconnectAttempts: number) {
        this.#executor = executor;
        this.#maximumReconnectAttempts = maximumReconnectAttempts;
        this.#projectId = projectId;
    }

    readonly subscribeLive = async (
        sessionId: string,
        observer: MobiusSessionEventObserver,
        signal: AbortSignal,
    ): Promise<MobiusLiveEventSubscription> => {
        const subscription = new MobiusLiveEventSubscription(
            this.#executor,
            sessionPath(this.#projectId, sessionId, "events-v2"),
            observer,
            signal,
            this.#maximumReconnectAttempts,
        );
        this.#liveSubscriptions.add(subscription);
        void subscription.completed.finally(() => this.#liveSubscriptions.delete(subscription)).catch(() => undefined);
        await subscription.connected;
        return subscription;
    };

    readonly list = async (
        sessionId: string,
        page: MobiusPageRequest,
        signal: AbortSignal,
    ): Promise<SessionEventLogPage> => {
        const path = requestUrl(
            new URL("https://mobius.invalid/"),
            sessionPath(this.#projectId, sessionId, "events-v2"),
        );
        path.searchParams.set("limit", page.limit.toString());
        if (page.cursor.length > 0) {
            path.searchParams.set("cursor", page.cursor);
        }
        return decodeKnownSessionEventLogPage(
            await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal),
        );
    };

    readonly close = (): void => {
        for (const subscription of this.#liveSubscriptions) {
            subscription.close();
        }
        this.#liveSubscriptions.clear();
    };
}

export class MobiusClient {
    readonly channels: MobiusChannelResources;
    readonly credentials: MobiusCredentialResources;
    readonly events: MobiusEventResources;
    readonly interactions: MobiusInteractionResources;
    readonly runtimePairings: MobiusRuntimePairingResources;
    readonly runtimes: MobiusRuntimeResources;
    readonly sessions: MobiusSessionResources;
    readonly turns: MobiusTurnResources;

    constructor(options: MobiusClientOptions) {
        const executor = new MobiusRequestExecutor(options);
        const reconnectAttempts = options.maxStreamReconnectAttempts ?? DEFAULT_STREAM_RECONNECT_ATTEMPTS;
        if (!Number.isSafeInteger(reconnectAttempts) || reconnectAttempts < 0) {
            throw new MobiusValidationError("The stream reconnect attempt limit is invalid");
        }
        this.channels = new MobiusChannelResources(executor);
        this.credentials = new MobiusCredentialResources(executor, options.projectId);
        this.events = new MobiusEventResources(executor, options.projectId, reconnectAttempts);
        this.interactions = new MobiusInteractionResources(executor, options.projectId);
        this.runtimePairings = new MobiusRuntimePairingResources(executor, options.projectId);
        this.runtimes = new MobiusRuntimeResources(executor, options.projectId);
        this.sessions = new MobiusSessionResources(executor, options.projectId);
        this.turns = new MobiusTurnResources(executor, options.projectId);
    }

    readonly close = (): void => {
        this.events.close();
    };
}
