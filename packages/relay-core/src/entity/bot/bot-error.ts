export type BotErrorCode =
    | "behavior_not_approved"
    | "binding_incompatible"
    | "binding_not_approved"
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

export class BotApiError extends Error {
    readonly code: BotErrorCode;
    readonly kind: BotFailureKind;

    constructor(code: BotErrorCode, message: string, kind: BotFailureKind, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "BotApiError";
        this.kind = kind;
    }
}
