import type { ContentBlock, SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { sniffRasterMime } from "../authorization/local-raster.ts";
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
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data) {
        throw new Error("The ACP embedded content is not canonical base64");
    }
    return bytes;
}

interface PreparedContent {
    readonly agent: ContentBlock;
    readonly event: unknown;
}

export interface PreparedAcpUpdate {
    readonly agent: SessionUpdate;
    readonly event: unknown;
}

const embeddedImageSchema = z.looseObject({
    type: z.literal("image"),
    data: z.string(),
    mimeType: z.string(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AcpContentExternalizer {
    readonly #store: ExternalContentStore;

    constructor(store: ExternalContentStore) {
        this.#store = store;
    }

    async #content(sessionId: string, content: ContentBlock, signal: AbortSignal): Promise<PreparedContent> {
        switch (content.type) {
            case "text":
            case "resource_link":
                return { agent: content, event: content };
            case "image": {
                if (content.data.length === 0) {
                    return { agent: content, event: content };
                }
                try {
                    const bytes = decodeBase64(content.data);
                    if (sniffRasterMime(bytes) !== content.mimeType) {
                        throw new Error("Embedded image bytes do not match a supported image MIME type");
                    }
                    const stored = await this.#store.put({
                        bytes,
                        kind: "image",
                        mediaType: content.mimeType,
                        name: "image",
                        sessionId,
                        signal,
                    });
                    return {
                        agent: { ...content, data: "", uri: `mobius-content:image:${stored.key}` },
                        event: {
                            _meta: content._meta,
                            annotations: content.annotations,
                            byteLength: stored.byteLength,
                            imageKey: stored.key,
                            mimeType: content.mimeType,
                            type: "external_image",
                            uri: content.uri,
                        },
                    };
                } catch {
                    signal.throwIfAborted();
                    const unavailable: ContentBlock = { type: "text", text: "[Image unavailable]" };
                    return { agent: unavailable, event: unavailable };
                }
            }
            case "audio": {
                if (content.data.length === 0) {
                    return { agent: content, event: content };
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
                    agent: content,
                    event: {
                        _meta: content._meta,
                        annotations: content.annotations,
                        audioKey: stored.key,
                        byteLength: stored.byteLength,
                        mimeType: content.mimeType,
                        type: "external_audio",
                    },
                };
            }
            case "resource": {
                const embedded = content.resource;
                const encoding = "text" in embedded ? "text" : "binary";
                const bytes = "text" in embedded ? Buffer.from(embedded.text, "utf8") : decodeBase64(embedded.blob);
                if (bytes.byteLength === 0) {
                    return { agent: content, event: content };
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
                    agent: content,
                    event: {
                        _meta: content._meta,
                        annotations: content.annotations,
                        byteLength: stored.byteLength,
                        encoding,
                        mimeType: embedded.mimeType,
                        resourceKey: stored.key,
                        type: "external_resource",
                        uri: embedded.uri,
                    },
                };
            }
        }
    }

    async #rawOutput(
        sessionId: string,
        value: unknown,
        images: Map<string, PreparedContent>,
        signal: AbortSignal,
        depth = 0,
    ): Promise<unknown> {
        signal.throwIfAborted();
        if (depth > 16) {
            throw new Error("ACP tool output exceeds the maximum nesting depth");
        }
        if (Array.isArray(value)) {
            const result: unknown[] = [];
            for (const item of value) {
                result.push(await this.#rawOutput(sessionId, item, images, signal, depth + 1));
            }
            return result;
        }
        if (!isRecord(value)) {
            return value;
        }
        const image = embeddedImageSchema.safeParse(value);
        if (image.success && image.data.data.length > 0) {
            const prepared = await this.#content(sessionId, image.data, signal);
            if (isRecord(prepared.event) && typeof prepared.event["imageKey"] === "string") {
                images.set(prepared.event["imageKey"], prepared);
            } else {
                images.set(`unavailable:${images.size}`, prepared);
            }
            // Replace the image object itself: retaining `data` here duplicates it in
            // tool JSON even when the visible ACP content already uses a reference.
            return prepared.event;
        }
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            result[key] = await this.#rawOutput(sessionId, item, images, signal, depth + 1);
        }
        return result;
    }

    async #toolUpdate(
        sessionId: string,
        update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
        signal: AbortSignal,
    ): Promise<PreparedAcpUpdate> {
        const images = new Map<string, PreparedContent>();
        const rawOutput =
            update.rawOutput === undefined
                ? undefined
                : await this.#rawOutput(sessionId, update.rawOutput, images, signal);
        const originalJson = images.size === 0 ? undefined : JSON.stringify(update.rawOutput);
        const rewrittenJson = images.size === 0 ? undefined : JSON.stringify(rawOutput);
        const agentContent: ToolCallContent[] = [];
        const eventContent: unknown[] = [];
        for (const item of update.content ?? []) {
            if (item.type !== "content") {
                agentContent.push(item);
                eventContent.push(item);
                continue;
            }
            const content =
                item.content.type === "text" && item.content.text === originalJson && rewrittenJson !== undefined
                    ? { ...item.content, text: rewrittenJson }
                    : item.content;
            const prepared = await this.#content(sessionId, content, signal);
            agentContent.push({ ...item, content: prepared.agent });
            eventContent.push({ ...item, content: prepared.event });
            if (isRecord(prepared.event) && typeof prepared.event["imageKey"] === "string") {
                images.delete(prepared.event["imageKey"]);
            }
        }
        for (const prepared of images.values()) {
            agentContent.push({ type: "content", content: prepared.agent });
            eventContent.push({ type: "content", content: prepared.event });
        }
        const output = update.rawOutput === undefined ? {} : { rawOutput };
        const hasContent = (update.content !== undefined && update.content !== null) || agentContent.length > 0;
        return {
            agent: { ...update, ...output, ...(hasContent ? { content: agentContent } : {}) },
            event: { ...update, ...output, ...(hasContent ? { content: eventContent } : {}) },
        };
    }

    readonly update = async (
        sessionId: string,
        update: SessionUpdate,
        signal: AbortSignal,
    ): Promise<PreparedAcpUpdate> => {
        switch (update.sessionUpdate) {
            case "user_message_chunk":
            case "agent_message_chunk":
            case "agent_thought_chunk":
            case "compaction_summary_chunk": {
                const content = await this.#content(sessionId, update.content, signal);
                return {
                    agent: { ...update, content: content.agent },
                    event: { ...update, content: content.event },
                };
            }
            case "tool_call":
            case "tool_call_update":
                return await this.#toolUpdate(sessionId, update, signal);
            case "compaction_update": {
                if (update.summary === undefined || update.summary === null) {
                    return { agent: update, event: update };
                }
                const content = await Promise.all(
                    update.summary.map(async (item) => await this.#content(sessionId, item, signal)),
                );
                return {
                    agent: { ...update, summary: content.map((item) => item.agent) },
                    event: { ...update, summary: content.map((item) => item.event) },
                };
            }
            case "plan":
            case "plan_update":
            case "plan_removed":
            case "available_commands_update":
            case "current_mode_update":
            case "config_option_update":
            case "session_info_update":
            case "usage_update":
                return { agent: update, event: update };
        }
    };
}
