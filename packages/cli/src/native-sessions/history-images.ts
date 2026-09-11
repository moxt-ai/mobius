import {
    type NativeHistoryImage,
    type NativeHistoryMessage,
    type NativeSessionHistory,
    parseNativeHistoryText,
    SESSION_HISTORY_IMAGE_CHARACTER_LIMIT,
} from "@moxt-ai/mobius-protocol";
import { readAuthorizedRaster } from "../authorization/local-raster.ts";

const IMAGE_MARKER = /\[@image\]\(([^)\r\n]*)(?:\)|$)/g;

export async function embedLocalHistoryImages(
    history: NativeSessionHistory,
    roots: readonly string[],
    signal: AbortSignal,
): Promise<NativeSessionHistory> {
    if (history.status !== "available") {
        return history;
    }
    const messages: NativeHistoryMessage[] = [];
    let imageCharacters = 0;
    for (const message of history.messages) {
        signal.throwIfAborted();
        const resolved = await resolveMessageImages(message, roots, imageCharacters, signal);
        imageCharacters += (resolved.images ?? []).reduce((size, image) => size + image.data.length, 0);
        messages.push(resolved);
    }
    return {
        ...history,
        messages,
    };
}

async function resolveMessageImages(
    message: NativeHistoryMessage,
    roots: readonly string[],
    usedCharacters: number,
    signal: AbortSignal,
): Promise<NativeHistoryMessage> {
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
        const local = await readAuthorizedRaster(uri, roots, signal);
        if (local === null) {
            return "[Image unavailable]";
        }
        const data = local.base64();
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
