import {
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    SESSION_LIST_KIND,
    SESSION_LISTED_KIND,
    SESSION_QUERIED_KIND,
    SESSION_QUERY_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import type { CommandContext } from "../context.ts";
import type { RuntimeCommand } from "../definition.ts";
import { createNativeSessionRequestHandler } from "../native-session-requests.ts";
import { reportOperationFailure, send } from "../transport.ts";

export function createNativeSessionCommands(context: CommandContext): readonly RuntimeCommand[] {
    const handler = createNativeSessionRequestHandler({
        diagnostics: context.diagnostics,
        nativeSessions: context.nativeSessions,
        signal: context.signal,
        socket: context.socket,
        timer: context.timer,
    });
    return [
        {
            kind: NATIVE_SESSION_CANCEL_KIND,
            handle: (_context, message): void => {
                if (message.kind !== NATIVE_SESSION_CANCEL_KIND) {
                    throw new Error("Command kind mismatch");
                }
                handler.cancel(message);
            },
            settle: handler.settle,
        },
        {
            kind: NATIVE_SESSION_REQUEST_KIND,
            handle: (_context, message): void => {
                if (message.kind !== NATIVE_SESSION_REQUEST_KIND) {
                    throw new Error("Command kind mismatch");
                }
                handler.handle(message);
            },
        },
        {
            kind: SESSION_LIST_KIND,
            handle: ({ nativeSessions, signal, socket }, message): void => {
                if (message.kind !== SESSION_LIST_KIND) {
                    throw new Error("Command kind mismatch");
                }
                void nativeSessions
                    .listSessions(message.limit, signal)
                    .then((entries) => {
                        send(socket, { entries, kind: SESSION_LISTED_KIND, requestId: message.requestId });
                    })
                    .catch((error: unknown) => {
                        reportOperationFailure(socket, message.requestId, "", error);
                    });
            },
        },
        {
            kind: SESSION_QUERY_KIND,
            handle: ({ nativeSessions, signal, socket }, message): void => {
                if (message.kind !== SESSION_QUERY_KIND) {
                    throw new Error("Command kind mismatch");
                }
                void nativeSessions
                    .querySessions(message.sessionIds, signal)
                    .then((entries) => {
                        send(socket, { entries, kind: SESSION_QUERIED_KIND, requestId: message.requestId });
                    })
                    .catch((error: unknown) => {
                        reportOperationFailure(socket, message.requestId, "", error);
                    });
            },
        },
    ];
}
