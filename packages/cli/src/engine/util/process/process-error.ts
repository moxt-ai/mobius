interface ProcessExecutionErrorOptions extends ErrorOptions {
    readonly diagnosticDetails?: Readonly<Record<string, string>>;
}

export class ProcessExecutionError extends Error {
    readonly code: string;
    readonly diagnosticDetails: Readonly<Record<string, string>>;

    constructor(code: string, message: string, options: ProcessExecutionErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.diagnosticDetails = options.diagnosticDetails ?? {};
        this.name = "ProcessExecutionError";
    }
}
