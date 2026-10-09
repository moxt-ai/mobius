import type {
    AcpSessionUpdateV2,
    AgentDisplayContent,
    ContentBlockV2,
    NativeMessageActivity,
    SessionEventV2,
} from "@moxt-ai/mobius-protocol";
import type { NativeSessionHistory, PresentedNativeMessage } from "@/domain/native-history";

type Assistant = Extract<PresentedNativeMessage, { readonly role: "assistant" }>;
export type AcpPresentationChange =
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "content"; readonly content: AgentDisplayContent }
    | { readonly kind: "activity"; readonly activity: NativeMessageActivity };

function unreachable(value: never): never {
    throw new Error(`Unsupported ACP content: ${String(value)}`);
}

function emptyContent(type: AgentDisplayContent["type"]): AgentDisplayContent {
    return {
        type,
        artifactId: "",
        data: "",
        mimeType: "",
        name: "",
        newText: "",
        oldText: "",
        path: "",
        terminalId: "",
        text: "",
        uri: "",
    };
}
export function displayContent(content: ContentBlockV2): AgentDisplayContent {
    switch (content.type) {
        case "text":
            return { ...emptyContent("text"), text: content.text };
        case "image":
            return { ...emptyContent("image"), data: content.data, mimeType: content.mimeType, uri: content.uri ?? "" };
        case "external_image":
            return {
                ...emptyContent("image"),
                mimeType: content.mimeType,
                uri: `mobius-content:image:${content.imageKey}`,
            };
        case "audio":
            return { ...emptyContent("resource"), data: content.data, mimeType: content.mimeType };
        case "external_audio":
            return {
                ...emptyContent("resource"),
                mimeType: content.mimeType,
                uri: `mobius-content:audio:${content.audioKey}`,
            };
        case "external_resource":
            return {
                ...emptyContent("resource"),
                mimeType: content.mimeType ?? "",
                uri: `mobius-content:resource:${content.resourceKey}`,
            };
        case "resource_link":
            return {
                ...emptyContent("resource_link"),
                name: content.name,
                mimeType: content.mimeType ?? "",
                uri: content.uri,
            };
        case "resource":
            return {
                ...emptyContent(content.resource.mimeType?.startsWith("video/") ? "video" : "resource"),
                mimeType: content.resource.mimeType ?? "",
                uri: content.resource.uri,
                ...("text" in content.resource ? { text: content.resource.text } : { data: content.resource.blob }),
            };
    }
}
function printable(value: unknown): string {
    return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}
function commentary(update: Extract<AcpSessionUpdateV2, { readonly sessionUpdate: "agent_message_chunk" }>): boolean {
    const codex = update._meta?.["codex"];
    return typeof codex === "object" && codex !== null && "phase" in codex && codex.phase === "commentary";
}

/** Presentation of raw ACP updates, shared by native history and the current live prompt. */
export class AcpTranscript {
    readonly #messages: PresentedNativeMessage[] = [];
    readonly #coveredCommands = new Set<string>();
    #lastMessageId: string | null = null;
    readonly append = (update: AcpSessionUpdateV2, sequence: number): readonly AcpPresentationChange[] => {
        if (update.sessionUpdate === "user_message_chunk") {
            this.message("user", update.messageId ?? null, displayContent(update.content));
            return [];
        }
        if (update.sessionUpdate === "agent_message_chunk" && !commentary(update)) {
            const content = displayContent(update.content);
            this.message("assistant", update.messageId ?? null, content);
            return content.type === "text" ? [{ kind: "text", text: content.text }] : [{ kind: "content", content }];
        }
        if (update.sessionUpdate === "agent_thought_chunk" || update.sessionUpdate === "agent_message_chunk") {
            const kind = update.sessionUpdate === "agent_thought_chunk" ? "reasoning" : "progress";
            const id = `${kind}:${update.messageId ?? "current"}`;
            const previous = this.assistant().activities.find((a) => a.activityId === id);
            return [
                this.activity({
                    ...this.emptyActivity(id, kind, sequence),
                    title: kind === "reasoning" ? "Reasoning" : "Progress",
                    output: (previous?.output ?? "") + displayContent(update.content).text,
                }),
            ];
        }
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            const previous = this.#messages
                .flatMap((message) => (message.role === "assistant" ? message.activities : []))
                .find((a) => a.activityId === update.toolCallId);
            const content = update.content?.map((item): AgentDisplayContent => {
                switch (item.type) {
                    case "content":
                        return displayContent(item.content);
                    case "diff":
                        return {
                            ...emptyContent("diff"),
                            path: item.path,
                            newText: item.newText,
                            oldText: item.oldText ?? "",
                        };
                    case "terminal":
                        return { ...emptyContent("terminal"), terminalId: item.terminalId };
                }
                return unreachable(item);
            });
            return [
                this.activity({
                    ...(previous ?? this.emptyActivity(update.toolCallId, "tool", sequence)),
                    sequence,
                    title: update.title ?? previous?.title ?? "Tool",
                    status: update.status ?? previous?.status ?? "pending",
                    name: update.name ?? previous?.name ?? "",
                    toolKind: update.kind ?? previous?.toolKind ?? "",
                    input: update.rawInput === undefined ? (previous?.input ?? "") : printable(update.rawInput),
                    output: update.rawOutput === undefined ? (previous?.output ?? "") : printable(update.rawOutput),
                    locations: update.locations?.map((l) => l.path) ?? previous?.locations ?? [],
                    content: content ?? previous?.content ?? [],
                }),
            ];
        }
        if (update.sessionUpdate === "plan" || update.sessionUpdate === "plan_update") {
            const entries =
                update.sessionUpdate === "plan"
                    ? update.entries
                    : update.plan.type === "items"
                      ? update.plan.entries
                      : update.plan.type === "file"
                        ? update.plan.uri
                        : update.plan.content;
            return [
                this.activity({
                    ...this.emptyActivity("plan", "plan", sequence),
                    title: "Plan",
                    output: printable(entries),
                }),
            ];
        }
        return [];
    };
    readonly coverCommand = (commandId: string): void => {
        this.#coveredCommands.add(commandId);
    };
    readonly history = (truncated: boolean): NativeSessionHistory => ({
        status: "available",
        messages: this.#messages,
        coveredCommandIds: [...this.#coveredCommands],
        coveredMessageIds: [],
        truncated,
    });
    private readonly assistant = (): Assistant => {
        const last = this.#messages.at(-1);
        if (last?.role === "assistant") {
            return last;
        }
        const message: Assistant = { role: "assistant", text: "", activities: [], content: [] };
        this.#messages.push(message);
        return message;
    };
    private readonly emptyActivity = (id: string, type: string, sequence: number): NativeMessageActivity => ({
        activityId: id,
        activityType: type,
        sequence,
        title: "",
        status: "completed",
        input: "",
        output: "",
        locations: [],
        name: "",
        toolKind: "",
        content: [],
    });
    private readonly activity = (activity: NativeMessageActivity): AcpPresentationChange => {
        const existingIndex = this.#messages.findIndex(
            (message) =>
                message.role === "assistant" && message.activities.some((a) => a.activityId === activity.activityId),
        );
        const fallback = this.assistant();
        const index = existingIndex < 0 ? this.#messages.length - 1 : existingIndex;
        const existing = this.#messages[index];
        const message = existing?.role === "assistant" ? existing : fallback;
        this.#messages[index] = {
            ...message,
            activities: [...message.activities.filter((a) => a.activityId !== activity.activityId), activity],
        };
        return { kind: "activity", activity };
    };
    private readonly message = (role: "user" | "assistant", id: string | null, content: AgentDisplayContent): void => {
        const last = this.#messages.at(-1);
        const continuation = last?.role === role && this.#lastMessageId === id;
        const text = content.type === "text" ? content.text : "";
        const message: PresentedNativeMessage =
            role === "user"
                ? {
                      role,
                      text: (continuation ? last.text : "") + text,
                      content: [
                          ...(continuation ? (last.content ?? []) : []),
                          ...(content.type === "text" ? [] : [content]),
                      ],
                  }
                : {
                      ...(continuation && last.role === "assistant"
                          ? last
                          : { role: "assistant", activities: [], content: [], text: "" }),
                      role: "assistant",
                      text: (continuation ? last.text : "") + text,
                      content: [
                          ...(continuation && last.role === "assistant" ? last.content : []),
                          ...(content.type === "text" ? [] : [content]),
                      ],
                  };
        if (continuation) {
            this.#messages.pop();
        }
        this.#messages.push(message);
        this.#lastMessageId = id;
    };
}
export function nativeEventHistory(events: readonly SessionEventV2[], truncated: boolean): NativeSessionHistory {
    const transcript = new AcpTranscript();
    for (const event of events) {
        if (event.type === "acp") {
            transcript.append(event.payload, Number(event.position));
        } else if (event.type === "lifecycle-metadata" && "commandId" in event.payload) {
            transcript.coverCommand(event.payload.commandId);
        }
    }
    return transcript.history(truncated);
}
