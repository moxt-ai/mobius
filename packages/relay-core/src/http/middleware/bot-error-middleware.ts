import type { Env, MiddlewareHandler } from "hono";
import { BotDeliveryError, type BotDeliveryErrorCode } from "../../entity/bot/bot-delivery-error.ts";
import { botErrorResponse } from "../bot/bot-error-response.ts";
import type { BodyParserEnvironment } from "./body-parser.ts";
import { errorResponseMiddleware } from "./error-response-middleware.ts";

function deliveryErrorStatus(code: BotDeliveryErrorCode): number {
    switch (code) {
        case "connection_storage_unavailable":
            return 503;
        case "idempotency_conflict":
        case "revision_conflict":
            return 409;
        case "queue_full":
            return 429;
        case "invalid_request":
            return 400;
        case "connection_not_found":
            return 404;
        default: {
            const unreachable: never = code;
            return unreachable;
        }
    }
}

function botDeliveryErrorResponse(error: unknown): Response {
    if (error instanceof BotDeliveryError) {
        return Response.json(
            { error: { code: error.code, message: error.message } },
            { status: deliveryErrorStatus(error.code) },
        );
    }
    console.error("Bot connection operation failed", error);
    return Response.json(
        {
            error: {
                code: "connection_storage_unavailable",
                message: "The Bot connection storage is unavailable",
            },
        },
        { status: 503 },
    );
}

export function botErrorMiddleware<TEnvironment extends BodyParserEnvironment>(): MiddlewareHandler<TEnvironment> {
    return errorResponseMiddleware<TEnvironment>(botErrorResponse);
}

export function botDeliveryErrorMiddleware<TEnvironment extends Env>(): MiddlewareHandler<TEnvironment> {
    return errorResponseMiddleware<TEnvironment>(botDeliveryErrorResponse);
}
