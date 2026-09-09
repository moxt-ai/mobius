export type BotDeliveryErrorCode =
    | "connection_storage_unavailable"
    | "idempotency_conflict"
    | "queue_full"
    | "invalid_request"
    | "revision_conflict"
    | "connection_not_found";

export class BotDeliveryError extends Error {
    readonly code: BotDeliveryErrorCode;
    constructor(code: BotDeliveryErrorCode, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "BotDeliveryError";
        this.code = code;
    }
}
