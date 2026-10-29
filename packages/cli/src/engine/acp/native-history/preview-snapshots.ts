import { MemorySessionEventStore } from "../../session/history/session-event-store.ts";
import { AcpExecutionError } from "../acp-error.ts";
import type { NativeSessionPreviewKey } from "../adapter/query-scope.ts";

/** Snapshot lifetime is independent of the client that produced its events. */
export class NativeHistoryPreviewSnapshots {
    readonly #snapshots = new Map<NativeSessionPreviewKey, MemorySessionEventStore>();

    readonly replace = (key: NativeSessionPreviewKey): MemorySessionEventStore => {
        this.#snapshots.get(key)?.close();
        const store = new MemorySessionEventStore();
        this.#snapshots.set(key, store);
        return store;
    };

    readonly get = (key: NativeSessionPreviewKey): MemorySessionEventStore => {
        const store = this.#snapshots.get(key);
        if (store === undefined) {
            throw new AcpExecutionError("The native event cursor is invalid", {}, "invalid_native_session_response");
        }
        return store;
    };

    readonly discard = (key: NativeSessionPreviewKey, store: MemorySessionEventStore): void => {
        if (this.#snapshots.get(key) === store) {
            this.#snapshots.delete(key);
        }
        store.close();
    };

    readonly close = (): void => {
        for (const store of this.#snapshots.values()) {
            store.close();
        }
        this.#snapshots.clear();
    };
}
