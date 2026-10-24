import { FILE_FAILED_KIND, FILE_READ_KIND } from "@moxt-ai/mobius-sdk/protocol";
import { streamLocalFile } from "../../../../session/content/session-files.ts";
import type { RuntimeCommand } from "../../definition.ts";
import { send } from "../../transport.ts";

export const fileReadCommand: RuntimeCommand = {
    kind: FILE_READ_KIND,
    handle: ({ externalContent, sessions, signal, transport }, message): void => {
        if (message.kind !== FILE_READ_KIND) {
            throw new Error("Command kind mismatch");
        }
        void streamLocalFile(
            message,
            (response) => send(transport, response),
            signal,
            sessions.findSessions([message.sessionId])[0]?.cwd ?? null,
            externalContent,
        ).catch((error: unknown) => {
            if (!transport.isOpen() || signal.aborted) {
                return;
            }
            send(transport, {
                code: "file_unavailable",
                kind: FILE_FAILED_KIND,
                message: error instanceof Error ? error.message : "The local file is unavailable",
                requestId: message.requestId,
                sessionId: message.sessionId,
            });
        });
    },
};
