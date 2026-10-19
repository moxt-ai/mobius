import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-sdk/protocol";

import {
    MobiusApiError,
    MobiusCancellationError,
    MobiusConnectionError,
    MobiusError,
    MobiusProtocolError,
    MobiusTimeoutError,
    MobiusValidationError,
} from "./errors.ts";
import { HttpTransport, type MobiusHttpTransport } from "./transport/http-transport.ts";

const DEFAULT_OPERATION_TIMEOUT_MILLISECONDS = 20_000;

export interface MobiusPublicRequestOptions {
    readonly endpoint: string;
    readonly observeResponse?: (metadata: { readonly serverTiming: string | null; readonly status: number }) => void;
    readonly operationTimeoutMilliseconds?: number;
    readonly transport?: MobiusHttpTransport;
}

function normalizeEndpoint(value: string): URL {
    let endpoint: URL;
    try {
        endpoint = new URL(value);
    } catch (cause) {
        throw new MobiusValidationError("The Mobius endpoint is invalid", { cause });
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

function operationTimeout(value: number | undefined): number {
    const timeout = value ?? DEFAULT_OPERATION_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(timeout) || timeout < 1) {
        throw new MobiusValidationError("The operation timeout is invalid");
    }
    return timeout;
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
        throw new MobiusProtocolError("The service returned invalid JSON", { cause });
    }
}

async function throwApiError(response: Response): Promise<never> {
    const error = record(record(await responseValue(response))["error"]);
    const code = error["code"];
    const message = error["message"];
    if (typeof code !== "string" || typeof message !== "string") {
        throw new MobiusProtocolError("The service returned an invalid error response");
    }
    throw new MobiusApiError(code, message, response.status);
}

export class MobiusPublicRequestExecutor {
    readonly #endpoint: URL;
    readonly #observeResponse: MobiusPublicRequestOptions["observeResponse"];
    readonly #operationTimeoutMilliseconds: number;
    readonly #transport: MobiusHttpTransport;

    constructor(options: MobiusPublicRequestOptions) {
        this.#endpoint = normalizeEndpoint(options.endpoint);
        this.#observeResponse = options.observeResponse;
        this.#operationTimeoutMilliseconds = operationTimeout(options.operationTimeoutMilliseconds);
        this.#transport = options.transport ?? new HttpTransport();
    }

    readonly post = async (path: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
        const encoded = JSON.stringify(body);
        if (typeof encoded !== "string") {
            throw new MobiusValidationError("The Mobius request body is invalid");
        }
        const timeout = AbortSignal.timeout(this.#operationTimeoutMilliseconds);
        const requestSignal = AbortSignal.any([signal, timeout]);
        try {
            const response = await this.#transport.fetch(
                new Request(new URL(path, this.#endpoint), {
                    body: encoded,
                    headers: { accept: "application/json", "content-type": "application/json" },
                    method: "POST",
                    signal: requestSignal,
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
            if (signal.aborted) {
                throw new MobiusCancellationError({ cause });
            }
            if (timeout.aborted) {
                throw new MobiusTimeoutError({ cause });
            }
            if (cause instanceof MobiusError) {
                throw cause;
            }
            throw new MobiusConnectionError("The Mobius service could not be reached", { cause });
        }
    };
}
