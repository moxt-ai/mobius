import type { SessionLiveEventV2 } from "@moxt-ai/mobius-protocol";
import type { AcpNativeEventReplayV2 } from "../acp/session-contracts.ts";
import type { AcpSessionEventStoreV2 } from "../acp/session-event-store-v2.ts";
import { AcpHistoryReplay } from "../acp/session-history.ts";
import type {
    HarnessAdapter,
    HarnessHistoryPageRequest,
    HarnessHistoryPreviewRequest,
    HarnessHistoryRequest,
    HarnessLiveEventSubscriber,
    HarnessLiveEventSubscription,
} from "./harness-adapter.ts";

type HistoryPreviewPagePlan =
    | { readonly kind: "cached"; readonly page: AcpNativeEventReplayV2 }
    | { readonly kind: "load"; readonly token: symbol };

export class AcpHarnessAdapter implements HarnessAdapter {
    readonly id: string;
    protected readonly events: AcpSessionEventStoreV2;
    readonly #historyPreviews = new Map<string, { readonly nativeSessionId: string; readonly token: symbol }>();
    readonly #subscriptions = new Set<{ readonly subscriber: HarnessLiveEventSubscriber }>();
    #lifecycle: "closed" | "open" = "open";

    constructor(id: string, events: AcpSessionEventStoreV2) {
        this.events = events;
        this.id = id;
    }

    readonly readPageHistoryEvents = async (request: HarnessHistoryPageRequest) => await request.readFromHarness();

    readonly readHistory = async (request: HarnessHistoryRequest) => await request.readFromHarness();

    protected readonly planPreviewPage = (request: HarnessHistoryPreviewRequest): HistoryPreviewPagePlan => {
        const preview = this.#historyPreviews.get(request.options.sessionId);
        if (request.cursor !== null) {
            if (preview === undefined || preview.nativeSessionId !== request.nativeSessionId) {
                throw new Error("The native event cursor is invalid");
            }
            return {
                kind: "cached",
                page: this.events.page(request.options.sessionId, request.eventLimit, request.cursor),
            };
        }
        const token = Symbol();
        this.#historyPreviews.set(request.options.sessionId, { nativeSessionId: request.nativeSessionId, token });
        return { kind: "load", token };
    };

    protected readonly failPreviewPage = (sessionId: string, token: symbol): void => {
        if (this.#historyPreviews.get(sessionId)?.token === token) {
            this.#historyPreviews.delete(sessionId);
        }
    };

    protected readonly readHarnessPreviewPage = async (request: HarnessHistoryPreviewRequest) => {
        const plan = this.planPreviewPage(request);
        if (plan.kind === "cached") {
            return plan.page;
        }
        try {
            return await request.readFromHarness();
        } catch (error) {
            this.failPreviewPage(request.options.sessionId, plan.token);
            throw error;
        }
    };

    readonly previewPageHistoryEvents = async (request: HarnessHistoryPreviewRequest) =>
        await this.readHarnessPreviewPage(request);

    readonly createHistoryReplay = (sessionId: string): AcpHistoryReplay =>
        new AcpHistoryReplay(this.events, sessionId);

    readonly removeHistoryEvents = (sessionId: string): void => this.events.remove(sessionId);

    readonly resetHistoryEvents = (sessionId: string): void => this.events.reset(sessionId);

    readonly publishLiveEvent = async (event: SessionLiveEventV2): Promise<void> => {
        for (const subscription of this.#subscriptions) {
            await subscription.subscriber(event);
        }
    };

    readonly subscribeLiveEvents = (subscriber: HarnessLiveEventSubscriber): HarnessLiveEventSubscription => {
        if (this.#lifecycle === "closed") {
            throw new Error("The harness adapter is closed");
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
        this.events.close();
    };
}
