import {
    type AgentSettingsDiscoveredEvent,
    decodeAgentSettingsDiscoveredEvent,
    decodeNativeSessionResult,
    decodeWorkspaceEntriesEvent,
    MOBIUS_API_PREFIX,
    type NativeSessionRequest,
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
    decodeMobiusBrowserCredential,
    decodeMobiusRuntimeList,
    decodeMobiusRuntimePairing,
    decodeMobiusRuntimePairingStatus,
    type MobiusBrowserCredential,
    type MobiusBrowserCredentialRequest,
    MobiusPairedRuntimePairingStatus,
    type MobiusRuntimeDescriptor,
    type MobiusRuntimePairing,
    MobiusRuntimePairingLifecycle,
    type MobiusRuntimePairingRequest,
    type MobiusRuntimePairingStatus,
    type MobiusRuntimePairingWaitOptions,
} from "./resources.ts";
import { HttpTransport, type MobiusHttpTransport } from "./transport/http-transport.ts";

const DEFAULT_OPERATION_TIMEOUT_MILLISECONDS = 20_000;

export interface MobiusCredentialProvider {
    readonly credential: (signal: AbortSignal) => Promise<string>;
}

export interface DiscoverMobiusAgentSettingsRequest {
    readonly model?: string;
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
    readonly observeResponse?: (metadata: MobiusResponseMetadata) => void;
    readonly operationTimeoutMilliseconds?: number;
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

export class MobiusRequestExecutor {
    readonly #authenticationProviderId: string;
    readonly #credentialProvider: MobiusCredentialProvider;
    readonly #endpoint: URL;
    readonly #operationTimeoutMilliseconds: number;
    readonly #observeResponse: ((metadata: MobiusResponseMetadata) => void) | undefined;
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
        this.#transport = options.transport ?? new HttpTransport();
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

    readonly delete = async (path: string, signal: AbortSignal): Promise<unknown> =>
        await this.request(path, "DELETE", "", false, signal);

    readonly deleteEmpty = async (path: string, signal: AbortSignal): Promise<void> => {
        await this.requestEmpty(path, "DELETE", signal);
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
            | Omit<
                  Extract<NativeSessionRequest, { readonly action: "create" }>,
                  "kind" | "requestId" | "sessionId" | "bindingId"
              >
            | (Omit<
                  Extract<NativeSessionRequest, { readonly action: "list" }>,
                  "kind" | "requestId" | "sessionId" | "bindingId"
              > & { readonly discoveryId: string | null })
            | (Omit<
                  Extract<NativeSessionRequest, { readonly action: "import" | "fork" }>,
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

export class MobiusClient {
    readonly credentials: MobiusCredentialResources;
    readonly runtimePairings: MobiusRuntimePairingResources;
    readonly runtimes: MobiusRuntimeResources;

    constructor(options: MobiusClientOptions) {
        const executor = new MobiusRequestExecutor(options);
        this.credentials = new MobiusCredentialResources(executor, options.projectId);
        this.runtimePairings = new MobiusRuntimePairingResources(executor, options.projectId);
        this.runtimes = new MobiusRuntimeResources(executor, options.projectId);
    }
}
