import type { CatalogAgent, LocalAgentCatalogSnapshot } from "../../agent/catalog.ts";
import type { RuntimeConfig } from "../config.ts";
import type { CatalogUpdateLock } from "./catalog-update-lock.ts";

type PublishCatalog = (config: RuntimeConfig, signal: AbortSignal) => Promise<void>;

/**
 * Transitions the catalog and publishes the new snapshot as one serialized critical section.
 * The next snapshot is built from the catalog state the section itself reads, and a failed
 * publication rolls back to that same state; sharing one lock across every catalog writer
 * means the rollback can never overwrite a concurrent update that published after this
 * section started. The returned snapshot is the one this section published, so callers
 * describe their own result rather than whatever the shared catalog holds when they resume.
 */
export async function transitionAndPublishCatalog(
    config: RuntimeConfig,
    build: (current: readonly CatalogAgent[]) => readonly CatalogAgent[],
    publish: PublishCatalog,
    signal: AbortSignal,
    lock?: CatalogUpdateLock,
): Promise<LocalAgentCatalogSnapshot> {
    const critical = async (): Promise<LocalAgentCatalogSnapshot> => {
        const previous = config.catalog.read();
        const next = config.catalog.transition(build(previous.agents));
        try {
            await publish(config, signal);
        } catch (error) {
            config.catalog.transition(previous.agents);
            throw error;
        }
        return next;
    };
    if (lock === undefined) {
        return await critical();
    }
    return (await lock(critical)) as LocalAgentCatalogSnapshot;
}
