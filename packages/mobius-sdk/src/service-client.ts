import {
    type Attempt,
    decodeNativeSessionHistory,
    decodeNativeSessionResult,
    decodeSessionConfigUpdatedEvent,
    decodeSessionReadyEvent,
    decodeWorkspaceEntriesEvent,
    type Interaction,
    MOBIUS_API_PREFIX,
    MOBIUS_EVENT_FORMAT_VERSION,
    MOBIUS_SESSION_EVENT_STREAM_EVENT,
    MOBIUS_SESSION_EVENT_STREAM_MEDIA_TYPE,
    type NativeSessionCommand,
    type NativeSessionHistory,
    type SessionConfigureCommand,
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
import {
    type CancelMobiusTurnRequest,
    type ConfigureMobiusSessionRequest,
    type CreateMobiusSessionRequest,
    decodeMobiusArtifact,
    decodeMobiusArtifactUpload,
    decodeMobiusAttempt,
    decodeMobiusAvailableArtifact,
    decodeMobiusBrowserCredential,
    decodeMobiusEventPage,
    decodeMobiusInteraction,
    decodeMobiusInteractionList,
    decodeMobiusMessagePage,
    decodeMobiusRuntimeList,
    decodeMobiusRuntimePairing,
    decodeMobiusRuntimePairingStatus,
    decodeMobiusServiceCapabilities,
    decodeMobiusSession,
    decodeMobiusSessionEvent,
    decodeMobiusSessionExport,
    decodeMobiusSessionPage,
    decodeMobiusSessionState,
    decodeMobiusToolCallDetail,
    decodeMobiusTurn,
    type MobiusArtifact,
    MobiusArtifactDownload,
    type MobiusArtifactUpload,
    type MobiusArtifactUploadRequest,
    MobiusAvailableArtifact,
    type MobiusBrowserCredential,
    type MobiusBrowserCredentialRequest,
    type MobiusEventPage,
    type MobiusInteractionResponseRequest,
    type MobiusMessagePage,
    type MobiusPageRequest,
    MobiusPairedRuntimePairingStatus,
    type MobiusRuntimeDescriptor,
    type MobiusRuntimePairing,
    MobiusRuntimePairingLifecycle,
    type MobiusRuntimePairingRequest,
    type MobiusRuntimePairingStatus,
    type MobiusRuntimePairingWaitOptions,
    type MobiusServiceCapabilities,
    type MobiusSession,
    MobiusSessionAccess,
    type MobiusSessionEvent,
    type MobiusSessionExport,
    type MobiusSessionImportBinding,
    type MobiusSessionPage,
    type MobiusSessionState,
    type MobiusToolCallDetail,
    type MobiusTurn,
    type SubmitMobiusTurnRequest,
} from "./resources.ts";

const DEFAULT_OPERATION_TIMEOUT_MILLISECONDS = 20_000;
const DEFAULT_STREAM_CONNECTION_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_STREAM_LIVENESS_TIMEOUT_MILLISECONDS = 45_000;
const DEFAULT_STREAM_RECONNECT_ATTEMPTS = 4;
const MAX_EVENT_BLOCK_LENGTH = 9 * 1024 * 1024;

export interface MobiusCredentialProvider {
    readonly credential: (signal: AbortSignal) => Promise<string>;
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

export interface MobiusHttpTransport {
    readonly fetch: (request: Request) => Promise<Response>;
}

export interface MobiusResponseMetadata {
    readonly serverTiming: string | null;
    readonly status: number;
}

class PlatformMobiusHttpTransport implements MobiusHttpTransport {
    readonly fetch = async (request: Request): Promise<Response> => await globalThis.fetch(request);
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
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(projectId)) {
        throw new MobiusValidationError("The Mobius project identifier is invalid");
    }
    return `v1/projects/${encodeURIComponent(projectId)}/${resourcePath}`;
}

function sessionPath(projectId: string, sessionId: string, resourcePath: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(sessionId)) {
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

class StreamConnection {
    #closed = false;
    readonly #controller: AbortController;
    #hasActivity = false;
    #livenessTimedOut = false;
    #livenessTimeoutId: ReturnType<typeof globalThis.setTimeout>;
    readonly #livenessTimeoutMilliseconds: number;
    readonly #release: () => void;
    readonly response: Response;

    constructor(
        response: Response,
        controller: AbortController,
        release: () => void,
        livenessTimeoutMilliseconds: number,
    ) {
        this.#controller = controller;
        this.#livenessTimeoutMilliseconds = livenessTimeoutMilliseconds;
        this.#release = release;
        this.response = response;
        this.#livenessTimeoutId = globalThis.setTimeout(
            this.abortFromLivenessTimeout,
            this.#livenessTimeoutMilliseconds,
        );
    }

    get hasActivity(): boolean {
        return this.#hasActivity;
    }

    readonly close = (): void => {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        globalThis.clearTimeout(this.#livenessTimeoutId);
        this.#controller.abort(new Error("The Mobius event connection closed"));
        this.#release();
    };

    readonly touch = (): void => {
        if (this.#closed) {
            return;
        }
        this.#hasActivity = true;
        globalThis.clearTimeout(this.#livenessTimeoutId);
        this.#livenessTimeoutId = globalThis.setTimeout(
            this.abortFromLivenessTimeout,
            this.#livenessTimeoutMilliseconds,
        );
    };

    readonly translateFailure = (cause: unknown): never => {
        if (this.#livenessTimedOut) {
            throw new MobiusTimeoutError({ cause });
        }
        throw new MobiusConnectionError("The Mobius event stream was interrupted", {
            cause,
        });
    };

    private readonly abortFromLivenessTimeout = (): void => {
        this.#livenessTimedOut = true;
        this.#controller.abort(new Error("The Mobius event stream became inactive"));
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
        this.#transport = options.transport ?? new PlatformMobiusHttpTransport();
    }

    readonly get = async (path: string, signal: AbortSignal): Promise<unknown> =>
        await this.request(path, "GET", "", false, signal);

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

    readonly putBytes = async (
        path: string,
        bytes: Uint8Array,
        mediaType: string,
        uploadToken: string,
        signal: AbortSignal,
    ): Promise<unknown> => {
        const deadline = new RequestDeadline(signal, this.#operationTimeoutMilliseconds);
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(deadline.signal));
            const headers = this.authenticationHeaders(credential, "application/json");
            headers.set("content-type", mediaType);
            headers.set("x-mobius-upload-token", validateCredential(uploadToken));
            const response = await this.#transport.fetch(
                new Request(requestUrl(this.#endpoint, path), {
                    body: Uint8Array.from(bytes),
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

    readonly getBytes = async (
        path: string,
        artifact: MobiusAvailableArtifact,
        signal: AbortSignal,
    ): Promise<Uint8Array> => {
        const deadline = new RequestDeadline(signal, this.#operationTimeoutMilliseconds);
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(deadline.signal));
            const response = await this.#transport.fetch(
                new Request(requestUrl(this.#endpoint, path), {
                    headers: this.authenticationHeaders(credential, artifact.mediaType),
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
            if (
                response.headers.get("content-type") !== artifact.mediaType ||
                response.headers.get("x-mobius-artifact-id") !== artifact.artifactId ||
                response.headers.get("x-mobius-sha256") !== artifact.sha256
            ) {
                throw new MobiusProtocolError("The service returned invalid artifact metadata");
            }
            return await readExactResponseBytes(response, artifact.byteLength, deadline.signal);
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

    readonly openEventStream = async (path: string, signal: AbortSignal): Promise<StreamConnection> => {
        const controller = new AbortController();
        let timedOut = false;
        const abortFromRequest = (): void => controller.abort(signal.reason);
        if (signal.aborted) {
            abortFromRequest();
        } else {
            signal.addEventListener("abort", abortFromRequest, { once: true });
        }
        const timeoutId = globalThis.setTimeout(() => {
            timedOut = true;
            controller.abort(new Error("The Mobius event stream timed out"));
        }, this.#streamConnectionTimeoutMilliseconds);
        const release = (): void => {
            globalThis.clearTimeout(timeoutId);
            signal.removeEventListener("abort", abortFromRequest);
        };
        let response: Response;
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(controller.signal));
            response = await this.#transport.fetch(
                new Request(requestUrl(this.#endpoint, path), {
                    headers: this.authenticationHeaders(credential, MOBIUS_SESSION_EVENT_STREAM_MEDIA_TYPE),
                    signal: controller.signal,
                }),
            );
        } catch (cause) {
            release();
            if (signal.aborted) {
                throw new MobiusCancellationError({ cause });
            }
            if (timedOut) {
                throw new MobiusTimeoutError({ cause });
            }
            if (cause instanceof MobiusError) {
                throw cause;
            }
            throw new MobiusConnectionError("The Mobius event stream could not connect", { cause });
        }
        if (!response.ok) {
            try {
                await throwApiError(response);
            } catch (cause) {
                release();
                if (signal.aborted) {
                    throw new MobiusCancellationError({ cause });
                }
                if (timedOut) {
                    throw new MobiusTimeoutError({ cause });
                }
                throw cause;
            }
        }
        globalThis.clearTimeout(timeoutId);
        const contentType = response.headers.get("content-type") ?? "";
        if (
            !contentType.startsWith(MOBIUS_SESSION_EVENT_STREAM_MEDIA_TYPE) ||
            response.headers.get("x-mobius-event-format") !== MOBIUS_EVENT_FORMAT_VERSION ||
            response.body === null
        ) {
            controller.abort(new Error("The Mobius event stream is invalid"));
            release();
            throw new MobiusProtocolError("The service returned an invalid Session event stream");
        }
        return new StreamConnection(response, controller, release, this.#streamLivenessTimeoutMilliseconds);
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
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    signal.throwIfAborted();
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (sha256 !== response.headers.get("x-mobius-sha256")) {
        throw new MobiusProtocolError("The service returned artifact content with an invalid digest");
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

export class MobiusArtifactResources {
    readonly #executor: MobiusRequestExecutor;
    readonly #projectId: string;

    constructor(executor: MobiusRequestExecutor, projectId: string) {
        this.#executor = executor;
        this.#projectId = projectId;
    }

    readonly createUpload = async (
        sessionId: string,
        request: MobiusArtifactUploadRequest,
        signal: AbortSignal,
    ): Promise<MobiusArtifactUpload> =>
        decodeMobiusArtifactUpload(
            await this.#executor.post(sessionPath(this.#projectId, sessionId, "artifacts/uploads"), request, signal),
        );

    readonly uploadContent = async (
        sessionId: string,
        upload: MobiusArtifactUpload,
        bytes: Uint8Array,
        signal: AbortSignal,
    ): Promise<MobiusAvailableArtifact> => {
        if (upload.sessionId !== sessionId || bytes.byteLength !== upload.byteLength) {
            throw new MobiusValidationError("The artifact content does not match its upload authorization");
        }
        return decodeMobiusAvailableArtifact(
            await this.#executor.putBytes(
                sessionPath(this.#projectId, sessionId, `artifacts/${encodeURIComponent(upload.artifactId)}/content`),
                bytes,
                upload.mediaType,
                upload.uploadToken,
                signal,
            ),
        );
    };

    readonly read = async (sessionId: string, artifactId: string, signal: AbortSignal): Promise<MobiusArtifact> =>
        decodeMobiusArtifact(
            await this.#executor.get(
                sessionPath(this.#projectId, sessionId, `artifacts/${encodeURIComponent(artifactId)}`),
                signal,
            ),
        );

    readonly download = async (
        sessionId: string,
        artifactId: string,
        signal: AbortSignal,
    ): Promise<MobiusArtifactDownload> => {
        const artifact = await this.read(sessionId, artifactId, signal);
        if (!(artifact instanceof MobiusAvailableArtifact)) {
            throw new MobiusApiError("artifact_not_ready", "The artifact content is not available", 409);
        }
        const bytes = await this.#executor.getBytes(
            sessionPath(this.#projectId, sessionId, `artifacts/${encodeURIComponent(artifactId)}/content`),
            artifact,
            signal,
        );
        return new MobiusArtifactDownload(artifact, bytes);
    };
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
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(credentialId)) {
            throw new MobiusValidationError("The browser credential identifier is invalid");
        }
        await this.#executor.deleteEmpty(
            projectPath(this.#projectId, `browser-credentials/${encodeURIComponent(credentialId)}`),
            signal,
        );
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

    readonly nativeSessions = async (
        runtimeId: string,
        request:
            | (Omit<
                  Extract<NativeSessionCommand, { readonly action: "list" }>,
                  "kind" | "requestId" | "sessionId" | "bindingId"
              > & { readonly discoveryId: string | null })
            | (Omit<
                  Extract<NativeSessionCommand, { readonly action: "import" | "fork" }>,
                  "kind" | "requestId" | "sessionId" | "targetSessionId" | "bindingId" | "action"
              > & { readonly action: "import" | "fork" | "preview"; readonly discoveryId: string }),
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

    readonly revoke = async (runtimeId: string, signal: AbortSignal): Promise<void> => {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(runtimeId)) {
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
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(pairingId)) {
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

    readonly create = async (request: CreateMobiusSessionRequest, signal: AbortSignal): Promise<MobiusSession> =>
        decodeMobiusSession(await this.#executor.post(projectPath(this.#projectId, "sessions"), request, signal));

    readonly createAccess = async (sessionId: string, expiresInSeconds: number, signal: AbortSignal) =>
        new MobiusSessionAccess(
            await this.#executor.post(
                sessionPath(this.#projectId, sessionId, "access-credentials"),
                { expiresInSeconds },
                signal,
            ),
        );

    readonly prepare = async (sessionId: string, signal: AbortSignal) =>
        decodeSessionReadyEvent(
            JSON.stringify(await this.#executor.post(sessionPath(this.#projectId, sessionId, "prepare"), {}, signal)),
        );

    readonly updateConfiguration = async (
        sessionId: string,
        request: Pick<SessionConfigureCommand, "configId" | "value" | "booleanValue" | "valueType">,
        signal: AbortSignal,
    ) =>
        decodeSessionConfigUpdatedEvent(
            JSON.stringify(
                await this.#executor.post(sessionPath(this.#projectId, sessionId, "configuration"), request, signal),
            ),
        );

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

    readonly read = async (sessionId: string, signal: AbortSignal): Promise<MobiusSession> =>
        decodeMobiusSession(await this.#executor.get(sessionPath(this.#projectId, sessionId, "").slice(0, -1), signal));

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

    readonly readNativeHistory = async (sessionId: string, signal: AbortSignal): Promise<NativeSessionHistory> => {
        try {
            return decodeNativeSessionHistory(
                await this.#executor.get(sessionPath(this.#projectId, sessionId, "native-history"), signal),
            );
        } catch (cause) {
            if (cause instanceof MobiusError) {
                throw cause;
            }
            throw new MobiusProtocolError("The service returned invalid native Session history", { cause });
        }
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
        request: SubmitMobiusTurnRequest,
        signal: AbortSignal,
    ): Promise<MobiusTurn> =>
        decodeMobiusTurn(await this.#executor.post(sessionPath(this.#projectId, sessionId, "turns"), request, signal));

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

    readonly steer = async (sessionId: string, turnId: string, signal: AbortSignal): Promise<MobiusTurn> =>
        decodeMobiusTurn(
            await this.#executor.put(
                sessionPath(this.#projectId, sessionId, `turns/${encodeURIComponent(turnId)}/disposition`),
                { disposition: SessionPromptDisposition.Steer },
                signal,
            ),
        );
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
    ): Promise<Interaction> =>
        decodeMobiusInteraction(
            await this.#executor.post(
                sessionPath(this.#projectId, sessionId, `interactions/${encodeURIComponent(interactionId)}/responses`),
                request,
                signal,
            ),
        );
}

export interface MobiusSessionEventObserver {
    readonly receive: (event: MobiusSessionEvent) => Promise<boolean>;
}

export class MobiusEventSubscription {
    readonly #controller: AbortController;
    readonly #executor: MobiusRequestExecutor;
    readonly #externalSignal: AbortSignal;
    readonly #maximumReconnectAttempts: number;
    readonly #observer: MobiusSessionEventObserver;
    readonly #path: string;
    readonly #cursorParameter: string;
    #closed = false;
    #cursor: string;
    #hasSequence = false;
    #lastSequence = 0n;
    readonly completed: Promise<void>;

    constructor(
        executor: MobiusRequestExecutor,
        path: string,
        cursor: string,
        observer: MobiusSessionEventObserver,
        signal: AbortSignal,
        controller: AbortController,
        firstConnection: StreamConnection,
        maximumReconnectAttempts: number,
        cursorParameter = "cursor",
    ) {
        this.#cursor = cursor;
        this.#controller = controller;
        this.#executor = executor;
        this.#externalSignal = signal;
        this.#maximumReconnectAttempts = maximumReconnectAttempts;
        this.#observer = observer;
        this.#path = path;
        this.#cursorParameter = cursorParameter;
        if (this.#externalSignal.aborted) {
            this.abortFromExternal();
        } else {
            this.#externalSignal.addEventListener("abort", this.abortFromExternal, {
                once: true,
            });
        }
        this.completed = this.run(firstConnection).finally(() => {
            this.#externalSignal.removeEventListener("abort", this.abortFromExternal);
        });
    }

    get cursor(): string {
        return this.#cursor;
    }

    readonly close = (): void => {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#controller.abort(new Error("The Mobius event subscription closed"));
    };

    private readonly abortFromExternal = (): void => {
        this.#controller.abort(this.#externalSignal.reason);
    };

    private readonly run = async (firstConnection: StreamConnection): Promise<void> => {
        let connection = firstConnection;
        let reconnectAttempts = 0;
        while (!this.#closed) {
            try {
                const stopped = await this.consume(connection);
                connection.close();
                if (stopped || this.#closed) {
                    this.#closed = true;
                    return;
                }
                throw new MobiusConnectionError("The Mobius event stream closed before the observer stopped it");
            } catch (cause) {
                connection.close();
                if (this.#closed) {
                    return;
                }
                if (connection.hasActivity) {
                    reconnectAttempts = 0;
                }
                try {
                    const recovery = await this.recover(cause, reconnectAttempts);
                    reconnectAttempts = recovery.attempts;
                    connection = recovery.connection;
                } catch (recoveryCause) {
                    if (this.#closed) {
                        return;
                    }
                    throw recoveryCause;
                }
            }
        }
    };

    private readonly consume = async (connection: StreamConnection): Promise<boolean> => {
        const body = connection.response.body;
        if (body === null) {
            throw new MobiusProtocolError("The Mobius event stream has no body");
        }
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        try {
            while (!this.#closed) {
                const result = await reader.read();
                if (result.done) {
                    buffered += decoder.decode();
                    if (buffered.trim().length > 0) {
                        throw new MobiusProtocolError("The Mobius event stream ended with an incomplete event");
                    }
                    return false;
                }
                connection.touch();
                buffered += decoder.decode(result.value, { stream: true });
                if (buffered.length > MAX_EVENT_BLOCK_LENGTH) {
                    throw new MobiusProtocolError("The Mobius event stream exceeded its event limit");
                }
                let boundary = buffered.indexOf("\n\n");
                let boundaryLength = 2;
                const carriageReturnBoundary = buffered.indexOf("\r\n\r\n");
                if (carriageReturnBoundary >= 0 && (boundary < 0 || carriageReturnBoundary < boundary)) {
                    boundary = carriageReturnBoundary;
                    boundaryLength = 4;
                }
                while (boundary >= 0) {
                    const block = buffered.slice(0, boundary);
                    buffered = buffered.slice(boundary + boundaryLength);
                    if (await this.consumeBlock(block.replaceAll("\r\n", "\n"))) {
                        return true;
                    }
                    boundary = buffered.indexOf("\n\n");
                    boundaryLength = 2;
                    const nextCarriageReturnBoundary = buffered.indexOf("\r\n\r\n");
                    if (nextCarriageReturnBoundary >= 0 && (boundary < 0 || nextCarriageReturnBoundary < boundary)) {
                        boundary = nextCarriageReturnBoundary;
                        boundaryLength = 4;
                    }
                }
            }
            return true;
        } catch (cause) {
            if (this.#closed || this.#controller.signal.aborted) {
                throw cause;
            }
            if (cause instanceof MobiusError) {
                throw cause;
            }
            return connection.translateFailure(cause);
        } finally {
            reader.releaseLock();
        }
    };

    private readonly consumeBlock = async (block: string): Promise<boolean> => {
        if (block.length === 0 || block.startsWith(":")) {
            return false;
        }
        let eventName = "";
        let eventId = "";
        let data = "";
        for (const line of block.split("\n")) {
            if (line.startsWith("event:")) {
                eventName = line.slice("event:".length).trimStart();
            } else if (line.startsWith("id:")) {
                eventId = line.slice("id:".length).trimStart();
            } else if (line.startsWith("data:")) {
                data += `${line.slice("data:".length).trimStart()}\n`;
            } else if (!line.startsWith(":")) {
                throw new MobiusProtocolError("The Mobius event stream contains an invalid field");
            }
        }
        if (eventName !== MOBIUS_SESSION_EVENT_STREAM_EVENT || data.length === 0) {
            throw new MobiusProtocolError("The Mobius event stream contains an unsupported event");
        }
        let value: unknown;
        try {
            value = JSON.parse(data.slice(0, -1));
        } catch (cause) {
            throw new MobiusProtocolError("The Mobius event stream contains invalid JSON", { cause });
        }
        const event = decodeMobiusSessionEvent(value);
        if (event.cursor !== eventId) {
            throw new MobiusProtocolError("The Mobius event identifier does not match its cursor");
        }
        const sequence = BigInt(event.sequence);
        if (this.#hasSequence && sequence <= this.#lastSequence) {
            return false;
        }
        if (this.#hasSequence && sequence !== this.#lastSequence + 1n) {
            throw new MobiusProtocolError("The Mobius event stream contains a gap");
        }
        let shouldContinue: boolean;
        try {
            shouldContinue = await this.#observer.receive(event);
        } catch (cause) {
            throw new MobiusError("event_observer_failed", "The Mobius event observer failed", { cause });
        }
        this.#cursor = event.cursor;
        this.#hasSequence = true;
        this.#lastSequence = sequence;
        return !shouldContinue;
    };

    private readonly pathWithCursor = (): string => {
        if (this.#cursor.length === 0) {
            return this.#path;
        }
        return `${this.#path}${this.#path.includes("?") ? "&" : "?"}${this.#cursorParameter}=${encodeURIComponent(this.#cursor)}`;
    };

    private readonly recover = async (
        initialCause: unknown,
        completedAttempts: number,
    ): Promise<MobiusEventStreamRecovery> => {
        this.throwIfTerminal(initialCause);
        let attempts = completedAttempts;
        let latestCause = initialCause;
        while (attempts < this.#maximumReconnectAttempts) {
            attempts += 1;
            await this.reconnectDelay(attempts);
            try {
                return new MobiusEventStreamRecovery(
                    await this.#executor.openEventStream(this.pathWithCursor(), this.#controller.signal),
                    attempts,
                );
            } catch (cause) {
                latestCause = cause;
                this.throwIfTerminal(cause);
            }
        }
        throw new MobiusConnectionError("The Mobius event stream could not recover", { cause: latestCause });
    };

    private readonly throwIfTerminal = (cause: unknown): void => {
        if (this.#externalSignal.aborted) {
            throw new MobiusCancellationError({ cause });
        }
        if (
            cause instanceof MobiusProtocolError ||
            (cause instanceof MobiusApiError && cause.status < 500) ||
            (cause instanceof MobiusError &&
                !(cause instanceof MobiusConnectionError) &&
                !(cause instanceof MobiusTimeoutError) &&
                !(cause instanceof MobiusApiError))
        ) {
            throw cause;
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

class MobiusEventStreamRecovery {
    readonly attempts: number;
    readonly connection: StreamConnection;

    constructor(connection: StreamConnection, attempts: number) {
        this.attempts = attempts;
        this.connection = connection;
    }
}

export class MobiusEventResources {
    readonly #executor: MobiusRequestExecutor;
    readonly #maximumReconnectAttempts: number;
    readonly #projectId: string;
    readonly #subscriptions = new Set<MobiusEventSubscription>();

    constructor(executor: MobiusRequestExecutor, projectId: string, maximumReconnectAttempts: number) {
        this.#executor = executor;
        this.#maximumReconnectAttempts = maximumReconnectAttempts;
        this.#projectId = projectId;
    }

    readonly subscribe = async (
        sessionId: string,
        cursor: string,
        observer: MobiusSessionEventObserver,
        signal: AbortSignal,
    ): Promise<MobiusEventSubscription> => {
        if (cursor.length > 512) {
            throw new MobiusValidationError("The Session event cursor is invalid");
        }
        const path = sessionPath(this.#projectId, sessionId, "events");
        const streamPath = cursor.length === 0 ? path : `${path}?cursor=${encodeURIComponent(cursor)}`;
        const controller = new AbortController();
        const abortFromExternal = (): void => controller.abort(signal.reason);
        if (signal.aborted) {
            abortFromExternal();
        } else {
            signal.addEventListener("abort", abortFromExternal, { once: true });
        }
        let firstConnection: StreamConnection;
        try {
            firstConnection = await this.#executor.openEventStream(streamPath, controller.signal);
        } finally {
            signal.removeEventListener("abort", abortFromExternal);
        }
        const subscription = new MobiusEventSubscription(
            this.#executor,
            path,
            cursor,
            observer,
            signal,
            controller,
            firstConnection,
            this.#maximumReconnectAttempts,
        );
        this.#subscriptions.add(subscription);
        const remove = subscription.completed.finally(() => {
            this.#subscriptions.delete(subscription);
        });
        void remove.catch(() => {});
        return subscription;
    };

    readonly list = async (
        sessionId: string,
        page: MobiusPageRequest,
        signal: AbortSignal,
    ): Promise<MobiusEventPage> => {
        const path = requestUrl(new URL("https://mobius.invalid/"), sessionPath(this.#projectId, sessionId, "events"));
        path.searchParams.set("limit", page.limit.toString());
        if (page.cursor.length > 0) {
            path.searchParams.set("cursor", page.cursor);
        }
        return decodeMobiusEventPage(await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal));
    };

    readonly close = (): void => {
        for (const subscription of this.#subscriptions) {
            subscription.close();
        }
        this.#subscriptions.clear();
    };
}

export class MobiusFixedSessionEventResources {
    readonly #projectId: string;
    readonly #executor: MobiusRequestExecutor;
    readonly #maximumReconnectAttempts: number;
    readonly #subscriptions = new Set<MobiusEventSubscription>();

    constructor(
        executor: MobiusRequestExecutor,
        projectId: string,
        maximumReconnectAttempts = DEFAULT_STREAM_RECONNECT_ATTEMPTS,
    ) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(projectId)) {
            throw new MobiusValidationError("The Mobius project identifier is invalid");
        }
        this.#projectId = projectId;
        this.#executor = executor;
        this.#maximumReconnectAttempts = validatePositiveInteger(
            maximumReconnectAttempts,
            "stream reconnect attempt limit",
        );
    }

    readonly subscribe = async (
        cursor: string,
        observer: MobiusSessionEventObserver,
        signal: AbortSignal,
    ): Promise<MobiusEventSubscription> => {
        if (cursor.length > 512) {
            throw new MobiusValidationError("The Session event cursor is invalid");
        }
        const path = `v1/projects/${encodeURIComponent(this.#projectId)}/client/session/events`;
        const streamPath = cursor.length === 0 ? path : `${path}?after=${encodeURIComponent(cursor)}`;
        const controller = new AbortController();
        const abortFromExternal = (): void => controller.abort(signal.reason);
        if (signal.aborted) {
            abortFromExternal();
        } else {
            signal.addEventListener("abort", abortFromExternal, { once: true });
        }
        let firstConnection: StreamConnection;
        try {
            firstConnection = await this.#executor.openEventStream(streamPath, controller.signal);
        } finally {
            signal.removeEventListener("abort", abortFromExternal);
        }
        const subscription = new MobiusEventSubscription(
            this.#executor,
            path,
            cursor,
            observer,
            signal,
            controller,
            firstConnection,
            this.#maximumReconnectAttempts,
            "after",
        );
        this.#subscriptions.add(subscription);
        const remove = subscription.completed.finally(() => {
            this.#subscriptions.delete(subscription);
        });
        void remove.catch(() => {});
        return subscription;
    };

    readonly list = async (page: MobiusPageRequest, signal: AbortSignal): Promise<MobiusEventPage> => {
        const query = new URLSearchParams({ limit: page.limit.toString() });
        if (page.cursor.length > 0) {
            query.set("after", page.cursor);
        }
        return decodeMobiusEventPage(
            await this.#executor.get(
                `v1/projects/${encodeURIComponent(this.#projectId)}/client/session/events?${query.toString()}`,
                signal,
            ),
        );
    };

    readonly close = (): void => {
        for (const subscription of this.#subscriptions) {
            subscription.close();
        }
        this.#subscriptions.clear();
    };
}

export class MobiusClient {
    readonly artifacts: MobiusArtifactResources;
    readonly attempts: MobiusAttemptResources;
    readonly capabilities: MobiusCapabilityResources;
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
        this.artifacts = new MobiusArtifactResources(executor, options.projectId);
        this.attempts = new MobiusAttemptResources(executor, options.projectId);
        this.capabilities = new MobiusCapabilityResources(executor);
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
