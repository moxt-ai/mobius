import { open, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LOCAL_RASTER_BYTES = 128 * 1024 * 1024;
const MAX_INLINE_RASTER_BYTES = 3_000_000;
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
const JPEG_SIGNATURE = Uint8Array.of(0xff, 0xd8, 0xff);
const GIF87_SIGNATURE = new TextEncoder().encode("GIF87a");
const GIF89_SIGNATURE = new TextEncoder().encode("GIF89a");
const RIFF_SIGNATURE = new TextEncoder().encode("RIFF");
const WEBP_SIGNATURE = new TextEncoder().encode("WEBP");

export type LocalRasterMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export class LocalRasterImage {
    readonly bytes: Uint8Array | null;
    readonly mimeType: LocalRasterMimeType;
    readonly name: string;
    readonly sourceUri: string;

    constructor(name: string, mimeType: LocalRasterMimeType, bytes: Uint8Array | null, sourceUri = "") {
        this.bytes = bytes;
        this.mimeType = mimeType;
        this.name = name;
        this.sourceUri = sourceUri;
    }

    readonly base64 = async (): Promise<string> => {
        const bytes = this.bytes ?? new Uint8Array(await readFile(this.sourceUri));
        return Buffer.from(bytes).toString("base64");
    };
}

function startsWith(bytes: Uint8Array, signature: Uint8Array, offset = 0): boolean {
    if (bytes.byteLength < offset + signature.byteLength) {
        return false;
    }
    return signature.every((value, index) => bytes[offset + index] === value);
}

function sniffRasterMime(bytes: Uint8Array): LocalRasterMimeType | null {
    if (startsWith(bytes, PNG_SIGNATURE)) {
        return "image/png";
    }
    if (startsWith(bytes, JPEG_SIGNATURE)) {
        return "image/jpeg";
    }
    if (startsWith(bytes, GIF87_SIGNATURE) || startsWith(bytes, GIF89_SIGNATURE)) {
        return "image/gif";
    }
    if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8)) {
        return "image/webp";
    }
    return null;
}

export function readInlineRaster(data: string, name = "Image"): LocalRasterImage | null {
    if (data.length === 0 || data.length > Math.ceil(MAX_INLINE_RASTER_BYTES / 3) * 4 || data.length % 4 !== 0) {
        return null;
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        return null;
    }
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_INLINE_RASTER_BYTES) {
        return null;
    }
    const mimeType = sniffRasterMime(bytes);
    if (mimeType === null) {
        return null;
    }
    return new LocalRasterImage(basename(name) || "Image", mimeType, bytes);
}

async function resolveCanonicalPath(requested: string, signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted();
    if (!isAbsolute(requested) || requested.includes("\0") || normalize(requested) !== requested) {
        return null;
    }
    try {
        const target = await realpath(requested);
        signal.throwIfAborted();
        if (!isAbsolute(target) || normalize(target) !== target) {
            return null;
        }
        return target;
    } catch (cause) {
        signal.throwIfAborted();
        if (cause instanceof Error && cause.name === "AbortError") {
            throw cause;
        }
        return null;
    }
}

function parseLocalImageUri(uri: string): string | null {
    const trimmed = uri.trim();
    if (trimmed.length === 0 || trimmed.length > 2_048 || trimmed.includes("\0")) {
        return null;
    }
    if (trimmed.startsWith("data:")) {
        return null;
    }
    if (trimmed.startsWith("file:")) {
        try {
            const url = new URL(trimmed);
            if (url.protocol !== "file:" || url.host.length > 0) {
                return null;
            }
            return fileURLToPath(url);
        } catch {
            return null;
        }
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
        return null;
    }
    return trimmed;
}

export async function readLocalRaster(uri: string, signal: AbortSignal): Promise<LocalRasterImage | null> {
    signal.throwIfAborted();
    const requested = parseLocalImageUri(uri);
    if (requested === null) {
        return null;
    }
    const target = await resolveCanonicalPath(requested, signal);
    if (target === null) {
        return null;
    }
    const targetMetadata = await stat(target);
    signal.throwIfAborted();
    if (!targetMetadata.isFile() || targetMetadata.size < 1 || targetMetadata.size > MAX_LOCAL_RASTER_BYTES) {
        return null;
    }
    const handle = await open(target, "r");
    const header = new Uint8Array(12);
    try {
        await handle.read(header, 0, header.byteLength, 0);
    } finally {
        await handle.close();
    }
    signal.throwIfAborted();
    const mimeType = sniffRasterMime(header);
    if (mimeType === null) {
        return null;
    }
    return new LocalRasterImage(basename(target) || "Image", mimeType, null, target);
}
