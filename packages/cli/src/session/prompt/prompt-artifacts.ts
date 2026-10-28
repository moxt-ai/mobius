import { createHash } from "node:crypto";
import {
    isPromptBinaryDocument,
    isPromptSvg,
    isPromptTextMediaType,
    isSvgDocument,
    PROMPT_DOCUMENT_MAX_BYTES,
    PROMPT_IMAGE_MAX_BYTES,
    PROMPT_TEXT_RESOURCE_MAX_BYTES,
    type PromptAttachment,
} from "@moxt-ai/mobius-sdk/protocol";
import type { PromptImageInput, PromptResourceInput } from "../../acp/client/prompt-content.ts";
import { OperationError } from "../../infra/operation-error.ts";

export class PromptArtifactError extends OperationError {
    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(code, message, options);
        this.name = "PromptArtifactError";
    }
}

export class ResolvedPromptArtifacts {
    readonly images: readonly PromptImageInput[];
    readonly resources: readonly PromptResourceInput[];

    constructor(images: readonly PromptImageInput[], resources: readonly PromptResourceInput[]) {
        this.images = images;
        this.resources = resources;
    }
}

export type ReadPromptArtifact = (attachment: PromptAttachment, signal: AbortSignal) => Promise<Uint8Array>;

function decodeUtf8(bytes: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function resolvePromptArtifacts(
    read: ReadPromptArtifact,
    attachments: readonly PromptAttachment[],
    signal: AbortSignal,
): Promise<ResolvedPromptArtifacts> {
    const images: PromptImageInput[] = [];
    const resources: PromptResourceInput[] = [];
    for (const attachment of attachments) {
        signal.throwIfAborted();
        const bytes = await read(attachment, signal);
        if (
            bytes.byteLength !== attachment.byteLength ||
            createHash("sha256").update(bytes).digest("hex") !== attachment.contentKey
        ) {
            throw new PromptArtifactError(
                "artifact_integrity_failed",
                "The prompt attachment failed integrity validation",
            );
        }
        if (attachment.kind === "image") {
            if (isPromptSvg(attachment.mimeType)) {
                if (bytes.byteLength > PROMPT_TEXT_RESOURCE_MAX_BYTES || images.length >= 8) {
                    throw new PromptArtifactError(
                        "artifact_too_large_for_agent",
                        "The prompt attachment exceeds the Agent image limit",
                    );
                }
                let text: string;
                try {
                    text = decodeUtf8(bytes);
                } catch (cause) {
                    throw new PromptArtifactError(
                        "artifact_encoding_invalid",
                        "The prompt attachment is not valid UTF-8 text",
                        { cause },
                    );
                }
                if (!isSvgDocument(text)) {
                    throw new PromptArtifactError(
                        "artifact_media_type_unsupported",
                        "The Agent cannot consume this prompt attachment media type",
                    );
                }
            } else if (bytes.byteLength > PROMPT_IMAGE_MAX_BYTES || images.length >= 8) {
                throw new PromptArtifactError(
                    "artifact_too_large_for_agent",
                    "The prompt attachment exceeds the Agent image limit",
                );
            }
            images.push({
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
                name: attachment.name,
                uri: attachment.uri,
            });
            continue;
        }
        if (isPromptBinaryDocument(attachment.mimeType)) {
            if (bytes.byteLength > PROMPT_DOCUMENT_MAX_BYTES || resources.length >= 16) {
                throw new PromptArtifactError(
                    "artifact_too_large_for_agent",
                    "The prompt attachment exceeds the Agent resource limit",
                );
            }
            resources.push({
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
                name: attachment.name,
                type: "blob",
                uri: attachment.uri,
            });
            continue;
        }
        if (!isPromptTextMediaType(attachment.mimeType)) {
            throw new PromptArtifactError(
                "artifact_media_type_unsupported",
                "The Agent cannot consume this prompt attachment media type",
            );
        }
        if (bytes.byteLength > PROMPT_TEXT_RESOURCE_MAX_BYTES || resources.length >= 16) {
            throw new PromptArtifactError(
                "artifact_too_large_for_agent",
                "The prompt attachment exceeds the Agent resource limit",
            );
        }
        let text: string;
        try {
            text = decodeUtf8(bytes);
        } catch (cause) {
            throw new PromptArtifactError(
                "artifact_encoding_invalid",
                "The prompt attachment is not valid UTF-8 text",
                {
                    cause,
                },
            );
        }
        resources.push({ mimeType: attachment.mimeType, text, type: "embedded", uri: attachment.uri });
    }
    return new ResolvedPromptArtifacts(images, resources);
}
