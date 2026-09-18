import type { MiddlewareHandler } from "hono";
import { BotApiError } from "../../entity/bot/bot-error.ts";
import { RequestBodyError, readBoundedUtf8Body } from "../../infra/bounded-request-body.ts";
import { type BodyParserEnvironment, contextBodyParser } from "./body-parser.ts";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DEFAULT_BOT_BODY_LIMIT_BYTES = 256 * 1024;

async function parseBotBody(request: Request, maximumBytes: number): Promise<Readonly<Record<string, unknown>>> {
    let encoded: string;
    try {
        encoded = await readBoundedUtf8Body(request, maximumBytes);
    } catch (cause) {
        if (cause instanceof RequestBodyError) {
            throw new BotApiError(
                "invalid_request",
                cause.code === "body_too_large" ? "The request body is too large" : "The request body is invalid",
                cause.code === "body_too_large" ? "input-too-large" : "invalid-input",
                { cause },
            );
        }
        throw cause;
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotApiError("invalid_request", "The request body is not valid JSON", "invalid-input", { cause });
    }
    if (!isRecord(value)) {
        throw new BotApiError("invalid_request", "The request body must be an object", "invalid-input");
    }
    return value;
}

export function botBodyParser<TEnvironment extends BodyParserEnvironment>(
    maximumBytes: number = DEFAULT_BOT_BODY_LIMIT_BYTES,
): MiddlewareHandler<TEnvironment> {
    return contextBodyParser<TEnvironment>(
        (request) => parseBotBody(request, maximumBytes),
        (request) => request.method === "POST" || request.method === "PUT",
    );
}
