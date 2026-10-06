import type {
    AcpSessionUpdateV2,
    ContentBlockV2,
    ExecutingPromptRequestEventLogV2,
    NativeSessionEventsV2,
    SessionEventPayloadV2,
    SessionEventV2,
    SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import { AcpExecutionError } from "./acp/acp-error.ts";
import type { AcpSessionStore } from "./acp/session-store.ts";
import type { DaemonSessionEventPublisher } from "./relay-connection/session-event-publisher.ts";

const EXECUTING_PROMPT_EVENT_LIMIT = 10_000;

type PromptRequestStateV2 =
    | {
          readonly kind: "requested";
          readonly commandId: string;
          readonly events: readonly SessionEventV2[];
          readonly sessionId: string;
      }
    | {
          readonly kind: "executing";
          readonly attemptId: string;
          readonly commandId: string;
          readonly epoch: string;
          readonly events: readonly SessionEventV2[];
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

interface LocalEventCursorV2 {
    readonly endEvent: number;
    readonly sessionId: string;
}

function encodeLocalEventCursor(cursor: LocalEventCursorV2): string {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeLocalEventCursor(sessionId: string, cursor: string): LocalEventCursorV2 {
    try {
        const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value) ||
            Object.keys(value).sort().join(",") !== "endEvent,sessionId" ||
            Reflect.get(value, "sessionId") !== sessionId
        ) {
            throw new Error("Invalid V2 event cursor target");
        }
        const endEvent = Reflect.get(value, "endEvent");
        if (typeof endEvent !== "number" || !Number.isSafeInteger(endEvent) || endEvent < 0) {
            throw new Error("Invalid V2 event cursor boundary");
        }
        return { endEvent, sessionId };
    } catch (cause) {
        throw new AcpExecutionError("The native Session event cursor is invalid", { cause }, "invalid_cursor");
    }
}

export class DaemonSessionEventLogV2 {
    readonly #positions = new Map<string, number>();
    readonly #events = new Map<string, readonly SessionEventV2[]>();
    readonly #requests = new Map<string, PromptRequestStateV2>();
    readonly #loadedRequestSessions = new Set<string>();
    readonly #publisher: DaemonSessionEventPublisher;
    readonly #store: AcpSessionStore;

    constructor(publisher: DaemonSessionEventPublisher, store: AcpSessionStore) {
        this.#publisher = publisher;
        this.#store = store;
    }

    readonly #eventsFor = (sessionId: string): readonly SessionEventV2[] => {
        const cached = this.#events.get(sessionId);
        if (cached !== undefined) {
            return cached;
        }
        const stored = this.#store.readEventsV2(sessionId);
        this.#events.set(sessionId, stored);
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
        for (const event of this.#eventsFor(sessionId)) {
            const payload = event.payload;
            if (payload.kind === "prompt.requested") {
                this.#requests.set(payload.commandId, {
                    commandId: payload.commandId,
                    events: [event],
                    kind: "requested",
                    sessionId,
                });
                continue;
            }
            if (payload.kind === "acp.session.update") {
                const executing = [...this.#requests.values()].find(
                    (request) => request.sessionId === sessionId && request.kind === "executing",
                );
                if (executing !== undefined) {
                    this.#requests.set(executing.commandId, {
                        ...executing,
                        events: [...executing.events, event],
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
            const events = [...state.events, event];
            if (payload.kind === "prompt.started") {
                this.#requests.set(payload.commandId, {
                    attemptId: payload.attemptId,
                    commandId: payload.commandId,
                    epoch: payload.epoch,
                    events,
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
        this.#eventsFor(sessionId);
        const position = (this.#positions.get(sessionId) ?? 0) + 1;
        const event: SessionEventV2 = {
            eventId: `event-${crypto.randomUUID()}`,
            payload,
            position: position.toString(),
            provenance: { kind: "original" },
            recordedAt: new Date().toISOString(),
            sessionId,
        };
        this.#store.appendEventV2(event);
        this.#positions.set(sessionId, position);
        this.#events.set(sessionId, [...this.#eventsFor(sessionId), event]);
        this.#publisher.publishV2(event);
        return event;
    };

    readonly requested = (command: SessionPromptCommand): void => {
        const event = this.#append(command.sessionId, {
            commandId: command.commandId,
            content: promptContent(command),
            kind: "prompt.requested",
        });
        this.#requests.set(command.commandId, {
            commandId: command.commandId,
            events: [event],
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
        const event = this.#append(sessionId, { attemptId, commandId, epoch, kind: "prompt.started" });
        this.#requests.set(commandId, {
            attemptId,
            commandId,
            epoch,
            events: [...request.events, event],
            kind: "executing",
            sessionId,
        });
    };

    readonly acpUpdate = (sessionId: string, update: AcpSessionUpdateV2): void => {
        this.#loadRequests(sessionId);
        const event = this.#append(sessionId, { kind: "acp.session.update", update });
        const executing = [...this.#requests.values()].find(
            (request) => request.sessionId === sessionId && request.kind === "executing",
        );
        if (executing !== undefined) {
            this.#requests.set(executing.commandId, { ...executing, events: [...executing.events, event] });
        }
    };

    readonly completed = (sessionId: string, commandId: string, stopReason: string): void => {
        this.#append(sessionId, { commandId, kind: "prompt.completed", stopReason });
        this.#requests.delete(commandId);
    };

    readonly failed = (sessionId: string, commandId: string, code: string, message: string): void => {
        this.#loadRequests(sessionId);
        const request = this.#requests.get(commandId);
        if (request?.kind === "executing" && request.commandId === commandId) {
            this.#append(sessionId, { attemptId: request.attemptId, code, commandId, kind: "prompt.failed", message });
        } else {
            this.#append(sessionId, { code, commandId, kind: "prompt.failed-before-start", message });
        }
        this.#requests.delete(commandId);
    };

    readonly executingPromptRequest = (sessionId: string): ExecutingPromptRequestEventLogV2 | null => {
        this.#loadRequests(sessionId);
        const request = [...this.#requests.values()].find(
            (candidate) => candidate.sessionId === sessionId && candidate.kind === "executing",
        );
        if (request?.kind !== "executing") {
            return null;
        }
        const events = request.events.slice(-EXECUTING_PROMPT_EVENT_LIMIT);
        return {
            attemptId: request.attemptId,
            commandId: request.commandId,
            epoch: request.epoch,
            events,
            tailCursor: events.at(-1)?.eventId ?? "",
            truncated: events.length < request.events.length,
        };
    };

    readonly recovery = (
        sessionId: string,
        eventLimit: number,
        cursor: string | null,
    ): NativeSessionEventsV2 | null => {
        const events = this.#eventsFor(sessionId);
        if (events.length === 0) {
            return null;
        }
        const executingPromptRequest = this.executingPromptRequest(sessionId);
        const executingRequestState = [...this.#requests.values()].find(
            (request) => request.sessionId === sessionId && request.kind === "executing",
        );
        const firstExecutingPosition = executingRequestState?.events[0]?.position;
        const historyEvents =
            firstExecutingPosition === undefined
                ? events
                : events.filter((event) => BigInt(event.position) < BigInt(firstExecutingPosition));
        const endEvent = cursor === null ? historyEvents.length : decodeLocalEventCursor(sessionId, cursor).endEvent;
        if (endEvent > historyEvents.length) {
            throw new AcpExecutionError("The native Session event cursor is invalid", {}, "invalid_cursor");
        }
        const startEvent = Math.max(0, endEvent - eventLimit);
        const pageEvents = historyEvents.slice(startEvent, endEvent);
        return {
            executingPromptRequest,
            history: {
                events: pageEvents,
                nextCursor: startEvent === 0 ? null : encodeLocalEventCursor({ endEvent: startEvent, sessionId }),
                tailCursor: pageEvents.at(-1)?.eventId ?? "",
                truncated: startEvent > 0,
                version: 2,
            },
        };
    };
}
