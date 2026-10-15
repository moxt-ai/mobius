import type { SessionLiveEventV2 } from "@moxt-ai/mobius-protocol";
import type { AcpSessionEventStoreV2 } from "../../acp/session-event-store-v2.ts";
import type { AcpHistoryReplay } from "../../acp/session-history.ts";
import { AdapterEventCache } from "../adapter-event-cache.ts";
import type {
    HarnessAdapter,
    HarnessHistoryPageRequest,
    HarnessHistoryPreviewRequest,
    HarnessHistoryRequest,
    HarnessLiveEventSubscriber,
    HarnessLiveEventSubscription,
} from "../harness-adapter.ts";

export class ClaudeHarnessAdapter implements HarnessAdapter {
    readonly id = "claude";
    readonly #eventCache: AdapterEventCache;

    constructor(events: AcpSessionEventStoreV2) {
        this.#eventCache = new AdapterEventCache(events);
    }

    readonly readHistory = async (request: HarnessHistoryRequest) => await request.readFromHarness();

    readonly readPageHistoryEvents = async (request: HarnessHistoryPageRequest) => await request.readFromHarness();

    readonly previewPageHistoryEvents = async (request: HarnessHistoryPreviewRequest) => {
        const plan = this.#eventCache.planPreviewPage(request);
        if (plan.kind === "cached") {
            return plan.page;
        }
        try {
            return await request.readFromHarness();
        } catch (error) {
            this.#eventCache.failPreviewPage(request.options.sessionId, plan.token);
            throw error;
        }
    };

    readonly createHistoryReplay = (sessionId: string): AcpHistoryReplay =>
        this.#eventCache.createHistoryReplay(sessionId);

    readonly removeHistoryEvents = (sessionId: string): void => this.#eventCache.removeHistoryEvents(sessionId);

    readonly resetHistoryEvents = (sessionId: string): void => this.#eventCache.resetHistoryEvents(sessionId);

    readonly publishLiveEvent = async (event: SessionLiveEventV2): Promise<void> =>
        await this.#eventCache.publishLiveEvent(event);

    readonly subscribeLiveEvents = (subscriber: HarnessLiveEventSubscriber): HarnessLiveEventSubscription =>
        this.#eventCache.subscribeLiveEvents(subscriber);

    readonly close = (): void => this.#eventCache.close();
}
