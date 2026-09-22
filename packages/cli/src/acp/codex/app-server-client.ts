import { type ChildProcess, spawn } from "node:child_process";

import { decodeAppServerMessage } from "./app-server-protocol.ts";

const INITIALIZE_TIMEOUT_MILLISECONDS = 30_000;
const OUTPUT_LIMIT_BYTES = 32 * 1_024 * 1_024;

/** A failure in the Codex app-server boundary, reported with a stable code. */
export class CodexAppServerError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "CodexAppServerError";
    }
}

/** A request the app-server addressed to Mobius, which Mobius must answer by id. */
export interface CodexAppServerServerRequest {
    readonly id: number | string;
    readonly method: string;
    readonly params: unknown;
}

export interface CodexAppServerHandlers {
    readonly onNotification: (method: string, params: unknown) => Promise<void>;
    readonly onServerRequest: (request: CodexAppServerServerRequest) => Promise<void>;
}

interface PendingRequest {
    readonly completion: PromiseWithResolvers<unknown>;
}

export interface CodexAppServerOptions {
    readonly command: string;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly handlers: CodexAppServerHandlers;
}

/**
 * Owns one `codex app-server` child process and the newline-delimited JSON-RPC conversation over its
 * stdio. The app-server omits the `jsonrpc` field on the wire in both directions.
 */
export class CodexAppServerClient {
    readonly #child: ChildProcess;
    readonly #handlers: CodexAppServerHandlers;
    readonly #pending = new Map<number | string, PendingRequest>();
    readonly #processExit: Promise<void>;
    #failure: CodexAppServerError | null = null;
    #nextRequestId = 1;
    #pendingBuffer = "";
    #receivedBytes = 0;
    #closed = false;

    constructor(options: CodexAppServerOptions) {
        this.#handlers = options.handlers;
        this.#child = spawn(options.command, ["app-server"], {
            cwd: options.cwd,
            detached: process.platform !== "win32",
            env: { ...process.env, ...options.environment },
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdin = this.#child.stdin;
        const stdout = this.#child.stdout;
        const stderr = this.#child.stderr;
        if (stdin === null || stdout === null || stderr === null) {
            this.#child.kill("SIGKILL");
            throw new CodexAppServerError("codex_app_server_unavailable", "The Codex app-server is unavailable");
        }
        stdout.setEncoding("utf8");
        stdout.on("data", (chunk: string) => {
            this.#consume(chunk);
        });
        stderr.setEncoding("utf8");
        stderr.on("data", (chunk: string) => {
            process.stderr.write(`[codex-app-server] ${chunk}`);
        });
        this.#processExit = new Promise<void>((resolve) => {
            this.#child.once("error", resolve);
            this.#child.once("exit", resolve);
        });
    }

    readonly child = (): ChildProcess => this.#child;

    readonly #fail = (error: CodexAppServerError): void => {
        this.#failure ??= error;
        for (const [id, pending] of this.#pending) {
            this.#pending.delete(id);
            pending.completion.reject(error);
        }
    };

    readonly #exitedFailure = (method: string): CodexAppServerError =>
        this.#failure ??
        new CodexAppServerError("codex_app_server_exited", `The Codex app-server stopped during ${method}`);

    readonly #consume = (chunk: string): void => {
        try {
            this.#receivedBytes += Buffer.byteLength(chunk);
            if (this.#receivedBytes > OUTPUT_LIMIT_BYTES) {
                throw new CodexAppServerError(
                    "codex_app_server_output_limit",
                    "The Codex app-server produced too much output",
                );
            }
            this.#pendingBuffer += chunk;
            let newline = this.#pendingBuffer.indexOf("\n");
            while (newline >= 0) {
                const line = this.#pendingBuffer.slice(0, newline);
                this.#pendingBuffer = this.#pendingBuffer.slice(newline + 1);
                newline = this.#pendingBuffer.indexOf("\n");
                if (line.trim().length === 0) {
                    continue;
                }
                const value: unknown = JSON.parse(line);
                this.#dispatch(decodeAppServerMessage(value));
            }
        } catch (error) {
            this.#fail(
                error instanceof CodexAppServerError
                    ? error
                    : new CodexAppServerError(
                          "codex_app_server_protocol_error",
                          "The Codex app-server sent an unreadable message",
                          { cause: error },
                      ),
            );
            this.#child.kill("SIGKILL");
        }
    };

    // Handler failures are recorded as the app-server's terminal failure: an ACP client that cannot
    // accept an update or answer an approval has no way to resume the conversation.
    readonly #runHandler = (operation: Promise<void>): void => {
        void operation.catch((error: unknown) => {
            this.#fail(
                error instanceof CodexAppServerError
                    ? error
                    : new CodexAppServerError(
                          "codex_app_server_client_error",
                          "Mobius could not process a Codex app-server message",
                          { cause: error },
                      ),
            );
        });
    };

    readonly #dispatch = (message: ReturnType<typeof decodeAppServerMessage>): void => {
        if (message.kind === "result-response") {
            const pending = this.#pending.get(message.id);
            if (pending === undefined) {
                return;
            }
            this.#pending.delete(message.id);
            pending.completion.resolve(message.result);
            return;
        }
        if (message.kind === "error-response") {
            const pending = this.#pending.get(message.id);
            if (pending === undefined) {
                return;
            }
            this.#pending.delete(message.id);
            pending.completion.reject(
                new CodexAppServerError("codex_app_server_request_failed", message.message, {
                    cause: { code: message.code },
                }),
            );
            return;
        }
        if (message.kind === "server-request") {
            this.#runHandler(
                this.#handlers.onServerRequest({ id: message.id, method: message.method, params: message.params }),
            );
            return;
        }
        this.#runHandler(this.#handlers.onNotification(message.method, message.params));
    };

    /** Sends a request and waits for its response, bounded by the caller's cancellation signal. */
    readonly request = async (method: string, params: unknown, signal: AbortSignal): Promise<unknown> => {
        signal.throwIfAborted();
        if (this.#closed) {
            throw new CodexAppServerError("codex_app_server_closed", "The Codex app-server is closed");
        }
        const id = this.#nextRequestId;
        this.#nextRequestId += 1;
        const completion = Promise.withResolvers<unknown>();
        this.#pending.set(id, { completion });
        const abort = (): void => {
            if (this.#pending.delete(id)) {
                completion.reject(signal.reason ?? new Error("Codex app-server request was cancelled"));
            }
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            this.#write({ id, method, params });
            return await Promise.race([completion.promise, this.#processExit.then(() => this.#exitedFailure(method))]);
        } finally {
            signal.removeEventListener("abort", abort);
            this.#pending.delete(id);
        }
    };

    readonly notify = (method: string, params: unknown): void => {
        this.#write({ method, params });
    };

    readonly respond = (id: number | string, result: unknown): void => {
        this.#write({ id, result });
    };

    readonly respondWithError = (id: number | string, code: number, message: string): void => {
        this.#write({ error: { code, message }, id });
    };

    readonly #write = (message: unknown): void => {
        if (this.#closed) {
            return;
        }
        const stdin = this.#child.stdin;
        if (stdin === null || stdin.destroyed) {
            throw new CodexAppServerError("codex_app_server_closed", "The Codex app-server input is closed");
        }
        stdin.write(`${JSON.stringify(message)}\n`);
    };

    /** Performs the `initialize` / `initialized` handshake. */
    readonly initialize = async (signal: AbortSignal): Promise<void> => {
        await this.request(
            "initialize",
            {
                capabilities: { experimentalApi: true },
                clientInfo: { name: "mobius", version: "1.0.0" },
            },
            AbortSignal.any([signal, AbortSignal.timeout(INITIALIZE_TIMEOUT_MILLISECONDS)]),
        );
        this.notify("initialized", undefined);
    };

    /**
     * Rejects every in-flight request and marks the conversation closed without waiting on the
     * process. Process teardown stays with the caller, which owns the process tree: it stops the
     * app-server and every tool subprocess it started.
     */
    readonly detach = (): void => {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#fail(new CodexAppServerError("codex_app_server_closed", "The Codex app-server is closed"));
        const stdin = this.#child.stdin;
        if (stdin !== null && !stdin.destroyed) {
            stdin.end();
        }
    };
}
