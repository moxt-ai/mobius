import { z } from "zod";

const MAX_CONTENT_LENGTH = 1_000_000;
const MAX_COLLECTION_SIZE = 1_000;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_KEYS = 1_000;
const boundedString = z.string().max(MAX_CONTENT_LENGTH);

function boundedJsonIssue(value: unknown, depth = 0): string | null {
    if (depth > MAX_JSON_DEPTH) {
        return "JSON nesting exceeds the maximum depth";
    }
    if (typeof value === "string") {
        return value.length <= MAX_CONTENT_LENGTH ? null : "JSON string exceeds the maximum length";
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? null : "JSON number must be finite";
    }
    if (typeof value === "boolean" || value === null) {
        return null;
    }
    if (Array.isArray(value)) {
        if (value.length > MAX_COLLECTION_SIZE) {
            return "JSON array exceeds the maximum length";
        }
        for (const item of value) {
            const issue = boundedJsonIssue(item, depth + 1);
            if (issue !== null) {
                return issue;
            }
        }
        return null;
    }
    if (typeof value === "object" && value !== undefined) {
        const entries = Object.entries(value);
        if (entries.length > MAX_JSON_KEYS) {
            return "JSON object exceeds the maximum key count";
        }
        for (const [key, item] of entries) {
            if (key.length > 255) {
                return "JSON key exceeds the maximum length";
            }
            const issue = boundedJsonIssue(item, depth + 1);
            if (issue !== null) {
                return issue;
            }
        }
        return null;
    }
    return "Value is not bounded JSON";
}

export const boundedJsonSchema = z.unknown().superRefine((value, context) => {
    const issue = boundedJsonIssue(value);
    if (issue !== null) {
        context.addIssue({ code: "custom", message: issue });
    }
});
export const toolCallLocationSchema = z
    .object({
        line: z.number().int().nonnegative().safe().nullable().optional(),
        path: boundedString,
    })
    .readonly();
