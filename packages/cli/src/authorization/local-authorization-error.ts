export class LocalAuthorizationError extends Error {
    readonly code = "local_authorization_failed";

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "LocalAuthorizationError";
    }
}
