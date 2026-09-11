import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
    type NativeHistoryMessage,
    type NativeSessionHistory,
    SESSION_HISTORY_CHARACTER_LIMIT,
    SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT,
} from "@moxt-ai/mobius-protocol";
import { isProgressMessage } from "./activity.ts";

/** Captures ACP load replay without turning historical updates into live turns. */
export class AcpHistoryReplay {
    readonly #messages: NativeHistoryMessage[] = [];
    #lastMessageId: string | null = null;
    #characters = 0;
    #truncated = false;

    readonly record = (update: SessionNotification["update"]): void => {
        if (update.sessionUpdate !== "user_message_chunk" && update.sessionUpdate !== "agent_message_chunk") {
            return;
        }
        if (update.sessionUpdate === "agent_message_chunk" && isProgressMessage(update)) {
            return;
        }
        const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
        const content = update.content;
        const text =
            content.type === "text"
                ? content.text
                : content.type === "image"
                  ? content.data.length > 0
                      ? `[@image](data:${content.mimeType};base64,${content.data})`
                      : content.uri != null && content.uri.length > 0
                        ? `[@image](${content.uri})`
                        : "[image attachment]"
                  : `[${content.type} attachment]`;
        if (text.length === 0) {
            return;
        }
        const previous = this.#messages.at(-1);
        const id = update.messageId ?? null;
        const continuation = previous?.role === role && id === this.#lastMessageId;
        const combined = continuation ? `${previous.text}${text}` : text;
        if (continuation) {
            this.#messages.pop();
            this.#characters -= previous.text.length;
        }
        const bounded = combined.slice(-SESSION_HISTORY_CHARACTER_LIMIT);
        this.#truncated ||= bounded.length < combined.length;
        this.#messages.push({
            role,
            text: bounded,
        });
        this.#characters += bounded.length;
        this.#lastMessageId = id;
        while (
            this.#messages.length > SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT ||
            this.#characters > SESSION_HISTORY_CHARACTER_LIMIT
        ) {
            const removed = this.#messages.shift();
            if (removed !== undefined) {
                this.#characters -= removed.text.length;
            }
            this.#truncated = true;
        }
    };

    readonly snapshot = (): NativeSessionHistory => ({
        status: "available",
        messages: [...this.#messages],
        truncated: this.#truncated,
        coveredCommandIds: [],
        coveredMessageIds: [],
    });
}
