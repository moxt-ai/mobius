import { PairingDirectoryError, SessionRuntimeError } from "@moxt-ai/mobius-relay-core";

export class BotApiError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, message: string, status: number, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "BotApiError";
        this.status = status;
    }
}

export function botErrorResponse(error: unknown): Response {
    if (error instanceof BotApiError) {
        return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    if (error instanceof PairingDirectoryError) {
        const status = error.code === "owner_access_required" ? 403 : 401;
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
