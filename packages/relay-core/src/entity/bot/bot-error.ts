import type { HttpError } from "../http-error.ts";

export type BotErrorCode =
    | "behavior_not_active"
    | "binding_incompatible"
    | "binding_not_active"
    | "bot_not_active"
    | "bot_not_found"
    | "bot_service_unavailable"
    | "bot_suspended"
    | "connection_revoked"
    | "connection_storage_unavailable"
    | "connection_not_found"
    | "conversation_access_denied"
    | "credential_invalid"
    | "delivery_target_not_allowed"
    | "delivery_target_unavailable"
    | "execution_context_required"
    | "idempotency_conflict"
    | "invalid_request"
    | "owner_access_required"
    | "project_access_denied"
    | "queue_full"
    | "revision_conflict"
    | "scope_denied";

export type BotFailureKind =
    | "invalid-input"
    | "input-too-large"
    | "unauthenticated"
    | "access-denied"
    | "not-found"
    | "conflict"
    | "capacity-exceeded"
    | "unavailable";

export class BotApiError extends Error implements HttpError {
    readonly code: BotErrorCode;
    readonly kind: BotFailureKind;

    constructor(code: BotErrorCode, message: string, kind: BotFailureKind, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "BotApiError";
        this.kind = kind;
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: {
            "invalid-input": 400,
            "input-too-large": 413,
            unauthenticated: 401,
            "access-denied": 403,
            "not-found": 404,
            conflict: 409,
            "capacity-exceeded": 429,
            unavailable: 503,
        }[this.kind],
    });
}
