import {
    SESSION_CANCEL_KIND,
    SESSION_CLOSE_KIND,
    SESSION_CLOSED_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { reportOperationFailure, send, settleAbandonedTurn } from "../../command-dispatcher.ts";
import type { DaemonCommand } from "../definition.ts";

export const sessionCancelCommand: DaemonCommand = {
    kind: SESSION_CANCEL_KIND,
    handle: ({ activeTurns, eventProjection, operations, sessions }, message): void => {
        if (message.kind !== SESSION_CANCEL_KIND) {
            throw new Error("Command kind mismatch");
        }
        const turn = activeTurns.get(message.commandId);
        if (turn === undefined || !turn.matches(message)) {
            void settleAbandonedTurn(eventProjection, operations, message).catch((error: unknown) => {
                console.error("Could not settle abandoned turn", error);
            });
            return;
        }
        const cancellationState = turn.requestCancellation();
        if (cancellationState === "already-requested" || cancellationState === "pending") {
            return;
        }
        void sessions.cancelPrompt(message.sessionId).catch((error) => {
            console.error("Mobius daemon could not cancel the agent turn", error);
        });
    },
};

export const sessionCloseCommand: DaemonCommand = {
    kind: SESSION_CLOSE_KIND,
    handle: ({ sessions, signal, socket }, message): void => {
        if (message.kind !== SESSION_CLOSE_KIND) {
            throw new Error("Command kind mismatch");
        }
        void sessions
            .closeSession(message.sessionId, signal)
            .then(() => {
                send(socket, { kind: SESSION_CLOSED_KIND, requestId: message.requestId, sessionId: message.sessionId });
            })
            .catch((error: unknown) => {
                reportOperationFailure(socket, message.requestId, message.sessionId, error);
            });
    },
};

export const promptDispositionCommand: DaemonCommand = {
    kind: SESSION_PROMPT_DISPOSITION_KIND,
    handle: ({ activeTurns, socket }, message): void => {
        if (message.kind !== SESSION_PROMPT_DISPOSITION_KIND) {
            throw new Error("Command kind mismatch");
        }
        const turn = activeTurns.get(message.commandId);
        if (turn === undefined || !turn.promoteQueuedPrompt(message)) {
            reportOperationFailure(
                socket,
                message.commandId,
                message.sessionId,
                new Error("The queued prompt is unavailable"),
            );
        }
    },
};

export const permissionRespondCommand: DaemonCommand = {
    kind: SESSION_PERMISSION_RESPOND_KIND,
    handle: ({ sessions, socket }, message): void => {
        if (message.kind !== SESSION_PERMISSION_RESPOND_KIND) {
            throw new Error("Command kind mismatch");
        }
        void sessions.respondPermission(message).catch((error: unknown) => {
            reportOperationFailure(socket, message.interactionId, message.sessionId, error);
        });
    },
};

export const elicitationRespondCommand: DaemonCommand = {
    kind: SESSION_ELICITATION_RESPOND_KIND,
    handle: ({ sessions, socket }, message): void => {
        if (message.kind !== SESSION_ELICITATION_RESPOND_KIND) {
            throw new Error("Command kind mismatch");
        }
        void sessions.respondElicitation(message).catch((error: unknown) => {
            reportOperationFailure(socket, message.interactionId, message.sessionId, error);
        });
    },
};
