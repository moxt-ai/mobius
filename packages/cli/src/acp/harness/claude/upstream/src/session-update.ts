import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";

type MessageUpdate = Extract<
    SessionUpdate,
    { readonly sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" }
>;
export type ClaudeMessageUpdate = MessageUpdate & {
    readonly messageId: string;
    readonly nativeMessageId: string;
};
export type ClaudeSessionUpdate = ClaudeMessageUpdate | Exclude<SessionUpdate, MessageUpdate>;
export interface ClaudeSessionNotification extends Omit<SessionNotification, "update"> {
    readonly update: ClaudeSessionUpdate;
}
