import { z } from "zod";

import { ProtocolMessageError } from "./codecs/messages.ts";
import {
    elicitationFieldSchema,
    permissionOptionSchema,
    sessionConfigurationSelectionsSchema,
} from "./control-messages.ts";
import { identifierSchema } from "./identifier.ts";

export const MAX_LOCAL_AGENT_DIRECTORY_ENTRIES = 32;

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

const permissionRequestSchema = z
    .object({
        kind: z.literal("permission"),
        options: z.array(permissionOptionSchema).min(1).max(20).readonly(),
        title: z.string().min(1).max(500),
        toolCallId: z.string().min(1).max(255),
        toolKind: z.string().max(64),
    })
    .readonly();

const elicitationRequestSchema = z
    .object({
        elicitationId: z.string().max(255),
        fields: z.array(elicitationFieldSchema).max(100).readonly(),
        kind: z.literal("elicitation"),
        message: z.string().min(1).max(2_000),
        mode: z.enum(["form", "url"]),
        url: z.string().max(4_096),
    })
    .readonly();

const interactionRequestSchema = z.discriminatedUnion("kind", [permissionRequestSchema, elicitationRequestSchema]);

export type InteractionRequest = z.infer<typeof interactionRequestSchema>;

const interactionResponseSchema = z
    .object({
        content: z.string().max(100_000),
        kind: z.enum(["permission", "elicitation"]),
    })
    .readonly();

export type InteractionResponse = z.infer<typeof interactionResponseSchema>;

const interactionStateSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pending") }).readonly(),
    z
        .object({
            kind: z.literal("responded"),
            respondedAt: timestampSchema,
            responderId: identifierSchema,
            response: interactionResponseSchema,
        })
        .readonly(),
    z
        .object({
            kind: z.literal("resolved"),
            resolution: z.discriminatedUnion("kind", [
                z.object({ kind: z.literal("without_response") }).readonly(),
                z
                    .object({
                        kind: z.literal("response_applied"),
                        respondedAt: timestampSchema,
                        responderId: identifierSchema,
                        response: interactionResponseSchema,
                    })
                    .readonly(),
            ]),
            resolvedAt: timestampSchema,
        })
        .readonly(),
    z.object({ expiredAt: timestampSchema, kind: z.literal("expired") }).readonly(),
    z
        .object({
            cancelledAt: timestampSchema,
            kind: z.literal("cancelled"),
        })
        .readonly(),
]);

export type InteractionState = z.infer<typeof interactionStateSchema>;

const interactionSchema = z
    .object({
        attemptId: identifierSchema,
        interactionId: identifierSchema,
        request: interactionRequestSchema,
        sessionId: identifierSchema,
        state: interactionStateSchema,
        turnId: identifierSchema,
    })
    .readonly();

export type Interaction = z.infer<typeof interactionSchema>;

function decodeResource<T>(value: unknown, schema: z.ZodType<T>): T {
    const decoded = schema.safeParse(value);
    if (!decoded.success) {
        throw new ProtocolMessageError("Resource does not match its schema", {
            cause: decoded.error,
        });
    }
    return decoded.data;
}

export const decodeTurn = (value: unknown): Turn => decodeResource(value, turnSchema);
export const decodeInteraction = (value: unknown): Interaction => decodeResource(value, interactionSchema);
