import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";

type MessageUpdate = Extract<
    SessionUpdate,
    {
        readonly sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
    }
>;
export type IdentifiedSessionUpdate =
    | (MessageUpdate & { readonly messageId: string })
    | Exclude<SessionUpdate, MessageUpdate>;
export interface IdentifiedSessionNotification extends Omit<SessionNotification, "update"> {
    readonly update: IdentifiedSessionUpdate;
}
