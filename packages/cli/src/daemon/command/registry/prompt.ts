import { encodeSessionPromptCommand, SESSION_PROMPT_KIND, SessionPromptDisposition } from "@moxt-ai/mobius-protocol";
import { send } from "../../command-dispatcher.ts";
import type { DaemonCommand } from "../definition.ts";
import { executePrompt } from "./prompt-executor.ts";

export const sessionPromptCommand: DaemonCommand = {
    kind: SESSION_PROMPT_KIND,
    handle: (context, message): void => {
        if (message.kind !== SESSION_PROMPT_KIND) {
            throw new Error("Command kind mismatch");
        }
        const receipt = context.operations.claimExecution(
            message.commandId,
            message.sessionId,
            encodeSessionPromptCommand(message),
        );
        if (receipt.kind === "conflict") {
            send(context.socket, {
                code: "command_identity_conflict",
                requestId: message.commandId,
                kind: "session.operation.failed",
                message: "This command identifier was already used for a different request.",
                sessionId: message.sessionId,
            });
            return;
        }
        if (receipt.kind === "duplicate") {
            return;
        }
        const turn = context.activeTurns.start(message, receipt.attemptId);
        context.eventProjectionV2.requested(message);
        // Queue admission is acknowledged by the V2 session.queue.changed lifecycle
        // event; the relay resolves the pending Turn submission from it, so the
        // daemon sends no separate acknowledgment frame.
        const queueChanged = (): void => {
            void context.eventProjectionV2.queueChanged(message.sessionId).catch((error: unknown) => {
                console.error("Could not record queue change", error);
            });
        };
        void executePrompt({
            operations: context.operations,
            eventProjectionV2: context.eventProjectionV2,
            command: message,
            config: context.config,
            directories: context.directories,
            sessions: context.sessions,
            attemptId: receipt.attemptId,
            activateAttempt: turn.activate,
            waitForSessionAvailability: (signal) =>
                context.activeTurns.admitAndWait(turn, signal, () => {
                    queueChanged();
                }),
            signal: turn.signal,
            recordTurnActivity: turn.recordActivity,
            recordTurnNarration: turn.recordNarration,
            recordTurnText: turn.recordText,
            recordSteeringPrompt: () => context.activeTurns.recordSteeringPrompt(message),
            cancellationRequested: turn.cancellationRequested,
        })
            .catch((error: unknown) => {
                console.error("Mobius daemon turn failed", error);
            })
            .finally(() => {
                context.activeTurns.finish(turn);
                context.eventProjectionV2.publishTerminal(message.sessionId, message.commandId);
                if (message.disposition === SessionPromptDisposition.Queue) {
                    queueChanged();
                }
            });
    },
};
