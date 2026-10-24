import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import { join } from "node:path";
import { platformSupportFor } from "../../util/platform/index.ts";

export class LocalSessionError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "LocalSessionError";
    }
}

export function localSessionSocketPath(stateDirectory: string, channelId: string): string {
    const hash = createHash("sha256").update(`${stateDirectory}:sessions:${channelId}`).digest("hex").slice(0, 32);
    const path = platformSupportFor(process.platform).controlSocketPath(hash);
    // Unix socket names have a roughly 100-byte limit, even when TMPDIR is a longer private path.
    return process.platform !== "win32" && Buffer.byteLength(path) >= 100 ? join("/tmp", `mobius-${hash}.sock`) : path;
}

/** A bounded, cancellable local stream. It carries the existing daemon protocol after authentication. */
export async function* readLocalSessionMessages(socket: Socket, signal: AbortSignal): AsyncGenerator<unknown> {
    signal.throwIfAborted();
    const abort = (): void => {
        socket.destroy();
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    let buffered = "";
    try {
        for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
            signal.throwIfAborted();
            if (typeof chunk !== "string") {
                throw new LocalSessionError("local_session_invalid_message", "Invalid local session message");
            }
            buffered += chunk;
            for (;;) {
                const newline = buffered.indexOf("\n");
                const length = newline < 0 ? buffered.length : newline;
                if (Buffer.byteLength(buffered.slice(0, length)) > 8 * 1024 * 1024) {
                    throw new LocalSessionError(
                        "local_session_message_limit",
                        "The local session message is too large",
                    );
                }
                if (newline < 0) {
                    break;
                }
                const line = buffered.slice(0, newline);
                buffered = buffered.slice(newline + 1);
                let decoded: unknown;
                try {
                    decoded = JSON.parse(line);
                } catch (cause) {
                    throw new LocalSessionError("local_session_invalid_message", "Invalid local session message", {
                        cause,
                    });
                }
                yield decoded;
            }
        }
        signal.throwIfAborted();
    } finally {
        signal.removeEventListener("abort", abort);
    }
}

export function writeLocalSessionMessage(socket: Socket, message: unknown): void {
    if (socket.destroyed || socket.writableEnded) {
        return;
    }
    const encoded = `${JSON.stringify(message)}\n`;
    if (socket.writableLength + Buffer.byteLength(encoded) > 16 * 1024 * 1024) {
        socket.destroy(new LocalSessionError("local_session_backpressure", "The local session client is too slow"));
        return;
    }
    socket.write(encoded);
}
