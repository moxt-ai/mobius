import { type AcpSessionEventStoreV2, MemoryAcpSessionEventStoreV2 } from "../acp/session-event-store-v2.ts";
import { AcpHarnessAdapter } from "./acp-harness-adapter.ts";
import { ClaudeHarnessAdapter } from "./claude/adapter.ts";
import { CodexHarnessAdapter } from "./codex/adapter.ts";
import {
    acpHarnessNativeHistoryReader,
    type HarnessAdapter,
    type HarnessLiveEventSubscriber,
    type HarnessLiveEventSubscription,
    type HarnessNativeHistoryReader,
} from "./harness-adapter.ts";
import { PiHarnessAdapter } from "./pi/adapter.ts";

export type HarnessEventStoreFactory = (adapterId: string) => AcpSessionEventStoreV2;

interface RegistryLiveEventSubscription {
    readonly adapters: Map<string, HarnessLiveEventSubscription>;
    readonly subscriber: HarnessLiveEventSubscriber;
}

export class HarnessAdapterRegistry {
    readonly #adapters = new Map<string, HarnessAdapter>();
    readonly #eventStoreFactory: HarnessEventStoreFactory;
    readonly #subscriptions = new Set<RegistryLiveEventSubscription>();
    #lifecycle: "closed" | "open" = "open";

    constructor(adapters: readonly HarnessAdapter[], eventStoreFactory: HarnessEventStoreFactory) {
        this.#eventStoreFactory = eventStoreFactory;
        for (const adapter of adapters) {
            if (this.#adapters.has(adapter.id)) {
                throw new Error(`Duplicate harness adapter: ${adapter.id}`);
            }
            this.#adapters.set(adapter.id, adapter);
        }
    }

    static readonly inMemory = (
        nativeHistory: HarnessNativeHistoryReader = acpHarnessNativeHistoryReader,
    ): HarnessAdapterRegistry => {
        const eventStoreFactory = () => new MemoryAcpSessionEventStoreV2();
        return new HarnessAdapterRegistry(
            [
                new CodexHarnessAdapter(eventStoreFactory(), nativeHistory),
                new ClaudeHarnessAdapter(eventStoreFactory()),
                new PiHarnessAdapter(eventStoreFactory()),
            ],
            eventStoreFactory,
        );
    };

    static readonly create = (
        eventStoreFactory: HarnessEventStoreFactory,
        nativeHistory?: HarnessNativeHistoryReader,
    ): HarnessAdapterRegistry => {
        const eventStores: AcpSessionEventStoreV2[] = [];
        const createEventStore = (adapterId: string): AcpSessionEventStoreV2 => {
            const events = eventStoreFactory(adapterId);
            eventStores.push(events);
            return events;
        };
        try {
            return new HarnessAdapterRegistry(
                [
                    new CodexHarnessAdapter(createEventStore("codex"), nativeHistory),
                    new ClaudeHarnessAdapter(createEventStore("claude")),
                    new PiHarnessAdapter(createEventStore("pi")),
                ],
                () => new MemoryAcpSessionEventStoreV2(),
            );
        } catch (error) {
            for (const events of eventStores) {
                events.close();
            }
            throw error;
        }
    };

    readonly forAgent = (agentId: string): HarnessAdapter => {
        if (this.#lifecycle === "closed") {
            throw new Error("The harness adapter registry is closed");
        }
        const existing = this.#adapters.get(agentId);
        if (existing !== undefined) {
            return existing;
        }
        const adapter = new AcpHarnessAdapter(agentId, this.#eventStoreFactory(agentId));
        this.#adapters.set(agentId, adapter);
        for (const subscription of this.#subscriptions) {
            subscription.adapters.set(agentId, adapter.subscribeLiveEvents(subscription.subscriber));
        }
        return adapter;
    };

    readonly subscribeLiveEvents = (subscriber: HarnessLiveEventSubscriber): HarnessLiveEventSubscription => {
        if (this.#lifecycle === "closed") {
            throw new Error("The harness adapter registry is closed");
        }
        const subscription = {
            adapters: new Map(
                [...this.#adapters].map(([id, adapter]) => [id, adapter.subscribeLiveEvents(subscriber)]),
            ),
            subscriber,
        };
        this.#subscriptions.add(subscription);
        let lifecycle: "closed" | "subscribed" = "subscribed";
        return {
            close: () => {
                if (lifecycle === "closed") {
                    return;
                }
                lifecycle = "closed";
                this.#subscriptions.delete(subscription);
                for (const adapterSubscription of subscription.adapters.values()) {
                    adapterSubscription.close();
                }
                subscription.adapters.clear();
            },
        };
    };

    readonly close = (): void => {
        if (this.#lifecycle === "closed") {
            return;
        }
        this.#lifecycle = "closed";
        for (const subscription of this.#subscriptions) {
            for (const adapterSubscription of subscription.adapters.values()) {
                adapterSubscription.close();
            }
            subscription.adapters.clear();
        }
        this.#subscriptions.clear();
        for (const adapter of this.#adapters.values()) {
            adapter.close();
        }
        this.#adapters.clear();
    };
}
