import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
    type AgentDisplayContent,
    type NativeHistoryMessage,
    type NativeSessionHistory,
    SESSION_HISTORY_CHARACTER_LIMIT,
    SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT,
} from "@moxt-ai/mobius-protocol";
import { type AcpActivity, AcpActivityTracker, isProgressMessage, normalizeContentBlock } from "./activity.ts";

type ReplayMessage =
    | {
          readonly role: "user";
          readonly text: string;
      }
    | {
          readonly activityIds: readonly string[];
          readonly content: readonly AgentDisplayContent[];
          readonly role: "assistant";
          readonly text: string;
      };

/** Captures ACP load replay without turning historical updates into live turns. */
export class AcpHistoryReplay {
    readonly #activities = new Map<string, AcpActivity>();
    readonly #messages: ReplayMessage[] = [];
    readonly #turnActivityIds = new Set<string>();
    readonly #activityTracker = new AcpActivityTracker(async (activity) => {
        this.#activities.set(activity.activityId, activity);
        this.#turnActivityIds.add(activity.activityId);
        const latest = this.#messages.at(-1);
        if (latest?.role === "assistant") {
            this.#messages[this.#messages.length - 1] = {
                ...latest,
                activityIds: [...this.#turnActivityIds],
            };
        }
    });
    #lastMessageId: string | null = null;
    #characters = 0;
    #truncated = false;

    readonly record = async (update: SessionNotification["update"]): Promise<void> => {
        if (update.sessionUpdate === "agent_thought_chunk") {
            if (update.content.type === "text") {
                await this.#activityTracker.recordNarrative(
                    "reasoning",
                    update.messageId ?? "current",
                    update.content.text,
                );
            }
            return;
        }
        if (update.sessionUpdate === "tool_call") {
            await this.#activityTracker.recordToolCall(update);
            return;
        }
        if (update.sessionUpdate === "tool_call_update") {
            await this.#activityTracker.recordToolCallUpdate(update);
            return;
        }
        if (update.sessionUpdate === "plan") {
            await this.#activityTracker.recordPlan(update);
            return;
        }
        if (update.sessionUpdate === "plan_update") {
            await this.#activityTracker.recordPlanUpdate(update);
            return;
        }
        if (update.sessionUpdate === "plan_removed") {
            await this.#activityTracker.removePlan(update);
            return;
        }
        if (update.sessionUpdate !== "user_message_chunk" && update.sessionUpdate !== "agent_message_chunk") {
            return;
        }
        if (update.sessionUpdate === "agent_message_chunk" && isProgressMessage(update)) {
            if (update.content.type === "text") {
                await this.#activityTracker.recordNarrative(
                    "progress",
                    update.messageId ?? "current",
                    update.content.text,
                );
            }
            return;
        }
        const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
        const content = update.content;
        if (role === "assistant" && content.type !== "text") {
            await this.#activityTracker.finishNarrative();
            this.recordAssistantContent(update.messageId ?? null, normalizeContentBlock(content));
            return;
        }
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
        if (role === "user" && !continuation) {
            await this.#activityTracker.finish();
            this.#turnActivityIds.clear();
        }
        const combined = continuation ? `${previous.text}${text}` : text;
        if (continuation) {
            this.#messages.pop();
            this.#characters -= previous.text.length;
        }
        const bounded = combined.slice(-SESSION_HISTORY_CHARACTER_LIMIT);
        this.#truncated ||= bounded.length < combined.length;
        this.#messages.push(
            role === "user"
                ? { role, text: bounded }
                : {
                      activityIds: [...this.#turnActivityIds],
                      content: previous?.role === "assistant" ? previous.content : [],
                      role,
                      text: bounded,
                  },
        );
        this.#characters += bounded.length;
        this.#lastMessageId = id;
        this.trimMessages();
    };

    readonly snapshot = async (): Promise<NativeSessionHistory> => {
        await this.#activityTracker.finish();
        return {
            status: "available",
            messages: this.#messages.map(
                (message): NativeHistoryMessage =>
                    message.role === "user"
                        ? message
                        : {
                              role: "assistant",
                              text: message.text,
                              content: message.content,
                              activities: message.activityIds.flatMap((id) => {
                                  const activity = this.#activities.get(id);
                                  return activity === undefined
                                      ? []
                                      : [
                                            {
                                                activityId: activity.activityId,
                                                activityType: activity.activityType,
                                                content: activity.content,
                                                input: activity.input,
                                                locations: activity.locations,
                                                name: activity.name,
                                                output: activity.output,
                                                sequence: activity.sequence,
                                                status: activity.status,
                                                title: activity.title,
                                                toolKind: activity.toolKind,
                                            },
                                        ];
                              }),
                          },
            ),
            truncated: this.#truncated,
            coveredCommandIds: [],
            coveredMessageIds: [],
        };
    };

    private readonly recordAssistantContent = (messageId: string | null, content: AgentDisplayContent): void => {
        const previous = this.#messages.at(-1);
        const continuation = previous?.role === "assistant" && messageId === this.#lastMessageId;
        if (continuation) {
            this.#messages[this.#messages.length - 1] = {
                ...previous,
                activityIds: [...this.#turnActivityIds],
                content: [...previous.content, content],
            };
        } else {
            this.#messages.push({
                activityIds: [...this.#turnActivityIds],
                content: [content],
                role: "assistant",
                text: "",
            });
        }
        this.#lastMessageId = messageId;
        this.trimMessages();
    };

    private readonly trimMessages = (): void => {
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
}
