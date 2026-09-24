import { z } from "zod";

import {
    decodeAgentActivityEvent,
    decodeAgentActivityNarrationEvent,
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
import { identifierStringSchema } from "./identifier.ts";
import {
    AGENT_ACTIVITY_KIND,
    AGENT_ACTIVITY_NARRATION_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    type AgentActivityEvent,
    type AgentActivityNarrationEvent,
    type AgentMessageDeltaEvent,
    SESSION_COMPLETED_KIND,
    SESSION_FAILED_KIND,
    SESSION_STARTED_KIND,
    type SessionCompletedEvent,
    type SessionFailedEvent,
    type SessionStartedEvent,
} from "./messages.ts";
export const SESSION_EVENT_KIND = "session.event";
export const SESSION_EVENT_COMMITTED_KIND = "session.event.committed";

const MAX_RECORDED_EVENT_LENGTH = 8 * 1024 * 1024;

const eventEnvelopeSchema = z
    .strictObject({
        kind: z.literal(SESSION_EVENT_KIND),
        payload: z.string().min(2).max(MAX_RECORDED_EVENT_LENGTH),
        sessionId: identifierStringSchema,
    })
    .readonly();

const committedEventSchema = z
    .strictObject({
        kind: z.literal(SESSION_EVENT_COMMITTED_KIND),
        payload: z.string().min(2).max(MAX_RECORDED_EVENT_LENGTH),
        sessionId: identifierStringSchema,
    })
    .readonly();

export type SessionEventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type CommittedSessionEvent = z.infer<typeof committedEventSchema>;

export type RecordedSessionEvent =
    | AgentActivityEvent
    | AgentActivityNarrationEvent
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

export function decodeRecordedSessionEvent(encoded: string): RecordedSessionEvent {
    const kind = decodeMessageKind(encoded);
    switch (kind) {
        case AGENT_ACTIVITY_KIND:
            return decodeAgentActivityEvent(encoded);
        case AGENT_ACTIVITY_NARRATION_KIND:
            return decodeAgentActivityNarrationEvent(encoded);
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

export const encodeRecordedSessionEvent = (event: RecordedSessionEvent): string =>
    JSON.stringify(decodeRecordedSessionEvent(JSON.stringify(event)));

export function validateSessionEventEnvelope(envelope: SessionEventEnvelope): RecordedSessionEvent {
    const event = decodeRecordedSessionEvent(envelope.payload);
    if (event.sessionId !== envelope.sessionId) {
        throw new ProtocolMessageError("Session event payload does not match its envelope");
    }
    return event;
}
