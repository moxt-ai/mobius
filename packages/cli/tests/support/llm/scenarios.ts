type JsonObject = Record<string, unknown>;

export interface FakeProviderScenario {
    readonly command: "false" | "pwd";
    readonly streamed: boolean;
    readonly toolCalls: number;
}

export const fakeProviderPrompts = {
    failedTool: "Use a shell tool that fails, then explain the result using the configured model",
    streamedTool: "Use a shell tool successfully, then stream a Unicode reply using the configured model",
    successfulTool: "Use a shell tool successfully, then reply using the configured model",
    twoTools: "Use two shell tools successfully, then reply using the configured model",
} as const;

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(contentText).filter(Boolean).join("\n");
    }
    if (!isObject(value)) {
        return "";
    }
    for (const key of ["text", "content", "parts"] as const) {
        const text = contentText(value[key]);
        if (text.length > 0) {
            return text;
        }
    }
    return "";
}

export function latestUserPrompt(value: unknown): string {
    if (!isObject(value)) {
        return "";
    }
    for (const key of ["messages", "input", "contents"] as const) {
        const items = value[key];
        if (typeof items === "string") {
            return items;
        }
        if (!Array.isArray(items)) {
            continue;
        }
        for (const item of [...items].reverse()) {
            if (!isObject(item) || !["user", "USER"].includes(String(item["role"]))) {
                continue;
            }
            if (
                countMatchingObjects(
                    item,
                    (object) => object["type"] === "tool_result" || isObject(object["functionResponse"]),
                ) > 0
            ) {
                continue;
            }
            const text = contentText(item);
            if (text.length > 0) {
                return text;
            }
        }
        const text = contentText(items);
        if (text.length > 0) {
            return text;
        }
    }
    return "";
}

export function selectFakeProviderScenario(payload: unknown): FakeProviderScenario {
    const prompt = latestUserPrompt(payload);
    const asksForTool = /\b(?:bash|command|shell|tool)s?\b/iu.test(prompt);
    const asksForTwo = /\b(?:two|twice)\b/iu.test(prompt);
    const asksForFailure = /\b(?:error|fail|failure|failing)\w*\b/iu.test(prompt);
    const asksForStreaming = /\b(?:chunk|stream|unicode)\w*\b/iu.test(prompt);
    return {
        command: asksForFailure ? "false" : "pwd",
        streamed: asksForStreaming,
        toolCalls: asksForTool ? (asksForTwo ? 2 : 1) : 0,
    };
}

export function fakeProviderResponse(base: string, scenario: FakeProviderScenario): string {
    const toolResult =
        scenario.toolCalls === 0
            ? "plain response"
            : scenario.command === "false"
              ? "failed tool result observed"
              : scenario.toolCalls === 2
                ? "two tool results observed"
                : "tool result observed";
    return `${base}: ${toolResult}${scenario.streamed ? " — streamed Unicode: héllo 🌍" : ""}`;
}

export function responseChunks(response: string, scenario: FakeProviderScenario): readonly string[] {
    if (!scenario.streamed) {
        return [response];
    }
    const midpoint = Math.ceil(response.length / 2);
    return [response.slice(0, midpoint), response.slice(midpoint)];
}

export function countMatchingObjects(value: unknown, predicate: (object: JsonObject) => boolean): number {
    if (Array.isArray(value)) {
        return value.reduce((count, item) => count + countMatchingObjects(item, predicate), 0);
    }
    if (!isObject(value)) {
        return 0;
    }
    let count = predicate(value) ? 1 : 0;
    for (const item of Object.values(value)) {
        count += countMatchingObjects(item, predicate);
    }
    return count;
}
