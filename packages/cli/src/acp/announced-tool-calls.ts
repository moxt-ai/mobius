import type { ToolCallLocation, ToolCallUpdate, ToolKind } from "@agentclientprotocol/sdk";

/** The fields of a tool call that describe what an Agent is about to do. */
export interface ToolCallDescription {
    readonly title: string | undefined;
    readonly kind: ToolKind | undefined;
    readonly rawInput: unknown;
    readonly locations: readonly ToolCallLocation[] | undefined;
}

const MAX_ANNOUNCED_TOOL_CALLS = 256;

/**
 * The tool calls an Agent announced during the current turn.
 *
 * ACP sends permission requests and later tool call updates as partial
 * ToolCallUpdates: a field the Agent omits keeps the value it announced
 * earlier. Recording those announcements lets the daemon describe a
 * permission request with the input the Agent actually intends to run.
 */
export class AnnouncedToolCalls {
    readonly #calls = new Map<string, ToolCallDescription>();

    readonly record = (update: ToolCallUpdate): void => {
        const merged = this.describe(update);
        this.#calls.delete(update.toolCallId);
        this.#calls.set(update.toolCallId, merged);
        if (this.#calls.size > MAX_ANNOUNCED_TOOL_CALLS) {
            const oldest = this.#calls.keys().next();
            if (oldest.done !== true) {
                this.#calls.delete(oldest.value);
            }
        }
    };

    /** Applies a partial update to what was announced for the same tool call. */
    readonly describe = (update: ToolCallUpdate): ToolCallDescription => {
        const announced = this.#calls.get(update.toolCallId);
        return {
            title: update.title ?? announced?.title,
            kind: update.kind ?? announced?.kind,
            rawInput: update.rawInput ?? announced?.rawInput,
            locations: update.locations ?? announced?.locations,
        };
    };

    readonly clear = (): void => {
        this.#calls.clear();
    };
}
