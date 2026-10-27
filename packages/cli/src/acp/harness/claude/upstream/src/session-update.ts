import { RequestError, type SessionNotification, type SessionUpdate } from "@agentclientprotocol/sdk";

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
export function claudeSessionNotification({ update, ...notification }: SessionNotification): ClaudeSessionNotification {
    switch (update.sessionUpdate) {
        case "user_message_chunk":
        case "agent_message_chunk":
        case "agent_thought_chunk": {
            const nativeMessageId = update.messageId;
            if (typeof nativeMessageId !== "string" || nativeMessageId.length === 0) {
                throw new RequestError(-32603, "Claude emitted a message without native identity", {
                    code: "invalid_native_message_id",
                });
            }
            return {
                ...notification,
                update: {
                    ...update,
                    nativeMessageId,
                    messageId: `claude:${nativeMessageId}`,
                },
            };
        }
        default:
            return { ...notification, update };
    }
}
