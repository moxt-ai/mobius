import { boundedJsonSchema } from "@moxt-ai/mobius-sdk/protocol";
import { z } from "zod";

const toolEventSchema = z.looseObject({
    sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
});
const TRUNCATED_TOOL_PAYLOAD_CHARACTER_LIMIT = 32_768;

function fitPayload(value: unknown): unknown {
    if (value === undefined || boundedJsonSchema.safeParse(value).success) {
        return value;
    }
    let text: string;
    try {
        text = JSON.stringify(value) ?? "";
    } catch {
        text = "Tool payload could not be represented as JSON.";
    }
    return {
        truncated: true,
        text: text.slice(0, TRUNCATED_TOOL_PAYLOAD_CHARACTER_LIMIT),
    };
}

/** Codex-owned fitting after media externalization, before SDK event validation. */
export function fitCodexToolEvent(event: unknown): unknown {
    const decoded = toolEventSchema.safeParse(event);
    if (!decoded.success) {
        return event;
    }
    return {
        ...decoded.data,
        rawInput: fitPayload(decoded.data.rawInput),
        rawOutput: fitPayload(decoded.data.rawOutput),
    };
}
