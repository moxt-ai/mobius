import {
    type CommittedSessionEvent,
    encodeCommittedSessionEvent,
    MOBIUS_EVENT_FORMAT_VERSION,
    MOBIUS_SESSION_EVENT_STREAM_EVENT,
    MOBIUS_SESSION_EVENT_STREAM_MEDIA_TYPE,
} from "@moxt-ai/mobius-protocol";
import { type ProjectScope, type SessionEventPage, SessionRuntimeError } from "../../entity/do/session.ts";
import type { SessionQueryGateway } from "../../gateway/index.ts";

const CATCH_UP_PAGE_SIZE = 100;
const EVENT_BUFFER_CAPACITY = 256;
const HEARTBEAT_INTERVAL_MILLISECONDS = 15_000;
const MAX_EVENT_WAIT_MILLISECONDS = 10_000;

function streamKey(scope: ProjectScope, sessionId: string): string {
    return `${scope.projectId}\u0000${sessionId}`;
}

class SessionEventSubscriber {
    readonly #abortController = new AbortController();
    readonly #catchUpCapacityWaiters = new Set<() => void>();
    readonly #controller: ReadableStreamDefaultController<Uint8Array>;
    readonly #encoder = new TextEncoder();
    readonly #onClose: () => void;
    readonly #queuedEvents: CommittedSessionEvent[] = [];
    readonly #requestSignal: AbortSignal;
    #catchingUp = true;
    #closed = false;
    #hasQueuedSequence = false;
    #heartbeatId: ReturnType<typeof globalThis.setInterval>;
    #lastQueuedSequence = 0n;
    #latestPublishedSequence = 0n;

    constructor(
        controller: ReadableStreamDefaultController<Uint8Array>,
        requestSignal: AbortSignal,
        onClose: () => void,
    ) {
        this.#controller = controller;
        this.#onClose = onClose;
        this.#requestSignal = requestSignal;
        this.#requestSignal.addEventListener("abort", this.close, { once: true });
        this.#controller.enqueue(this.#encoder.encode(": connected\n\n"));
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
            const sequence = BigInt(event.sequence);
            if (sequence > this.#latestPublishedSequence) {
                this.#latestPublishedSequence = sequence;
            }
            return;
        }
        this.queue(event);
    };

    readonly queueCatchUp = async (event: CommittedSessionEvent): Promise<void> => {
        this.#abortController.signal.throwIfAborted();
        while (this.#queuedEvents.length >= EVENT_BUFFER_CAPACITY) {
            await this.waitForCatchUpCapacity();
            this.#abortController.signal.throwIfAborted();
        }
        this.queue(event);
    };

    readonly needsCatchUp = (): boolean => this.#latestPublishedSequence > this.#lastQueuedSequence;

    readonly finishCatchUp = (): void => {
        if (this.#closed) {
            return;
        }
        this.#catchingUp = false;
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
        this.notifyCatchUpCapacity();
    };

    private readonly notifyCatchUpCapacity = (): void => {
        if (this.#queuedEvents.length >= EVENT_BUFFER_CAPACITY) {
            return;
        }
        for (const waiter of [...this.#catchUpCapacityWaiters]) {
            waiter();
        }
    };

    private readonly waitForCatchUpCapacity = async (): Promise<void> => {
        if (this.#queuedEvents.length < EVENT_BUFFER_CAPACITY) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const cleanup = (): void => {
                this.#catchUpCapacityWaiters.delete(capacityAvailable);
                this.#abortController.signal.removeEventListener("abort", aborted);
            };
            const capacityAvailable = (): void => {
                cleanup();
                resolve();
            };
            const aborted = (): void => {
                cleanup();
                reject(this.#abortController.signal.reason);
            };
            this.#catchUpCapacityWaiters.add(capacityAvailable);
            this.#abortController.signal.addEventListener("abort", aborted, { once: true });
        });
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

class SessionEventWaiter {
    readonly #completion = Promise.withResolvers<void>();
    readonly #requestSignal: AbortSignal;
    readonly #timeoutId: ReturnType<typeof globalThis.setTimeout>;
    #active = true;

    constructor(requestSignal: AbortSignal, waitMilliseconds: number) {
        requestSignal.throwIfAborted();
        this.#requestSignal = requestSignal;
        this.#requestSignal.addEventListener("abort", this.abort, { once: true });
        this.#timeoutId = globalThis.setTimeout(this.notify, waitMilliseconds);
    }

    get completed(): Promise<void> {
        return this.#completion.promise;
    }

    readonly notify = (): void => {
        if (!this.#active) {
            return;
        }
        this.dispose();
        this.#completion.resolve();
    };

    readonly fail = (error: unknown): void => {
        if (!this.#active) {
            return;
        }
        this.dispose();
        this.#completion.reject(error);
    };

    readonly dispose = (): void => {
        if (!this.#active) {
            return;
        }
        this.#active = false;
        globalThis.clearTimeout(this.#timeoutId);
        this.#requestSignal.removeEventListener("abort", this.abort);
    };

    private readonly abort = (): void => this.fail(this.#requestSignal.reason);
}

export class SessionEventStreams {
    readonly #queries: SessionQueryGateway;
    readonly #subscribers = new Map<string, Set<SessionEventSubscriber>>();
    readonly #waiters = new Map<string, Set<SessionEventWaiter>>();

    constructor(cx: { readonly gateways: { readonly queries: SessionQueryGateway } }) {
        const { queries } = cx.gateways;
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
                await subscriber.queueCatchUp(event);
            }
            if (page.hasMore || subscriber.needsCatchUp()) {
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
        const key = streamKey(scope, event.sessionId);
        const subscribers = this.#subscribers.get(key);
        if (subscribers !== undefined) {
            for (const subscriber of subscribers) {
                subscriber.publish(event);
            }
        }
        const waiters = this.#waiters.get(key);
        if (waiters !== undefined) {
            for (const waiter of [...waiters]) {
                waiter.notify();
            }
        }
    };

    readonly wait = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        limit: number,
        waitMilliseconds: number,
        signal: AbortSignal,
    ): Promise<SessionEventPage> => {
        signal.throwIfAborted();
        if (
            !Number.isSafeInteger(waitMilliseconds) ||
            waitMilliseconds < 1 ||
            waitMilliseconds > MAX_EVENT_WAIT_MILLISECONDS
        ) {
            throw new SessionRuntimeError("invalid_request", "The Session event wait is invalid");
        }
        const key = streamKey(scope, sessionId);
        const waiter = new SessionEventWaiter(signal, waitMilliseconds);
        this.addWaiter(key, waiter);
        try {
            const internalCursor = cursor.length === 0 ? null : cursor;
            const initial = await this.#queries.readEvents(scope, sessionId, internalCursor, limit, signal);
            if (initial.events.length > 0 || initial.hasMore) {
                return initial;
            }
            await waiter.completed;
            signal.throwIfAborted();
            return await this.#queries.readEvents(scope, sessionId, internalCursor, limit, signal);
        } finally {
            this.removeWaiter(key, waiter);
            waiter.dispose();
        }
    };

    readonly close = (): void => {
        for (const subscribers of this.#subscribers.values()) {
            for (const subscriber of subscribers) {
                subscriber.close();
            }
        }
        this.#subscribers.clear();
        for (const waiters of this.#waiters.values()) {
            for (const waiter of waiters) {
                waiter.fail(new SessionRuntimeError("session_storage_unavailable", "The Session event wait closed"));
            }
        }
        this.#waiters.clear();
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
                await subscriber.queueCatchUp(event);
            }
            cursor = page.cursor;
        } while ((page.hasMore || subscriber.needsCatchUp()) && subscriber.active);
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

    private readonly addWaiter = (key: string, waiter: SessionEventWaiter): void => {
        const existing = this.#waiters.get(key);
        if (existing === undefined) {
            this.#waiters.set(key, new Set([waiter]));
            return;
        }
        existing.add(waiter);
    };

    private readonly removeWaiter = (key: string, waiter: SessionEventWaiter): void => {
        const existing = this.#waiters.get(key);
        if (existing === undefined) {
            return;
        }
        existing.delete(waiter);
        if (existing.size === 0) {
            this.#waiters.delete(key);
        }
    };
}
