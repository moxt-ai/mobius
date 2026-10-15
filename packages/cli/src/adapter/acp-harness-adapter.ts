import type { AcpSessionEventStoreV2 } from "../acp/session-event-store-v2.ts";
import { createAcpSession, openAcpSession } from "./acp-session-lifecycle.ts";
import { AdapterEventCache } from "./adapter-event-cache.ts";
import type {
    HarnessAdapter,
    HarnessCreateSessionRequest,
    HarnessHistoryPageRequest,
    HarnessHistoryPreviewRequest,
    HarnessLiveEventSubscriber,
    HarnessLiveEventSubscription,
    HarnessOpenSessionRequest,
    OpenedSession,
} from "./harness-adapter.ts";

export class AcpHarnessAdapter implements HarnessAdapter {
    readonly id: string;
    readonly #eventCache: AdapterEventCache;

    constructor(id: string, events: AcpSessionEventStoreV2) {
        this.id = id;
        this.#eventCache = new AdapterEventCache(events);
    }

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

    readonly createSession = async (request: HarnessCreateSessionRequest): Promise<OpenedSession> =>
        await createAcpSession(this.id, this.#eventCache, request);

    readonly openSession = async (request: HarnessOpenSessionRequest): Promise<OpenedSession> =>
        await openAcpSession(this.#eventCache, request);

    readonly subscribeLiveEvents = (subscriber: HarnessLiveEventSubscriber): HarnessLiveEventSubscription =>
        this.#eventCache.subscribeLiveEvents(subscriber);

    readonly close = (): void => this.#eventCache.close();
}
