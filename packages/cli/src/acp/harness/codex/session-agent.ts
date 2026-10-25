import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { AcpEndpointTermination } from "../../agent/in-process-endpoint.ts";
import type { CodexAppServerServerRequest } from "./app-server-client.ts";

/** Session behavior selected after opening; transport ownership stays with the ACP endpoint. */
export interface CodexSessionAgent {
    readonly steeringSupported: boolean;
    readonly prompt: (input: readonly unknown[], signal: AbortSignal) => Promise<PromptResponse>;
    readonly steer: (
        params: unknown,
        signal: AbortSignal,
    ) => Promise<{ readonly outcome: "injected" | "promptRequired"; readonly reason?: string }>;
    readonly cancel: () => Promise<void>;
    readonly close: () => Promise<void>;
    readonly nativeTurnId: () => string | null;
    /** Reports a manual compaction through thread/compact/start. Unsupported session
     *  agents (borrowed queue access) reject with an execution error. */
    readonly compact: (signal: AbortSignal) => Promise<PromptResponse>;
    readonly onNotification: (method: string, params: unknown) => Promise<void>;
    readonly onServerRequest: (request: CodexAppServerServerRequest) => Promise<void>;
    readonly onTerminated: (termination: AcpEndpointTermination) => void;
}
