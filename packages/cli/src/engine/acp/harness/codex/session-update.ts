import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import type { InProcessAcpEndpointOptions } from "../../agent/in-process-endpoint.ts";

type MessageUpdate = Extract<
    SessionUpdate,
    { readonly sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" }
>;
export type CodexMessageUpdate = MessageUpdate & {
    readonly messageId: string;
};
export type CodexSessionUpdate = CodexMessageUpdate | Exclude<SessionUpdate, MessageUpdate>;
export interface CodexSessionNotification extends Omit<SessionNotification, "update"> {
    readonly update: CodexSessionUpdate;
}
export interface CodexEndpointOptions extends Omit<InProcessAcpEndpointOptions, "onSessionUpdate"> {
    readonly onSessionUpdate: (notification: CodexSessionNotification) => Promise<void>;
}

import { type PromptResponse, RequestError } from "@agentclientprotocol/sdk";
import { OperationError } from "../../../infra/operation-error.ts";

export async function promptResultWithMessageId(
    result: Promise<PromptResponse>,
    messageId: string,
): Promise<PromptResponse> {
    try {
        const response = await result;
        return { ...response, _meta: { ...response._meta, messageId } };
    } catch (cause) {
        if (cause instanceof RequestError) {
            const data = typeof cause.data === "object" && cause.data !== null ? cause.data : {};
            cause.data = { ...data, messageId };
            throw cause;
        }
        // An OperationError carries a message written for clients (for example Codex's own turn failure
        // reason or why the app-server stopped); any other error may quote internals and stays opaque.
        const detail = cause instanceof OperationError ? cause.message : "The prompt could not be completed";
        const failure = RequestError.internalError({ messageId }, detail);
        Object.defineProperty(failure, "cause", { value: cause });
        throw failure;
    }
}
