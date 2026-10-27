import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";

type MessageUpdate = Extract<
    SessionUpdate,
    { readonly sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" }
>;
export type PiMessageUpdate = MessageUpdate & { readonly messageId: string };
export type PiSessionUpdate = PiMessageUpdate | Exclude<SessionUpdate, MessageUpdate>;
export interface PiSessionNotification extends Omit<SessionNotification, "update"> {
    readonly update: PiSessionUpdate;
}
