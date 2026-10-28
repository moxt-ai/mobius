import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { SessionCapabilities } from "@moxt-ai/mobius-sdk/protocol";
import { AcpExecutionError } from "../acp-error.ts";

/** One image attachment of a prompt, as the ACP content block will carry it. */
export interface PromptImageInput {
    readonly data: string;
    readonly mimeType: string;
    readonly name: string;
    readonly uri: string;
}

/** One resource attachment of a prompt: embedded text, a binary document, or a link. */
export type PromptResourceInput =
    | { readonly type: "embedded"; readonly mimeType: string; readonly text: string; readonly uri: string }
    | {
          readonly data: string;
          readonly mimeType: string;
          readonly name: string;
          /** Workspace path where the document bytes were saved for the Agent. */
          readonly savedPath?: string;
          readonly type: "blob";
          readonly uri: string;
      }
    | { readonly type: "link"; readonly mimeType: string; readonly name: string; readonly uri: string };

/** The prompt inputs that become ACP content blocks. */
export interface PromptContent {
    readonly images: readonly PromptImageInput[];
    readonly prompt: string;
    readonly resources: readonly PromptResourceInput[];
}

/**
 * Builds the ACP content blocks of a prompt: text, images, and linked or embedded resources.
 * Capability gates reject what the selected Agent cannot accept before anything is sent.
 */
function deliversEmbeddedContext(resource: PromptResourceInput): boolean {
    return resource.type === "embedded" || resource.type === "blob";
}

export function validatePromptContent(options: PromptContent, capabilities: SessionCapabilities): void {
    if (options.images.length > 0 && !capabilities.imagePrompt) {
        throw new AcpExecutionError(
            "The selected agent does not accept image prompts",
            {},
            "unsupported_prompt_content",
        );
    }
    if (options.resources.some(deliversEmbeddedContext) && !capabilities.embeddedContextPrompt) {
        throw new AcpExecutionError(
            "The selected agent does not accept embedded context",
            {},
            "unsupported_prompt_content",
        );
    }
    if (options.prompt.length === 0 && options.images.length === 0 && options.resources.length === 0) {
        throw new AcpExecutionError("A prompt must contain text or an attachment", {}, "empty_prompt");
    }
}

export function buildPromptContent(options: PromptContent, capabilities: SessionCapabilities): ContentBlock[] {
    validatePromptContent(options, capabilities);
    const prompt: ContentBlock[] = [];
    if (options.prompt.length > 0) {
        prompt.push({ text: options.prompt, type: "text" });
    }
    for (const image of options.images) {
        prompt.push({
            _meta: { mobius: { name: image.name } },
            data: image.data,
            mimeType: image.mimeType,
            type: "image",
        });
    }
    for (const resource of options.resources) {
        switch (resource.type) {
            case "embedded":
                prompt.push({
                    resource: {
                        mimeType: resource.mimeType,
                        text: resource.text,
                        uri: resource.uri,
                    },
                    type: "resource",
                });
                break;
            case "blob":
                prompt.push({
                    ...(resource.savedPath === undefined
                        ? {}
                        : { _meta: { mobius: { savedPath: resource.savedPath } } }),
                    resource: {
                        blob: resource.data,
                        mimeType: resource.mimeType,
                        uri: resource.uri,
                    },
                    type: "resource",
                });
                break;
            case "link":
                prompt.push({
                    mimeType: resource.mimeType,
                    name: resource.name,
                    type: "resource_link",
                    uri: resource.uri,
                });
                break;
            default: {
                const unexpected: never = resource;
                throw new AcpExecutionError(
                    "A prompt attachment has an unknown kind",
                    { cause: unexpected },
                    "unsupported_prompt_content",
                );
            }
        }
    }
    return prompt;
}
