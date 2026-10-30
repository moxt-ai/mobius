import { z } from "zod";
import { DIRECTORY_IDENTIFIER as directoryId, MAX_WORKSPACE_PATH_LENGTH } from "../../shared/directory.ts";
import { identifierStringSchema as identifier } from "../../shared/identifier.ts";
import { ProtocolMessageError } from "../../shared/message-codec.ts";
import {
    sessionElicitationRequestedEventSchema,
    sessionPermissionRequestedEventSchema,
} from "../interactions/index.ts";
import { sessionReadyEventSchema } from "../lifecycle/index.ts";
import { promptAttachmentSchema } from "../prompt/commands.ts";
import { sessionCapabilitiesSchema } from "../shared/index.ts";

export const NATIVE_SESSION_REQUEST_KIND = "native.session.request";
export const NATIVE_SESSION_RESULT_KIND = "native.session.result";
export const NATIVE_SESSION_CANCEL_KIND = "native.session.cancel";

/** Bounding limits for materialized history payloads. */
export const SESSION_HISTORY_CHARACTER_LIMIT = 256_000;
export const SESSION_HISTORY_MESSAGE_LIMIT = 1_000;

const envelope = {
    requestId: identifier,
    sessionId: identifier,
};
export const sessionInteractionSnapshotSchema = z
    .object({
        sessionGenerationId: identifier,
        throughPosition: z.string().regex(/^(0|[1-9][0-9]*)$/),
        interactions: z
            .array(
                z.discriminatedUnion("kind", [
                    sessionPermissionRequestedEventSchema,
                    sessionElicitationRequestedEventSchema,
                ]),
            )
            .readonly(),
    })
    .readonly();
export type SessionInteractionSnapshot = z.infer<typeof sessionInteractionSnapshotSchema>;

export const activeTurnSnapshotSchema = z
    .object({
        commandId: identifier,
        epoch: identifier,
        interaction: z
            .discriminatedUnion("kind", [sessionPermissionRequestedEventSchema, sessionElicitationRequestedEventSchema])
            .nullable(),
        sequence: z.number().int().nonnegative(),
        state: z.literal("running"),
    })
    .readonly();
export type ActiveTurnSnapshot = z.infer<typeof activeTurnSnapshotSchema>;

/**
 * Where one submitted command stands in the Runtime's execution receipts. Only the
 * Runtime that receives a command can say whether it arrived, so a client recovers an
 * unconfirmed submission from this rather than from Agent message identities.
 */
export const commandDeliverySchema = z.discriminatedUnion("state", [
    // No receipt: the command has not arrived. A delayed submission may still arrive later.
    z.object({ state: z.literal("unknown") }).readonly(),
    // The Runtime holds the command and has not finished it; it may be waiting or running.
    z.object({ state: z.literal("accepted") }).readonly(),
    z.object({ state: z.literal("completed"), stopReason: z.string().max(2_048) }).readonly(),
    z.object({ code: identifier, state: z.literal("failed") }).readonly(),
    // The command started, but the Runtime no longer retains its result.
    z.object({ state: z.literal("expired") }).readonly(),
]);
export type CommandDelivery = z.infer<typeof commandDeliverySchema>;

/**
 * How the Session's most recent started command ended, from the Runtime's execution receipts.
 * A client that missed the live outcome, after leaving, reloading or reconnecting, shows it from
 * this. While the Runtime retains the live receipt, a failure carries its bounded client-facing
 * lifecycle message. After a Runtime restart (or on older Runtimes), it carries the sanitized
 * durable summary: Agent error text may quote user input and is not persisted in receipts.
 */
export const lastTurnOutcomeSchema = z.discriminatedUnion("state", [
    z.object({ commandId: identifier, state: z.literal("completed"), stopReason: z.string().max(2_048) }).readonly(),
    z
        .object({
            code: identifier,
            commandId: identifier,
            message: z.string().min(1).max(500),
            state: z.literal("failed"),
        })
        .readonly(),
]);
export type LastTurnOutcome = z.infer<typeof lastTurnOutcomeSchema>;

const identity = {
    ...envelope,
    kind: z.literal(NATIVE_SESSION_REQUEST_KIND),
    additionalDirectoryIds: z.array(directoryId).max(16).readonly(),
    agentId: identifier,
    bindingId: identifier,
    directoryId,
};

const nativeSessionRequestSchema = z.discriminatedUnion("action", [
    z
        .object({
            ...identity,
            action: z.literal("active-turn"),
            // Asks the Runtime for this command's delivery alongside the execution snapshot. It is not
            // named `commandId`, which routes a request as the command it names.
            deliveryCommandId: identifier.optional(),
            targetSessionId: identifier,
        })
        .readonly(),
    z.object({ ...identity, action: z.literal("find"), nativeSessionId: identifier }).readonly(),
    z
        .object({
            ...identity,
            action: z.literal("list"),
            cursor: identifier.nullable(),
        })
        .readonly(),
    z
        .object({
            ...identity,
            action: z.enum(["import", "fork"]),
            entryId: identifier,
            targetSessionId: identifier,
        })
        .readonly(),
]);
export type NativeSessionRequest = z.infer<typeof nativeSessionRequestSchema>;
const nativeSessionCommandSchema = z.discriminatedUnion("action", [
    z
        .object({
            ...identity,
            action: z.literal("active-turn"),
            // Asks the Runtime for this command's delivery alongside the execution snapshot. It is not
            // named `commandId`, which routes a request as the command it names.
            deliveryCommandId: identifier.optional(),
            targetSessionId: identifier,
        })
        .readonly(),
    z.object({ ...identity, action: z.literal("find"), nativeSessionId: identifier }).readonly(),
    z
        .object({
            ...identity,
            action: z.literal("list"),
            cursor: identifier.nullable(),
        })
        .readonly(),
    z
        .object({
            ...identity,
            action: z.enum(["import", "fork"]),
            entryId: identifier,
            targetSessionId: identifier,
        })
        .readonly(),
]);
export type NativeSessionCommand = z.infer<typeof nativeSessionCommandSchema>;

const nativeSessionEntrySchema = z
    .object({
        entryId: identifier,
        mobiusSessionIds: z.array(identifier).max(500).readonly(),
        nativeSessionId: identifier,
        title: z.string().max(500),
        directoryId,
        directoryLabel: z.string().min(1).max(MAX_WORKSPACE_PATH_LENGTH),
        updatedAt: z.iso.datetime({ offset: true }).nullable(),
        additionalDirectories: z
            .array(z.object({ directoryId, name: z.string().min(1).max(255) }).readonly())
            .max(16)
            .readonly(),
    })
    .readonly();
export type NativeSessionEntry = z.infer<typeof nativeSessionEntrySchema>;

const resultEnvelope = {
    ...envelope,
    kind: z.literal(NATIVE_SESSION_RESULT_KIND),
};
const nativeSessionResultSchema = z.discriminatedUnion("action", [
    z
        .object({
            ...resultEnvelope,
            action: z.literal("active-turn"),
            targetSessionId: identifier,
            queued: z
                .array(
                    z
                        .object({
                            commandId: identifier,
                            prompt: z.string().max(100_000),
                            attachments: z.array(promptAttachmentSchema).max(16).readonly(),
                        })
                        .readonly(),
                )
                .readonly(),
            turn: activeTurnSnapshotSchema.nullable(),
            // Absent when an older Runtime or Relay cannot provide session-scoped interaction recovery.
            interactionState: sessionInteractionSnapshotSchema.optional(),
            // Present only when the request named a command and every hop understands it. An
            // unrecognized delivery from a newer peer reads as absent instead of failing the snapshot.
            command: commandDeliverySchema.optional().catch(undefined),
            // Absent from older Runtimes and while the last started command is still running.
            lastTurn: lastTurnOutcomeSchema.optional().catch(undefined),
            // The Runtime withdraws a queued command only before it starts.
            queuedCancellation: z.literal("before-start"),
        })
        .readonly(),
    z
        .object({
            ...resultEnvelope,
            action: z.literal("find"),
            entry: nativeSessionEntrySchema,
        })
        .readonly(),
    z
        .object({
            ...resultEnvelope,
            action: z.literal("list"),
            capabilities: sessionCapabilitiesSchema,
            entries: z.array(nativeSessionEntrySchema).max(500).readonly(),
            nextCursor: identifier.nullable(),
        })
        .readonly(),
    z
        .object({
            ...resultEnvelope,
            action: z.enum(["import", "fork"]),
            targetSessionId: identifier,
            ready: sessionReadyEventSchema,
            title: z.string().max(500),
        })
        .readonly(),
]);
export type NativeSessionResult = z.infer<typeof nativeSessionResultSchema>;

const nativeSessionCancelSchema = z.object({ ...envelope, kind: z.literal(NATIVE_SESSION_CANCEL_KIND) }).readonly();
export type NativeSessionCancel = z.infer<typeof nativeSessionCancelSchema>;
function decode<T>(schema: z.ZodType<T>, encoded: string): T {
    try {
        const value: unknown = JSON.parse(encoded);
        return schema.parse(value);
    } catch (cause) {
        throw new ProtocolMessageError("Invalid native session message", { cause });
    }
}

export const decodeNativeSessionCommand = (encoded: string): NativeSessionCommand =>
    decode(nativeSessionCommandSchema, encoded);
export const encodeNativeSessionCommand = (value: NativeSessionCommand): string =>
    JSON.stringify(nativeSessionCommandSchema.parse(value));
export const decodeNativeSessionRequest = (encoded: string): NativeSessionRequest =>
    decode(nativeSessionRequestSchema, encoded);
export const encodeNativeSessionRequest = (value: NativeSessionRequest): string =>
    JSON.stringify(nativeSessionRequestSchema.parse(value));
export const decodeNativeSessionResult = (encoded: string): NativeSessionResult =>
    decode(nativeSessionResultSchema, encoded);
export const encodeNativeSessionResult = (value: NativeSessionResult): string =>
    JSON.stringify(nativeSessionResultSchema.parse(value));
export const decodeNativeSessionCancel = (encoded: string): NativeSessionCancel =>
    decode(nativeSessionCancelSchema, encoded);
export const encodeNativeSessionCancel = (value: NativeSessionCancel): string =>
    JSON.stringify(nativeSessionCancelSchema.parse(value));
