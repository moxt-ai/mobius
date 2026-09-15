import type { HttpError } from "../http-error.ts";

export type BotDeliveryErrorCode =
    | "connection_storage_unavailable"
    | "idempotency_conflict"
    | "queue_full"
    | "invalid_request"
    | "revision_conflict"
    | "connection_not_found";

export class BotDeliveryError extends Error implements HttpError {
    readonly code: BotDeliveryErrorCode;
    constructor(code: BotDeliveryErrorCode, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "BotDeliveryError";
        this.code = code;
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: {
            connection_storage_unavailable: 503,
            idempotency_conflict: 409,
            revision_conflict: 409,
            queue_full: 429,
            invalid_request: 400,
            connection_not_found: 404,
        }[this.code],
    });
}
