export class MobiusError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "MobiusError";
    }
}

export class MobiusApiError extends MobiusError {
    readonly status: number;

    constructor(code: string, message: string, status: number, options: ErrorOptions = {}) {
        super(code, message, options);
        this.name = "MobiusApiError";
        this.status = status;
    }
}

export class MobiusCancellationError extends MobiusError {
    constructor(options: ErrorOptions = {}) {
        super("operation_cancelled", "The Mobius operation was cancelled", options);
        this.name = "MobiusCancellationError";
    }
}

export class MobiusConnectionError extends MobiusError {
    constructor(message: string, options: ErrorOptions = {}) {
        super("service_unavailable", message, options);
        this.name = "MobiusConnectionError";
    }
}

export class MobiusProtocolError extends MobiusError {
    constructor(message: string, options: ErrorOptions = {}) {
        super("invalid_service_response", message, options);
        this.name = "MobiusProtocolError";
    }
}

export class MobiusTimeoutError extends MobiusError {
    constructor(options: ErrorOptions = {}) {
        super("operation_timeout", "The Mobius operation timed out", options);
        this.name = "MobiusTimeoutError";
    }
}

export class MobiusValidationError extends MobiusError {
    constructor(message: string, options: ErrorOptions = {}) {
        super("invalid_request", message, options);
        this.name = "MobiusValidationError";
    }
}
