import type {
    ContentBlockV2,
    ExecutingPromptRequestEventLogV2,
    SessionEventPayloadV2,
    SessionEventV2,
    SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import type { AcpSessionStore } from "./acp/session-store.ts";
import type { DaemonSessionEventPublisher } from "./relay-connection/session-event-publisher.ts";

const EXECUTING_PROMPT_EVENT_LIMIT = 10_000;

type PromptRequestStateV2 =
    | {
          readonly kind: "requested";
          readonly commandId: string;
          readonly sessionId: string;
      }
    | {
          readonly kind: "executing";
          readonly attemptId: string;
          readonly commandId: string;
          readonly epoch: string;
          readonly sessionId: string;
      };

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

export class DaemonSessionEventLogV2 {
    readonly #positions = new Map<string, number>();
    readonly #requests = new Map<string, PromptRequestStateV2>();
    readonly #loadedRequestSessions = new Set<string>();
    readonly #publisher: DaemonSessionEventPublisher;
    readonly #store: AcpSessionStore;

    constructor(publisher: DaemonSessionEventPublisher, store: AcpSessionStore) {
        this.#publisher = publisher;
        this.#store = store;
    }

    readonly #loadStoredEvents = (sessionId: string): readonly SessionEventV2[] => {
        const stored = this.#store.readExecutingPromptEventsV2(sessionId);
        const lastPosition = stored.at(-1)?.position;
        if (lastPosition !== undefined) {
            this.#positions.set(sessionId, Number(lastPosition));
        }
        return stored;
    };

    readonly #loadRequests = (sessionId: string): void => {
        if (this.#loadedRequestSessions.has(sessionId)) {
            return;
        }
        for (const event of this.#loadStoredEvents(sessionId)) {
            if (event.type === "acp") {
                continue;
            }
            const payload = event.payload;
            if (payload.kind === "prompt.requested") {
                this.#requests.set(payload.commandId, {
                    commandId: payload.commandId,
                    kind: "requested",
                    sessionId,
                });
                continue;
            }
            if ("event" in payload) {
                continue;
            }
            if (!("commandId" in payload)) {
                continue;
            }
            const state = this.#requests.get(payload.commandId);
            if (state === undefined) {
                continue;
            }
            if (payload.kind === "prompt.started") {
                this.#requests.set(payload.commandId, {
                    attemptId: payload.attemptId,
                    commandId: payload.commandId,
                    epoch: payload.epoch,
                    kind: "executing",
                    sessionId,
                });
            } else if (
                payload.kind === "prompt.completed" ||
                payload.kind === "prompt.failed" ||
                payload.kind === "prompt.failed-before-start"
            ) {
                this.#requests.delete(payload.commandId);
            }
        }
        this.#loadedRequestSessions.add(sessionId);
    };

    readonly #append = (sessionId: string, payload: SessionEventPayloadV2): SessionEventV2 => {
        this.#loadRequests(sessionId);
        const position = (this.#positions.get(sessionId) ?? 0) + 1;
        const event: SessionEventV2 = {
            eventId: `event-${crypto.randomUUID()}`,
            ...payload,
            position: position.toString(),
            provenance: { kind: "original" },
            recordedAt: new Date().toISOString(),
            sessionId,
        };
        this.#publisher.publishV2(event);
        this.#positions.set(sessionId, position);
        return event;
    };

    readonly requested = (command: SessionPromptCommand): void => {
        const content = promptContent(command);
        this.#append(command.sessionId, {
            payload: { commandId: command.commandId, content, kind: "prompt.requested" },
            type: "lifecycle-metadata",
        });
        this.#requests.set(command.commandId, {
            commandId: command.commandId,
            kind: "requested",
            sessionId: command.sessionId,
        });
    };

    readonly started = (sessionId: string, commandId: string, attemptId: string, epoch: string): void => {
        this.#loadRequests(sessionId);
        const request = this.#requests.get(commandId);
        if (request?.sessionId !== sessionId) {
            return;
        }
        this.#append(sessionId, {
            payload: { attemptId, commandId, epoch, kind: "prompt.started" },
            type: "lifecycle-metadata",
        });
        this.#requests.set(commandId, {
            attemptId,
            commandId,
            epoch,
            kind: "executing",
            sessionId,
        });
    };

    readonly record = (sessionId: string, payload: SessionEventPayloadV2): void => {
        this.#loadRequests(sessionId);
        this.#append(sessionId, payload);
    };

    readonly #clearCompletedSession = (sessionId: string): void => {
        if (![...this.#requests.values()].some((request) => request.sessionId === sessionId)) {
            this.#store.clearExecutingPromptEventsV2(sessionId);
        }
    };

    readonly queueChanged = (sessionId: string): void => {
        this.#append(sessionId, {
            payload: { kind: "session.queue.changed" },
            type: "lifecycle-metadata",
        });
    };

    readonly completed = (sessionId: string, commandId: string, stopReason: string): void => {
        this.#loadRequests(sessionId);
        this.#append(sessionId, {
            payload: { commandId, kind: "prompt.completed", stopReason },
            type: "lifecycle-metadata",
        });
        this.#requests.delete(commandId);
        this.#clearCompletedSession(sessionId);
    };

    readonly failed = (sessionId: string, commandId: string, code: string, message: string): void => {
        this.#loadRequests(sessionId);
        const request = this.#requests.get(commandId);
        if (request?.kind === "executing" && request.commandId === commandId) {
            this.#append(sessionId, {
                payload: {
                    attemptId: request.attemptId,
                    code,
                    commandId,
                    kind: "prompt.failed",
                    message,
                },
                type: "lifecycle-metadata",
            });
        } else {
            this.#append(sessionId, {
                payload: { code, commandId, kind: "prompt.failed-before-start", message },
                type: "lifecycle-metadata",
            });
        }
        this.#requests.delete(commandId);
        this.#clearCompletedSession(sessionId);
    };

    readonly executingPromptRequest = (sessionId: string): ExecutingPromptRequestEventLogV2 | null => {
        this.#loadRequests(sessionId);
        const request = [...this.#requests.values()].find(
            (candidate) => candidate.sessionId === sessionId && candidate.kind === "executing",
        );
        if (request?.kind !== "executing") {
            return null;
        }
        const requestEvents = this.#store.readExecutingPromptEventsV2(sessionId);
        const events = requestEvents.slice(-EXECUTING_PROMPT_EVENT_LIMIT);
        return {
            attemptId: request.attemptId,
            commandId: request.commandId,
            epoch: request.epoch,
            events,
            tailCursor: events.at(-1)?.eventId ?? "",
            truncated: events.length < requestEvents.length,
        };
    };
}
