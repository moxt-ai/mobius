/**
 * Serializes catalog snapshot transitions and their Relay publications. The lazy per-Agent
 * resolver and the full catalog discovery both commit through this lock, so one writer's
 * failed-publication rollback restores the snapshot its own critical section read instead of
 * overwriting a concurrent swap that already published successfully.
 */
export type CatalogUpdateLock = (update: () => Promise<unknown>) => Promise<unknown>;

export function createCatalogUpdateLock(): CatalogUpdateLock {
    let tail: Promise<unknown> = Promise.resolve();
    return (update: () => Promise<unknown>): Promise<unknown> => {
        const result = tail.then(update, update);
        tail = result.catch(() => undefined);
        return result;
    };
}
