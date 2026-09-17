import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { fetch } from "undici";

import type { ActiveBotExecutionContext, BotExecutionContextRegistry } from "./bot-execution-context.ts";
import { LocalBotAuthorizationError } from "./local-bot-execution-authorizer.ts";

const BOT_IPC_REQUEST_LIMIT = 32 * 1024;
const BOT_IPC_TIMEOUT_MILLISECONDS = 20_000;
const BOT_RELAY_TIMEOUT_MILLISECONDS = 20_000;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const WINDOWS_NAMED_PIPE_PREFIX = "\\\\.\\pipe\\";

class BotOutboundIpcRequest {
    readonly contextHandle: string;
    readonly idempotencyKey: string;
    readonly target: string;
    readonly text: string;

    constructor(contextHandle: string, idempotencyKey: string, target: string, text: string) {
        this.contextHandle = contextHandle;
        this.idempotencyKey = idempotencyKey;
        this.target = target;
        this.text = text;
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeRequest(encoded: string): BotOutboundIpcRequest {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new LocalBotAuthorizationError("invalid_request", "The local Bot request is invalid", { cause });
    }
    if (!isRecord(value)) {
        throw new LocalBotAuthorizationError("invalid_request", "The local Bot request is invalid");
    }
    const keys = Object.keys(value);
    if (
        keys.length !== 4 ||
        !keys.every((key) => ["contextHandle", "idempotencyKey", "target", "text"].includes(key))
    ) {
        throw new LocalBotAuthorizationError("invalid_request", "The local Bot request fields are invalid");
    }
    const contextHandle = value["contextHandle"];
    const idempotencyKey = value["idempotencyKey"];
    const target = value["target"];
    const text = value["text"];
    if (
        typeof contextHandle !== "string" ||
        !/^ctx_[a-zA-Z0-9_-]{43}$/.test(contextHandle) ||
        typeof idempotencyKey !== "string" ||
        !IDENTIFIER_PATTERN.test(idempotencyKey) ||
        typeof target !== "string" ||
        !IDENTIFIER_PATTERN.test(target) ||
        typeof text !== "string" ||
        text.trim().length === 0 ||
        text.length > 10_000
    ) {
        throw new LocalBotAuthorizationError("invalid_request", "The local Bot request is invalid");
    }
    return new BotOutboundIpcRequest(contextHandle, idempotencyKey, target, text);
}

function relayEndpoint(relayUrl: URL, context: ActiveBotExecutionContext, target: string): URL {
    const endpoint = new URL(relayUrl);
    if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
        throw new LocalBotAuthorizationError("bot_service_unavailable", "The Mobius Relay URL is invalid");
    }
    endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
    endpoint.search = "";
    const execution = encodeURIComponent(context.command.executionId);
    if (target === "current") {
        context.resolveTarget(target);
        endpoint.pathname = `${MOBIUS_API_PREFIX}/v1/bot-executions/${execution}/reply-messages`;
        return endpoint;
    }
    const deliveryTargetId = context.resolveTarget(target);
    endpoint.pathname = `${MOBIUS_API_PREFIX}/v1/bot-executions/${execution}/delivery-targets/${encodeURIComponent(deliveryTargetId)}/messages`;
    return endpoint;
}

function daemonToken(relayUrl: URL): string {
    const token = relayUrl.searchParams.get("token") ?? "";
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token)) {
        throw new LocalBotAuthorizationError("bot_service_unavailable", "The Runtime credential is unavailable");
    }
    return token;
}

async function decodeRelayResponse(response: Awaited<ReturnType<typeof fetch>>): Promise<string> {
    const encoded = await response.text();
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new LocalBotAuthorizationError("bot_service_unavailable", "The Mobius Relay returned invalid data", {
            cause,
        });
    }
    if (response.status === 202 && isRecord(value) && typeof value["outboundMessageId"] === "string") {
        return value["outboundMessageId"];
    }
    if (isRecord(value) && isRecord(value["error"])) {
        const error = value["error"];
        if (typeof error["code"] === "string" && typeof error["message"] === "string") {
            throw new LocalBotAuthorizationError(error["code"], error["message"]);
        }
    }
    throw new LocalBotAuthorizationError("bot_service_unavailable", "The Mobius Relay rejected the Bot action");
}

export class BotOutboundIpcServer {
    readonly #registry: BotExecutionContextRegistry;
    readonly #relayUrl: URL;
    readonly #server: Server;
    readonly #socketPath: string;
    readonly #usesFilesystemSocket: boolean;

    constructor(socketPath: string, relayUrl: URL, registry: BotExecutionContextRegistry) {
        const usesFilesystemSocket = !socketPath.startsWith(WINDOWS_NAMED_PIPE_PREFIX);
        if (usesFilesystemSocket && !isAbsolute(socketPath)) {
            throw new Error("The Bot IPC path must be absolute");
        }
        this.#registry = registry;
        this.#relayUrl = new URL(relayUrl);
        this.#server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
        this.#socketPath = socketPath;
        this.#usesFilesystemSocket = usesFilesystemSocket;
    }

    get socketPath(): string {
        return this.#socketPath;
    }

    readonly listen = async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if (this.#usesFilesystemSocket) {
            await mkdir(dirname(this.#socketPath), { mode: 0o700, recursive: true });
            await unlink(this.#socketPath).catch((error: unknown) => {
                if (!isRecord(error) || error["code"] !== "ENOENT") {
                    throw error;
                }
            });
        }
        await new Promise<void>((resolve, reject) => {
            const fail = (error: Error): void => reject(error);
            this.#server.once("error", fail);
            this.#server.listen(this.#socketPath, () => {
                this.#server.removeListener("error", fail);
                resolve();
            });
        });
        if (this.#usesFilesystemSocket) {
            await chmod(this.#socketPath, 0o600);
        }
        signal.addEventListener("abort", this.abort, { once: true });
        if (signal.aborted) {
            this.abort();
        }
    };

    readonly close = async (): Promise<void> => {
        if (this.#server.listening) {
            await new Promise<void>((resolve, reject) => {
                this.#server.close((error) => {
                    if (error === undefined) {
                        resolve();
                        return;
                    }
                    reject(error);
                });
            });
        }
        if (this.#usesFilesystemSocket) {
            await unlink(this.#socketPath).catch((error: unknown) => {
                if (!isRecord(error) || error["code"] !== "ENOENT") {
                    throw error;
                }
            });
        }
    };

    readonly #abort = (): void => {
        this.#server.close();
    };

    private readonly abort = (): void => this.#abort();

    private readonly accept = (socket: Socket): void => {
        const chunks: Buffer[] = [];
        let length = 0;
        let rejected = false;
        const controller = new AbortController();
        socket.setTimeout(BOT_IPC_TIMEOUT_MILLISECONDS, () => {
            controller.abort(new Error("Bot IPC request timed out"));
            socket.destroy();
        });
        socket.on("data", (chunk: Buffer) => {
            length += chunk.byteLength;
            if (length > BOT_IPC_REQUEST_LIMIT) {
                rejected = true;
                controller.abort(new Error("Bot IPC request is too large"));
                socket.end(
                    JSON.stringify({
                        error: { code: "invalid_request", message: "The local Bot request is too large" },
                        ok: false,
                    }),
                );
                return;
            }
            chunks.push(chunk);
        });
        socket.once("error", () => controller.abort());
        socket.once("close", () => controller.abort());
        socket.once("end", () => {
            if (rejected) {
                return;
            }
            void this.handle(Buffer.concat(chunks).toString("utf8").trim(), controller.signal).then(
                (outboundMessageId) => {
                    if (!socket.destroyed) {
                        socket.end(JSON.stringify({ ok: true, outboundMessageId }));
                    }
                },
                (error: unknown) => {
                    if (socket.destroyed) {
                        return;
                    }
                    const code = error instanceof LocalBotAuthorizationError ? error.code : "bot_service_unavailable";
                    const message =
                        error instanceof LocalBotAuthorizationError
                            ? error.message
                            : "The local Bot action could not be completed";
                    socket.end(JSON.stringify({ error: { code, message }, ok: false }));
                },
            );
        });
    };

    private readonly handle = async (encoded: string, signal: AbortSignal): Promise<string> => {
        const request = decodeRequest(encoded);
        const context = this.#registry.read(request.contextHandle);
        const timeout = AbortSignal.timeout(BOT_RELAY_TIMEOUT_MILLISECONDS);
        const requestSignal = AbortSignal.any([signal, timeout]);
        let response: Awaited<ReturnType<typeof fetch>>;
        try {
            response = await fetch(relayEndpoint(this.#relayUrl, context, request.target), {
                body: JSON.stringify({ idempotencyKey: request.idempotencyKey, text: request.text }),
                headers: {
                    authorization: `Bearer ${daemonToken(this.#relayUrl)}`,
                    "content-type": "application/json",
                    "x-mobius-bot-execution-capability": context.command.executionCapabilitySecret,
                },
                method: "POST",
                signal: requestSignal,
            });
        } catch (cause) {
            signal.throwIfAborted();
            throw new LocalBotAuthorizationError(
                timeout.aborted ? "bot_service_timeout" : "bot_service_unavailable",
                timeout.aborted ? "The Mobius Bot action timed out" : "The Mobius Relay is unavailable",
                { cause },
            );
        }
        return await decodeRelayResponse(response);
    };
}
