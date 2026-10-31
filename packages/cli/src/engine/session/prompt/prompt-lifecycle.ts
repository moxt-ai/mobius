import type {
    ContentBlock,
    PromptExecutionContext,
    QueuedPromptRequestEventLog,
    SessionCancelCommand,
    SessionEventPayload,
    SessionLiveEvent,
    SessionPromptCommand,
} from "@moxt-ai/mobius-sdk/protocol";
import { isPromptTerminal, SESSION_CLOSED_ERROR_CODE } from "@moxt-ai/mobius-sdk/protocol";
import type { SessionEventSink } from "../api/session-api.ts";
import type { ExecutionReceipts, RestatedOutcome } from "../turn/execution-receipts.ts";
import { isTextPromptResourceMediaType } from "./prompt-artifacts.ts";

interface QueuedPromptRequest {
    readonly commandId: string;
    readonly content: readonly ContentBlock[];
    readonly disposition?: string;
    readonly sessionId: string;
    readonly targetCommandId?: string;
    readonly context: {
        readonly agentId: string;
        readonly directoryId: string;
        readonly additionalDirectoryIds: readonly string[];
    };
}

export interface PromptRequestRecovery {
    readonly queuedPromptRequests: readonly QueuedPromptRequestEventLog[];
}

function promptContent(command: SessionPromptCommand): readonly ContentBlock[] {
    const content: ContentBlock[] = [];
    if (command.prompt.length > 0) {
        content.push({ text: command.prompt, type: "text" });
    }
    for (const attachment of command.attachments) {
        content.push(
            attachment.kind === "image"
                ? {
                      byteLength: attachment.byteLength,
                      imageKey: attachment.contentKey,
                      mimeType: attachment.mimeType,
                      type: "external_image",
                      uri: attachment.uri,
                  }
                : {
                      byteLength: attachment.byteLength,
                      encoding: isTextPromptResourceMediaType(attachment.mimeType) ? "text" : "binary",
                      mimeType: attachment.mimeType,
                      resourceKey: attachment.contentKey,
                      type: "external_resource",
                      uri: attachment.uri,
                  },
        );
    }
    return content;
}

/** Whether a command started or settled, as its execution receipt records it. */
type ExecutionProgress = Pick<ExecutionReceipts, "findUnsettledAttemptId" | "hasStarted" | "isTerminalExecution">;

export class PromptLifecycle {
    readonly #sink: SessionEventSink;
    /** Terminal events held until their command's admission and execution state are released. */
    readonly #terminal = new Map<string, SessionLiveEvent>();
    readonly #publications = new Map<string, SessionLiveEvent[]>();
    readonly #queued = new Map<string, QueuedPromptRequest>();
    readonly #recordActiveTurn: (event: SessionLiveEvent) => void;
    readonly #executions: ExecutionProgress;

    readonly #recordLifecycle: (sessionId: string, event: SessionEventPayload) => Promise<boolean>;
    readonly #append: (sessionId: string, event: SessionEventPayload, recordedAt?: string) => SessionLiveEvent;
    constructor(
        sink: SessionEventSink,
        recordLifecycle: (sessionId: string, event: SessionEventPayload) => Promise<boolean>,
        append: (sessionId: string, event: SessionEventPayload, recordedAt?: string) => SessionLiveEvent,
        recordActiveTurn: (event: SessionLiveEvent) => void,
        executions: ExecutionProgress,
    ) {
        this.#recordLifecycle = recordLifecycle;
        this.#append = append;
        this.#recordActiveTurn = recordActiveTurn;
        this.#executions = executions;
        this.#sink = sink;
    }

    readonly requested = (command: SessionPromptCommand): void => {
        this.#queued.set(command.commandId, {
            commandId: command.commandId,
            content: promptContent(command),
            ...(command.disposition === undefined ? {} : { disposition: command.disposition }),
            context: {
                agentId: command.agentId,
                directoryId: command.directoryId,
                additionalDirectoryIds: command.additionalDirectoryIds,
            },
            sessionId: command.sessionId,
            ...(command.targetCommandId.length === 0 ? {} : { targetCommandId: command.targetCommandId }),
        });
    };

    /** The lifecycle metadata the Agent session records when it starts this claimed command. */
    readonly lifecycle = (
        sessionId: string,
        commandId: string,
        attemptId: string,
        epoch: string,
        disposition: string,
    ): {
        readonly attemptId: string;
        readonly content: readonly ContentBlock[];
        readonly disposition?: string;
        readonly epoch: string;
        readonly context: PromptExecutionContext;
        readonly targetCommandId?: string;
    } => {
        const request = this.#queued.get(commandId);
        if (request?.sessionId === sessionId) {
            return {
                attemptId,
                content: request.content,
                disposition,
                epoch,
                context: request.context,
                ...(request.targetCommandId === undefined ? {} : { targetCommandId: request.targetCommandId }),
            };
        }
        throw new Error("The executing prompt was not registered in the V2 queue");
    };

    readonly record = (recorded: SessionLiveEvent): void => {
        this.#recordActiveTurn(recorded);
        const sessionId = recorded.sessionId;
        if (recorded.type === "lifecycle-metadata" && isPromptTerminal(recorded.payload)) {
            // Publish termination after prompt admission and execution state are settled.
            this.#terminal.set(recorded.payload.commandId, recorded);
            const pending = this.#publications.get(sessionId) ?? [];
            pending.push(recorded);
            this.#publications.set(sessionId, pending);
            return;
        }
        this.#publishInOrder(recorded);
    };

    /** Publishes after the Session's held terminal events, so clients receive its events in order. */
    readonly #publishInOrder = (event: SessionLiveEvent): void => {
        const pending = this.#publications.get(event.sessionId);
        if (pending !== undefined) {
            pending.push(event);
        } else {
            this.#sink.publish(event);
        }
    };

    readonly publishTerminal = (sessionId: string, commandId: string): void => {
        const event = this.#terminal.get(commandId);
        if (event?.sessionId === sessionId) {
            this.#terminal.delete(commandId);
            const pending = this.#publications.get(sessionId) ?? [];
            while (pending.length > 0) {
                const next = pending[0];
                if (next === undefined) {
                    break;
                }
                if (
                    next.type === "lifecycle-metadata" &&
                    "commandId" in next.payload &&
                    this.#terminal.has(next.payload.commandId)
                ) {
                    break;
                }
                pending.shift();
                this.#sink.publish(next);
            }
            if (pending.length === 0) {
                this.#publications.delete(sessionId);
            }
        }
        this.#queued.delete(commandId);
    };

    readonly recordOutcome = async (sessionId: string, event: SessionEventPayload): Promise<void> => {
        if (event.type !== "lifecycle-metadata" || !("commandId" in event.payload)) {
            return;
        }
        await this.#recordLifecycle(sessionId, event);
        this.publishTerminal(sessionId, event.payload.commandId);
    };

    /**
     * Publishes again an outcome a receipt already holds, for clients that missed it. The restatement is marked, so
     * Recording and status notifications do not take it for a new outcome, and it does not settle the receipt again.
     * It keeps the time the outcome was recorded, which receivers that predate the marker report as when it ended.
     */
    readonly restateOutcome = (sessionId: string, { event, recordedAt }: RestatedOutcome): void => {
        if (event.type !== "lifecycle-metadata" || !("commandId" in event.payload)) {
            return;
        }
        const restated = this.#append(sessionId, event, recordedAt);
        this.#publishInOrder({ ...restated, mobiusMetadata: { ...restated.mobiusMetadata, restated: true } });
    };

    readonly queueChanged = async (sessionId: string, commandId: string): Promise<void> => {
        await this.#recordLifecycle(sessionId, {
            type: "lifecycle-metadata",
            payload: { changedByCommandId: commandId, kind: "session.queue.changed" },
        });
    };

    readonly completed = async (sessionId: string, commandId: string, stopReason: string): Promise<void> => {
        const request = this.#queued.get(commandId);
        if (request?.sessionId !== sessionId || this.#executions.isTerminalExecution(commandId, sessionId)) {
            return;
        }
        const recorded = await this.#recordLifecycle(sessionId, {
            type: "lifecycle-metadata",
            payload: {
                kind: "prompt.completed",
                commandId,
                stopReason,
                ...(this.#executions.hasStarted(commandId, sessionId) ? {} : { execution: "not-started" as const }),
            },
        });
        if (!recorded) {
            this.#sink.publishOperationFailure(
                sessionId,
                commandId,
                "cancelled",
                "The prompt was cancelled before execution",
            );
        }
    };

    /**
     * Settles a failed command; whether it failed before or after starting is its receipt's fact. The unsettled
     * receipt, not the queue registration, admits the failure: a turn that ended without recording its terminal
     * event has already left the queue, and its abandonment must still settle it.
     */
    readonly failed = async (
        sessionId: string,
        commandId: string,
        attemptId: string,
        code: string,
        message: string,
    ): Promise<void> => {
        if (this.#executions.findUnsettledAttemptId(commandId, sessionId) === null) {
            return;
        }
        const recorded = await this.#recordLifecycle(sessionId, {
            type: "lifecycle-metadata",
            payload: this.#executions.hasStarted(commandId, sessionId)
                ? { kind: "prompt.failed", attemptId, commandId, code, message }
                : { kind: "prompt.failed-before-start", commandId, code, message },
        });
        if (!recorded || code === SESSION_CLOSED_ERROR_CODE) {
            this.#sink.publishOperationFailure(sessionId, commandId, code, message);
        }
    };

    readonly promptRequestRecovery = (sessionId: string): PromptRequestRecovery => ({
        queuedPromptRequests: [...this.#queued.values()]
            .filter(
                (request) =>
                    request.sessionId === sessionId && !this.#executions.hasStarted(request.commandId, sessionId),
            )
            .map(({ commandId, content, disposition, targetCommandId }) => ({
                commandId,
                content,
                ...(disposition === undefined ? {} : { disposition }),
                ...(targetCommandId === undefined ? {} : { targetCommandId }),
            })),
    });
}

export async function settleAbandonedTurn(
    projection: PromptLifecycle,
    operations: ExecutionReceipts,
    cancellation: SessionCancelCommand,
): Promise<void> {
    const cancelled = operations.recordCancellationBeforeAdmission(cancellation.commandId, cancellation.sessionId);
    switch (cancelled.kind) {
        case "recorded":
            await projection.recordOutcome(cancellation.sessionId, cancelled.outcome);
            return;
        case "restated":
            projection.restateOutcome(cancellation.sessionId, cancelled.outcome);
            return;
        case "unavailable":
            break;
    }
    const attemptId = operations.findUnsettledAttemptId(cancellation.commandId, cancellation.sessionId);
    if (attemptId === null) {
        console.warn("Mobius daemon ignored cancellation for an inactive turn");
        return;
    }
    await projection.failed(
        cancellation.sessionId,
        cancellation.commandId,
        attemptId,
        "agent_execution_abandoned",
        "The local Agent execution was abandoned before it completed",
    );
    projection.publishTerminal(cancellation.sessionId, cancellation.commandId);
}
