import type {
    ContentBlock,
    ContentChunk,
    PlanEntry,
    ToolCallContent,
    ToolCallLocation,
} from "@agentclientprotocol/sdk";
import type { AgentDisplayContent } from "@moxt-ai/mobius-protocol";

const TRUNCATION_MARKER = "\n… output truncated by Mobius";

// Bounding budgets for captured Agent activity detail. Purely daemon-internal: the
// folded activity view never crosses the protocol boundary anymore.
export const ACTIVITY_DETAIL_LIMIT = 500_000;
const ACTIVITY_RECORDED_FIELD_LIMIT = 4_000_000;
const ACTIVITY_RECORDED_DETAIL_LIMIT = 6_000_000;
const ACTIVITY_LOCATION_LIMIT = 12;
const ACTIVITY_LOCATION_LENGTH_LIMIT = 1_024;

export type CapturedActivityDetail =
    | {
          readonly content: readonly AgentDisplayContent[];
          readonly input: string;
          readonly kind: "recorded";
          readonly output: string;
      }
    | {
          readonly capturedBytes: number;
          readonly kind: "truncated";
          readonly originalBytes: number;
      };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function truncate(value: string, maximumLength: number): string {
    if (value.length <= maximumLength) {
        return value;
    }
    return `${value.slice(0, maximumLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

export function formatUnknown(value: unknown): string {
    if (typeof value === "string") {
        return truncate(value, ACTIVITY_DETAIL_LIMIT);
    }
    try {
        const encoded = JSON.stringify(value, null, 2);
        return truncate(encoded ?? "", ACTIVITY_DETAIL_LIMIT);
    } catch {
        return truncate(String(value), ACTIVITY_DETAIL_LIMIT);
    }
}

export function formatUnknownDetail(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    try {
        return JSON.stringify(value, null, 2) ?? "";
    } catch {
        return String(value);
    }
}

export function readContentOutput(content: unknown): string {
    if (!Array.isArray(content) || content.length === 0) {
        return "";
    }
    return formatUnknown(content);
}

export function readContentOutputDetail(content: unknown): string {
    if (!Array.isArray(content) || content.length === 0) {
        return "";
    }
    return formatUnknownDetail(content);
}

export function summarizeDisplayContent(content: AgentDisplayContent): AgentDisplayContent {
    return {
        ...content,
        artifactId: truncate(content.artifactId, 128),
        data: truncate(content.data, ACTIVITY_DETAIL_LIMIT),
        mimeType: truncate(content.mimeType, 255),
        name: truncate(content.name, 500),
        newText: truncate(content.newText, ACTIVITY_DETAIL_LIMIT),
        oldText: truncate(content.oldText, ACTIVITY_DETAIL_LIMIT),
        path: truncate(content.path, 2_048),
        terminalId: truncate(content.terminalId, 255),
        text: truncate(content.text, ACTIVITY_DETAIL_LIMIT),
        uri: truncate(content.uri, 4_096),
    };
}

function contentFitsRecordingEnvelope(content: AgentDisplayContent): boolean {
    return (
        content.artifactId.length <= 128 &&
        content.data.length <= ACTIVITY_RECORDED_FIELD_LIMIT &&
        content.mimeType.length <= 255 &&
        content.name.length <= 500 &&
        content.newText.length <= ACTIVITY_RECORDED_FIELD_LIMIT &&
        content.oldText.length <= ACTIVITY_RECORDED_FIELD_LIMIT &&
        content.path.length <= 2_048 &&
        content.terminalId.length <= 255 &&
        content.text.length <= ACTIVITY_RECORDED_FIELD_LIMIT &&
        content.uri.length <= 4_096
    );
}

export function encodedByteLength(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function captureActivityDetail(
    content: readonly AgentDisplayContent[],
    input: string,
    output: string,
): CapturedActivityDetail {
    const recorded = { content, input, kind: "recorded", output } as const;
    const originalBytes = encodedByteLength(recorded);
    if (
        content.length <= 100 &&
        content.every(contentFitsRecordingEnvelope) &&
        input.length <= ACTIVITY_RECORDED_FIELD_LIMIT &&
        output.length <= ACTIVITY_RECORDED_FIELD_LIMIT &&
        JSON.stringify(recorded).length <= ACTIVITY_RECORDED_DETAIL_LIMIT
    ) {
        return recorded;
    }
    return {
        capturedBytes: encodedByteLength({
            content: content.slice(0, 100).map(summarizeDisplayContent),
            input: truncate(input, ACTIVITY_DETAIL_LIMIT),
            output: truncate(output, ACTIVITY_DETAIL_LIMIT),
        }),
        kind: "truncated",
        originalBytes,
    };
}

export function recordedDetail(
    activity: { readonly detail: CapturedActivityDetail } | undefined,
): Extract<CapturedActivityDetail, { readonly kind: "recorded" }> | null {
    return activity?.detail.kind === "recorded" ? activity.detail : null;
}

function emptyDisplayContent(type: AgentDisplayContent["type"]): AgentDisplayContent {
    return {
        artifactId: "",
        data: "",
        mimeType: "",
        name: "",
        newText: "",
        oldText: "",
        path: "",
        terminalId: "",
        text: "",
        type,
        uri: "",
    };
}

function resourceName(uri: string): string {
    try {
        const pathname = new URL(uri).pathname;
        return decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
    } catch {
        return "";
    }
}

export function imageDisplayContent(
    mimeType: string,
    name: string,
    data: string,
    artifactId = "",
    uri = "",
): AgentDisplayContent {
    return {
        ...emptyDisplayContent("image"),
        artifactId,
        data,
        mimeType,
        name,
        uri,
    };
}

export function normalizeContentBlock(content: ContentBlock): AgentDisplayContent {
    if (content.type === "text") {
        return { ...emptyDisplayContent("text"), text: content.text };
    }
    if (content.type === "image") {
        return {
            ...emptyDisplayContent("image"),
            data: content.data,
            mimeType: content.mimeType,
            uri: content.uri ?? "",
        };
    }
    if (content.type === "resource_link") {
        return {
            ...emptyDisplayContent("resource_link"),
            mimeType: content.mimeType ?? "",
            name: content.name,
            uri: content.uri,
        };
    }
    if (content.type === "resource") {
        const type = content.resource.mimeType?.startsWith("video/") === true ? "video" : "resource";
        if ("text" in content.resource) {
            return {
                ...emptyDisplayContent(type),
                mimeType: content.resource.mimeType ?? "",
                name: resourceName(content.resource.uri),
                text: content.resource.text,
                uri: content.resource.uri,
            };
        }
        return {
            ...emptyDisplayContent(type),
            data: content.resource.blob,
            mimeType: content.resource.mimeType ?? "",
            name: resourceName(content.resource.uri),
            uri: content.resource.uri,
        };
    }
    return {
        ...emptyDisplayContent("resource"),
        data: content.data,
        mimeType: content.mimeType,
    };
}

export async function normalizeToolContent(
    content: readonly ToolCallContent[],
    prepareContent: (content: AgentDisplayContent) => Promise<AgentDisplayContent>,
): Promise<readonly AgentDisplayContent[]> {
    const normalized: AgentDisplayContent[] = [];
    for (const item of content) {
        if (item.type === "diff") {
            normalized.push({
                ...emptyDisplayContent("diff"),
                newText: item.newText,
                oldText: item.oldText ?? "",
                path: item.path,
            });
            continue;
        }
        if (item.type === "terminal") {
            normalized.push({
                ...emptyDisplayContent("terminal"),
                terminalId: item.terminalId,
            });
            continue;
        }
        normalized.push(await prepareContent(normalizeContentBlock(item.content)));
    }
    return normalized;
}

function rawMcpToolContent(rawOutput: unknown): readonly ToolCallContent[] {
    if (!isRecord(rawOutput)) {
        return [];
    }
    const result = isRecord(rawOutput["result"]) ? rawOutput["result"] : rawOutput;
    const content = result["content"];
    if (!Array.isArray(content)) {
        return [];
    }
    return content.flatMap((item): readonly ToolCallContent[] => {
        if (
            !isRecord(item) ||
            item["type"] !== "image" ||
            typeof item["data"] !== "string" ||
            typeof item["mimeType"] !== "string"
        ) {
            return [];
        }
        const uri = item["uri"];
        return [
            {
                type: "content",
                content: {
                    type: "image",
                    data: item["data"],
                    mimeType: item["mimeType"],
                    ...(typeof uri === "string" ? { uri } : {}),
                },
            },
        ];
    });
}

export function toolContent(content: readonly ToolCallContent[] | null | undefined, rawOutput: unknown) {
    return content !== undefined && content !== null && content.length > 0 ? content : rawMcpToolContent(rawOutput);
}

export function normalizeLocations(locations: readonly ToolCallLocation[]): readonly string[] {
    const normalized: string[] = [];
    const unique = new Set<string>();
    for (const location of locations) {
        if (normalized.length === ACTIVITY_LOCATION_LIMIT) {
            break;
        }
        const suffix = typeof location.line === "number" ? `:${location.line.toString()}` : "";
        const value = truncate(`${location.path}${suffix}`, ACTIVITY_LOCATION_LENGTH_LIMIT);
        if (value.length > 0 && !unique.has(value)) {
            unique.add(value);
            normalized.push(value);
        }
    }
    return normalized;
}

export function normalizeToolStatus(status: string, fallback: string): string {
    if (status === "pending") {
        return "pending";
    }
    if (status === "in_progress") {
        return "running";
    }
    if (status === "completed" || status === "failed") {
        return status;
    }
    return fallback;
}

export function normalizeTitle(title: string, fallback: string): string {
    const normalized = title.trim();
    return truncate(normalized.length === 0 ? fallback : normalized, 500);
}

export function formatPlanEntries(entries: readonly PlanEntry[]): string {
    const lines: string[] = [];
    for (const entry of entries) {
        lines.push(`[${entry.status}] ${entry.content}`);
    }
    return truncate(lines.join("\n"), ACTIVITY_DETAIL_LIMIT);
}

export function planStatus(entries: readonly PlanEntry[]): string {
    if (entries.length === 0) {
        return "completed";
    }
    if (entries.every((entry) => entry.status === "completed")) {
        return "completed";
    }
    if (entries.some((entry) => entry.status === "in_progress")) {
        return "running";
    }
    return "pending";
}

function contentPhase(content: ContentChunk): string {
    const metadata = content._meta;
    if (metadata === undefined || metadata === null) {
        return "";
    }
    const codex = metadata["codex"];
    if (!isRecord(codex)) {
        return "";
    }
    const phase = codex["phase"];
    return typeof phase === "string" ? phase : "";
}

export function isProgressMessage(content: ContentChunk): boolean {
    return contentPhase(content) === "commentary";
}
