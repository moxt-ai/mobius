import { BotApiError, type BotFailureKind } from "../../entity/bot/bot-error.ts";
import { SessionRuntimeError } from "../../entity/do/session.ts";
import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";

export function botErrorResponse(error: unknown): Response {
    if (error instanceof BotApiError) {
        return Response.json(
            { error: { code: error.code, message: error.message } },
            { status: botFailureStatus(error.kind) },
        );
    }
    if (error instanceof PairingDirectoryError) {
        const status =
            error.code === "directory_unavailable" ? 503 : error.code === "owner_access_required" ? 403 : 401;
        return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    if (error instanceof SessionRuntimeError) {
        return Response.json(
            { error: { code: error.code, message: error.message } },
            { status: botSessionErrorStatus(error.code) },
        );
    }
    console.error("Bot API operation failed", error);
    return Response.json(
        { error: { code: "bot_service_unavailable", message: "The Bot service is unavailable" } },
        { status: 503 },
    );
}

function botFailureStatus(kind: BotFailureKind): number {
    switch (kind) {
        case "invalid-input":
            return 400;
        case "input-too-large":
            return 413;
        case "unauthenticated":
            return 401;
        case "access-denied":
            return 403;
        case "not-found":
            return 404;
        case "conflict":
            return 409;
        case "capacity-exceeded":
            return 429;
        case "unavailable":
            return 503;
        default: {
            const unreachable: never = kind;
            return unreachable;
        }
    }
}

function botSessionErrorStatus(code: string): number {
    if (code === "execution_capability_invalid") {
        return 401;
    }
    if (code === "conversation_access_denied" || code === "delivery_target_not_allowed") {
        return 403;
    }
    if (code === "execution_capability_expired") {
        return 410;
    }
    if (code === "queue_full") {
        return 429;
    }
    if (code === "idempotency_conflict" || code === "session_busy") {
        return 409;
    }
    if (code === "invalid_request") {
        return 400;
    }
    return 503;
}
