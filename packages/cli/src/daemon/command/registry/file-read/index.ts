import { FILE_FAILED_KIND, FILE_READ_KIND } from "@moxt-ai/mobius-sdk/protocol";
import { WebSocket } from "undici";
import { send } from "../../../command-dispatcher.ts";
import type { DaemonCommand } from "../../definition.ts";
import { streamLocalFile } from "./logic/local-file-streamer.ts";

export const fileReadCommand: DaemonCommand = {
    kind: FILE_READ_KIND,
    handle: ({ externalContent, sessions, signal, socket }, message): void => {
        if (message.kind !== FILE_READ_KIND) {
            throw new Error("Command kind mismatch");
        }
        void streamLocalFile(
            message,
            (response) => send(socket, response),
            signal,
            sessions.findSessions([message.sessionId])[0]?.cwd ?? null,
            externalContent,
        ).catch((error: unknown) => {
            if (socket.readyState !== WebSocket.OPEN || signal.aborted) {
                return;
            }
            send(socket, {
                code: "file_unavailable",
                kind: FILE_FAILED_KIND,
                message: error instanceof Error ? error.message : "The local file is unavailable",
                requestId: message.requestId,
                sessionId: message.sessionId,
            });
        });
    },
};
