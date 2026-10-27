import { z } from "zod";

import { identifierStringSchema as IDENTIFIER, isIdentifier } from "../../shared/identifier.ts";
import { decodeZodMessage as decode, encodeZodMessage as encode } from "../../shared/message-codec.ts";

export const FILE_READ_KIND = "file.read";
export const FILE_BEGIN_KIND = "file.begin";
export const FILE_END_KIND = "file.end";
export const FILE_FAILED_KIND = "file.failed";
export const CONTENT_WRITE_KIND = "content.write";
export const CONTENT_COMMIT_KIND = "content.commit";
export const CONTENT_READY_KIND = "content.ready";
export const CONTENT_AVAILABLE_KIND = "content.available";

export const CONTENT_CHUNK_MAX_BYTES = 192 * 1024;
export const CONTENT_WRITE_MAX_BYTES = 32 * 1024 * 1024;
const CONTENT_CHUNK_MAGIC = new Uint8Array([0x4d, 0x42, 0x43, 0x31]);
const CONTENT_CHUNK_HEADER_BYTES = CONTENT_CHUNK_MAGIC.byteLength + 1 + 4;

const fileReadCommandSchema = z
    .object({
        kind: z.literal(FILE_READ_KIND),
        maxBytes: z
            .number()
            .int()
            .positive()
            .max(128 * 1024 * 1024),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
        path: z.string().min(1).max(4_096),
    })
    .readonly();

export type FileReadCommand = z.infer<typeof fileReadCommandSchema>;

const fileBeginEventSchema = z
    .object({
        byteLength: z
            .number()
            .int()
            .positive()
            .max(128 * 1024 * 1024),
        kind: z.literal(FILE_BEGIN_KIND),
        mediaType: z.string().min(1).max(255),
        modifiedAt: z.iso.datetime({ offset: true }),
        name: z.string().min(1).max(500),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
    })
    .readonly();

export type FileBeginEvent = z.infer<typeof fileBeginEventSchema>;

const contentWriteCommandSchema = z
    .object({
        byteLength: z.number().int().positive().max(CONTENT_WRITE_MAX_BYTES),
        contentKey: z.string().regex(/^[a-f0-9]{64}$/u),
        contentKind: z.enum(["image", "resource"]),
        kind: z.literal(CONTENT_WRITE_KIND),
        mediaType: z.string().min(1).max(255),
        name: z.string().min(1).max(500),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
    })
    .readonly();

export type ContentWriteCommand = z.infer<typeof contentWriteCommandSchema>;

const contentCommitCommandSchema = z
    .object({
        kind: z.literal(CONTENT_COMMIT_KIND),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
    })
    .readonly();

export type ContentCommitCommand = z.infer<typeof contentCommitCommandSchema>;

const contentReadyEventSchema = z
    .object({
        kind: z.literal(CONTENT_READY_KIND),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
    })
    .readonly();

export type ContentReadyEvent = z.infer<typeof contentReadyEventSchema>;

const contentAvailableEventSchema = z
    .object({
        byteLength: z.number().int().positive().max(CONTENT_WRITE_MAX_BYTES),
        contentKey: z.string().regex(/^[a-f0-9]{64}$/u),
        kind: z.literal(CONTENT_AVAILABLE_KIND),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
    })
    .readonly();

export type ContentAvailableEvent = z.infer<typeof contentAvailableEventSchema>;

export interface ContentChunkFrame {
    readonly bytes: Uint8Array;
    readonly requestId: string;
    readonly sequence: number;
}

function binaryBytes(value: unknown): Uint8Array {
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new Error("Content chunk must be a binary WebSocket frame");
}

export function encodeContentChunkFrame(frame: ContentChunkFrame): Uint8Array {
    if (!isIdentifier(frame.requestId)) {
        throw new Error("Content chunk request identifier is invalid");
    }
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0 || frame.sequence > 0xffff_ffff) {
        throw new Error("Content chunk sequence is invalid");
    }
    if (frame.bytes.byteLength < 1 || frame.bytes.byteLength > CONTENT_CHUNK_MAX_BYTES) {
        throw new Error("Content chunk size is invalid");
    }
    const requestId = new TextEncoder().encode(frame.requestId);
    if (requestId.byteLength > 255) {
        throw new Error("Content chunk request identifier is too long");
    }
    const encoded = new Uint8Array(CONTENT_CHUNK_HEADER_BYTES + requestId.byteLength + frame.bytes.byteLength);
    encoded.set(CONTENT_CHUNK_MAGIC, 0);
    encoded[CONTENT_CHUNK_MAGIC.byteLength] = requestId.byteLength;
    new DataView(encoded.buffer).setUint32(CONTENT_CHUNK_MAGIC.byteLength + 1, frame.sequence);
    encoded.set(requestId, CONTENT_CHUNK_HEADER_BYTES);
    encoded.set(frame.bytes, CONTENT_CHUNK_HEADER_BYTES + requestId.byteLength);
    return encoded;
}

export function decodeContentChunkFrame(value: unknown): ContentChunkFrame {
    const encoded = binaryBytes(value);
    if (
        encoded.byteLength <= CONTENT_CHUNK_HEADER_BYTES ||
        !CONTENT_CHUNK_MAGIC.every((byte, index) => encoded[index] === byte)
    ) {
        throw new Error("Content chunk frame header is invalid");
    }
    const requestIdLength = encoded[CONTENT_CHUNK_MAGIC.byteLength] ?? 0;
    const payloadOffset = CONTENT_CHUNK_HEADER_BYTES + requestIdLength;
    if (requestIdLength < 1 || payloadOffset >= encoded.byteLength) {
        throw new Error("Content chunk frame length is invalid");
    }
    const requestId = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        encoded.subarray(CONTENT_CHUNK_HEADER_BYTES, payloadOffset),
    );
    const bytes = encoded.slice(payloadOffset);
    const sequence = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getUint32(
        CONTENT_CHUNK_MAGIC.byteLength + 1,
    );
    if (!isIdentifier(requestId) || bytes.byteLength > CONTENT_CHUNK_MAX_BYTES) {
        throw new Error("Content chunk frame is invalid");
    }
    return { bytes, requestId, sequence };
}

const fileEndEventSchema = z
    .object({
        kind: z.literal(FILE_END_KIND),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
    })
    .readonly();

export type FileEndEvent = z.infer<typeof fileEndEventSchema>;

const fileFailedEventSchema = z
    .object({
        code: IDENTIFIER,
        kind: z.literal(FILE_FAILED_KIND),
        message: z.string().min(1).max(500),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
    })
    .readonly();

export type FileFailedEvent = z.infer<typeof fileFailedEventSchema>;

export const decodeFileReadCommand = (encoded: string): FileReadCommand => decode(encoded, fileReadCommandSchema);
export const encodeFileReadCommand = (message: FileReadCommand): string => encode(message, fileReadCommandSchema);
export const decodeFileBeginEvent = (encoded: string): FileBeginEvent => decode(encoded, fileBeginEventSchema);
export const encodeFileBeginEvent = (message: FileBeginEvent): string => encode(message, fileBeginEventSchema);
export const decodeFileEndEvent = (encoded: string): FileEndEvent => decode(encoded, fileEndEventSchema);
export const encodeFileEndEvent = (message: FileEndEvent): string => encode(message, fileEndEventSchema);
export const decodeFileFailedEvent = (encoded: string): FileFailedEvent => decode(encoded, fileFailedEventSchema);
export const encodeFileFailedEvent = (message: FileFailedEvent): string => encode(message, fileFailedEventSchema);
export const decodeContentWriteCommand = (encoded: string): ContentWriteCommand =>
    decode(encoded, contentWriteCommandSchema);
export const encodeContentWriteCommand = (message: ContentWriteCommand): string =>
    encode(message, contentWriteCommandSchema);
export const decodeContentCommitCommand = (encoded: string): ContentCommitCommand =>
    decode(encoded, contentCommitCommandSchema);
export const encodeContentCommitCommand = (message: ContentCommitCommand): string =>
    encode(message, contentCommitCommandSchema);
export const decodeContentReadyEvent = (encoded: string): ContentReadyEvent => decode(encoded, contentReadyEventSchema);
export const encodeContentReadyEvent = (message: ContentReadyEvent): string => encode(message, contentReadyEventSchema);
export const decodeContentAvailableEvent = (encoded: string): ContentAvailableEvent =>
    decode(encoded, contentAvailableEventSchema);
export const encodeContentAvailableEvent = (message: ContentAvailableEvent): string =>
    encode(message, contentAvailableEventSchema);
