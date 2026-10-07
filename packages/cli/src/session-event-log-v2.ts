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
          readonly eventTail: EventNodeV2;
          readonly sessionId: string;
      }
    | {
          readonly kind: "executing";
          readonly attemptId: string;
          readonly commandId: string;
          readonly epoch: string;
          readonly eventTail: EventNodeV2;
          readonly sessionId: string;
      };

interface EventNodeV2 {
    readonly event: SessionEventV2;
    readonly previous: EventNodeV2 | null;
}

function eventArray(tail: EventNodeV2): readonly SessionEventV2[] {
    const reversed: SessionEventV2[] = [];
    let node: EventNodeV2 | null = tail;
    while (node !== null) {
        reversed.push(node.event);
        node = node.previous;
    }
    return reversed.reverse();
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
                const executing = [...this.#requests.values()].find(
                    (request) => request.sessionId === sessionId && request.kind === "executing",
                );
                if (executing !== undefined) {
                    this.#requests.set(executing.commandId, {
                        ...executing,
                        eventTail: { event, previous: executing.eventTail },
                    });
                }
                continue;
            }
            const payload = event.payload;
            if (payload.kind === "prompt.requested") {
                this.#requests.set(payload.commandId, {
                    commandId: payload.commandId,
                    eventTail: { event, previous: null },
                    kind: "requested",
                    sessionId,
                });
                continue;
            }
            if ("event" in payload) {
                const executing = [...this.#requests.values()].find(
                    (request) => request.sessionId === sessionId && request.kind === "executing",
                );
                if (executing !== undefined) {
                    this.#requests.set(executing.commandId, {
                        ...executing,
                        eventTail: { event, previous: executing.eventTail },
                    });
                }
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
                    eventTail: { event, previous: state.eventTail },
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
        this.#positions.set(sessionId, position);
        this.#publisher.publishV2(event);
        return event;
    };

    readonly requested = (command: SessionPromptCommand): void => {
        const content = promptContent(command);
        const event = this.#append(command.sessionId, {
            payload: { commandId: command.commandId, content, kind: "prompt.requested" },
            type: "lifecycle-metadata",
        });
        this.#requests.set(command.commandId, {
            commandId: command.commandId,
            eventTail: { event, previous: null },
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
        const event = this.#append(sessionId, {
            payload: { attemptId, commandId, epoch, kind: "prompt.started" },
            type: "lifecycle-metadata",
        });
        this.#requests.set(commandId, {
            attemptId,
            commandId,
            epoch,
            eventTail: { event, previous: request.eventTail },
            kind: "executing",
            sessionId,
        });
        this.#store.startExecutingPromptEventsV2(sessionId, eventArray({ event, previous: request.eventTail }));
    };

    readonly record = (sessionId: string, payload: SessionEventPayloadV2): void => {
        this.#loadRequests(sessionId);
        const event = this.#append(sessionId, payload);
        this.#appendToExecutingRequest(sessionId, event);
    };

    readonly #appendToExecutingRequest = (sessionId: string, event: SessionEventV2): void => {
        const executing = [...this.#requests.values()].find(
            (request) => request.sessionId === sessionId && request.kind === "executing",
        );
        if (executing !== undefined) {
            this.#requests.set(executing.commandId, {
                ...executing,
                eventTail: { event, previous: executing.eventTail },
            });
            this.#store.appendExecutingPromptEventV2(event);
        }
    };

    readonly queueChanged = (sessionId: string): void => {
        const event = this.#append(sessionId, {
            payload: { kind: "session.queue.changed" },
            type: "lifecycle-metadata",
        });
        this.#appendToExecutingRequest(sessionId, event);
    };

    readonly completed = (sessionId: string, commandId: string, stopReason: string): void => {
        this.#loadRequests(sessionId);
        const request = this.#requests.get(commandId);
        const event = this.#append(sessionId, {
            payload: { commandId, kind: "prompt.completed", stopReason },
            type: "lifecycle-metadata",
        });
        this.#requests.delete(commandId);
        if (request?.kind === "executing" && request.sessionId === sessionId) {
            this.#store.clearExecutingPromptEventsV2(sessionId);
        } else {
            this.#appendToExecutingRequest(sessionId, event);
        }
    };

    readonly failed = (sessionId: string, commandId: string, code: string, message: string): void => {
        this.#loadRequests(sessionId);
        const request = this.#requests.get(commandId);
        let event: SessionEventV2;
        if (request?.kind === "executing" && request.commandId === commandId) {
            event = this.#append(sessionId, {
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
            event = this.#append(sessionId, {
                payload: { code, commandId, kind: "prompt.failed-before-start", message },
                type: "lifecycle-metadata",
            });
        }
        this.#requests.delete(commandId);
        if (request?.kind === "executing" && request.sessionId === sessionId) {
            this.#store.clearExecutingPromptEventsV2(sessionId);
        } else {
            this.#appendToExecutingRequest(sessionId, event);
        }
    };

    readonly executingPromptRequest = (sessionId: string): ExecutingPromptRequestEventLogV2 | null => {
        this.#loadRequests(sessionId);
        const request = [...this.#requests.values()].find(
            (candidate) => candidate.sessionId === sessionId && candidate.kind === "executing",
        );
        if (request?.kind !== "executing") {
            return null;
        }
        const requestEvents = eventArray(request.eventTail);
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
