import { z } from "zod";

import { identifierSchema } from "../../shared/identifier.ts";
import { ProtocolMessageError } from "../../shared/message-codec.ts";
import { elicitationFieldSchema, permissionOptionSchema } from "./index.ts";

const timestampSchema = z.string().datetime({ offset: true });

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

export const decodeInteraction = (value: unknown): Interaction => decodeResource(value, interactionSchema);
