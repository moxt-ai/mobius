/** A failure with a stable machine-readable code, which may cross a subsystem boundary and reach a client. */
export class OperationError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
    }
}

/** The code a client sees for a failed operation. Failures without a code stay opaque. */
export function operationErrorCode(error: unknown): string {
    return error instanceof OperationError ? error.code : "session_operation_failed";
}

export function operationErrorMessage(error: unknown): string {
    return error instanceof OperationError ? error.message : "The local agent operation could not be completed";
}
