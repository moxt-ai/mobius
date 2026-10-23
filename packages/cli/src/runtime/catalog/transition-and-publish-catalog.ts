import type { CatalogAgent } from "../../agent/catalog.ts";
import type { RuntimeConfig } from "../config.ts";
import type { CatalogUpdateLock } from "./catalog-update-lock.ts";

type PublishCatalog = (config: RuntimeConfig, signal: AbortSignal) => Promise<void>;

/**
 * Transitions the catalog and publishes the new snapshot as one serialized critical section.
 * The next snapshot is built from the catalog state the section itself reads, and a failed
 * publication rolls back to that same state; sharing one lock across every catalog writer
 * means the rollback can never overwrite a concurrent update that published after this
 * section started.
 */
export async function transitionAndPublishCatalog(
    config: RuntimeConfig,
    build: (current: readonly CatalogAgent[]) => readonly CatalogAgent[],
    publish: PublishCatalog,
    signal: AbortSignal,
    lock?: CatalogUpdateLock,
): Promise<void> {
    const critical = async (): Promise<void> => {
        const previous = config.catalog.read();
        config.catalog.transition(build(previous.agents));
        try {
            await publish(config, signal);
        } catch (error) {
            config.catalog.transition(previous.agents);
            throw error;
        }
    };
    if (lock === undefined) {
        await critical();
        return;
    }
    await lock(critical);
}
