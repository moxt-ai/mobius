import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
    type DaemonToServiceMessage,
    FILE_BEGIN_KIND,
    FILE_CHUNK_KIND,
    FILE_END_KIND,
    type FileReadCommand,
} from "@moxt-ai/mobius-protocol";
import { readLocalRaster } from "../authorization/local-raster.ts";

const CHUNK_BYTES = 192 * 1024;

function requestedPath(value: string): string | null {
    if (value.includes("\0")) {
        return null;
    }
    if (value.startsWith("file:")) {
        try {
            const url = new URL(value);
            return url.protocol === "file:" && url.host.length === 0 ? fileURLToPath(url) : null;
        } catch {
            return null;
        }
    }
    return value;
}

async function resolveFile(value: string, signal: AbortSignal): Promise<string | null> {
    const requested = requestedPath(value);
    if (requested === null || !isAbsolute(requested) || normalize(requested) !== requested) {
        return null;
    }
    try {
        const target = await realpath(requested);
        signal.throwIfAborted();
        return isAbsolute(target) && normalize(target) === target ? target : null;
    } catch {
        signal.throwIfAborted();
        return null;
    }
}

export async function streamLocalFile(
    command: FileReadCommand,
    send: (message: DaemonToServiceMessage) => void,
    signal: AbortSignal,
): Promise<void> {
    const target = await resolveFile(command.path, signal);
    if (target === null) {
        throw new Error("The local file is unavailable");
    }
    const before = await stat(target);
    signal.throwIfAborted();
    if (!before.isFile() || before.size < 1 || before.size > command.maxBytes) {
        throw new Error("The local file is too large to read");
    }
    const raster = await readLocalRaster(target, signal);
    send({
        byteLength: before.size,
        kind: FILE_BEGIN_KIND,
        mediaType: raster?.mimeType ?? "application/octet-stream",
        modifiedAt: before.mtime.toISOString(),
        name: basename(target) || "file",
        requestId: command.requestId,
        sessionId: command.sessionId,
    });
    let sequence = 0;
    const stream = createReadStream(target, { highWaterMark: CHUNK_BYTES, signal });
    for await (const value of stream) {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
        send({
            data: Buffer.from(bytes).toString("base64"),
            kind: FILE_CHUNK_KIND,
            requestId: command.requestId,
            sequence,
            sessionId: command.sessionId,
        });
        sequence += 1;
    }
    const after = await stat(target);
    signal.throwIfAborted();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error("The local file changed during transfer");
    }
    send({
        kind: FILE_END_KIND,
        requestId: command.requestId,
        sessionId: command.sessionId,
    });
}
