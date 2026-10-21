import { z } from "zod";

import { identifierStringSchema as IDENTIFIER } from "../../shared/identifier.ts";
import { decodeZodMessage as decode, encodeZodMessage as encode } from "../../shared/message-codec.ts";
import { sessionConfigOptionsSchema } from "../configuration/index.ts";
import {
    DIRECTORY_IDENTIFIER,
    sessionCapabilitiesSchema,
    sessionCommandSchema,
    sessionIdentityFields,
    sessionStatusSchema,
    workspaceEntrySchema,
} from "../shared/index.ts";

export const SESSION_PREPARE_KIND = "session.prepare";
export const SESSION_READY_KIND = "session.ready";
export const SESSION_LIST_KIND = "session.list";
export const SESSION_LISTED_KIND = "session.listed";
export const SESSION_QUERY_KIND = "session.query";
export const SESSION_QUERIED_KIND = "session.queried";
export const SESSION_RESTORE_KIND = "session.restore";
export const SESSION_RESTORED_KIND = "session.restored";
export const SESSION_CLOSE_KIND = "session.close";
export const SESSION_CLOSED_KIND = "session.closed";
export const SESSION_STATUS_CHANGED_KIND = "session.status.changed";
export const SESSION_COMMANDS_UPDATED_KIND = "session.commands.updated";
export const SESSION_INFO_UPDATED_KIND = "session.info.updated";
export const SESSION_OPERATION_FAILED_KIND = "session.operation.failed";

const sessionStatusChangedEventSchema = z
    .object({
        kind: z.literal(SESSION_STATUS_CHANGED_KIND),
        sessionId: IDENTIFIER,
        status: sessionStatusSchema,
    })
    .readonly();

export type SessionStatusChangedEvent = z.infer<typeof sessionStatusChangedEventSchema>;

const sessionMetadataSchema = z
    .object({
        additionalDirectories: z.array(workspaceEntrySchema).max(16).readonly(),
        agentId: IDENTIFIER,
        directoryId: DIRECTORY_IDENTIFIER,
        directoryLabel: z.string().min(1).max(2_048),
        prompted: z.boolean(),
        sessionId: IDENTIFIER,
        status: sessionStatusSchema.default({ kind: "idle" }),
        title: z.string().max(500),
        updatedAt: z.iso.datetime({ offset: true }),
    })
    .readonly();

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

const sessionListCommandSchema = z
    .object({
        kind: z.literal(SESSION_LIST_KIND),
        limit: z.number().int().positive().max(500),
        requestId: IDENTIFIER,
    })
    .readonly();

export type SessionListCommand = z.infer<typeof sessionListCommandSchema>;

const sessionsListedEventSchema = z
    .object({
        entries: z.array(sessionMetadataSchema).max(500).readonly(),
        kind: z.literal(SESSION_LISTED_KIND),
        requestId: IDENTIFIER,
    })
    .readonly();

export type SessionsListedEvent = z.infer<typeof sessionsListedEventSchema>;

const sessionQueryCommandSchema = z
    .object({
        kind: z.literal(SESSION_QUERY_KIND),
        requestId: IDENTIFIER,
        sessionIds: z.array(IDENTIFIER).min(1).max(500).readonly(),
    })
    .readonly();

export type SessionQueryCommand = z.infer<typeof sessionQueryCommandSchema>;

const sessionsQueriedEventSchema = z
    .object({
        entries: z.array(sessionMetadataSchema).max(500).readonly(),
        kind: z.literal(SESSION_QUERIED_KIND),
        requestId: IDENTIFIER,
    })
    .readonly();

export type SessionsQueriedEvent = z.infer<typeof sessionsQueriedEventSchema>;

const sessionRestoreCommandSchema = z
    .object({
        kind: z.literal(SESSION_RESTORE_KIND),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionRestoreCommand = z.infer<typeof sessionRestoreCommandSchema>;

const sessionCloseCommandSchema = z
    .object({
        kind: z.literal(SESSION_CLOSE_KIND),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionCloseCommand = z.infer<typeof sessionCloseCommandSchema>;

const sessionPrepareCommandSchema = z
    .object({
        ...sessionIdentityFields,
        configuration: z
            .object({
                booleanValue: z.boolean(),
                configId: z.string().min(1).max(128),
                value: z.string().max(500),
                valueType: z.enum(["boolean", "select"]),
            })
            .readonly()
            .optional(),
        kind: z.literal(SESSION_PREPARE_KIND),
        requestId: IDENTIFIER,
        sessionState: z.literal("provisioned").optional(),
        /** Marks an inspection-only Session preparation. */
        transient: z.boolean().optional(),
    })
    .superRefine((command, context) => {
        if (command.transient === true && command.sessionState === "provisioned") {
            context.addIssue({
                code: "custom",
                message: "A transient Session cannot already be provisioned",
                path: ["sessionState"],
            });
        }
    })
    .readonly();

export type SessionPrepareCommand = z.infer<typeof sessionPrepareCommandSchema>;

const runtimeTimingsSchema = z
    .array(
        z
            .object({
                durationMilliseconds: z.number().finite().nonnegative().max(120_000),
                name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
            })
            .readonly(),
    )
    .max(16)
    .readonly();

export const sessionReadyEventSchema = z
    .object({
        additionalDirectories: z.array(workspaceEntrySchema).max(16).readonly(),
        agentId: IDENTIFIER,
        agentName: z.string().max(255),
        agentVersion: z.string().max(128),
        capabilities: sessionCapabilitiesSchema,
        commands: z.array(sessionCommandSchema).max(500).readonly(),
        configOptions: sessionConfigOptionsSchema,
        directoryId: DIRECTORY_IDENTIFIER,
        directoryLabel: z.string().min(1).max(2_048),
        kind: z.literal(SESSION_READY_KIND),
        requestId: IDENTIFIER,
        restored: z.boolean(),
        runtimeTimings: runtimeTimingsSchema.optional(),
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionReadyEvent = z.infer<typeof sessionReadyEventSchema>;

const sessionRestoredEventSchema = z
    .object({
        entry: sessionMetadataSchema,
        kind: z.literal(SESSION_RESTORED_KIND),
        ready: sessionReadyEventSchema,
        requestId: IDENTIFIER,
    })
    .readonly();

export type SessionRestoredEvent = z.infer<typeof sessionRestoredEventSchema>;

const sessionClosedEventSchema = z
    .object({
        kind: z.literal(SESSION_CLOSED_KIND),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionClosedEvent = z.infer<typeof sessionClosedEventSchema>;

const sessionCommandsUpdatedEventSchema = z
    .object({
        commands: z.array(sessionCommandSchema).max(500).readonly(),
        kind: z.literal(SESSION_COMMANDS_UPDATED_KIND),
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionCommandsUpdatedEvent = z.infer<typeof sessionCommandsUpdatedEventSchema>;

const sessionInfoUpdatedEventSchema = z
    .object({
        kind: z.literal(SESSION_INFO_UPDATED_KIND),
        projectId: IDENTIFIER.optional(),
        sessionId: IDENTIFIER,
        title: z.string().max(500).nullable(),
        updatedAt: z.string().max(128),
    })
    .readonly();

export type SessionInfoUpdatedEvent = z.infer<typeof sessionInfoUpdatedEventSchema>;

const sessionOperationFailedEventSchema = z
    .object({
        code: IDENTIFIER,
        kind: z.literal(SESSION_OPERATION_FAILED_KIND),
        message: z.string().min(1).max(500),
        requestId: IDENTIFIER,
        runtimeTimings: runtimeTimingsSchema.optional(),
        sessionId: z.string().max(128),
    })
    .readonly();

export type SessionOperationFailedEvent = z.infer<typeof sessionOperationFailedEventSchema>;

export const decodeSessionListCommand = (encoded: string): SessionListCommand =>
    decode(encoded, sessionListCommandSchema);
export const encodeSessionListCommand = (message: SessionListCommand): string =>
    encode(message, sessionListCommandSchema);
export const decodeSessionsListedEvent = (encoded: string): SessionsListedEvent =>
    decode(encoded, sessionsListedEventSchema);
export const encodeSessionsListedEvent = (message: SessionsListedEvent): string =>
    encode(message, sessionsListedEventSchema);
export const decodeSessionQueryCommand = (encoded: string): SessionQueryCommand =>
    decode(encoded, sessionQueryCommandSchema);
export const encodeSessionQueryCommand = (message: SessionQueryCommand): string =>
    encode(message, sessionQueryCommandSchema);
export const decodeSessionsQueriedEvent = (encoded: string): SessionsQueriedEvent =>
    decode(encoded, sessionsQueriedEventSchema);
export const encodeSessionsQueriedEvent = (message: SessionsQueriedEvent): string =>
    encode(message, sessionsQueriedEventSchema);
export const decodeSessionRestoreCommand = (encoded: string): SessionRestoreCommand =>
    decode(encoded, sessionRestoreCommandSchema);
export const encodeSessionRestoreCommand = (message: SessionRestoreCommand): string =>
    encode(message, sessionRestoreCommandSchema);
export const decodeSessionRestoredEvent = (encoded: string): SessionRestoredEvent =>
    decode(encoded, sessionRestoredEventSchema);
export const encodeSessionRestoredEvent = (message: SessionRestoredEvent): string =>
    encode(message, sessionRestoredEventSchema);
export const decodeSessionCloseCommand = (encoded: string): SessionCloseCommand =>
    decode(encoded, sessionCloseCommandSchema);
export const encodeSessionCloseCommand = (message: SessionCloseCommand): string =>
    encode(message, sessionCloseCommandSchema);
export const decodeSessionClosedEvent = (encoded: string): SessionClosedEvent =>
    decode(encoded, sessionClosedEventSchema);
export const encodeSessionClosedEvent = (message: SessionClosedEvent): string =>
    encode(message, sessionClosedEventSchema);
export const decodeSessionStatusChangedEvent = (encoded: string): SessionStatusChangedEvent =>
    decode(encoded, sessionStatusChangedEventSchema);
export const encodeSessionStatusChangedEvent = (message: SessionStatusChangedEvent): string =>
    encode(message, sessionStatusChangedEventSchema);
export const decodeSessionPrepareCommand = (encoded: string): SessionPrepareCommand =>
    decode(encoded, sessionPrepareCommandSchema);
export const encodeSessionPrepareCommand = (message: SessionPrepareCommand): string =>
    encode(message, sessionPrepareCommandSchema);
export const decodeSessionReadyEvent = (encoded: string): SessionReadyEvent => decode(encoded, sessionReadyEventSchema);
export const encodeSessionReadyEvent = (message: SessionReadyEvent): string => encode(message, sessionReadyEventSchema);
export const decodeSessionCommandsUpdatedEvent = (encoded: string): SessionCommandsUpdatedEvent =>
    decode(encoded, sessionCommandsUpdatedEventSchema);
export const encodeSessionCommandsUpdatedEvent = (message: SessionCommandsUpdatedEvent): string =>
    encode(message, sessionCommandsUpdatedEventSchema);
export const decodeSessionInfoUpdatedEvent = (encoded: string): SessionInfoUpdatedEvent =>
    decode(encoded, sessionInfoUpdatedEventSchema);
export const encodeSessionInfoUpdatedEvent = (message: SessionInfoUpdatedEvent): string =>
    encode(message, sessionInfoUpdatedEventSchema);
export const decodeSessionOperationFailedEvent = (encoded: string): SessionOperationFailedEvent =>
    decode(encoded, sessionOperationFailedEventSchema);
export const encodeSessionOperationFailedEvent = (message: SessionOperationFailedEvent): string =>
    encode(message, sessionOperationFailedEventSchema);
