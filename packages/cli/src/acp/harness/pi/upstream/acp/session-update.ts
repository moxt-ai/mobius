import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { type PromptResponse, RequestError } from "@agentclientprotocol/sdk";

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
        const failure = RequestError.internalError({ messageId }, "The prompt could not be completed");
        Object.defineProperty(failure, "cause", { value: cause });
        throw failure;
    }
}

type MessageUpdate = Extract<
    SessionUpdate,
    { readonly sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" }
>;
export type PiMessageUpdate = MessageUpdate & { readonly messageId: string };
export type PiSessionUpdate = PiMessageUpdate | Exclude<SessionUpdate, MessageUpdate>;
export interface PiSessionNotification extends Omit<SessionNotification, "update"> {
    readonly update: PiSessionUpdate;
}
