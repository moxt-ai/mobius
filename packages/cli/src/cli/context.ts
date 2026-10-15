export interface CliContext {
    readonly shutdownSignal: AbortSignal;
    readonly version: string;
}
