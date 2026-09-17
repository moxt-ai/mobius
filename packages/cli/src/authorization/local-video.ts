import { basename } from "node:path";
import type { LocalArtifact } from "./local-artifact.ts";

const MAX_INLINE_VIDEO_BYTES = 3_000_000;
const MP4_FILE_TYPE = new TextEncoder().encode("ftyp");
const WEBM_SIGNATURE = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3);

export type LocalVideoMimeType = "video/mp4" | "video/webm";

export class LocalVideo implements LocalArtifact {
    readonly bytes: Uint8Array;
    readonly mimeType: LocalVideoMimeType;
    readonly name: string;

    constructor(name: string, mimeType: LocalVideoMimeType, bytes: Uint8Array) {
        this.bytes = bytes;
        this.mimeType = mimeType;
        this.name = name;
    }

    readonly base64 = (): string => Buffer.from(this.bytes).toString("base64");
}

function startsWith(bytes: Uint8Array, signature: Uint8Array, offset = 0): boolean {
    if (bytes.byteLength < offset + signature.byteLength) {
        return false;
    }
    return signature.every((value, index) => bytes[offset + index] === value);
}

function sniffVideoMime(bytes: Uint8Array): LocalVideoMimeType | null {
    if (startsWith(bytes, MP4_FILE_TYPE, 4)) {
        return "video/mp4";
    }
    if (startsWith(bytes, WEBM_SIGNATURE)) {
        return "video/webm";
    }
    return null;
}

export function readInlineVideo(data: string, declaredMimeType: string, name = "Video"): LocalVideo | null {
    if (data.length === 0 || data.length > Math.ceil(MAX_INLINE_VIDEO_BYTES / 3) * 4 || data.length % 4 !== 0) {
        return null;
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        return null;
    }
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_INLINE_VIDEO_BYTES) {
        return null;
    }
    const mimeType = sniffVideoMime(bytes);
    if (mimeType === null || mimeType !== declaredMimeType) {
        return null;
    }
    return new LocalVideo(basename(name) || "Video", mimeType, bytes);
}
