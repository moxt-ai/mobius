import { OperationError } from "../infra/operation-error.ts";

/**
 * The typed error contract for the ACP execution boundary. It lives apart from the session manager so
 * that endpoint implementations can report failures without depending on the manager that drives
 * them.
 */
export class AcpExecutionError extends OperationError {
    constructor(message: string, options: ErrorOptions = {}, code = "acp_execution_failed") {
        super(code, message, options);
        this.name = "AcpExecutionError";
    }
}

export class AcpConfigurationValueUnavailableError extends AcpExecutionError {
    readonly configId: string;
    readonly offeredValueCount: number;
    readonly offeredValues: readonly string[];
    readonly requestedValue: string;

    constructor(configId: string, requestedValue: string, offeredValues: readonly string[]) {
        super("The requested ACP configuration value is unavailable", {}, "invalid_session_configuration");
        this.name = "AcpConfigurationValueUnavailableError";
        this.configId = configId.slice(0, 128);
        this.requestedValue = requestedValue.slice(0, 128);
        this.offeredValueCount = offeredValues.length;
        this.offeredValues = Object.freeze(offeredValues.slice(0, 32).map((value) => value.slice(0, 128)));
    }
}
