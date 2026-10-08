import type { ContentBlock, SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import type { ExternalContentStore } from "./local-external-content-store.ts";

const MAXIMUM_ENCODED_CONTENT_CHARACTERS = 4_000_000;

function decodeBase64(data: string): Uint8Array {
    if (
        data.length > MAXIMUM_ENCODED_CONTENT_CHARACTERS ||
        data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)
    ) {
        throw new Error("The ACP embedded content is not valid bounded base64");
    }
    return Buffer.from(data, "base64");
}

export class AcpContentExternalizer {
    readonly #store: ExternalContentStore;

    constructor(store: ExternalContentStore) {
        this.#store = store;
    }

    async #content(sessionId: string, content: ContentBlock, signal: AbortSignal): Promise<unknown> {
        switch (content.type) {
            case "text":
            case "resource_link":
                return content;
            case "image": {
                if (content.data.length === 0) {
                    return content;
                }
                const stored = await this.#store.put({
                    bytes: decodeBase64(content.data),
                    kind: "image",
                    mediaType: content.mimeType,
                    name: "image",
                    sessionId,
                    signal,
                });
                return {
                    _meta: content._meta,
                    annotations: content.annotations,
                    byteLength: stored.byteLength,
                    imageKey: stored.key,
                    mimeType: content.mimeType,
                    type: "external_image",
                    uri: content.uri,
                };
            }
            case "audio": {
                if (content.data.length === 0) {
                    return content;
                }
                const stored = await this.#store.put({
                    bytes: decodeBase64(content.data),
                    kind: "audio",
                    mediaType: content.mimeType,
                    name: "audio",
                    sessionId,
                    signal,
                });
                return {
                    _meta: content._meta,
                    annotations: content.annotations,
                    audioKey: stored.key,
                    byteLength: stored.byteLength,
                    mimeType: content.mimeType,
                    type: "external_audio",
                };
            }
            case "resource": {
                const embedded = content.resource;
                const encoding = "text" in embedded ? "text" : "binary";
                const bytes = "text" in embedded ? Buffer.from(embedded.text, "utf8") : decodeBase64(embedded.blob);
                if (bytes.byteLength === 0) {
                    return content;
                }
                const mediaType = embedded.mimeType ?? "application/octet-stream";
                const stored = await this.#store.put({
                    bytes,
                    kind: "resource",
                    mediaType,
                    name: "resource",
                    sessionId,
                    signal,
                });
                return {
                    _meta: content._meta,
                    annotations: content.annotations,
                    byteLength: stored.byteLength,
                    encoding,
                    mimeType: embedded.mimeType,
                    resourceKey: stored.key,
                    type: "external_resource",
                    uri: embedded.uri,
                };
            }
        }
    }

    async #toolContent(sessionId: string, item: ToolCallContent, signal: AbortSignal): Promise<unknown> {
        return item.type === "content"
            ? { ...item, content: await this.#content(sessionId, item.content, signal) }
            : item;
    }

    readonly update = async (sessionId: string, update: SessionUpdate, signal: AbortSignal): Promise<unknown> => {
        switch (update.sessionUpdate) {
            case "user_message_chunk":
            case "agent_message_chunk":
            case "agent_thought_chunk":
            case "compaction_summary_chunk":
                return { ...update, content: await this.#content(sessionId, update.content, signal) };
            case "tool_call":
            case "tool_call_update":
                return update.content === undefined || update.content === null
                    ? update
                    : {
                          ...update,
                          content: await Promise.all(
                              update.content.map(async (item) => await this.#toolContent(sessionId, item, signal)),
                          ),
                      };
            case "compaction_update":
                return update.summary === undefined || update.summary === null
                    ? update
                    : {
                          ...update,
                          summary: await Promise.all(
                              update.summary.map(async (content) => await this.#content(sessionId, content, signal)),
                          ),
                      };
            case "plan":
            case "plan_update":
            case "plan_removed":
            case "available_commands_update":
            case "current_mode_update":
            case "config_option_update":
            case "session_info_update":
            case "usage_update":
                return update;
        }
    };
}
