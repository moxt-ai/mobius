import { z } from "zod";

import { ProtocolMessageError } from "../../shared/message-codec.ts";

const TOKEN_COUNT = z.number().int().nonnegative();

function normalizeQuotaTokenCount(value: unknown): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return value;
    }
    if (Reflect.has(value, "inputTokens") || Reflect.has(value, "outputTokens") || Reflect.has(value, "totalTokens")) {
        return value;
    }
    if (!Reflect.has(value, "input_tokens") && !Reflect.has(value, "output_tokens")) {
        return value;
    }
    const inputTokens = Reflect.get(value, "input_tokens");
    const outputTokens = Reflect.get(value, "output_tokens");
    const reportedTotal = Reflect.get(value, "total_tokens");
    return {
        cachedInputTokens: Reflect.get(value, "cached_input_tokens"),
        cachedWriteTokens: Reflect.get(value, "cached_write_tokens"),
        inputTokens,
        outputTokens,
        reasoningOutputTokens: Reflect.get(value, "reasoning_output_tokens"),
        totalTokens:
            reportedTotal === undefined && typeof inputTokens === "number" && typeof outputTokens === "number"
                ? inputTokens + outputTokens
                : reportedTotal,
    };
}

// Adapter-reported snapshots, not deltas. Cache and reasoning counters can
// overlap other counters; consumers must not sum fields or successive reports.
export const promptUsageSchema = z
    .object({
        cachedReadTokens: TOKEN_COUNT.nullish(),
        cachedWriteTokens: TOKEN_COUNT.nullish(),
        inputTokens: TOKEN_COUNT,
        outputTokens: TOKEN_COUNT,
        thoughtTokens: TOKEN_COUNT.nullish(),
        totalTokens: TOKEN_COUNT,
    })
    .readonly();

const quotaTokenCountSchema = z.preprocess(
    normalizeQuotaTokenCount,
    z
        .object({
            cachedInputTokens: TOKEN_COUNT.optional(),
            cachedWriteTokens: TOKEN_COUNT.optional(),
            inputTokens: TOKEN_COUNT,
            outputTokens: TOKEN_COUNT,
            reasoningOutputTokens: TOKEN_COUNT.optional(),
            totalTokens: TOKEN_COUNT,
        })
        .readonly(),
);

// Codex ACP 1.8.0 and Claude ACP 0.73.0 report camel-case quota counters.
// Gemini CLI 0.59.0 reports bounded snake-case input/output counters instead.
// Claude model rows can include subagents, so they need not sum to token_count.
export const promptMetadataSchema = z
    .object({
        messageId: z.string().min(1).max(2_048).optional(),
        quota: z
            .object({
                model_usage: z
                    .array(
                        z
                            .object({
                                model: z.string().min(1).max(255),
                                token_count: quotaTokenCountSchema,
                            })
                            .readonly(),
                    )
                    .max(100)
                    .readonly(),
                token_count: quotaTokenCountSchema.nullable(),
            })
            .readonly()
            .optional(),
    })
    .readonly();

export type PromptUsage = z.infer<typeof promptUsageSchema>;
export type PromptMetadata = z.infer<typeof promptMetadataSchema>;

const agentPromptResponseSchema = z
    .object({
        _meta: promptMetadataSchema.nullish(),
        stopReason: z.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]),
        usage: promptUsageSchema.nullish(),
    })
    .readonly();

export type AgentPromptResponse = z.infer<typeof agentPromptResponseSchema>;

export function decodeAgentPromptResponse(value: unknown): AgentPromptResponse {
    const result = agentPromptResponseSchema.safeParse(value);
    if (!result.success) {
        throw new ProtocolMessageError("Invalid agent prompt response", {
            cause: result.error,
        });
    }
    return result.data;
}
