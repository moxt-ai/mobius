import { z } from "zod";

import {
    decodeAgentActivityEvent,
    decodeAgentMessageDeltaEvent,
    decodeMessageKind,
    decodeSessionCompletedEvent,
    decodeSessionFailedEvent,
    decodeSessionStartedEvent,
    ProtocolMessageError,
} from "./codecs/messages.ts";
import {
    AGENT_CONTENT_KIND,
    type AgentContentEvent,
    decodeAgentContentEvent,
    decodeSessionCommandsUpdatedEvent,
    decodeSessionConfigUpdatedEvent,
    decodeSessionElicitationRequestedEvent,
    decodeSessionElicitationResolvedEvent,
    decodeSessionInfoUpdatedEvent,
    decodeSessionPermissionRequestedEvent,
    decodeSessionPermissionResolvedEvent,
    decodeSessionReadyEvent,
    decodeSessionUsageUpdatedEvent,
    SESSION_COMMANDS_UPDATED_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    SESSION_READY_KIND,
    SESSION_USAGE_UPDATED_KIND,
    type SessionCommandsUpdatedEvent,
    type SessionConfigUpdatedEvent,
    type SessionElicitationRequestedEvent,
    type SessionElicitationResolvedEvent,
    type SessionInfoUpdatedEvent,
    type SessionPermissionRequestedEvent,
    type SessionPermissionResolvedEvent,
    type SessionReadyEvent,
    type SessionUsageUpdatedEvent,
} from "./control-messages.ts";
import {
    AGENT_ACTIVITY_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    type AgentActivityEvent,
    type AgentMessageDeltaEvent,
    SESSION_COMPLETED_KIND,
    SESSION_FAILED_KIND,
    SESSION_STARTED_KIND,
    type SessionCompletedEvent,
    type SessionFailedEvent,
    type SessionStartedEvent,
} from "./messages.ts";
export const SESSION_EVENT_KIND = "session.event";
export const SESSION_EVENT_ACK_KIND = "session.event.ack";
export const SESSION_EVENT_COMMITTED_KIND = "session.event.committed";
export const SESSION_EVENT_REJECTED_KIND = "session.event.rejected";

export const SessionEventRejectionCode = {
    SessionDeleted: "session_deleted",
    SessionNotFound: "session_not_found",
} as const;

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const MAX_RECORDED_EVENT_LENGTH = 8 * 1024 * 1024;
const DECIMAL_SEQUENCE_PATTERN = /^(?:0|[1-9][0-9]*)$/;

const eventSourceSchema = z.discriminatedUnion("kind", [
    z
        .strictObject({
            attemptId: z.string().min(1).max(128).regex(IDENTIFIER_PATTERN),
            kind: z.literal("attempt"),
            sourceSeq: z.string().min(1).max(40).regex(DECIMAL_SEQUENCE_PATTERN),
        })
        .readonly(),
    z
        .strictObject({
            kind: z.literal("runtime"),
            sourceSeq: z.string().min(1).max(40).regex(DECIMAL_SEQUENCE_PATTERN),
        })
        .readonly(),
]);

export type SessionEventSource = z.infer<typeof eventSourceSchema>;

const eventEnvelopeSchema = z
    .strictObject({
        eventId: z.string().min(1).max(128).regex(IDENTIFIER_PATTERN),
        kind: z.literal(SESSION_EVENT_KIND),
        payload: z.string().min(2).max(MAX_RECORDED_EVENT_LENGTH),
        sessionId: z.string().min(1).max(128).regex(IDENTIFIER_PATTERN),
        source: eventSourceSchema,
    })
    .readonly();

const committedEventSchema = z
    .strictObject({
        cursor: z.string().min(1).max(512).regex(CURSOR_PATTERN),
        eventId: z.string().min(1).max(128).regex(IDENTIFIER_PATTERN),
        kind: z.literal(SESSION_EVENT_COMMITTED_KIND),
        payload: z.string().min(2).max(MAX_RECORDED_EVENT_LENGTH),
        recordedAt: z.string().datetime({ offset: true }),
        sequence: z.string().min(1).max(40).regex(DECIMAL_SEQUENCE_PATTERN),
        sessionId: z.string().min(1).max(128).regex(IDENTIFIER_PATTERN),
        source: eventSourceSchema,
    })
    .readonly();

const eventAcknowledgementSchema = z
    .strictObject({
        cursor: z.string().min(1).max(512).regex(CURSOR_PATTERN),
        duplicate: z.boolean(),
        eventId: z.string().min(1).max(128).regex(IDENTIFIER_PATTERN),
        kind: z.literal(SESSION_EVENT_ACK_KIND),
        sequence: z.string().min(1).max(40).regex(DECIMAL_SEQUENCE_PATTERN),
        sessionId: z.string().min(1).max(128).regex(IDENTIFIER_PATTERN),
    })
    .readonly();

const eventRejectionSchema = z
    .strictObject({
        code: z.enum(SessionEventRejectionCode),
        eventId: z.string().min(1).max(128).regex(IDENTIFIER_PATTERN),
        kind: z.literal(SESSION_EVENT_REJECTED_KIND),
        sessionId: z.string().min(1).max(128).regex(IDENTIFIER_PATTERN),
    })
    .readonly();

export type SessionEventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type CommittedSessionEvent = z.infer<typeof committedEventSchema>;
export type SessionEventAcknowledgement = z.infer<typeof eventAcknowledgementSchema>;
export type SessionEventRejection = z.infer<typeof eventRejectionSchema>;

export type RecordedSessionEvent =
    | AgentActivityEvent
    | AgentContentEvent
    | AgentMessageDeltaEvent
    | SessionCommandsUpdatedEvent
    | SessionCompletedEvent
    | SessionConfigUpdatedEvent
    | SessionElicitationRequestedEvent
    | SessionElicitationResolvedEvent
    | SessionFailedEvent
    | SessionInfoUpdatedEvent
    | SessionPermissionRequestedEvent
    | SessionPermissionResolvedEvent
    | SessionReadyEvent
    | SessionStartedEvent
    | SessionUsageUpdatedEvent;

function decode<T>(encoded: string, schema: z.ZodType<T>): T {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new ProtocolMessageError("Message is not valid JSON", { cause });
    }
    const decoded = schema.safeParse(value);
    if (!decoded.success) {
        throw new ProtocolMessageError("Message does not match its schema", {
            cause: decoded.error,
        });
    }
    return decoded.data;
}

const encode = <T>(message: T, schema: z.ZodType<T>): string => {
    const decoded = schema.safeParse(message);
    if (!decoded.success) {
        throw new ProtocolMessageError("Message does not match its schema", {
            cause: decoded.error,
        });
    }
    return JSON.stringify(decoded.data);
};

export const decodeSessionEventEnvelope = (encoded: string): SessionEventEnvelope =>
    decode(encoded, eventEnvelopeSchema);

export const encodeSessionEventEnvelope = (message: SessionEventEnvelope): string =>
    encode(message, eventEnvelopeSchema);

export const decodeCommittedSessionEvent = (encoded: string): CommittedSessionEvent =>
    decode(encoded, committedEventSchema);

export const encodeCommittedSessionEvent = (message: CommittedSessionEvent): string =>
    encode(message, committedEventSchema);

export const decodeSessionEventAcknowledgement = (encoded: string): SessionEventAcknowledgement =>
    decode(encoded, eventAcknowledgementSchema);

export const encodeSessionEventAcknowledgement = (message: SessionEventAcknowledgement): string =>
    encode(message, eventAcknowledgementSchema);

export const decodeSessionEventRejection = (encoded: string): SessionEventRejection =>
    decode(encoded, eventRejectionSchema);

export const encodeSessionEventRejection = (message: SessionEventRejection): string =>
    encode(message, eventRejectionSchema);

export function decodeRecordedSessionEvent(encoded: string): RecordedSessionEvent {
    const kind = decodeMessageKind(encoded);
    switch (kind) {
        case AGENT_ACTIVITY_KIND:
            return decodeAgentActivityEvent(encoded);
        case AGENT_CONTENT_KIND:
            return decodeAgentContentEvent(encoded);
        case AGENT_MESSAGE_DELTA_KIND:
            return decodeAgentMessageDeltaEvent(encoded);
        case SESSION_COMMANDS_UPDATED_KIND:
            return decodeSessionCommandsUpdatedEvent(encoded);
        case SESSION_COMPLETED_KIND:
            return decodeSessionCompletedEvent(encoded);
        case SESSION_CONFIG_UPDATED_KIND:
            return decodeSessionConfigUpdatedEvent(encoded);
        case SESSION_ELICITATION_REQUESTED_KIND:
            return decodeSessionElicitationRequestedEvent(encoded);
        case SESSION_ELICITATION_RESOLVED_KIND:
            return decodeSessionElicitationResolvedEvent(encoded);
        case SESSION_FAILED_KIND:
            return decodeSessionFailedEvent(encoded);
        case SESSION_INFO_UPDATED_KIND:
            return decodeSessionInfoUpdatedEvent(encoded);
        case SESSION_PERMISSION_REQUESTED_KIND:
            return decodeSessionPermissionRequestedEvent(encoded);
        case SESSION_PERMISSION_RESOLVED_KIND:
            return decodeSessionPermissionResolvedEvent(encoded);
        case SESSION_READY_KIND:
            return decodeSessionReadyEvent(encoded);
        case SESSION_STARTED_KIND:
            return decodeSessionStartedEvent(encoded);
        case SESSION_USAGE_UPDATED_KIND:
            return decodeSessionUsageUpdatedEvent(encoded);
        default:
            throw new ProtocolMessageError("Unsupported recorded session event");
    }
}

export function validateSessionEventEnvelope(envelope: SessionEventEnvelope): RecordedSessionEvent {
    const event = decodeRecordedSessionEvent(envelope.payload);
    if (event.sessionId !== envelope.sessionId) {
        throw new ProtocolMessageError("Session event payload does not match its envelope");
    }
    return event;
}
