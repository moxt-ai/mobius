import { encodeSessionPromptCommand, SESSION_PROMPT_KIND } from "@moxt-ai/mobius-sdk/protocol";
import { executePrompt } from "../../../session/prompt/execute-prompt.ts";
import type { RuntimeCommand } from "../definition.ts";
import { send } from "../transport.ts";

export const sessionPromptCommand: RuntimeCommand = {
    kind: SESSION_PROMPT_KIND,
    handle: (context, message): void => {
        if (message.kind !== SESSION_PROMPT_KIND) {
            throw new Error("Command kind mismatch");
        }
        if (!context.sessionTurns.acceptsPrompts()) {
            send(context.socket, {
                code: "runtime_upgrading",
                requestId: message.commandId,
                kind: "session.operation.failed",
                message: "The Runtime is upgrading. Retry after it reconnects.",
                sessionId: message.sessionId,
            });
            return;
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
            // A retry records no lifecycle event of its own, so it is answered directly with where the original
            // command stands, as its receipt records it. A settled outcome is also restated for clients that missed it.
            send(context.socket, {
                kind: "session.prompt.accepted",
                requestId: message.commandId,
                sessionId: message.sessionId,
                state:
                    receipt.state === "settled"
                        ? "settled"
                        : context.sessionTurns.get(message.commandId, message.sessionId)?.isQueued() === true
                          ? "queued"
                          : "running",
            });
            const outcome =
                receipt.state === "settled" ? context.operations.restatedOutcome(message.commandId) : undefined;
            if (outcome !== undefined) {
                context.eventProjection.restateOutcome(message.sessionId, outcome);
            }
            return;
        }
        if (receipt.kind === "expired") {
            send(context.socket, {
                code: "command_result_expired",
                requestId: message.commandId,
                kind: "session.operation.failed",
                message:
                    "This command already started. Its execution result is no longer available; it will not run again.",
                sessionId: message.sessionId,
            });
            return;
        }
        const turn = context.sessionTurns.start(message, receipt.attemptId);
        context.eventProjection.requested(message);
        // Queue admission is acknowledged by the V2 session.queue.changed lifecycle
        // event naming this command; the relay resolves the pending Turn submission
        // from it, so the daemon sends no separate acknowledgment frame.
        const queueChanged = (): void => {
            void context.eventProjection.queueChanged(message.sessionId, message.commandId).catch((error: unknown) => {
                console.error("Could not record queue change", error);
            });
        };
        void executePrompt({
            eventProjection: context.eventProjection,
            command: message,
            resolveAgent: context.resolveAgent,
            readArtifact: async (attachment, signal) => {
                const artifact = await context.externalContent.read(
                    message.sessionId,
                    `mobius-content:${attachment.kind}:${attachment.contentKey}`,
                    signal,
                );
                if (artifact === null) {
                    throw new Error("The prompt attachment is unavailable");
                }
                return { bytes: artifact.bytes, path: artifact.path };
            },
            reportFailure: context.diagnostics.daemonDiagnostic,
            directories: context.directories,
            sessions: context.sessions,
            attemptId: receipt.attemptId,
            epoch: turn.epoch,
            waitForSessionAvailability: (signal) =>
                context.sessionTurns.admitAndWait(turn, signal, () => {
                    queueChanged();
                }),
            signal: turn.signal,
            cancellationRequested: turn.cancellationRequested,
        })
            .catch((error: unknown) => {
                console.error("Mobius daemon turn failed", error);
            })
            .finally(() => {
                context.sessionTurns.finish(turn);
                context.eventProjection.publishTerminal(message.sessionId, message.commandId);
                // Only a prompt that entered the queue changes it by leaving.
                if (turn.enteredQueue()) {
                    queueChanged();
                }
            });
    },
};
