import { CachedSessionEventStore } from "../../session/history/session-event-store.ts";
import { openTemporarySessionEventCache } from "../../storage/session/temporary-session-event-cache.ts";

export interface PreviewEventCache {
    readonly events: CachedSessionEventStore;
    readonly close: () => void;
}

/** A disposable, adapter-private spill tier, never shared with live Session events. */
export function openPreviewEventCache(): PreviewEventCache {
    const cache = openTemporarySessionEventCache();
    const positions = new Map<string, number>();
    try {
        const events = new CachedSessionEventStore(cache.table, {
            allocate: (sessionId) => {
                const next = (positions.get(sessionId) ?? 0) + 1;
                positions.set(sessionId, next);
                return next;
            },
        });
        return {
            events,
            close: (): void => {
                try {
                    events.close();
                } finally {
                    cache.removeFiles();
                }
            },
        };
    } catch (error) {
        try {
            cache.table.close();
        } finally {
            cache.removeFiles();
        }
        throw error;
    }
}
