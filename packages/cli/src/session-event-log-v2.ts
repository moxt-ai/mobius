import type {
    ContentBlockV2,
    PromptExecutionContextV2,
    QueuedPromptRequestEventLogV2,
    SessionEventPayloadV2,
    SessionEventV2,
    SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import type { AcpSessionEventPositionV2 } from "./acp/session-event-store-v2.ts";
import type { DaemonSessionEventPublisher } from "./relay-connection/session-event-publisher.ts";

interface QueuedPromptRequestV2 {
    readonly commandId: string;
    readonly content: readonly ContentBlockV2[];
    readonly sessionId: string;
    readonly context: {
        readonly agentId: string;
        readonly directoryId: string;
        readonly additionalDirectoryIds: readonly string[];
    };
    readonly phase: "queued" | "running";
}

export interface PromptRequestRecoveryV2 {
    readonly queuedPromptRequests: readonly QueuedPromptRequestEventLogV2[];
}

function promptContent(command: SessionPromptCommand): readonly ContentBlockV2[] {
    const content: ContentBlockV2[] = [];
    if (command.prompt.length > 0) {
        content.push({ text: command.prompt, type: "text" });
    }
    for (const image of command.images) {
        content.push({
            _meta: { mobius: { name: image.name } },
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

export function sessionEventV2(
    sessionGenerationId: string,
    sessionId: string,
    position: number,
    event: SessionEventPayloadV2,
    recordedAt: string,
): SessionEventV2 {
    return {
        eventId: `event-${sessionGenerationId}-${position.toString().padStart(16, "0")}`,
        ...event,
        position: position.toString(),
        provenance: { kind: "original" },
        recordedAt,
        sessionGenerationId,
        sessionId,
    };
}

export class DaemonSessionEventLogV2 {
    readonly #publisher: DaemonSessionEventPublisher;
    readonly #terminal = new Map<string, SessionEventV2>();
    readonly #publications = new Map<string, SessionEventV2[]>();
    readonly #queued = new Map<string, QueuedPromptRequestV2>();

    readonly #recordLifecycle: (sessionId: string, event: SessionEventPayloadV2) => Promise<boolean>;
    constructor(
        publisher: DaemonSessionEventPublisher,
        recordLifecycle: (sessionId: string, event: SessionEventPayloadV2) => Promise<boolean>,
    ) {
        this.#recordLifecycle = recordLifecycle;
        this.#publisher = publisher;
    }

    readonly requested = (command: SessionPromptCommand): void => {
        this.#queued.set(command.commandId, {
            commandId: command.commandId,
            content: promptContent(command),
            context: {
                agentId: command.agentId,
                directoryId: command.directoryId,
                additionalDirectoryIds: command.additionalDirectoryIds,
            },
            phase: "queued",
            sessionId: command.sessionId,
        });
    };

    readonly started = (
        sessionId: string,
        commandId: string,
        attemptId: string,
        epoch: string,
    ): {
        readonly attemptId: string;
        readonly content: readonly ContentBlockV2[];
        readonly epoch: string;
        readonly context: PromptExecutionContextV2;
    } => {
        const request = this.#queued.get(commandId);
        if (request?.sessionId === sessionId) {
            this.#queued.set(commandId, { ...request, phase: "running" });
            return { attemptId, content: request.content, epoch, context: request.context };
        }
        throw new Error("The executing prompt was not registered in the V2 queue");
    };

    readonly record = (sessionId: string, event: SessionEventPayloadV2, position: AcpSessionEventPositionV2): void => {
        const recorded = this.event(
            sessionId,
            position.sessionGenerationId,
            position.position,
            event,
            new Date().toISOString(),
        );
        if (
            event.type === "lifecycle-metadata" &&
            (event.payload.kind === "prompt.completed" ||
                event.payload.kind === "prompt.failed" ||
                event.payload.kind === "prompt.failed-before-start")
        ) {
            // Publish termination after prompt admission and execution state are settled.
            this.#terminal.set(event.payload.commandId, recorded);
            const pending = this.#publications.get(sessionId) ?? [];
            pending.push(recorded);
            this.#publications.set(sessionId, pending);
            return;
        }
        const pending = this.#publications.get(sessionId);
        if (pending !== undefined) {
            pending.push(recorded);
        } else {
            this.#publisher.publishV2(recorded);
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
                this.#publisher.publishV2(next);
            }
            if (pending.length === 0) {
                this.#publications.delete(sessionId);
            }
        }
        this.#queued.delete(commandId);
    };

    readonly event = (
        sessionId: string,
        sessionGenerationId: string,
        position: number,
        event: SessionEventPayloadV2,
        recordedAt: string,
    ): SessionEventV2 => sessionEventV2(sessionGenerationId, sessionId, position, event, recordedAt);

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

    readonly promptRequestRecovery = (sessionId: string): PromptRequestRecoveryV2 => ({
        queuedPromptRequests: [...this.#queued.values()]
            .filter((request) => request.sessionId === sessionId && request.phase === "queued")
            .map(({ commandId, content }) => ({ commandId, content })),
    });
}
