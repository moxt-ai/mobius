import type { AgentDisplayContent, NativeHistoryImage } from "@moxt-ai/mobius-protocol";
import { parseNativeHistoryText, SESSION_HISTORY_IMAGE_CHARACTER_LIMIT } from "@moxt-ai/mobius-protocol";
import { readLocalRaster } from "../acp/resource/local-raster.ts";

const IMAGE_MARKER = /\[@image\]\(([^)\r\n]*)(?:\)|$)/g;

/**
 * Internal materialized history model for direct native reads. It exists only to
 * bound saved Agent threads before they are converted into V2 session events;
 * it is not a protocol contract.
 */
export interface NativeHistoryMessage {
    readonly role: "user";
    readonly text: string;
    readonly images?: readonly NativeHistoryImage[];
}

export interface NativeAssistantHistoryMessage {
    readonly activities: readonly NativeHistoryActivity[];
    readonly content: readonly AgentDisplayContent[];
    readonly role: "assistant";
    /** Absent when the source Agent does not report a terminal outcome. */
    readonly outcome?: "succeeded" | "cancelled" | "failed";
    readonly text: string;
    readonly images?: readonly NativeHistoryImage[];
}

export interface NativeHistoryActivity {
    readonly activityId: string;
    readonly activityType: string;
    readonly content: readonly AgentDisplayContent[];
    readonly input: string;
    readonly locations: readonly string[];
    readonly name: string;
    readonly output: string;
    readonly sequence: number;
    readonly status: string;
    readonly title: string;
    readonly toolKind: string;
}

export type NativeHistoryTimelineMessage = NativeHistoryMessage | NativeAssistantHistoryMessage;

export type NativeHistoryEntry =
    | {
          readonly status: "available";
          readonly messages: readonly (NativeHistoryMessage | NativeAssistantHistoryMessage)[];
          readonly truncated: boolean;
          /** Commands whose native turns are covered by this read; consumed by turn bookkeeping. */
          readonly coveredCommandIds?: readonly string[];
          readonly coveredMessageIds?: readonly string[];
      }
    | { readonly status: "unavailable"; readonly cause: { readonly code: string; readonly message: string } };

export async function embedLocalHistoryImages(
    history: NativeHistoryEntry,
    signal: AbortSignal,
): Promise<NativeHistoryEntry> {
    if (history.status !== "available") {
        return history;
    }
    const messages: (NativeHistoryMessage | NativeAssistantHistoryMessage)[] = [];
    let imageCharacters = 0;
    for (const message of history.messages) {
        signal.throwIfAborted();
        const resolved = await resolveMessageImages(message, imageCharacters, signal);
        imageCharacters += (resolved.images ?? []).reduce((size, image) => size + image.data.length, 0);
        messages.push(resolved);
    }
    return {
        ...history,
        messages,
    };
}

async function resolveMessageImages(
    message: NativeHistoryMessage | NativeAssistantHistoryMessage,
    usedCharacters: number,
    signal: AbortSignal,
): Promise<NativeHistoryMessage | NativeAssistantHistoryMessage> {
    const images: NativeHistoryImage[] = [...(message.images ?? [])];
    let imageCharacters = images.reduce((size, image) => size + image.data.length, 0);
    const text = await replaceImageMarkers(message.text, async (uri) => {
        if (images.length >= 8 || usedCharacters + imageCharacters >= SESSION_HISTORY_IMAGE_CHARACTER_LIMIT) {
            return "[Image unavailable]";
        }
        const embedded = parseNativeHistoryText(`[@image](${uri})`).images[0];
        if (embedded !== undefined) {
            if (usedCharacters + imageCharacters + embedded.data.length > SESSION_HISTORY_IMAGE_CHARACTER_LIMIT) {
                return "[Image unavailable]";
            }
            images.push(embedded);
            imageCharacters += embedded.data.length;
            return "";
        }
        const local = await readLocalRaster(uri, signal);
        if (local === null) {
            return "[Image unavailable]";
        }
        const data = await local.base64();
        if (usedCharacters + imageCharacters + data.length > SESSION_HISTORY_IMAGE_CHARACTER_LIMIT) {
            return "[Image unavailable]";
        }
        images.push({
            data,
            mimeType: local.mimeType,
            name: local.name,
        });
        imageCharacters += data.length;
        return "";
    });
    return {
        ...message,
        text,
        ...(images.length > 0 ? { images } : {}),
    };
}

async function replaceImageMarkers(text: string, replace: (uri: string) => Promise<string>): Promise<string> {
    const matches = [...text.matchAll(IMAGE_MARKER)];
    if (matches.length === 0) {
        return text;
    }
    let cursor = 0;
    let rewritten = "";
    for (const match of matches) {
        const index = match.index ?? 0;
        rewritten += text.slice(cursor, index);
        rewritten += await replace(match[1] ?? "");
        cursor = index + match[0].length;
    }
    return `${rewritten}${text.slice(cursor)}`;
}
