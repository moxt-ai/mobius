import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

const BOT_IPC_RESPONSE_LIMIT = 64 * 1024;
const BOT_IPC_TIMEOUT_MILLISECONDS = 20_000;

export class BotMessageCommandError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "BotMessageCommandError";
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredEnvironment(environment: Readonly<NodeJS.ProcessEnv>, name: string): string {
    const value = environment[name]?.trim();
    if (value === undefined || value.length === 0) {
        throw new BotMessageCommandError(
            "execution_context_required",
            "This command is available only inside an active Mobius Bot execution",
        );
    }
    return value;
}

function option(arguments_: readonly string[], name: string): string {
    const index = arguments_.indexOf(name);
    if (index < 0 || index + 1 >= arguments_.length || arguments_[index + 1]?.startsWith("--") === true) {
        throw new BotMessageCommandError(
            "invalid_request",
            "Usage: mobius bot message send --target <current|alias> --text <message>",
        );
    }
    const value = arguments_[index + 1];
    if (value === undefined) {
        throw new BotMessageCommandError("invalid_request", "The Bot message option is missing");
    }
    return value;
}

function validateArguments(arguments_: readonly string[]): void {
    if (arguments_.length !== 4) {
        throw new BotMessageCommandError(
            "invalid_request",
            "Usage: mobius bot message send --target <current|alias> --text <message>",
        );
    }
    const names = [arguments_[0], arguments_[2]];
    if (!names.includes("--target") || !names.includes("--text") || names[0] === names[1]) {
        throw new BotMessageCommandError(
            "invalid_request",
            "Usage: mobius bot message send --target <current|alias> --text <message>",
        );
    }
}

function decodeResponse(encoded: string): string {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotMessageCommandError("bot_service_unavailable", "The local Bot service returned invalid data", {
            cause,
        });
    }
    if (!isRecord(value) || typeof value["ok"] !== "boolean") {
        throw new BotMessageCommandError("bot_service_unavailable", "The local Bot service returned invalid data");
    }
    if (value["ok"] === true && typeof value["outboundMessageId"] === "string") {
        return value["outboundMessageId"];
    }
    const error = value["error"];
    if (
        value["ok"] === false &&
        isRecord(error) &&
        typeof error["code"] === "string" &&
        typeof error["message"] === "string"
    ) {
        throw new BotMessageCommandError(error["code"], error["message"]);
    }
    throw new BotMessageCommandError("bot_service_unavailable", "The local Bot service returned invalid data");
}

async function requestLocalBotService(socketPath: string, payload: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    return await new Promise<string>((resolve, reject) => {
        const socket = createConnection(socketPath);
        const chunks: Buffer[] = [];
        let length = 0;
        let finished = false;
        const finish = (): void => {
            socket.removeAllListeners();
            socket.destroy();
        };
        const fail = (error: unknown): void => {
            if (finished) {
                return;
            }
            finished = true;
            finish();
            if (error instanceof BotMessageCommandError) {
                reject(error);
                return;
            }
            reject(
                new BotMessageCommandError(
                    "execution_context_required",
                    "The active Mobius Bot execution is unavailable",
                    { cause: error },
                ),
            );
        };
        const abort = (): void => fail(signal.reason);
        socket.setTimeout(BOT_IPC_TIMEOUT_MILLISECONDS, () => {
            fail(new BotMessageCommandError("bot_service_unavailable", "The local Bot service timed out"));
        });
        socket.once("error", fail);
        socket.once("connect", () => socket.end(`${payload}\n`));
        socket.on("data", (chunk: Buffer) => {
            length += chunk.byteLength;
            if (length > BOT_IPC_RESPONSE_LIMIT) {
                fail(new BotMessageCommandError("bot_service_unavailable", "The local Bot response is too large"));
                return;
            }
            chunks.push(chunk);
        });
        socket.once("end", () => {
            if (finished) {
                return;
            }
            finished = true;
            signal.removeEventListener("abort", abort);
            try {
                resolve(decodeResponse(Buffer.concat(chunks).toString("utf8")));
            } catch (error) {
                reject(error);
            } finally {
                finish();
            }
        });
        signal.addEventListener("abort", abort, { once: true });
    });
}

export async function executeBotMessageCommand(
    arguments_: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
): Promise<string> {
    validateArguments(arguments_);
    const contextHandle = requiredEnvironment(environment, "MOBIUS_BOT_CONTEXT");
    const socketPath = requiredEnvironment(environment, "MOBIUS_BOT_SOCKET");
    const target = option(arguments_, "--target");
    const text = option(arguments_, "--text");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(target) || text.trim().length === 0 || text.length > 10_000) {
        throw new BotMessageCommandError("invalid_request", "The Bot outbound message is invalid");
    }
    return await requestLocalBotService(
        socketPath,
        JSON.stringify({
            contextHandle,
            idempotencyKey: `cli_${randomUUID()}`,
            target,
            text,
        }),
        signal,
    );
}
