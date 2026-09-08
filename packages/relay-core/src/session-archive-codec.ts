import { isRecord } from "./session-codec.ts";
import { SessionRuntimeError } from "./session-runtime.ts";
export const ARCHIVE_SEGMENT_INPUT_BYTE_LIMIT = 128 * 1024;
export const ARCHIVE_SEGMENT_BYTE_LIMIT = 192 * 1024;
export interface StoredArchiveChunk {
    readonly artifactId: string;
    readonly byteLength: number;
    readonly sha256: string;
    readonly storedByteLength: number;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function gzip(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    const stream = new Blob([Uint8Array.from(bytes).buffer]).stream().pipeThrough(new CompressionStream("gzip"));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    signal.throwIfAborted();
    return compressed;
}

export async function gunzip(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    const stream = new Blob([Uint8Array.from(bytes).buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    const uncompressed = new Uint8Array(await new Response(stream).arrayBuffer());
    signal.throwIfAborted();
    return uncompressed;
}

export function encodeBase64(bytes: Uint8Array): string {
    let encoded = "";
    for (let offset = 0; offset < bytes.length; offset += 16_384) {
        encoded += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
    }
    return btoa(encoded);
}

export function decodeBase64(encoded: string): Uint8Array {
    const binary = atob(encoded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function parseSegments(encoded: string): readonly StoredArchiveChunk[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new SessionRuntimeError("session_storage_unavailable", "The archive manifest is invalid", { cause });
    }
    if (!Array.isArray(value)) {
        throw new SessionRuntimeError("session_storage_unavailable", "The archive manifest is invalid");
    }
    return value.map((entry) => {
        if (!isRecord(entry)) {
            throw new SessionRuntimeError("session_storage_unavailable", "The archive manifest is invalid");
        }
        const artifactId = entry["artifactId"];
        const byteLength = entry["byteLength"];
        const digest = entry["sha256"];
        const storedByteLength = entry["storedByteLength"];
        if (
            typeof artifactId !== "string" ||
            typeof byteLength !== "number" ||
            !Number.isSafeInteger(byteLength) ||
            byteLength < 0 ||
            typeof storedByteLength !== "number" ||
            !Number.isSafeInteger(storedByteLength) ||
            storedByteLength < 0 ||
            storedByteLength > ARCHIVE_SEGMENT_BYTE_LIMIT ||
            typeof digest !== "string" ||
            !/^[a-f0-9]{64}$/.test(digest)
        ) {
            throw new SessionRuntimeError("session_storage_unavailable", "The archive manifest is invalid");
        }
        return { artifactId, byteLength, sha256: digest, storedByteLength };
    });
}
