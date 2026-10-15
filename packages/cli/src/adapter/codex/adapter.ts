import { AcpExecutionError } from "../../acp/acp-error.ts";
import type { AcpSessionEventStoreV2 } from "../../acp/session-event-store-v2.ts";
import { createAcpSession, openAcpSession } from "../acp-session-lifecycle.ts";
import { AdapterEventCache } from "../adapter-event-cache.ts";
import type {
    HarnessAdapter,
    HarnessCreateSessionRequest,
    HarnessHistoryPageRequest,
    HarnessHistoryPreviewRequest,
    HarnessLiveEventSubscriber,
    HarnessLiveEventSubscription,
    HarnessNativeHistoryReader,
    HarnessOpenSessionRequest,
    OpenedSession,
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
                read: async (nativeSessionId) =>
                    (await readCodexFullHistory(options.agent, options.cwd, nativeSessionId, options.signal)).history,
            }),
        },
    ) {
        this.#eventCache = new AdapterEventCache(events);
        this.#nativeHistory = nativeHistory;
    }

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
            const history = await access.read(request.nativeSessionId);
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

    readonly createSession = async (request: HarnessCreateSessionRequest): Promise<OpenedSession> =>
        await createAcpSession(this.id, this.#eventCache, request);

    readonly openSession = async (request: HarnessOpenSessionRequest): Promise<OpenedSession> =>
        await openAcpSession(this.#eventCache, request);

    readonly subscribeLiveEvents = (subscriber: HarnessLiveEventSubscriber): HarnessLiveEventSubscription =>
        this.#eventCache.subscribeLiveEvents(subscriber);

    readonly close = (): void => this.#eventCache.close();
}
