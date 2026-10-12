export class LocalPathError extends Error {
    readonly code = "unsafe_local_path";

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "LocalPathError";
    }
}
