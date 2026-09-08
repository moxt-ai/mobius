import {
    type CommittedSessionEvent,
    encodeCommittedSessionEvent,
    MOBIUS_EVENT_FORMAT_VERSION,
    MOBIUS_SESSION_EVENT_STREAM_EVENT,
    MOBIUS_SESSION_EVENT_STREAM_MEDIA_TYPE,
} from "@moxt-ai/mobius-protocol";

import type { ProjectScope, SessionEventPage, SessionQueryPort } from "./session-runtime.ts";

const CATCH_UP_PAGE_SIZE = 100;
const EVENT_BUFFER_CAPACITY = 256;
const HEARTBEAT_INTERVAL_MILLISECONDS = 15_000;

function streamKey(scope: ProjectScope, sessionId: string): string {
    return `${scope.tenantId}\u0000${scope.projectId}\u0000${sessionId}`;
}

function compareEventSequence(left: CommittedSessionEvent, right: CommittedSessionEvent): number {
    const leftSequence = BigInt(left.sequence);
    const rightSequence = BigInt(right.sequence);
    if (leftSequence < rightSequence) {
        return -1;
    }
    if (leftSequence > rightSequence) {
        return 1;
    }
    return 0;
}

class SessionEventSubscriber {
    readonly #abortController = new AbortController();
    readonly #controller: ReadableStreamDefaultController<Uint8Array>;
    readonly #encoder = new TextEncoder();
    readonly #onClose: () => void;
    readonly #queuedEvents: CommittedSessionEvent[] = [];
    readonly #requestSignal: AbortSignal;
    readonly #waitingLiveEvents: CommittedSessionEvent[] = [];
    #catchingUp = true;
    #closed = false;
    #hasQueuedSequence = false;
    #heartbeatId: ReturnType<typeof globalThis.setInterval>;
    #lastQueuedSequence = 0n;

    constructor(
        controller: ReadableStreamDefaultController<Uint8Array>,
        requestSignal: AbortSignal,
        onClose: () => void,
    ) {
        this.#controller = controller;
        this.#onClose = onClose;
        this.#requestSignal = requestSignal;
        this.#requestSignal.addEventListener("abort", this.close, { once: true });
        this.#heartbeatId = globalThis.setInterval(this.writeHeartbeat, HEARTBEAT_INTERVAL_MILLISECONDS);
    }

    get active(): boolean {
        return !this.#closed;
    }

    get signal(): AbortSignal {
        return this.#abortController.signal;
    }

    readonly publish = (event: CommittedSessionEvent): void => {
        if (this.#closed) {
            return;
        }
        if (this.#catchingUp) {
            if (this.#waitingLiveEvents.length >= EVENT_BUFFER_CAPACITY) {
                this.fail(new Error("The live Session event buffer filled before catch-up completed"));
                return;
            }
            this.#waitingLiveEvents.push(event);
            return;
        }
        this.queue(event);
    };

    readonly queueCatchUp = (event: CommittedSessionEvent): void => {
        if (!this.#closed) {
            this.queue(event);
        }
    };

    readonly finishCatchUp = (): void => {
        if (this.#closed) {
            return;
        }
        this.#catchingUp = false;
        for (const event of this.#waitingLiveEvents.toSorted(compareEventSequence)) {
            this.queue(event);
            if (this.#closed) {
                return;
            }
        }
        this.#waitingLiveEvents.length = 0;
        this.flush();
    };

    readonly pull = (): void => {
        this.flush();
    };

    readonly fail = (error: unknown): void => {
        if (this.#closed) {
            return;
        }
        this.release();
        this.#controller.error(error);
    };

    readonly close = (): void => {
        if (this.#closed) {
            return;
        }
        this.release();
        try {
            this.#controller.close();
        } catch {
            return;
        }
    };

    private readonly queue = (event: CommittedSessionEvent): void => {
        const sequence = BigInt(event.sequence);
        if (this.#hasQueuedSequence && sequence <= this.#lastQueuedSequence) {
            return;
        }
        if (this.#queuedEvents.length >= EVENT_BUFFER_CAPACITY) {
            this.fail(new Error("The Session event consumer is too slow"));
            return;
        }
        this.#hasQueuedSequence = true;
        this.#lastQueuedSequence = sequence;
        this.#queuedEvents.push(event);
        this.flush();
    };

    private readonly flush = (): void => {
        while (!this.#closed && this.#queuedEvents.length > 0 && (this.#controller.desiredSize ?? 0) > 0) {
            const event = this.#queuedEvents.shift();
            if (event === undefined) {
                return;
            }
            this.#controller.enqueue(
                this.#encoder.encode(
                    `id: ${event.cursor}\nevent: ${MOBIUS_SESSION_EVENT_STREAM_EVENT}\ndata: ${encodeCommittedSessionEvent(event)}\n\n`,
                ),
            );
        }
    };

    private readonly writeHeartbeat = (): void => {
        if (this.#closed || this.#queuedEvents.length > 0 || (this.#controller.desiredSize ?? 0) <= 0) {
            return;
        }
        this.#controller.enqueue(this.#encoder.encode(": heartbeat\n\n"));
    };

    private readonly release = (): void => {
        this.#closed = true;
        globalThis.clearInterval(this.#heartbeatId);
        this.#requestSignal.removeEventListener("abort", this.close);
        this.#abortController.abort(new Error("The Session event stream closed"));
        this.#onClose();
    };
}

export class SessionEventStreams {
    readonly #queries: SessionQueryPort;
    readonly #subscribers = new Map<string, Set<SessionEventSubscriber>>();

    constructor(queries: SessionQueryPort) {
        this.#queries = queries;
    }

    readonly open = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        signal: AbortSignal,
    ): Promise<Response> => {
        signal.throwIfAborted();
        await this.#queries.readSession(scope, sessionId, signal);
        signal.throwIfAborted();
        const key = streamKey(scope, sessionId);
        let cancel = (): void => {};
        let pull = (): void => {};
        let resolveSubscriber = (_subscriber: SessionEventSubscriber): void => {};
        const subscriberReady = new Promise<SessionEventSubscriber>((resolve) => {
            resolveSubscriber = resolve;
        });
        const body = new ReadableStream<Uint8Array>({
            cancel: () => cancel(),
            pull: () => pull(),
            start: (controller) => {
                const subscriber = new SessionEventSubscriber(controller, signal, () => this.remove(key, subscriber));
                cancel = subscriber.close;
                pull = subscriber.pull;
                this.add(key, subscriber);
                resolveSubscriber(subscriber);
            },
        });
        const subscriber = await subscriberReady;
        try {
            const page = await this.#queries.readEvents(
                scope,
                sessionId,
                cursor.length === 0 ? null : cursor,
                CATCH_UP_PAGE_SIZE,
                subscriber.signal,
            );
            for (const event of page.events) {
                subscriber.queueCatchUp(event);
            }
            if (page.hasMore) {
                const catchUp = this.catchUp(subscriber, scope, sessionId, page.cursor);
                void catchUp.catch(subscriber.fail);
            } else {
                subscriber.finishCatchUp();
            }
        } catch (cause) {
            subscriber.close();
            throw cause;
        }
        return new Response(body, {
            headers: {
                "cache-control": "no-cache, no-transform",
                "content-type": `${MOBIUS_SESSION_EVENT_STREAM_MEDIA_TYPE}; charset=utf-8`,
                "x-mobius-event-format": MOBIUS_EVENT_FORMAT_VERSION,
            },
        });
    };

    readonly publish = (scope: ProjectScope, event: CommittedSessionEvent): void => {
        const subscribers = this.#subscribers.get(streamKey(scope, event.sessionId));
        if (subscribers === undefined) {
            return;
        }
        for (const subscriber of subscribers) {
            subscriber.publish(event);
        }
    };

    readonly close = (): void => {
        for (const subscribers of this.#subscribers.values()) {
            for (const subscriber of subscribers) {
                subscriber.close();
            }
        }
        this.#subscribers.clear();
    };

    private readonly catchUp = async (
        subscriber: SessionEventSubscriber,
        scope: ProjectScope,
        sessionId: string,
        initialCursor: string,
    ): Promise<void> => {
        let cursor = initialCursor;
        let page: SessionEventPage;
        do {
            subscriber.signal.throwIfAborted();
            page = await this.#queries.readEvents(scope, sessionId, cursor, CATCH_UP_PAGE_SIZE, subscriber.signal);
            for (const event of page.events) {
                subscriber.queueCatchUp(event);
            }
            cursor = page.cursor;
        } while (page.hasMore && subscriber.active);
        subscriber.finishCatchUp();
    };

    private readonly add = (key: string, subscriber: SessionEventSubscriber): void => {
        const existing = this.#subscribers.get(key);
        if (existing === undefined) {
            this.#subscribers.set(key, new Set([subscriber]));
            return;
        }
        existing.add(subscriber);
    };

    private readonly remove = (key: string, subscriber: SessionEventSubscriber): void => {
        const existing = this.#subscribers.get(key);
        if (existing === undefined) {
            return;
        }
        existing.delete(subscriber);
        if (existing.size === 0) {
            this.#subscribers.delete(key);
        }
    };
}
