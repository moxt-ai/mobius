import { z } from "zod";

import { isIdentifier } from "../../shared/identifier.ts";
import {
    assertKind,
    decodeZodValue,
    ProtocolMessageError,
    parseJson,
    readDirectoryIdentifier,
    readDirectoryIdentifiers,
    readIdentifier,
    readText,
} from "../../shared/message-codec.ts";
import type { SessionConfigurationSelection } from "../configuration/index.ts";
import { decodeSessionConfigurationSelections } from "../configuration/index.ts";

export const SESSION_PROMPT_KIND = "session.prompt";
export const SESSION_PROMPT_DISPOSITION_KIND = "session.prompt.disposition";
export const SESSION_CANCEL_KIND = "session.cancel";
export const SESSION_CANCEL_BEFORE_START_KIND = "session.cancel-before-start";

export const SessionPromptDisposition = Object.freeze({
    Queue: "queue",
    Reject: "reject",
    Steer: "steer",
});

/** Controls whether starting a prompt may ask the native Agent to replay history. */
export const SessionHistoryPolicy = Object.freeze({
    Eager: "eager",
    ExecutionOnly: "execution-only",
} as const);

export type SessionHistoryPolicy = (typeof SessionHistoryPolicy)[keyof typeof SessionHistoryPolicy];

const MAX_PROMPT_LENGTH = 100_000;
export const MAX_PROMPT_ATTACHMENT_BYTES = 32 * 1024 * 1024;

export interface SessionPromptCommand {
    readonly additionalDirectoryIds: readonly string[];
    readonly agentId: string;
    readonly bindingId: string;
    readonly commandId: string;
    readonly directoryId: string;
    readonly disposition: string;
    readonly attachments: readonly PromptAttachment[];
    readonly historyPolicy?: SessionHistoryPolicy;
    readonly kind: typeof SESSION_PROMPT_KIND;
    readonly prompt: string;
    readonly sessionConfigurations?: readonly SessionConfigurationSelection[];
    readonly sessionId: string;
    readonly targetCommandId: string;
}

export interface SessionCancelCommand {
    readonly commandId: string;
    readonly kind: typeof SESSION_CANCEL_KIND;
    readonly sessionId: string;
}

/** Cancels only work that has not started; it must never degrade into cancellation of running work. */
export interface SessionCancelBeforeStartCommand {
    readonly commandId: string;
    readonly kind: typeof SESSION_CANCEL_BEFORE_START_KIND;
    readonly sessionId: string;
}

export function decodeSessionCancelBeforeStartCommand(encoded: string): SessionCancelBeforeStartCommand {
    const value = parseJson(encoded);
    assertKind(value, SESSION_CANCEL_BEFORE_START_KIND);
    return {
        commandId: readIdentifier(value, "commandId"),
        kind: SESSION_CANCEL_BEFORE_START_KIND,
        sessionId: readIdentifier(value, "sessionId"),
    };
}

export const encodeSessionCancelBeforeStartCommand = (message: SessionCancelBeforeStartCommand): string =>
    JSON.stringify(decodeSessionCancelBeforeStartCommand(JSON.stringify(message)));

export interface SessionPromptDispositionCommand {
    readonly commandId: string;
    readonly disposition: typeof SessionPromptDisposition.Steer;
    readonly kind: typeof SESSION_PROMPT_DISPOSITION_KIND;
    readonly sessionId: string;
}

export const promptAttachmentSchema = z
    .object({
        byteLength: z.number().int().positive().max(MAX_PROMPT_ATTACHMENT_BYTES),
        contentKey: z.string().regex(/^[a-f0-9]{64}$/u),
        kind: z.enum(["image", "resource"]),
        mimeType: z.string().min(1).max(255),
        name: z.string().min(1).max(500),
        uri: z.string().min(1).max(4_096),
    })
    .readonly();

export type PromptAttachment = z.infer<typeof promptAttachmentSchema>;

export const decodePromptAttachment = (value: unknown): PromptAttachment =>
    decodeZodValue(value, promptAttachmentSchema);
export const decodePromptAttachmentsValue = (value: unknown): readonly PromptAttachment[] =>
    decodeZodValue(value, z.array(promptAttachmentSchema).max(16).readonly());

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

export function decodeSessionPromptCommand(encoded: string): SessionPromptCommand {
    const value = parseJson(encoded);
    const hasSessionConfigurations = Object.hasOwn(value, "sessionConfigurations");
    assertKind(value, SESSION_PROMPT_KIND);

    const prompt = readText(value, "prompt", MAX_PROMPT_LENGTH);
    const attachments = decodePromptAttachmentsValue(value["attachments"]);
    const attachmentBytes = attachments.reduce((total, attachment) => total + attachment.byteLength, 0);
    if (attachmentBytes > MAX_PROMPT_ATTACHMENT_BYTES) {
        throw new ProtocolMessageError("Prompt attachments are too large");
    }
    if (prompt.trim().length === 0 && attachments.length === 0) {
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
        attachments,
        ...(value["historyPolicy"] === undefined
            ? {}
            : {
                  historyPolicy: readHistoryPolicy(value),
              }),
        kind: SESSION_PROMPT_KIND,
        prompt,
        ...(hasSessionConfigurations ? { sessionConfigurations } : {}),
        sessionId: readIdentifier(value, "sessionId"),
        targetCommandId,
    };
}

function readHistoryPolicy(value: Readonly<Record<string, unknown>>): SessionHistoryPolicy {
    const field = value["historyPolicy"];
    if (field === SessionHistoryPolicy.Eager || field === SessionHistoryPolicy.ExecutionOnly) {
        return field;
    }
    throw new ProtocolMessageError("Invalid value field: historyPolicy");
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

export function encodeSessionPromptCommand(message: SessionPromptCommand): string {
    return JSON.stringify(decodeSessionPromptCommand(JSON.stringify(message)));
}

export function encodeSessionCancelCommand(message: SessionCancelCommand): string {
    return JSON.stringify(decodeSessionCancelCommand(JSON.stringify(message)));
}

export function encodeSessionPromptDispositionCommand(message: SessionPromptDispositionCommand): string {
    return JSON.stringify(decodeSessionPromptDispositionCommand(JSON.stringify(message)));
}
