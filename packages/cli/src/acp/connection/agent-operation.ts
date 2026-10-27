import { RequestError } from "@agentclientprotocol/sdk";
import { isRecord, truncate } from "../../util/value-utils.ts";
import { AcpExecutionError } from "../acp-error.ts";
import { type AcpEndpointTermination, acpEndpointTerminationError } from "../agent/in-process-endpoint.ts";

function requestErrorMessage(error: RequestError): string {
    const fallback = truncate(error.message, 500);
    if (error.message !== "Internal error" || !isRecord(error.data)) {
        return fallback;
    }
    const agentError = error.data["error"];
    if (isRecord(agentError)) {
        const message = agentError["message"];
        if (typeof message === "string" && message.length > 0) {
            return truncate(message, 500);
        }
    }
    const details = error.data["details"];
    return typeof details === "string" && details.length > 0 ? truncate(details, 500) : fallback;
}

/** Observes an already-started operation even when cancellation wins before entry. */
export async function raceAgentOperation<T>(
    operation: Promise<T>,
    termination: Promise<AcpEndpointTermination>,
    exitMessage: string,
    signal: AbortSignal,
): Promise<T> {
    let removeAbortListener = (): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
        const rejectAbort = (): void => {
            reject(signal.reason ?? new Error("ACP request was cancelled"));
        };
        signal.addEventListener("abort", rejectAbort, { once: true });
        removeAbortListener = (): void => signal.removeEventListener("abort", rejectAbort);
        if (signal.aborted) {
            rejectAbort();
        }
    });
    try {
        return await Promise.race([
            aborted,
            operation,
            termination.then((result) => {
                const cause = acpEndpointTerminationError(result);
                throw new AcpExecutionError(exitMessage, { cause }, cause.code);
            }),
        ]);
    } catch (error) {
        signal.throwIfAborted();
        if (error instanceof RequestError && error.code === -32_000) {
            throw new AcpExecutionError(
                "Agent authentication is required",
                { cause: error },
                "authentication_required",
            );
        }
        if (error instanceof RequestError) {
            throw new AcpExecutionError(requestErrorMessage(error), { cause: error }, "acp_agent_error");
        }
        throw error;
    } finally {
        removeAbortListener();
    }
}
