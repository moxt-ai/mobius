import { z } from "zod";

import { identifierStringSchema as IDENTIFIER } from "../../shared/identifier.ts";
import { decodeZodMessage as decode, encodeZodMessage as encode } from "../../shared/message-codec.ts";

export const FILE_READ_KIND = "file.read";
export const FILE_BEGIN_KIND = "file.begin";
export const FILE_CHUNK_KIND = "file.chunk";
export const FILE_END_KIND = "file.end";
export const FILE_FAILED_KIND = "file.failed";

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

const fileChunkEventSchema = z
    .object({
        data: z.string().min(1).max(400_000),
        kind: z.literal(FILE_CHUNK_KIND),
        requestId: IDENTIFIER,
        sequence: z.number().int().nonnegative().max(1_024),
        sessionId: IDENTIFIER,
    })
    .readonly();

export type FileChunkEvent = z.infer<typeof fileChunkEventSchema>;

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
export const decodeFileChunkEvent = (encoded: string): FileChunkEvent => decode(encoded, fileChunkEventSchema);
export const encodeFileChunkEvent = (message: FileChunkEvent): string => encode(message, fileChunkEventSchema);
export const decodeFileEndEvent = (encoded: string): FileEndEvent => decode(encoded, fileEndEventSchema);
export const encodeFileEndEvent = (message: FileEndEvent): string => encode(message, fileEndEventSchema);
export const decodeFileFailedEvent = (encoded: string): FileFailedEvent => decode(encoded, fileFailedEventSchema);
export const encodeFileFailedEvent = (message: FileFailedEvent): string => encode(message, fileFailedEventSchema);
