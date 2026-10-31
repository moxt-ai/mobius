import {
    promptCompletion,
    SESSION_CANCEL_BEFORE_START_KIND,
    SESSION_CANCEL_KIND,
    SESSION_CLOSE_KIND,
    SESSION_CLOSED_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { SessionError } from "../../../session/api/session-error.ts";
import { settleAbandonedTurn } from "../../../session/prompt/prompt-lifecycle.ts";
import type { RuntimeCommand } from "../definition.ts";
import { reportOperationFailure, send } from "../transport.ts";

export const sessionCancelCommand: RuntimeCommand = {
    kind: SESSION_CANCEL_KIND,
    handle: ({ eventProjection, operations, sessions, sessionTurns, signal }, message): void => {
        if (message.kind !== SESSION_CANCEL_KIND) {
            throw new Error("Command kind mismatch");
        }
        const turn = sessionTurns.get(message.commandId, message.sessionId);
        if (turn === undefined) {
            void settleAbandonedTurn(eventProjection, operations, message).catch((error: unknown) => {
                console.error("Could not settle abandoned turn", error);
            });
            return;
        }
        const cancellation = turn.requestCancellation();
        if (cancellation.kind !== "running") {
            return;
        }
        void sessions.cancelPrompt(message.sessionId, cancellation.execution, signal).catch((error) => {
            console.error("Mobius daemon could not cancel the agent turn", error);
        });
    },
};

export const sessionCancelBeforeStartCommand: RuntimeCommand = {
    kind: SESSION_CANCEL_BEFORE_START_KIND,
    handle: ({ eventProjection, operations, sessionTurns, socket }, message): void => {
        if (message.kind !== SESSION_CANCEL_BEFORE_START_KIND) {
            throw new Error("Command kind mismatch");
        }
        if (operations.hasStarted(message.commandId, message.sessionId)) {
            reportOperationFailure(
                socket,
                message.commandId,
                message.sessionId,
                new SessionError("turn_already_started", "The message already started and could not be withdrawn"),
            );
            return;
        }
        const turn = sessionTurns.get(message.commandId, message.sessionId);
        if (turn === undefined) {
            const cancelled = operations.recordCancellationBeforeAdmission(message.commandId, message.sessionId);
            const outcome =
                cancelled.kind === "unavailable"
                    ? undefined
                    : cancelled.kind === "restated"
                      ? cancelled.outcome.event
                      : cancelled.outcome;
            if (
                outcome?.type === "lifecycle-metadata" &&
                outcome.payload.kind === "prompt.completed" &&
                promptCompletion(outcome.payload).kind === "cancelled"
            ) {
                if (cancelled.kind === "restated") {
                    eventProjection.restateOutcome(message.sessionId, cancelled.outcome);
                    return;
                }
                void eventProjection.recordOutcome(message.sessionId, outcome).catch((error: unknown) => {
                    reportOperationFailure(socket, message.commandId, message.sessionId, error);
                });
                return;
            }
            reportOperationFailure(
                socket,
                message.commandId,
                message.sessionId,
                new SessionError("turn_not_active", "The command is not waiting to start"),
            );
            return;
        }
        // No await separates checking admission from requesting cancellation.
        turn.requestCancellation();
    },
};

export const sessionCloseCommand: RuntimeCommand = {
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

export const promptDispositionCommand: RuntimeCommand = {
    kind: SESSION_PROMPT_DISPOSITION_KIND,
    handle: ({ diagnostics, operations, sessionTurns, socket }, message): void => {
        if (message.kind !== SESSION_PROMPT_DISPOSITION_KIND) {
            throw new Error("Command kind mismatch");
        }
        const turn = sessionTurns.get(message.commandId, message.sessionId);
        const result = turn?.promoteQueuedPrompt(message) ?? "unavailable";
        if (result === "accepted") {
            return;
        }
        const started = result === "already-started" || operations.hasStarted(message.commandId, message.sessionId);
        const error = started
            ? new SessionError("turn_already_started", "The message already left the queue and could not be steered")
            : new SessionError("turn_not_active", "The message is no longer waiting to be steered");
        diagnostics.daemonDiagnostic("session_prompt_disposition_failed", message.commandId, {
            code: error.code,
            commandId: message.commandId,
            sessionId: message.sessionId,
        });
        reportOperationFailure(socket, message.commandId, message.sessionId, error);
    },
};

export const permissionRespondCommand: RuntimeCommand = {
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

export const elicitationRespondCommand: RuntimeCommand = {
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
