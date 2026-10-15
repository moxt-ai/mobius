import type { SessionLiveEventV2 } from "@moxt-ai/mobius-protocol";
import type { AcpSessionEventStoreV2 } from "../acp/session-event-store-v2.ts";
import type {
    HarnessAdapter,
    HarnessHistoryPageRequest,
    HarnessHistoryPreviewRequest,
    HarnessHistoryRequest,
    HarnessLiveEventSubscriber,
    HarnessLiveEventSubscription,
} from "./harness-adapter.ts";

export class AcpHarnessAdapter implements HarnessAdapter {
    readonly events: AcpSessionEventStoreV2;
    readonly id: string;
    readonly #subscriptions = new Set<{ readonly subscriber: HarnessLiveEventSubscriber }>();
    #lifecycle: "closed" | "open" = "open";

    constructor(id: string, events: AcpSessionEventStoreV2) {
        this.events = events;
        this.id = id;
    }

    readonly readPageHistoryEvents = async (request: HarnessHistoryPageRequest) => await request.readFromHarness();

    readonly readHistory = async (request: HarnessHistoryRequest) => await request.readFromHarness();

    readonly previewPageHistoryEvents = async (request: HarnessHistoryPreviewRequest) =>
        await request.readFromHarness();

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
        this.events.close();
    };
}
