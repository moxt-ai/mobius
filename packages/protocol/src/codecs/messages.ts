import {
    decodeAgentDisplayContentValue,
    decodePromptImagesValue,
    decodePromptResourcesValue,
    decodeRecordedAgentContentValue,
    decodeSessionConfigurationSelections,
} from "../control-messages.ts";
import { decodeIdentifier, type Identifier, isIdentifier } from "../identifier.ts";
import {
    AGENT_ACTIVITY_DETAIL_LIMIT,
    AGENT_ACTIVITY_KIND,
    AGENT_ACTIVITY_LOCATION_LENGTH_LIMIT,
    AGENT_ACTIVITY_LOCATION_LIMIT,
    AGENT_ACTIVITY_NARRATION_KIND,
    AGENT_ACTIVITY_RECORDED_DETAIL_LIMIT,
    AGENT_ACTIVITY_RECORDED_FIELD_LIMIT,
    AGENT_MESSAGE_DELTA_KIND,
    type AgentActivityDetailCapture,
    type AgentActivityEvent,
    type AgentActivityNarrationEvent,
    type AgentMessageDeltaEvent,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    RUNTIME_PING_KIND,
    RUNTIME_PONG_KIND,
    RUNTIME_STATUS_KIND,
    type RuntimeHeartbeatAckEvent,
    type RuntimeHeartbeatEvent,
    type RuntimeLivenessReadyEvent,
    type RuntimePingCommand,
    type RuntimePongEvent,
    type RuntimeStatusEvent,
    SESSION_CANCEL_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_FAILED_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_PROMPT_KIND,
    SESSION_QUEUED_KIND,
    SESSION_STARTED_KIND,
    type SessionCancelCommand,
    type SessionCompletedEvent,
    type SessionFailedEvent,
    type SessionPromptCommand,
    SessionPromptDisposition,
    type SessionPromptDispositionCommand,
    type SessionQueuedEvent,
    type SessionStartedEvent,
} from "../messages.ts";

const DIRECTORY_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/;
const MAX_PROMPT_LENGTH = 100_000;
export const MAX_PROMPT_ATTACHMENT_LENGTH = 6_000_000;
const MAX_EVENT_TEXT_LENGTH = 100_000;
const ACTIVITY_TYPES = new Set(["notice", "plan", "progress", "reasoning", "tool"]);
// Only narrative activities stream incrementally; tools and plans are replaced wholesale.
const NARRATION_ACTIVITY_TYPES = new Set(["progress", "reasoning"]);
const ACTIVITY_STATUSES = new Set(["pending", "running", "completed", "failed"]);
const TOOL_KINDS = new Set([
    "",
    "delete",
    "edit",
    "execute",
    "fetch",
    "move",
    "other",
    "read",
    "search",
    "switch_mode",
    "think",
]);

export class ProtocolMessageError extends Error {
    readonly code = "invalid_protocol_message";

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "ProtocolMessageError";
    }
}

export class UnsupportedProtocolMessageKindError extends Error {
    readonly code = "unsupported_protocol_message_kind";
    readonly direction: "daemon-to-service" | "service-to-daemon";
    readonly messageKind: string;

    constructor(direction: "daemon-to-service" | "service-to-daemon", messageKind: string) {
        super(`Unsupported ${direction} message kind: ${messageKind}`);
        this.name = "UnsupportedProtocolMessageKindError";
        this.direction = direction;
        this.messageKind = messageKind;
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(encoded: string): Readonly<Record<string, unknown>> {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (error) {
        throw new ProtocolMessageError("Message is not valid JSON", {
            cause: error,
        });
    }

    if (!isRecord(value)) {
        throw new ProtocolMessageError("Message must be a JSON object");
    }

    return value;
}

function readString(value: Readonly<Record<string, unknown>>, key: string, maximumLength: number): string {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0 || field.length > maximumLength) {
        throw new ProtocolMessageError(`Invalid string field: ${key}`);
    }
    return field;
}

function readText(value: Readonly<Record<string, unknown>>, key: string, maximumLength: number): string {
    const field = value[key];
    if (typeof field !== "string" || field.length > maximumLength) {
        throw new ProtocolMessageError(`Invalid text field: ${key}`);
    }
    return field;
}

function readAllowedString(
    value: Readonly<Record<string, unknown>>,
    key: string,
    allowedValues: ReadonlySet<string>,
): string {
    const field = readText(value, key, 64);
    if (!allowedValues.has(field)) {
        throw new ProtocolMessageError(`Invalid value field: ${key}`);
    }
    return field;
}

function readPromptDisposition(value: Readonly<Record<string, unknown>>): string {
    const field = value["disposition"];
    if (field === undefined || field === SessionPromptDisposition.Reject) {
        return SessionPromptDisposition.Reject;
    }
    if (field === SessionPromptDisposition.Queue) {
        return SessionPromptDisposition.Queue;
    }
    if (field === SessionPromptDisposition.Steer) {
        return SessionPromptDisposition.Steer;
    }
    throw new ProtocolMessageError("Invalid value field: disposition");
}

function readSequence(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
        throw new ProtocolMessageError(`Invalid integer field: ${key}`);
    }
    return field;
}

function readLocations(value: Readonly<Record<string, unknown>>): readonly string[] {
    const field = value["locations"];
    if (!Array.isArray(field) || field.length > AGENT_ACTIVITY_LOCATION_LIMIT) {
        throw new ProtocolMessageError("Invalid locations field");
    }
    const locations: string[] = [];
    const unique = new Set<string>();
    for (const location of field) {
        if (
            typeof location !== "string" ||
            location.length === 0 ||
            location.length > AGENT_ACTIVITY_LOCATION_LENGTH_LIMIT
        ) {
            throw new ProtocolMessageError("Invalid activity location");
        }
        if (unique.has(location)) {
            throw new ProtocolMessageError("Duplicate activity location");
        }
        unique.add(location);
        locations.push(location);
    }
    return locations;
}

function readDirectoryIdentifiers(
    value: Readonly<Record<string, unknown>>,
    key: string,
    maximumCount: number,
): readonly string[] {
    const field = value[key];
    if (!Array.isArray(field) || field.length > maximumCount) {
        throw new ProtocolMessageError(`Invalid directory list field: ${key}`);
    }
    const identifiers: string[] = [];
    const unique = new Set<string>();
    for (const candidate of field) {
        if (typeof candidate !== "string" || !DIRECTORY_IDENTIFIER_PATTERN.test(candidate) || unique.has(candidate)) {
            throw new ProtocolMessageError(`Invalid directory in field: ${key}`);
        }
        unique.add(candidate);
        identifiers.push(candidate);
    }
    return identifiers;
}

function readActivityContent(
    value: Readonly<Record<string, unknown>>,
): readonly ReturnType<typeof decodeAgentDisplayContentValue>[] {
    const field = value["content"];
    if (!Array.isArray(field) || field.length > 100) {
        throw new ProtocolMessageError("Invalid activity content field");
    }
    return field.map((entry) => decodeAgentDisplayContentValue(entry));
}

function readActivityDetail(value: Readonly<Record<string, unknown>>): AgentActivityDetailCapture {
    const field = value["detail"];
    if (!isRecord(field)) {
        throw new ProtocolMessageError("Invalid activity detail field");
    }
    const kind = readString(field, "kind", 32);
    if (kind === "available") {
        return {
            artifactId: readIdentifier(field, "artifactId"),
            kind,
        };
    }
    if (kind === "unrecorded") {
        return { kind };
    }
    if (kind === "truncated") {
        const capturedBytes = readSequence(field, "capturedBytes");
        const originalBytes = readSequence(field, "originalBytes");
        if (capturedBytes > originalBytes) {
            throw new ProtocolMessageError("Invalid truncated activity detail size");
        }
        return { capturedBytes, kind, originalBytes };
    }
    if (kind === "recorded") {
        const contentValue = field["content"];
        if (!Array.isArray(contentValue) || contentValue.length > 100) {
            throw new ProtocolMessageError("Invalid recorded activity content");
        }
        const detail = {
            content: contentValue.map((entry) => decodeRecordedAgentContentValue(entry)),
            input: readText(field, "input", AGENT_ACTIVITY_RECORDED_FIELD_LIMIT),
            kind,
            output: readText(field, "output", AGENT_ACTIVITY_RECORDED_FIELD_LIMIT),
        } as const;
        if (JSON.stringify(detail).length > AGENT_ACTIVITY_RECORDED_DETAIL_LIMIT) {
            throw new ProtocolMessageError("Recorded activity detail is too large");
        }
        return detail;
    }
    throw new ProtocolMessageError("Invalid activity detail availability");
}

function readIdentifier(value: Readonly<Record<string, unknown>>, key: string): Identifier {
    try {
        return decodeIdentifier(value[key]);
    } catch (cause) {
        throw new ProtocolMessageError(`Invalid identifier field: ${key}`, { cause });
    }
}

function readDirectoryIdentifier(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = readString(value, key, 2_048);
    if (!DIRECTORY_IDENTIFIER_PATTERN.test(field)) {
        throw new ProtocolMessageError(`Invalid directory identifier field: ${key}`);
    }
    return field;
}

function readBoolean(value: Readonly<Record<string, unknown>>, key: string): boolean {
    const field = value[key];
    if (typeof field !== "boolean") {
        throw new ProtocolMessageError(`Invalid boolean field: ${key}`);
    }
    return field;
}

function assertKind(value: Readonly<Record<string, unknown>>, expectedKind: string): void {
    if (value["kind"] !== expectedKind) {
        throw new ProtocolMessageError(`Expected message kind: ${expectedKind}`);
    }
}

export function decodeMessageKind(encoded: string): string {
    return readString(parseJson(encoded), "kind", 64);
}

export function decodeSessionPromptCommand(encoded: string): SessionPromptCommand {
    const value = parseJson(encoded);
    const hasSessionConfigurations = Object.hasOwn(value, "sessionConfigurations");
    assertKind(value, SESSION_PROMPT_KIND);

    const prompt = readText(value, "prompt", MAX_PROMPT_LENGTH);
    const images = decodePromptImagesValue(value["images"]);
    const resources = decodePromptResourcesValue(value["resources"]);
    const attachmentLength =
        images.reduce((total, image) => total + image.data.length, 0) +
        resources.reduce((total, resource) => total + resource.text.length, 0);
    if (attachmentLength > MAX_PROMPT_ATTACHMENT_LENGTH) {
        throw new ProtocolMessageError("Prompt attachments are too large");
    }
    if (prompt.trim().length === 0 && images.length === 0 && resources.length === 0) {
        throw new ProtocolMessageError("Prompt must contain content");
    }

    const disposition = readPromptDisposition(value);
    const rawTargetCommandId = value["targetCommandId"];
    const targetCommandId = rawTargetCommandId === undefined ? "" : readText(value, "targetCommandId", 128);
    if (
        (disposition === SessionPromptDisposition.Reject && targetCommandId.length > 0) ||
        (disposition !== SessionPromptDisposition.Reject && !isIdentifier(targetCommandId))
    ) {
        throw new ProtocolMessageError("Prompt disposition has an invalid target command");
    }

    const sessionConfigurations = hasSessionConfigurations
        ? decodeSessionConfigurationSelections(value["sessionConfigurations"])
        : [];
    if (new Set(sessionConfigurations.map((selection) => selection.configId)).size !== sessionConfigurations.length) {
        throw new ProtocolMessageError("Session configuration identifiers must be unique");
    }

    return {
        additionalDirectoryIds: readDirectoryIdentifiers(value, "additionalDirectoryIds", 16),
        agentId: readIdentifier(value, "agentId"),
        bindingId: readIdentifier(value, "bindingId"),
        commandId: readIdentifier(value, "commandId"),
        directoryId: readDirectoryIdentifier(value, "directoryId"),
        disposition,
        images,
        kind: SESSION_PROMPT_KIND,
        prompt,
        resources,
        ...(hasSessionConfigurations ? { sessionConfigurations } : {}),
        sessionId: readIdentifier(value, "sessionId"),
        targetCommandId,
    };
}

export function decodeSessionCancelCommand(encoded: string): SessionCancelCommand {
    const value = parseJson(encoded);
    assertKind(value, SESSION_CANCEL_KIND);

    return {
        commandId: readIdentifier(value, "commandId"),
        kind: SESSION_CANCEL_KIND,
        sessionId: readIdentifier(value, "sessionId"),
    };
}

export function decodeSessionPromptDispositionCommand(encoded: string): SessionPromptDispositionCommand {
    const value = parseJson(encoded);
    assertKind(value, SESSION_PROMPT_DISPOSITION_KIND);
    if (readPromptDisposition(value) !== SessionPromptDisposition.Steer) {
        throw new ProtocolMessageError("Only queued prompts can be steered");
    }
    return {
        commandId: readIdentifier(value, "commandId"),
        disposition: SessionPromptDisposition.Steer,
        kind: SESSION_PROMPT_DISPOSITION_KIND,
        sessionId: readIdentifier(value, "sessionId"),
    };
}

export function decodeSessionQueuedEvent(encoded: string): SessionQueuedEvent {
    const value = parseJson(encoded);
    assertKind(value, SESSION_QUEUED_KIND);
    return {
        commandId: readIdentifier(value, "commandId"),
        kind: SESSION_QUEUED_KIND,
        sessionId: readIdentifier(value, "sessionId"),
    };
}

export function decodeRuntimeStatusEvent(encoded: string): RuntimeStatusEvent {
    const value = parseJson(encoded);
    assertKind(value, RUNTIME_STATUS_KIND);

    return {
        kind: RUNTIME_STATUS_KIND,
        online: readBoolean(value, "online"),
        runtimeId: readIdentifier(value, "runtimeId"),
    };
}

export function decodeRuntimeLivenessReadyEvent(encoded: string): RuntimeLivenessReadyEvent {
    const value = parseJson(encoded);
    assertKind(value, RUNTIME_LIVENESS_READY_KIND);
    return { kind: RUNTIME_LIVENESS_READY_KIND };
}

export function decodeRuntimeHeartbeatEvent(encoded: string): RuntimeHeartbeatEvent {
    const value = parseJson(encoded);
    assertKind(value, RUNTIME_HEARTBEAT_KIND);

    return {
        heartbeatId: readIdentifier(value, "heartbeatId"),
        kind: RUNTIME_HEARTBEAT_KIND,
    };
}

export function decodeRuntimeHeartbeatAckEvent(encoded: string): RuntimeHeartbeatAckEvent {
    const value = parseJson(encoded);
    assertKind(value, RUNTIME_HEARTBEAT_ACK_KIND);

    return {
        heartbeatId: readIdentifier(value, "heartbeatId"),
        kind: RUNTIME_HEARTBEAT_ACK_KIND,
    };
}

export function decodeRuntimePingCommand(encoded: string): RuntimePingCommand {
    const value = parseJson(encoded);
    assertKind(value, RUNTIME_PING_KIND);
    return { kind: RUNTIME_PING_KIND, requestId: readIdentifier(value, "requestId") };
}

export function decodeRuntimePongEvent(encoded: string): RuntimePongEvent {
    const value = parseJson(encoded);
    assertKind(value, RUNTIME_PONG_KIND);
    return { kind: RUNTIME_PONG_KIND, requestId: readIdentifier(value, "requestId") };
}

export function decodeSessionStartedEvent(encoded: string): SessionStartedEvent {
    const value = parseJson(encoded);
    assertKind(value, SESSION_STARTED_KIND);

    const sequence = readSequence(value, "sequence");
    if (sequence !== 0) {
        throw new ProtocolMessageError("Invalid live start sequence");
    }

    return {
        commandId: readIdentifier(value, "commandId"),
        epoch: readIdentifier(value, "epoch"),
        kind: SESSION_STARTED_KIND,
        attemptId: readIdentifier(value, "attemptId"),
        prompt: readText(value, "prompt", MAX_PROMPT_LENGTH),
        sequence,
        sessionId: readIdentifier(value, "sessionId"),
    };
}

export function decodeAgentMessageDeltaEvent(encoded: string): AgentMessageDeltaEvent {
    const value = parseJson(encoded);
    assertKind(value, AGENT_MESSAGE_DELTA_KIND);

    const sequence = readSequence(value, "sequence");
    if (sequence === 0) {
        throw new ProtocolMessageError("Invalid live sequence");
    }

    return {
        commandId: readIdentifier(value, "commandId"),
        epoch: readIdentifier(value, "epoch"),
        kind: AGENT_MESSAGE_DELTA_KIND,
        messageId: value["messageId"] === undefined ? "" : readText(value, "messageId", 255),
        sequence,
        sessionId: readIdentifier(value, "sessionId"),
        text: readString(value, "text", MAX_EVENT_TEXT_LENGTH),
    };
}

export function decodeAgentActivityEvent(encoded: string): AgentActivityEvent {
    const value = parseJson(encoded);
    assertKind(value, AGENT_ACTIVITY_KIND);

    return {
        activityId: readIdentifier(value, "activityId"),
        activityType: readAllowedString(value, "activityType", ACTIVITY_TYPES),
        commandId: readIdentifier(value, "commandId"),
        content: readActivityContent(value),
        detail: readActivityDetail(value),
        input: readText(value, "input", AGENT_ACTIVITY_DETAIL_LIMIT),
        kind: AGENT_ACTIVITY_KIND,
        locations: readLocations(value),
        name: readText(value, "name", 128),
        output: readText(value, "output", AGENT_ACTIVITY_DETAIL_LIMIT),
        sequence: readSequence(value, "sequence"),
        sessionId: readIdentifier(value, "sessionId"),
        status: readAllowedString(value, "status", ACTIVITY_STATUSES),
        title: readString(value, "title", 500),
        toolKind: readAllowedString(value, "toolKind", TOOL_KINDS),
    };
}

export function decodeSessionCompletedEvent(encoded: string): SessionCompletedEvent {
    const value = parseJson(encoded);
    assertKind(value, SESSION_COMPLETED_KIND);

    return {
        commandId: readIdentifier(value, "commandId"),
        kind: SESSION_COMPLETED_KIND,
        sessionId: readIdentifier(value, "sessionId"),
        stopReason: readString(value, "stopReason", 64),
    };
}

export function decodeSessionFailedEvent(encoded: string): SessionFailedEvent {
    const value = parseJson(encoded);
    assertKind(value, SESSION_FAILED_KIND);

    return {
        code: readIdentifier(value, "code"),
        commandId: readIdentifier(value, "commandId"),
        kind: SESSION_FAILED_KIND,
        message: readString(value, "message", 500),
        sessionId: readIdentifier(value, "sessionId"),
    };
}

export function encodeSessionPromptCommand(message: SessionPromptCommand): string {
    return JSON.stringify(decodeSessionPromptCommand(JSON.stringify(message)));
}

export function encodeSessionCancelCommand(message: SessionCancelCommand): string {
    return JSON.stringify(decodeSessionCancelCommand(JSON.stringify(message)));
}

export function encodeSessionPromptDispositionCommand(message: SessionPromptDispositionCommand): string {
    return JSON.stringify(decodeSessionPromptDispositionCommand(JSON.stringify(message)));
}

export function encodeSessionQueuedEvent(message: SessionQueuedEvent): string {
    return JSON.stringify(decodeSessionQueuedEvent(JSON.stringify(message)));
}

export function encodeRuntimeStatusEvent(message: RuntimeStatusEvent): string {
    return JSON.stringify(decodeRuntimeStatusEvent(JSON.stringify(message)));
}

export function encodeRuntimeLivenessReadyEvent(message: RuntimeLivenessReadyEvent): string {
    return JSON.stringify(decodeRuntimeLivenessReadyEvent(JSON.stringify(message)));
}

export function encodeRuntimeHeartbeatEvent(message: RuntimeHeartbeatEvent): string {
    return JSON.stringify(decodeRuntimeHeartbeatEvent(JSON.stringify(message)));
}

export function encodeRuntimeHeartbeatAckEvent(message: RuntimeHeartbeatAckEvent): string {
    return JSON.stringify(decodeRuntimeHeartbeatAckEvent(JSON.stringify(message)));
}

export function encodeRuntimePingCommand(message: RuntimePingCommand): string {
    return JSON.stringify(decodeRuntimePingCommand(JSON.stringify(message)));
}

export function encodeRuntimePongEvent(message: RuntimePongEvent): string {
    return JSON.stringify(decodeRuntimePongEvent(JSON.stringify(message)));
}

export function encodeSessionStartedEvent(message: SessionStartedEvent): string {
    return JSON.stringify(decodeSessionStartedEvent(JSON.stringify(message)));
}

export function encodeAgentMessageDeltaEvent(message: AgentMessageDeltaEvent): string {
    return JSON.stringify(decodeAgentMessageDeltaEvent(JSON.stringify(message)));
}

export function encodeAgentActivityEvent(message: AgentActivityEvent): string {
    return JSON.stringify(decodeAgentActivityEvent(JSON.stringify(message)));
}

export function decodeAgentActivityNarrationEvent(encoded: string): AgentActivityNarrationEvent {
    const value = parseJson(encoded);
    assertKind(value, AGENT_ACTIVITY_NARRATION_KIND);

    return {
        activityId: readIdentifier(value, "activityId"),
        activityType: readAllowedString(value, "activityType", NARRATION_ACTIVITY_TYPES),
        commandId: readIdentifier(value, "commandId"),
        kind: AGENT_ACTIVITY_NARRATION_KIND,
        sequence: readSequence(value, "sequence"),
        sessionId: readIdentifier(value, "sessionId"),
        text: readText(value, "text", MAX_EVENT_TEXT_LENGTH),
    };
}

export function encodeAgentActivityNarrationEvent(message: AgentActivityNarrationEvent): string {
    return JSON.stringify(decodeAgentActivityNarrationEvent(JSON.stringify(message)));
}

export function encodeSessionCompletedEvent(message: SessionCompletedEvent): string {
    return JSON.stringify(decodeSessionCompletedEvent(JSON.stringify(message)));
}

export function encodeSessionFailedEvent(message: SessionFailedEvent): string {
    return JSON.stringify(decodeSessionFailedEvent(JSON.stringify(message)));
}
