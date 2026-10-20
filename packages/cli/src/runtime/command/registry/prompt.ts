import {
    encodeSessionPromptCommand,
    SESSION_PROMPT_KIND,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { executePrompt } from "../../session/execute-prompt.ts";
import type { RuntimeCommand } from "../definition.ts";
import { send } from "../dispatcher.ts";

export const sessionPromptCommand: RuntimeCommand = {
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
        const turn = context.sessionTurns.start(message, receipt.attemptId);
        context.eventProjection.requested(message);
        // Queue admission is acknowledged by the V2 session.queue.changed lifecycle
        // event; the relay resolves the pending Turn submission from it, so the
        // daemon sends no separate acknowledgment frame.
        const queueChanged = (): void => {
            void context.eventProjection.queueChanged(message.sessionId).catch((error: unknown) => {
                console.error("Could not record queue change", error);
            });
        };
        void executePrompt({
            operations: context.operations,
            eventProjection: context.eventProjection,
            command: message,
            config: context.config,
            directories: context.directories,
            sessions: context.sessions,
            attemptId: receipt.attemptId,
            activateAttempt: turn.activate,
            waitForSessionAvailability: (signal) =>
                context.sessionTurns.admitAndWait(turn, signal, () => {
                    queueChanged();
                }),
            signal: turn.signal,
            recordSteeringPrompt: () => context.sessionTurns.recordSteeringPrompt(message),
            cancellationRequested: turn.cancellationRequested,
        })
            .catch((error: unknown) => {
                console.error("Mobius daemon turn failed", error);
            })
            .finally(() => {
                context.sessionTurns.finish(turn);
                context.eventProjection.publishTerminal(message.sessionId, message.commandId);
                if (message.disposition === SessionPromptDisposition.Queue) {
                    queueChanged();
                }
            });
    },
};
