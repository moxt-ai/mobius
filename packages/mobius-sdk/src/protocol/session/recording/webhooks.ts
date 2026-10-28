import { z } from "zod";

import { identifierStringSchema } from "../../shared/identifier.ts";
import { decodeZodMessage as decode, encodeZodMessage as encode } from "../../shared/message-codec.ts";
import { sessionRecordingStatusSchema } from "./recording.ts";

const isoTimestamp = z.iso.datetime({ offset: true });
const shortText = z.string().max(2_048);

// Terminal prompt outcomes, shared so a Turn read model and a status notification cannot disagree
// on what a finished prompt looks like.
const promptSucceededOutcome = { completedAt: isoTimestamp, stopReason: shortText };
const promptCancelledOutcome = { cancelledAt: isoTimestamp };
const promptFailedOutcome = {
    code: identifierStringSchema,
    failedAt: isoTimestamp,
    message: z.string().min(1).max(500),
};

/**
 * The terminal outcome of one command, keyed by the `commandId` the Recording already uses for the
 * Turn. A Session status notification reports these per command because the delivery that carries it
 * only observes the commands that ended in it; a session-wide "nothing is running" claim cannot be
 * derived from one delivery.
 */
export const sessionStatusWebhookCommandSchema = z.discriminatedUnion("outcome", [
    z
        .object({
            ...promptSucceededOutcome,
            commandId: identifierStringSchema,
            outcome: z.literal("succeeded"),
        })
        .readonly(),
    z
        .object({
            ...promptCancelledOutcome,
            commandId: identifierStringSchema,
            outcome: z.literal("cancelled"),
        })
        .readonly(),
    z
        .object({
            ...promptFailedOutcome,
            commandId: identifierStringSchema,
            outcome: z.literal("failed"),
        })
        .readonly(),
]);
export type SessionStatusWebhookCommand = z.infer<typeof sessionStatusWebhookCommandSchema>;

/**
 * One App Session status notification. `commands` names exactly the commands this delivery observed
 * ending, so a consumer resolves those Turns and no others. `status` is the trailing state of the
 * same delivery and is retained for consumers that have not adopted `commands`.
 */
const sessionStatusWebhookBodyFields = {
    appId: identifierStringSchema,
    projectId: identifierStringSchema,
    runtimeId: identifierStringSchema,
    sessionId: identifierStringSchema,
    status: sessionRecordingStatusSchema,
};
export const sessionStatusWebhookBodySchema = z
    .object({
        ...sessionStatusWebhookBodyFields,
        commands: z.array(sessionStatusWebhookCommandSchema).min(1).readonly(),
    })
    .readonly();
export type SessionStatusWebhookBody = z.infer<typeof sessionStatusWebhookBodySchema>;

const consumedSessionStatusWebhookBodySchema = z
    .object({
        ...sessionStatusWebhookBodyFields,
        commands: z.array(sessionStatusWebhookCommandSchema).readonly(),
    })
    .readonly();

export const decodeSessionStatusWebhookBody = (encoded: string): SessionStatusWebhookBody => {
    const value: unknown = JSON.parse(encoded);
    const candidate =
        typeof value === "object" && value !== null && "commands" in value && Array.isArray(value.commands)
            ? {
                  ...value,
                  commands: value.commands.flatMap((command) => {
                      const decoded = sessionStatusWebhookCommandSchema.safeParse(command);
                      return decoded.success ? [decoded.data] : [];
                  }),
              }
            : value;
    return decode(JSON.stringify(candidate), consumedSessionStatusWebhookBodySchema);
};

export const encodeSessionStatusWebhookBody = (value: SessionStatusWebhookBody): string =>
    encode(value, sessionStatusWebhookBodySchema);
