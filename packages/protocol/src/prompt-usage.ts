import { z } from "zod";

import { ProtocolMessageError } from "./codecs/messages.ts";

const TOKEN_COUNT = z.number().int().nonnegative();

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

const quotaTokenCountSchema = z
    .object({
        cachedInputTokens: TOKEN_COUNT,
        cachedWriteTokens: TOKEN_COUNT.optional(),
        inputTokens: TOKEN_COUNT,
        outputTokens: TOKEN_COUNT,
        reasoningOutputTokens: TOKEN_COUNT,
        totalTokens: TOKEN_COUNT,
    })
    .readonly();

// Codex ACP 1.8.0 and Claude ACP 0.73.0 share this quota representation.
// Claude model rows can include subagents, so they need not sum to token_count.
export const promptMetadataSchema = z
    .object({
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
