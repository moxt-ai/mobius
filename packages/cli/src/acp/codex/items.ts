import type { ContentBlock, ToolCallContent, ToolCallStatus, ToolCallUpdate, ToolKind } from "@agentclientprotocol/sdk";

import { type ThreadItem, threadItemSchema } from "./app-server-protocol.ts";

const TOOL_OUTPUT_CHARACTER_LIMIT = 32_768;
const TITLE_CHARACTER_LIMIT = 500;
// Mobius reads this key in its activity tracker to split streamed commentary from the final answer.
// It is a Mobius-internal convention, not an app-server field.
const CODEX_META_KEY = "codex";

function truncate(value: string, limit: number): string {
    return value.length <= limit ? value : value.slice(0, limit);
}

function textContent(text: string): ToolCallContent {
    const block: ContentBlock = { text: truncate(text, TOOL_OUTPUT_CHARACTER_LIMIT), type: "text" };
    return { content: block, type: "content" };
}

function firstLine(value: string): string {
    const line = value.split("\n", 1)[0] ?? "";
    return line.trim().length > 0 ? line.trim() : value.trim();
}

/** The ACP framing Mobius needs to display one app-server item as a tool call. */
interface ToolCallPresentation {
    readonly kind: ToolKind;
    readonly status: ToolCallStatus;
    readonly title: string;
    readonly content: readonly ToolCallContent[];
    readonly rawInput: unknown;
    readonly rawOutput: unknown;
    readonly locations: readonly { readonly path: string }[];
}

function commandStatus(status: "inProgress" | "completed" | "failed" | "declined"): ToolCallStatus {
    if (status === "inProgress") {
        return "in_progress";
    }
    return status === "completed" ? "completed" : "failed";
}

function patchStatus(status: "inProgress" | "completed" | "failed" | "declined"): ToolCallStatus {
    if (status === "inProgress") {
        return "in_progress";
    }
    return status === "completed" ? "completed" : "failed";
}

function mcpStatus(status: "inProgress" | "completed" | "failed"): ToolCallStatus {
    return status === "inProgress" ? "in_progress" : status === "completed" ? "completed" : "failed";
}

/**
 * Translates one app-server `ThreadItem` into the ACP tool-call framing, or returns null for an item
 * Mobius does not present (user messages, reasoning, plans, and item kinds a newer Codex added).
 */
function presentToolItem(item: ThreadItem): ToolCallPresentation | null {
    if (item.type === "commandExecution") {
        const output = item.aggregatedOutput ?? "";
        const content: ToolCallContent[] = [];
        if (output.length > 0) {
            content.push(textContent(output));
        }
        if (item.exitCode != null && item.exitCode !== 0) {
            content.push(textContent(`Exit code ${item.exitCode}`));
        }
        return {
            content,
            kind: "execute",
            locations: [],
            rawInput: { command: item.command, cwd: item.cwd },
            rawOutput: {
                ...(item.exitCode == null ? {} : { exitCode: item.exitCode }),
                output: truncate(output, TOOL_OUTPUT_CHARACTER_LIMIT),
            },
            status: commandStatus(item.status),
            title: truncate(firstLine(item.command), TITLE_CHARACTER_LIMIT),
        };
    }
    if (item.type === "fileChange") {
        const paths = item.changes.map((change) => change.path);
        const content: ToolCallContent[] = item.changes.map((change) => ({
            newText: truncate(change.diff, TOOL_OUTPUT_CHARACTER_LIMIT),
            path: change.path,
            type: "diff",
        }));
        return {
            content,
            kind: "edit",
            locations: paths.map((path) => ({ path })),
            rawInput: { changes: item.changes.map((change) => change.path) },
            rawOutput: null,
            status: patchStatus(item.status),
            title: truncate(paths.join(", "), TITLE_CHARACTER_LIMIT),
        };
    }
    if (item.type === "mcpToolCall") {
        const label = `${item.server}/${item.tool}`;
        const content: ToolCallContent[] = [];
        if (item.result != null) {
            content.push(textContent(JSON.stringify(item.result)));
        }
        if (item.error != null) {
            content.push(textContent(JSON.stringify(item.error)));
        }
        return {
            content,
            kind: "other",
            locations: [],
            rawInput: item.arguments ?? null,
            rawOutput: item.error ?? item.result ?? null,
            status: mcpStatus(item.status),
            title: truncate(label, TITLE_CHARACTER_LIMIT),
        };
    }
    if (item.type === "dynamicToolCall") {
        const label = item.namespace == null ? item.tool : `${item.namespace}/${item.tool}`;
        const content: ToolCallContent[] = (item.contentItems ?? []).map((entry) => textContent(JSON.stringify(entry)));
        return {
            content,
            kind: "other",
            locations: [],
            rawInput: item.arguments ?? null,
            rawOutput: item.success === true ? null : (item.contentItems ?? null),
            status: mcpStatus(item.status),
            title: truncate(label, TITLE_CHARACTER_LIMIT),
        };
    }
    return null;
}

/** The ACP tool-call payload for one app-server item: `tool_call` when it opens, `tool_call_update`
 *  for every later snapshot. Both carry the same fields. */
export function toolCallUpdate(
    item: ThreadItem,
    lifecycle: "snapshot" | "started" | "completed",
): ToolCallUpdate | null {
    const presentation = presentToolItem(item);
    if (presentation === null) {
        return null;
    }
    return {
        content: [...presentation.content],
        kind: presentation.kind,
        locations: [...presentation.locations],
        rawInput: presentation.rawInput,
        rawOutput: presentation.rawOutput,
        status: lifecycle === "completed" && presentation.status === "in_progress" ? "completed" : presentation.status,
        title: presentation.title,
        toolCallId: item.id,
    };
}

/** Parses an untrusted app-server item, returning null when the shape is not one Mobius presents. */
export function decodeThreadItem(value: unknown): ThreadItem | null {
    const decoded = threadItemSchema.safeParse(value);
    return decoded.success ? decoded.data : null;
}

/**
 * The `_meta` Mobius attaches to streamed agent text. `phase` distinguishes commentary from the
 * final answer so the activity tracker can render progress separately.
 */
export function agentMessageMeta(
    phase: "commentary" | "final_answer" | null | undefined,
): { readonly codex: { readonly phase: string } } | null {
    if (phase == null) {
        return null;
    }
    return { [CODEX_META_KEY]: { phase } };
}
