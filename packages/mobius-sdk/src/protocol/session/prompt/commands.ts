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

export const SessionPromptDisposition = Object.freeze({
    Queue: "queue",
    Reject: "reject",
    Steer: "steer",
});

const MAX_PROMPT_LENGTH = 100_000;
export const MAX_PROMPT_ATTACHMENT_LENGTH = 6_000_000;

export interface SessionPromptCommand {
    readonly additionalDirectoryIds: readonly string[];
    readonly agentId: string;
    readonly bindingId: string;
    readonly commandId: string;
    readonly directoryId: string;
    readonly disposition: string;
    readonly images: readonly PromptImage[];
    readonly kind: typeof SESSION_PROMPT_KIND;
    readonly prompt: string;
    readonly resources: readonly PromptResource[];
    readonly sessionConfigurations?: readonly SessionConfigurationSelection[];
    readonly sessionId: string;
    readonly targetCommandId: string;
}

export interface SessionCancelCommand {
    readonly commandId: string;
    readonly kind: typeof SESSION_CANCEL_KIND;
    readonly sessionId: string;
}

export interface SessionPromptDispositionCommand {
    readonly commandId: string;
    readonly disposition: typeof SessionPromptDisposition.Steer;
    readonly kind: typeof SESSION_PROMPT_DISPOSITION_KIND;
    readonly sessionId: string;
}

export const promptImageSchema = z
    .object({
        data: z.string().min(1).max(4_000_000),
        mimeType: z.string().min(1).max(255),
        name: z.string().min(1).max(500),
    })
    .readonly();

export type PromptImage = z.infer<typeof promptImageSchema>;

const promptResourceSchema = z
    .object({
        mimeType: z.string().max(255),
        name: z.string().min(1).max(500),
        text: z.string().max(1_000_000),
        type: z.enum(["embedded", "link"]),
        uri: z.string().min(1).max(4_096),
    })
    .readonly();

export type PromptResource = z.infer<typeof promptResourceSchema>;

export const decodePromptImagesValue = (value: unknown): readonly PromptImage[] =>
    decodeZodValue(value, z.array(promptImageSchema).max(8).readonly());

export const decodePromptResourcesValue = (value: unknown): readonly PromptResource[] =>
    decodeZodValue(value, z.array(promptResourceSchema).max(16).readonly());

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

export function encodeSessionPromptCommand(message: SessionPromptCommand): string {
    return JSON.stringify(decodeSessionPromptCommand(JSON.stringify(message)));
}

export function encodeSessionCancelCommand(message: SessionCancelCommand): string {
    return JSON.stringify(decodeSessionCancelCommand(JSON.stringify(message)));
}

export function encodeSessionPromptDispositionCommand(message: SessionPromptDispositionCommand): string {
    return JSON.stringify(decodeSessionPromptDispositionCommand(JSON.stringify(message)));
}
