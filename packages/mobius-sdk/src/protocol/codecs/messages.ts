import {
    decodePromptImagesValue,
    decodePromptResourcesValue,
    decodeSessionConfigurationSelections,
} from "../control-messages.ts";
import { decodeIdentifier, type Identifier, isIdentifier } from "../identifier.ts";
import {
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
    SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_PROMPT_KIND,
    type SessionCancelCommand,
    type SessionPromptCommand,
    SessionPromptDisposition,
    type SessionPromptDispositionCommand,
} from "../messages.ts";

const DIRECTORY_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/;
const MAX_PROMPT_LENGTH = 100_000;
export const MAX_PROMPT_ATTACHMENT_LENGTH = 6_000_000;

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

export function encodeSessionPromptCommand(message: SessionPromptCommand): string {
    return JSON.stringify(decodeSessionPromptCommand(JSON.stringify(message)));
}

export function encodeSessionCancelCommand(message: SessionCancelCommand): string {
    return JSON.stringify(decodeSessionCancelCommand(JSON.stringify(message)));
}

export function encodeSessionPromptDispositionCommand(message: SessionPromptDispositionCommand): string {
    return JSON.stringify(decodeSessionPromptDispositionCommand(JSON.stringify(message)));
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
