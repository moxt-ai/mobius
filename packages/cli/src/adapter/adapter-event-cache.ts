import type { NativeSessionHistory, SessionLiveEventV2 } from "@moxt-ai/mobius-protocol";
import type { AcpNativeEventReplayV2 } from "../acp/session-contracts.ts";
import type { AcpSessionEventStoreV2 } from "../acp/session-event-store-v2.ts";
import { nativeHistoryEventsV2 } from "../native-sessions/native-history-events-v2.ts";
import type {
    HarnessHistoryPreviewRequest,
    HarnessLiveEventSubscriber,
    HarnessLiveEventSubscription,
} from "./harness-adapter.ts";
import { AdapterOpenedSessionEvents, type OpenedSessionEvents } from "./opened-session-events.ts";

export type AdapterPreviewPagePlan =
    | { readonly kind: "cached"; readonly page: AcpNativeEventReplayV2 }
    | { readonly kind: "load"; readonly token: symbol };

export class AdapterEventCache {
    readonly #events: AcpSessionEventStoreV2;
    readonly #historyPreviews = new Map<string, { readonly nativeSessionId: string; readonly token: symbol }>();
    readonly #openedSessions = new Map<string, AdapterOpenedSessionEvents>();
    readonly #subscriptions = new Set<{ readonly subscriber: HarnessLiveEventSubscriber }>();
    #lifecycle: "closed" | "open" = "open";

    constructor(events: AcpSessionEventStoreV2) {
        this.#events = events;
    }

    readonly planPreviewPage = (request: HarnessHistoryPreviewRequest): AdapterPreviewPagePlan => {
        const preview = this.#historyPreviews.get(request.options.sessionId);
        if (request.cursor !== null) {
            if (preview === undefined || preview.nativeSessionId !== request.nativeSessionId) {
                throw new Error("The native event cursor is invalid");
            }
            return {
                kind: "cached",
                page: this.#events.page(request.options.sessionId, request.eventLimit, request.cursor),
            };
        }
        const token = Symbol();
        this.#historyPreviews.set(request.options.sessionId, { nativeSessionId: request.nativeSessionId, token });
        return { kind: "load", token };
    };

    readonly failPreviewPage = (sessionId: string, token: symbol): void => {
        if (this.#historyPreviews.get(sessionId)?.token === token) {
            this.#historyPreviews.delete(sessionId);
        }
    };

    readonly openSessionEvents = (sessionId: string): OpenedSessionEvents => {
        if (this.#lifecycle === "closed") {
            throw new Error("The harness adapter event cache is closed");
        }
        const existing = this.#openedSessions.get(sessionId);
        if (existing !== undefined) {
            return existing;
        }
        const opened = new AdapterOpenedSessionEvents(
            this.#events,
            sessionId,
            this.publishLiveEvent,
            (closedSessionId) => {
                this.#historyPreviews.delete(closedSessionId);
                this.#events.remove(closedSessionId);
                this.#openedSessions.delete(closedSessionId);
            },
        );
        this.#openedSessions.set(sessionId, opened);
        return opened;
    };

    readonly createSessionEvents = (sessionId: string): OpenedSessionEvents => {
        if (this.#openedSessions.has(sessionId)) {
            throw new Error("The harness session is already open");
        }
        this.#historyPreviews.delete(sessionId);
        this.#events.reset(sessionId);
        return this.openSessionEvents(sessionId);
    };

    readonly materializeNativeHistory = (
        sessionId: string,
        nativeSessionId: string,
        history: Extract<NativeSessionHistory, { readonly status: "available" }>,
        eventLimit: number,
        cursor: string | null,
    ): AcpNativeEventReplayV2 =>
        nativeHistoryEventsV2(sessionId, nativeSessionId, history, eventLimit, cursor, this.#events);

    readonly publishLiveEvent = async (event: SessionLiveEventV2): Promise<void> => {
        for (const subscription of this.#subscriptions) {
            await subscription.subscriber(event);
        }
    };

    readonly subscribeLiveEvents = (subscriber: HarnessLiveEventSubscriber): HarnessLiveEventSubscription => {
        if (this.#lifecycle === "closed") {
            throw new Error("The harness adapter event cache is closed");
        }
        const subscription = { subscriber };
        this.#subscriptions.add(subscription);
        let lifecycle: "closed" | "subscribed" = "subscribed";
        return {
            close: () => {
                if (lifecycle === "closed") {
                    return;
                }
                lifecycle = "closed";
                this.#subscriptions.delete(subscription);
            },
        };
    };

    readonly close = (): void => {
        if (this.#lifecycle === "closed") {
            return;
        }
        this.#lifecycle = "closed";
        this.#subscriptions.clear();
        this.#historyPreviews.clear();
        for (const session of this.#openedSessions.values()) {
            session.shutdown();
        }
        this.#openedSessions.clear();
        this.#events.close();
    };
}
