import { createHash } from "node:crypto";
import {
    CONTENT_AVAILABLE_KIND,
    CONTENT_COMMIT_KIND,
    CONTENT_READY_KIND,
    CONTENT_WRITE_KIND,
    type ContentChunkFrame,
    type ContentWriteCommand,
    FILE_FAILED_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import type { CommandContext } from "../../context.ts";
import type { RuntimeCommand } from "../../definition.ts";
import { send } from "../../transport.ts";

interface PendingWrite {
    readonly bytes: Uint8Array;
    readonly command: ContentWriteCommand;
    readonly hash: ReturnType<typeof createHash>;
    readonly receivedBytes: number;
    readonly sequence: number;
}

export interface ContentWriteCommands {
    readonly commands: readonly RuntimeCommand[];
    readonly receiveChunk: (frame: ContentChunkFrame) => void;
    readonly settle: () => Promise<void>;
}

export function createContentWriteCommands(context: CommandContext): ContentWriteCommands {
    const pending = new Map<string, PendingWrite>();
    const operations = new Set<Promise<void>>();

    const fail = (command: Pick<ContentWriteCommand, "requestId" | "sessionId">, error: unknown): void => {
        pending.delete(command.requestId);
        send(context.socket, {
            code: "content_write_failed",
            kind: FILE_FAILED_KIND,
            message: error instanceof Error ? error.message : "The content could not be stored",
            requestId: command.requestId,
            sessionId: command.sessionId,
        });
    };

    const write: RuntimeCommand = {
        kind: CONTENT_WRITE_KIND,
        handle: (_commandContext, message): void => {
            if (message.kind !== CONTENT_WRITE_KIND) {
                throw new Error("Command kind mismatch");
            }
            const existing = pending.get(message.requestId);
            if (existing !== undefined) {
                if (JSON.stringify(existing.command) !== JSON.stringify(message)) {
                    fail(message, new Error("The content request identifier is already in use"));
                    return;
                }
            } else {
                pending.set(message.requestId, {
                    bytes: new Uint8Array(message.byteLength),
                    command: message,
                    hash: createHash("sha256"),
                    receivedBytes: 0,
                    sequence: 0,
                });
            }
            send(context.socket, {
                kind: CONTENT_READY_KIND,
                requestId: message.requestId,
                sessionId: message.sessionId,
            });
        },
    };

    const commit: RuntimeCommand = {
        kind: CONTENT_COMMIT_KIND,
        handle: (_commandContext, message): void => {
            if (message.kind !== CONTENT_COMMIT_KIND) {
                throw new Error("Command kind mismatch");
            }
            const state = pending.get(message.requestId);
            if (state === undefined || state.command.sessionId !== message.sessionId) {
                fail(message, new Error("The content upload is unavailable"));
                return;
            }
            pending.delete(message.requestId);
            const operation = (async () => {
                try {
                    if (state.receivedBytes !== state.command.byteLength) {
                        throw new Error("The content upload ended at an unexpected length");
                    }
                    if (state.hash.digest("hex") !== state.command.contentKey) {
                        throw new Error("The content upload failed integrity validation");
                    }
                    const stored = await context.externalContent.put({
                        bytes: state.bytes,
                        kind: state.command.contentKind,
                        mediaType: state.command.mediaType,
                        name: state.command.name,
                        sessionId: state.command.sessionId,
                        signal: context.signal,
                    });
                    if (stored.key !== state.command.contentKey || stored.byteLength !== state.command.byteLength) {
                        throw new Error("Stored content did not match the upload");
                    }
                    send(context.socket, {
                        byteLength: stored.byteLength,
                        contentKey: stored.key,
                        kind: CONTENT_AVAILABLE_KIND,
                        requestId: message.requestId,
                        sessionId: message.sessionId,
                    });
                } catch (error) {
                    if (!context.signal.aborted) {
                        fail(message, error);
                    }
                }
            })();
            operations.add(operation);
            void operation.finally(() => operations.delete(operation));
        },
    };

    return {
        commands: [write, commit],
        receiveChunk: (frame) => {
            const state = pending.get(frame.requestId);
            if (state === undefined) {
                throw new Error("The content upload is unavailable");
            }
            if (
                frame.sequence !== state.sequence ||
                state.receivedBytes + frame.bytes.byteLength > state.command.byteLength
            ) {
                fail(state.command, new Error("The content upload contains invalid chunks"));
                return;
            }
            state.bytes.set(frame.bytes, state.receivedBytes);
            state.hash.update(frame.bytes);
            pending.set(frame.requestId, {
                ...state,
                receivedBytes: state.receivedBytes + frame.bytes.byteLength,
                sequence: state.sequence + 1,
            });
        },
        settle: async () => {
            pending.clear();
            await Promise.allSettled([...operations]);
        },
    };
}
