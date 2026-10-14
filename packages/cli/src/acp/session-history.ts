import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
    type AcpSessionUpdateV2,
    type AgentDisplayContent,
    type NativeHistoryMessage,
    type NativeMessageActivity,
    type NativeSessionHistory,
    SESSION_HISTORY_CHARACTER_LIMIT,
    type SessionEventPayloadV2,
    type SessionLiveEventV2,
} from "@moxt-ai/mobius-protocol";
import { type AcpActivity, AcpActivityTracker } from "./activity.ts";
import { isProgressMessage, normalizeContentBlock } from "./activity-content.ts";
import type { AcpSessionEventStoreV2 } from "./session-event-store-v2.ts";

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

const HISTORY_ACTIVITY_FIELD_LIMIT = 100_000;
const HISTORY_ACTIVITY_LIMIT = 100;
const HISTORY_MESSAGE_LIMIT = 50;

function historyActivity(activity: AcpActivity): NativeMessageActivity {
    return {
        activityId: activity.activityId.slice(0, 128),
        activityType: activity.activityType.slice(0, 128),
        content: activity.content.slice(0, 100),
        input: activity.input.slice(0, HISTORY_ACTIVITY_FIELD_LIMIT),
        locations: activity.locations.slice(0, 100).map((location) => location.slice(0, 2_048)),
        name: activity.name.slice(0, 128),
        output: activity.output.slice(0, HISTORY_ACTIVITY_FIELD_LIMIT),
        sequence: activity.sequence,
        status: activity.status.slice(0, 64),
        title: activity.title.slice(0, 500),
        toolKind: activity.toolKind.slice(0, 64),
    };
}

function historyContentCharacters(messages: readonly NativeHistoryMessage[]): number {
    return messages.reduce(
        (total, message) =>
            total +
            message.text.length +
            (message.role === "assistant"
                ? JSON.stringify(message.activities).length + JSON.stringify(message.content).length
                : 0),
        0,
    );
}

/** Captures ACP load replay without turning historical updates into live turns. */
export class AcpHistoryReplay {
    readonly #activities = new Map<string, AcpActivity>();
    readonly #messages: ReplayMessage[] = [];
    readonly #events: AcpSessionEventStoreV2;
    readonly #turnActivityIds = new Set<string>();
    readonly #sessionId: string;
    readonly #activityTracker = new AcpActivityTracker(
        async (activity) => {
            this.#activities.set(activity.activityId, activity);
            this.#turnActivityIds.add(activity.activityId);
            const latest = this.#messages.at(-1);
            if (latest?.role === "assistant") {
                this.#messages[this.#messages.length - 1] = {
                    ...latest,
                    activityIds: [...this.#turnActivityIds],
                };
            }
        },
        // History replay folds each narration into its snapshot activity, so no
        // separate incremental event is produced here.
        () => Promise.resolve(),
    );
    #lastMessageId: string | null = null;
    #firstMessageIndex = 0;
    #characters = 0;
    #truncated = false;

    constructor(events: AcpSessionEventStoreV2, sessionId: string) {
        this.#events = events;
        this.#sessionId = sessionId;
    }

    readonly record = async (
        update: SessionNotification["update"],
        rawUpdate: AcpSessionUpdateV2,
        onRecorded: (event: SessionLiveEventV2) => Promise<void> = () => Promise.resolve(),
    ): Promise<void> => {
        const event = this.#events.append(this.#sessionId, { payload: rawUpdate, type: "acp" });
        await onRecorded(event);
        await this.#applyUpdate(update);
    };

    readonly #applyUpdate = async (update: SessionNotification["update"]): Promise<void> => {
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

    readonly recordLifecycle = (event: SessionEventPayloadV2): SessionLiveEventV2 => {
        if (event.type !== "lifecycle-metadata") {
            throw new Error("Lifecycle history only accepts lifecycle metadata");
        }
        return this.#events.append(this.#sessionId, event);
    };

    readonly append = async (replay: AcpHistoryReplay): Promise<void> => {
        await replay.#activityTracker.finish();
        for (const [activityId, activity] of replay.#activities) {
            this.#activities.set(activityId, activity);
        }
        for (const message of replay.#messages.slice(replay.#firstMessageIndex)) {
            this.#messages.push(message);
            this.#characters += message.text.length;
        }
        this.#turnActivityIds.clear();
        for (const activityId of replay.#turnActivityIds) {
            this.#turnActivityIds.add(activityId);
        }
        this.#lastMessageId = replay.#lastMessageId;
        this.#truncated ||= replay.#truncated;
        this.trimMessages();
    };

    readonly eventPage = (
        eventLimit: number,
        cursor: string | null,
    ): import("./session-contracts.ts").AcpNativeEventReplayV2 =>
        this.#events.page(this.#sessionId, eventLimit, cursor);

    readonly snapshot = async (): Promise<NativeSessionHistory> => {
        await this.#activityTracker.finish();
        const messages: NativeHistoryMessage[] = this.#messages
            .slice(this.#firstMessageIndex)
            .map((message): NativeHistoryMessage => {
                if (message.role === "user") {
                    return message;
                }
                const activities = message.activityIds.flatMap((id) => {
                    const activity = this.#activities.get(id);
                    return activity === undefined ? [] : [historyActivity(activity)];
                });
                if (activities.length > HISTORY_ACTIVITY_LIMIT) {
                    this.#truncated = true;
                }
                return {
                    role: "assistant",
                    text: message.text,
                    content: message.content.slice(0, 100),
                    activities: activities.slice(-HISTORY_ACTIVITY_LIMIT),
                };
            });
        while (historyContentCharacters(messages) > SESSION_HISTORY_CHARACTER_LIMIT) {
            const richIndex = messages.findIndex(
                (message) =>
                    message.role === "assistant" && (message.activities.length > 0 || message.content.length > 0),
            );
            if (richIndex === -1) {
                messages.shift();
            } else {
                const message = messages[richIndex];
                if (message?.role === "assistant") {
                    messages[richIndex] = {
                        ...message,
                        activities: message.activities.length > 0 ? message.activities.slice(1) : message.activities,
                        content:
                            message.activities.length === 0 && message.content.length > 0
                                ? message.content.slice(1)
                                : message.content,
                    };
                }
            }
            this.#truncated = true;
        }
        return {
            status: "available",
            messages,
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
            this.#messages.length - this.#firstMessageIndex > HISTORY_MESSAGE_LIMIT ||
            this.#characters > SESSION_HISTORY_CHARACTER_LIMIT
        ) {
            const removed = this.#messages[this.#firstMessageIndex];
            if (removed !== undefined) {
                this.#characters -= removed.text.length;
                this.#firstMessageIndex += 1;
            }
            this.#truncated = true;
        }
        if (this.#firstMessageIndex >= HISTORY_MESSAGE_LIMIT) {
            this.#messages.splice(0, this.#firstMessageIndex);
            this.#firstMessageIndex = 0;
        }
    };
}
