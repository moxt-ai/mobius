import { OperationError } from "../../infra/operation-error.ts";

/** A session rule failed: the session was not found, was busy, reloaded, or the like. */
export class SessionError extends OperationError {
    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(code, message, options);
        this.name = "SessionError";
    }
}
