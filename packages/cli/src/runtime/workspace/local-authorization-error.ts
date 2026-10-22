import { OperationError } from "../../infra/operation-error.ts";

export class LocalAuthorizationError extends OperationError {
    constructor(message: string, options: ErrorOptions = {}) {
        super("local_authorization_failed", message, options);
        this.name = "LocalAuthorizationError";
    }
}
