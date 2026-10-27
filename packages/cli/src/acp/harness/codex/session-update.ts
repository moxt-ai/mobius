import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import type { InProcessAcpEndpointOptions } from "../../agent/in-process-endpoint.ts";

type MessageUpdate = Extract<
    SessionUpdate,
    { readonly sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" }
>;
export type CodexMessageUpdate = MessageUpdate & {
    readonly messageId: string;
    readonly nativeMessageId: string;
};
export type CodexSessionUpdate = CodexMessageUpdate | Exclude<SessionUpdate, MessageUpdate>;
export interface CodexSessionNotification extends Omit<SessionNotification, "update"> {
    readonly update: CodexSessionUpdate;
}
export interface CodexEndpointOptions extends Omit<InProcessAcpEndpointOptions, "onSessionUpdate"> {
    readonly onSessionUpdate: (notification: CodexSessionNotification) => Promise<void>;
}
