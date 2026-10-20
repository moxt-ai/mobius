import type {
    ContentBlock,
    PromptExecutionContext,
    QueuedPromptRequestEventLog,
    SessionEventPayload,
    SessionLiveEvent,
    SessionPromptCommand,
} from "@moxt-ai/mobius-sdk/protocol";
import type { RuntimeSessionEventPublisher } from "./runtime/relay/session-event-publisher.ts";

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
    readonly phase: "queued" | "running";
}

export interface PromptRequestRecovery {
    readonly queuedPromptRequests: readonly QueuedPromptRequestEventLog[];
}

function promptContent(command: SessionPromptCommand): readonly ContentBlock[] {
    const content: ContentBlock[] = [];
    if (command.prompt.length > 0) {
        content.push({ text: command.prompt, type: "text" });
    }
    for (const image of command.images) {
        content.push({
            data: image.data,
            mimeType: image.mimeType,
            type: "image",
        });
    }
    for (const resource of command.resources) {
        content.push(
            resource.type === "embedded"
                ? {
                      resource: { mimeType: resource.mimeType, text: resource.text, uri: resource.uri },
                      type: "resource",
                  }
                : { mimeType: resource.mimeType, name: resource.name, type: "resource_link", uri: resource.uri },
        );
    }
    return content;
}

export class RuntimeSessionEventProjection {
    readonly #publisher: RuntimeSessionEventPublisher;
    readonly #terminal = new Map<string, SessionLiveEvent>();
    readonly #publications = new Map<string, SessionLiveEvent[]>();
    readonly #queued = new Map<string, QueuedPromptRequest>();
    readonly #recordActiveTurn: (event: SessionLiveEvent) => void;

    readonly #recordLifecycle: (sessionId: string, event: SessionEventPayload) => Promise<boolean>;
    constructor(
        publisher: RuntimeSessionEventPublisher,
        recordLifecycle: (sessionId: string, event: SessionEventPayload) => Promise<boolean>,
        recordActiveTurn: (event: SessionLiveEvent) => void,
    ) {
        this.#recordLifecycle = recordLifecycle;
        this.#recordActiveTurn = recordActiveTurn;
        this.#publisher = publisher;
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
            phase: "queued",
            sessionId: command.sessionId,
            ...(command.targetCommandId.length === 0 ? {} : { targetCommandId: command.targetCommandId }),
        });
    };

    readonly started = (
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
            this.#queued.set(commandId, { ...request, phase: "running" });
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
        if (
            recorded.type === "lifecycle-metadata" &&
            (recorded.payload.kind === "prompt.completed" ||
                recorded.payload.kind === "prompt.failed" ||
                recorded.payload.kind === "prompt.failed-before-start")
        ) {
            // Publish termination after prompt admission and execution state are settled.
            this.#terminal.set(recorded.payload.commandId, recorded);
            const pending = this.#publications.get(sessionId) ?? [];
            pending.push(recorded);
            this.#publications.set(sessionId, pending);
            return;
        }
        const pending = this.#publications.get(sessionId);
        if (pending !== undefined) {
            pending.push(recorded);
        } else {
            this.#publisher.publish(recorded);
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
                this.#publisher.publish(next);
            }
            if (pending.length === 0) {
                this.#publications.delete(sessionId);
            }
        }
        this.#queued.delete(commandId);
    };

    readonly queueChanged = async (sessionId: string): Promise<void> => {
        await this.#recordLifecycle(sessionId, {
            type: "lifecycle-metadata",
            payload: { kind: "session.queue.changed" },
        });
    };

    readonly completed = async (sessionId: string, commandId: string, stopReason: string): Promise<void> => {
        const request = this.#queued.get(commandId);
        if (request?.sessionId !== sessionId || this.#terminal.has(commandId)) {
            return;
        }
        const recorded = await this.#recordLifecycle(sessionId, {
            type: "lifecycle-metadata",
            payload: { kind: "prompt.completed", commandId, stopReason },
        });
        if (!recorded) {
            this.#publisher.publishOperationFailure(
                sessionId,
                commandId,
                "cancelled",
                "The prompt was cancelled before execution",
            );
        }
    };

    readonly failed = async (sessionId: string, commandId: string, code: string, message: string): Promise<void> => {
        const request = this.#queued.get(commandId);
        if (request?.sessionId !== sessionId || this.#terminal.has(commandId)) {
            return;
        }
        const recorded = await this.#recordLifecycle(sessionId, {
            type: "lifecycle-metadata",
            payload: { kind: "prompt.failed-before-start", commandId, code, message },
        });
        if (!recorded) {
            this.#publisher.publishOperationFailure(sessionId, commandId, code, message);
        }
    };

    readonly promptRequestRecovery = (sessionId: string): PromptRequestRecovery => ({
        queuedPromptRequests: [...this.#queued.values()]
            .filter((request) => request.sessionId === sessionId && request.phase === "queued")
            .map(({ commandId, content, disposition, targetCommandId }) => ({
                commandId,
                content,
                ...(disposition === undefined ? {} : { disposition }),
                ...(targetCommandId === undefined ? {} : { targetCommandId }),
            })),
    });
}
