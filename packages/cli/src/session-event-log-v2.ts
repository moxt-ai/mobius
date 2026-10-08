import { createHash, randomUUID } from "node:crypto";
import type {
    AcpSessionUpdateV2,
    ContentBlockV2,
    QueuedPromptRequestEventLogV2,
    SessionEventV2,
    SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import type { DaemonSessionEventPublisher } from "./relay-connection/session-event-publisher.ts";

interface QueuedPromptRequestV2 {
    readonly commandId: string;
    readonly content: readonly ContentBlockV2[];
    readonly sessionId: string;
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

export function sessionUpdateEventV2(
    daemonGenerationId: string,
    sessionId: string,
    position: number,
    update: AcpSessionUpdateV2,
    recordedAt: string,
): SessionEventV2 {
    const sessionPrefix = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
    return {
        eventId: `event-${daemonGenerationId}-${sessionPrefix}-${position.toString().padStart(16, "0")}`,
        payload: update,
        position: position.toString(),
        provenance: { kind: "original" },
        recordedAt,
        sessionId,
        type: "acp",
    };
}

export class DaemonSessionEventLogV2 {
    readonly daemonGenerationId = randomUUID();
    readonly #publisher: DaemonSessionEventPublisher;
    readonly #queued = new Map<string, QueuedPromptRequestV2>();

    constructor(publisher: DaemonSessionEventPublisher) {
        this.#publisher = publisher;
    }

    readonly requested = (command: SessionPromptCommand): void => {
        this.#queued.set(command.commandId, {
            commandId: command.commandId,
            content: promptContent(command),
            sessionId: command.sessionId,
        });
    };

    readonly started = (sessionId: string, commandId: string, _attemptId: string, _epoch: string): void => {
        const request = this.#queued.get(commandId);
        if (request?.sessionId === sessionId) {
            this.#queued.delete(commandId);
        }
    };

    readonly record = (sessionId: string, update: AcpSessionUpdateV2, position: number): void => {
        this.#publisher.publishV2(this.event(sessionId, position, update, new Date().toISOString()));
    };

    readonly event = (
        sessionId: string,
        position: number,
        update: AcpSessionUpdateV2,
        recordedAt: string,
    ): SessionEventV2 => sessionUpdateEventV2(this.daemonGenerationId, sessionId, position, update, recordedAt);

    readonly queueChanged = (_sessionId: string): void => undefined;

    readonly completed = (sessionId: string, commandId: string, _stopReason: string): void => {
        const request = this.#queued.get(commandId);
        if (request?.sessionId === sessionId) {
            this.#queued.delete(commandId);
        }
    };

    readonly failed = (sessionId: string, commandId: string, _code: string, _message: string): void => {
        const request = this.#queued.get(commandId);
        if (request?.sessionId === sessionId) {
            this.#queued.delete(commandId);
        }
    };

    readonly promptRequestRecovery = (sessionId: string): PromptRequestRecoveryV2 => ({
        queuedPromptRequests: [...this.#queued.values()]
            .filter((request) => request.sessionId === sessionId)
            .map(({ commandId, content }) => ({ commandId, content })),
    });
}
