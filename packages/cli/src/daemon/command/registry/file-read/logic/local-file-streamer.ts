import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    type DaemonToServiceMessage,
    FILE_BEGIN_KIND,
    FILE_CHUNK_KIND,
    FILE_END_KIND,
    type FileReadCommand,
} from "@moxt-ai/mobius-protocol";
import { readLocalRaster } from "../../../../../acp/resource/local-raster.ts";
import type { ExternalContentStore } from "../../../../../external-content/local-external-content-store.ts";

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

async function resolveFile(
    value: string,
    workingDirectory: string | null,
    signal: AbortSignal,
): Promise<string | null> {
    const path = requestedPath(value);
    if (path === null || (!isAbsolute(path) && workingDirectory === null)) {
        return null;
    }
    const requested = workingDirectory === null ? path : resolve(workingDirectory, path);
    if (!isAbsolute(requested) || (isAbsolute(path) && normalize(path) !== path)) {
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
    workingDirectory: string | null,
    externalContent: ExternalContentStore,
): Promise<void> {
    const external = await externalContent.resolve(command.sessionId, command.path, signal);
    const target = external?.path ?? (await resolveFile(command.path, workingDirectory, signal));
    if (target === null) {
        throw new Error("The local file is unavailable");
    }
    const before = await stat(target);
    signal.throwIfAborted();
    if (!before.isFile() || before.size < 1 || before.size > command.maxBytes) {
        throw new Error("The local file is too large to read");
    }
    const raster = external === null ? await readLocalRaster(target, signal) : null;
    send({
        byteLength: before.size,
        kind: FILE_BEGIN_KIND,
        mediaType:
            external?.mediaType ??
            raster?.mimeType ??
            (extname(target).toLowerCase() === ".svg" ? "image/svg+xml" : "application/octet-stream"),
        modifiedAt: before.mtime.toISOString(),
        name: external?.name ?? (basename(target) || "file"),
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
