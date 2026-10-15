import type { SessionLiveEventV2 } from "@moxt-ai/mobius-protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
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
    HarnessNativeHistoryReader,
} from "../harness-adapter.ts";
import { readCodexFullHistory } from "./history.ts";

export class CodexHarnessAdapter implements HarnessAdapter {
    readonly id = "codex";
    readonly #eventCache: AdapterEventCache;
    readonly #nativeHistory: HarnessNativeHistoryReader;

    constructor(
        events: AcpSessionEventStoreV2,
        nativeHistory: HarnessNativeHistoryReader = {
            access: (options) => ({
                kind: "direct",
                read: async (nativeSessionId, nativeTurn) =>
                    (
                        await readCodexFullHistory(
                            options.agent,
                            options.cwd,
                            nativeSessionId,
                            options.signal,
                            nativeTurn,
                        )
                    ).history,
            }),
        },
    ) {
        this.#eventCache = new AdapterEventCache(events);
        this.#nativeHistory = nativeHistory;
    }

    readonly readHistory = async (request: HarnessHistoryRequest) => {
        const access = this.#nativeHistory.access(request.options);
        return access.kind === "direct"
            ? await access.read(request.nativeSessionId, request.nativeTurn)
            : await request.readFromHarness();
    };

    readonly readPageHistoryEvents = async (request: HarnessHistoryPageRequest) => await request.readFromHarness();

    readonly previewPageHistoryEvents = async (request: HarnessHistoryPreviewRequest) => {
        const plan = this.#eventCache.planPreviewPage(request);
        if (plan.kind === "cached") {
            return plan.page;
        }
        try {
            const access = this.#nativeHistory.access(request.options);
            if (access.kind === "acp") {
                return await request.readFromHarness();
            }
            const history = await access.read(request.nativeSessionId, () => null);
            if (history.status === "unavailable") {
                throw new AcpExecutionError(history.cause.message, {}, history.cause.code);
            }
            return this.#eventCache.materializeNativeHistory(
                request.options.sessionId,
                request.nativeSessionId,
                history,
                request.eventLimit,
                request.cursor,
            );
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
