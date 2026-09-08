import {
    decodeAgentDisplayContentValue,
    decodePromptImagesValue,
    decodePromptResourcesValue,
    decodeRecordedAgentContentValue,
} from "../control-messages.ts";
import {
    AGENT_ACTIVITY_DETAIL_LIMIT,
    AGENT_ACTIVITY_KIND,
    AGENT_ACTIVITY_LOCATION_LENGTH_LIMIT,
    AGENT_ACTIVITY_LOCATION_LIMIT,
    AGENT_ACTIVITY_RECORDED_DETAIL_LIMIT,
    AGENT_ACTIVITY_RECORDED_FIELD_LIMIT,
    AGENT_MESSAGE_DELTA_KIND,
    type AgentActivityDetailCapture,
    type AgentActivityEvent,
    type AgentMessageDeltaEvent,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    RUNTIME_STATUS_KIND,
    type RuntimeHeartbeatAckEvent,
    type RuntimeHeartbeatEvent,
    type RuntimeLivenessReadyEvent,
    type RuntimeStatusEvent,
    SESSION_CANCEL_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_FAILED_KIND,
    SESSION_PROMPT_KIND,
    SESSION_STARTED_KIND,
    type SessionCancelCommand,
    type SessionCompletedEvent,
    type SessionFailedEvent,
    type SessionPromptCommand,
    type SessionStartedEvent,
} from "../messages.ts";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DIRECTORY_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/;
const MAX_PROMPT_LENGTH = 10_000;
const MAX_PROMPT_ATTACHMENT_LENGTH = 6_000_000;
const MAX_EVENT_TEXT_LENGTH = 100_000;
const ACTIVITY_TYPES = new Set(["plan", "progress", "reasoning", "tool"]);
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

function assertExactKeys(value: Readonly<Record<string, unknown>>, allowedKeys: readonly string[]): void {
    for (const key of Object.keys(value)) {
        if (!allowedKeys.includes(key)) {
            throw new ProtocolMessageError(`Unexpected message field: ${key}`);
        }
    }
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
        assertExactKeys(field, ["artifactId", "kind"]);
        return {
            artifactId: readIdentifier(field, "artifactId"),
            kind,
        };
    }
    if (kind === "unrecorded") {
        assertExactKeys(field, ["kind"]);
        return { kind };
    }
    if (kind === "truncated") {
        assertExactKeys(field, ["capturedBytes", "kind", "originalBytes"]);
        const capturedBytes = readSequence(field, "capturedBytes");
        const originalBytes = readSequence(field, "originalBytes");
        if (capturedBytes > originalBytes) {
            throw new ProtocolMessageError("Invalid truncated activity detail size");
        }
        return { capturedBytes, kind, originalBytes };
    }
    if (kind === "recorded") {
        assertExactKeys(field, ["content", "input", "kind", "output"]);
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

function readIdentifier(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = readString(value, key, 128);
    if (!IDENTIFIER_PATTERN.test(field)) {
        throw new ProtocolMessageError(`Invalid identifier field: ${key}`);
    }
    return field;
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
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index-signature access here.
    if (value["kind"] !== expectedKind) {
        throw new ProtocolMessageError(`Expected message kind: ${expectedKind}`);
    }
}

export function decodeMessageKind(encoded: string): string {
    return readString(parseJson(encoded), "kind", 64);
}

export function decodeSessionPromptCommand(encoded: string): SessionPromptCommand {
    const value = parseJson(encoded);
    assertExactKeys(value, [
        "additionalDirectoryIds",
        "agentId",
        "bindingId",
        "commandId",
        "directoryId",
        "images",
        "kind",
        "prompt",
        "resources",
        "sessionId",
    ]);
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

    return {
        additionalDirectoryIds: readDirectoryIdentifiers(value, "additionalDirectoryIds", 16),
        agentId: readIdentifier(value, "agentId"),
        bindingId: readIdentifier(value, "bindingId"),
        commandId: readIdentifier(value, "commandId"),
        directoryId: readDirectoryIdentifier(value, "directoryId"),
        images,
        kind: SESSION_PROMPT_KIND,
        prompt,
        resources,
        sessionId: readIdentifier(value, "sessionId"),
    };
}

export function decodeSessionCancelCommand(encoded: string): SessionCancelCommand {
    const value = parseJson(encoded);
    assertExactKeys(value, ["commandId", "kind", "sessionId"]);
    assertKind(value, SESSION_CANCEL_KIND);

    return {
        commandId: readIdentifier(value, "commandId"),
        kind: SESSION_CANCEL_KIND,
        sessionId: readIdentifier(value, "sessionId"),
    };
}

export function decodeRuntimeStatusEvent(encoded: string): RuntimeStatusEvent {
    const value = parseJson(encoded);
    assertExactKeys(value, ["kind", "online", "runtimeId"]);
    assertKind(value, RUNTIME_STATUS_KIND);

    return {
        kind: RUNTIME_STATUS_KIND,
        online: readBoolean(value, "online"),
        runtimeId: readIdentifier(value, "runtimeId"),
    };
}

export function decodeRuntimeLivenessReadyEvent(encoded: string): RuntimeLivenessReadyEvent {
    const value = parseJson(encoded);
    assertExactKeys(value, ["kind"]);
    assertKind(value, RUNTIME_LIVENESS_READY_KIND);

    return { kind: RUNTIME_LIVENESS_READY_KIND };
}

export function decodeRuntimeHeartbeatEvent(encoded: string): RuntimeHeartbeatEvent {
    const value = parseJson(encoded);
    assertExactKeys(value, ["heartbeatId", "kind"]);
    assertKind(value, RUNTIME_HEARTBEAT_KIND);

    return {
        heartbeatId: readIdentifier(value, "heartbeatId"),
        kind: RUNTIME_HEARTBEAT_KIND,
    };
}

export function decodeRuntimeHeartbeatAckEvent(encoded: string): RuntimeHeartbeatAckEvent {
    const value = parseJson(encoded);
    assertExactKeys(value, ["heartbeatId", "kind"]);
    assertKind(value, RUNTIME_HEARTBEAT_ACK_KIND);

    return {
        heartbeatId: readIdentifier(value, "heartbeatId"),
        kind: RUNTIME_HEARTBEAT_ACK_KIND,
    };
}

export function decodeSessionStartedEvent(encoded: string): SessionStartedEvent {
    const value = parseJson(encoded);
    assertExactKeys(value, ["commandId", "kind", "attemptId", "sessionId"]);
    assertKind(value, SESSION_STARTED_KIND);

    return {
        commandId: readIdentifier(value, "commandId"),
        kind: SESSION_STARTED_KIND,
        attemptId: readIdentifier(value, "attemptId"),
        sessionId: readIdentifier(value, "sessionId"),
    };
}

export function decodeAgentMessageDeltaEvent(encoded: string): AgentMessageDeltaEvent {
    const value = parseJson(encoded);
    assertExactKeys(value, ["commandId", "kind", "sessionId", "text"]);
    assertKind(value, AGENT_MESSAGE_DELTA_KIND);

    return {
        commandId: readIdentifier(value, "commandId"),
        kind: AGENT_MESSAGE_DELTA_KIND,
        sessionId: readIdentifier(value, "sessionId"),
        text: readString(value, "text", MAX_EVENT_TEXT_LENGTH),
    };
}

export function decodeAgentActivityEvent(encoded: string): AgentActivityEvent {
    const value = parseJson(encoded);
    assertExactKeys(value, [
        "activityId",
        "activityType",
        "commandId",
        "content",
        "detail",
        "input",
        "kind",
        "locations",
        "name",
        "output",
        "sequence",
        "sessionId",
        "status",
        "title",
        "toolKind",
    ]);
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
    assertExactKeys(value, ["commandId", "kind", "sessionId", "stopReason"]);
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
    assertExactKeys(value, ["code", "commandId", "kind", "message", "sessionId"]);
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

export function encodeSessionStartedEvent(message: SessionStartedEvent): string {
    return JSON.stringify(decodeSessionStartedEvent(JSON.stringify(message)));
}

export function encodeAgentMessageDeltaEvent(message: AgentMessageDeltaEvent): string {
    return JSON.stringify(decodeAgentMessageDeltaEvent(JSON.stringify(message)));
}

export function encodeAgentActivityEvent(message: AgentActivityEvent): string {
    return JSON.stringify(decodeAgentActivityEvent(JSON.stringify(message)));
}

export function encodeSessionCompletedEvent(message: SessionCompletedEvent): string {
    return JSON.stringify(decodeSessionCompletedEvent(JSON.stringify(message)));
}

export function encodeSessionFailedEvent(message: SessionFailedEvent): string {
    return JSON.stringify(decodeSessionFailedEvent(JSON.stringify(message)));
}
