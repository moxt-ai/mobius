import { z } from "zod";

import { identifierSchema } from "../../shared/identifier.ts";
import { sessionConfigurationSelectionsSchema } from "../configuration/index.ts";

const timestampSchema = z.string().datetime({ offset: true });

const domainErrorSchema = z
    .object({
        code: identifierSchema,
        message: z.string().min(1).max(2_000),
        retryable: z.boolean(),
    })
    .readonly();

const executionResultSchema = z
    .object({
        kind: z.literal("agent_result"),
        stopReason: z.string().min(1).max(128),
    })
    .readonly();

const reconciliationSchema = z
    .object({
        detectedAt: timestampSchema,
        reason: z.enum(["connection_lost", "dispatch_indeterminate", "runtime_restarted"]),
    })
    .readonly();

const terminalTurnStateSchema = z.discriminatedUnion("kind", [
    z
        .object({
            completedAt: timestampSchema,
            kind: z.literal("succeeded"),
            result: executionResultSchema,
        })
        .readonly(),
    z
        .object({
            error: domainErrorSchema,
            failedAt: timestampSchema,
            kind: z.literal("failed"),
        })
        .readonly(),
    z
        .object({
            cancelledAt: timestampSchema,
            kind: z.literal("cancelled"),
        })
        .readonly(),
]);

const turnStateSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("queued") }).readonly(),
    z.object({ kind: z.literal("running"), startedAt: timestampSchema }).readonly(),
    ...terminalTurnStateSchema.options,
    z
        .object({
            kind: z.literal("indeterminate"),
            reconciliation: reconciliationSchema,
        })
        .readonly(),
]);

export type TurnState = z.infer<typeof turnStateSchema>;

const promptTurnRequestSchema = z
    .object({
        content: z.string().max(100_000),
        kind: z.literal("prompt"),
        sessionConfigurations: sessionConfigurationSelectionsSchema.default([]),
    })
    .readonly();
const notRetainedTurnRequestSchema = z.object({ kind: z.literal("not_retained") }).readonly();
const turnRequestSchema = z.discriminatedUnion("kind", [promptTurnRequestSchema, notRetainedTurnRequestSchema]);

export type TurnRequest = z.infer<typeof turnRequestSchema>;

const turnIdentitySchema = z.object({
    acceptedAt: timestampSchema,
    bindingId: identifierSchema,
    idempotencyKey: identifierSchema,
    sessionId: identifierSchema,
    turnId: identifierSchema,
});
const turnSchema = z.union([
    turnIdentitySchema.extend({ request: promptTurnRequestSchema, state: turnStateSchema }).readonly(),
    turnIdentitySchema.extend({ request: notRetainedTurnRequestSchema, state: terminalTurnStateSchema }).readonly(),
]);

export type Turn = z.infer<typeof turnSchema>;

/** Decodes a Turn resource, or skips an entry this SDK cannot consume. */
export const decodeTurn = (value: unknown): Turn | null => {
    const decoded = turnSchema.safeParse(value);
    return decoded.success ? decoded.data : null;
};
