import type { OpenedSession } from "../adapter/harness-adapter.ts";

type Resource = { readonly kind: "empty" } | { readonly kind: "ready"; readonly runtime: OpenedSession };
type Lifecycle =
    | Resource
    | {
          readonly kind: "preparing";
          readonly completion: Promise<OpenedSession>;
          readonly resource: Resource;
      };
interface Entry {
    readonly lifecycle: Lifecycle;
    readonly users: number;
}
interface RetainedSessionEvents {
    readonly touch: (runtime: OpenedSession) => void;
    readonly changed: () => void;
}

/** Tracks reusable Agent processes and their preparation/borrow lifetimes. */
export class RetainedAgentProcesses {
    readonly #entries = new Map<string, Entry>();
    readonly #events: RetainedSessionEvents;
    constructor(events: RetainedSessionEvents) {
        this.#events = events;
    }

    readonly #entry = (id: string): Entry => this.#entries.get(id) ?? { lifecycle: { kind: "empty" }, users: 0 };
    readonly #write = (id: string, entry: Entry): void => {
        if (entry.lifecycle.kind === "empty" && entry.users === 0) {
            this.#entries.delete(id);
        } else {
            this.#entries.set(id, entry);
        }
    };
    readonly #resource = (entry: Entry): Resource =>
        entry.lifecycle.kind === "preparing" ? entry.lifecycle.resource : entry.lifecycle;
    readonly get = (id: string): OpenedSession | undefined => {
        const resource = this.#resource(this.#entry(id));
        return resource.kind === "ready" ? resource.runtime : undefined;
    };
    readonly pending = (id: string): Promise<OpenedSession> | undefined => {
        const state = this.#entry(id).lifecycle;
        return state.kind === "preparing" ? state.completion : undefined;
    };
    readonly isBusy = (id: string): boolean => {
        const entry = this.#entry(id);
        return entry.users > 0 || entry.lifecycle.kind === "preparing";
    };
    readonly touch = (id: string, expected = this.get(id)): void => {
        if (expected !== undefined && this.get(id) === expected) {
            this.#events.touch(expected);
        }
    };
    readonly #setResource = (id: string, resource: Resource): void => {
        const entry = this.#entry(id);
        this.#write(id, {
            ...entry,
            lifecycle: entry.lifecycle.kind === "preparing" ? { ...entry.lifecycle, resource } : resource,
        });
    };
    readonly retain = (id: string, runtime: OpenedSession): void => {
        this.#setResource(id, { kind: "ready", runtime });
    };
    readonly detach = (id: string, expected: OpenedSession): boolean => {
        if (this.get(id) !== expected) {
            return false;
        }
        this.#setResource(id, { kind: "empty" });
        return true;
    };
    readonly entries = (): readonly (readonly [string, OpenedSession])[] => {
        const result: (readonly [string, OpenedSession])[] = [];
        for (const id of this.#entries.keys()) {
            const runtime = this.get(id);
            if (runtime !== undefined) {
                result.push([id, runtime]);
            }
        }
        return result;
    };
    readonly prepare = (id: string, start: () => Promise<OpenedSession>): Promise<OpenedSession> => {
        const pending = this.pending(id);
        if (pending !== undefined) {
            return pending;
        }
        const completion = Promise.withResolvers<OpenedSession>();
        const entry = this.#entry(id);
        this.#write(id, {
            ...entry,
            lifecycle: {
                kind: "preparing",
                completion: completion.promise,
                resource: this.#resource(entry),
            },
        });
        const run = async (): Promise<OpenedSession> => {
            try {
                return await start();
            } finally {
                const current = this.#entry(id);
                if (current.lifecycle.kind === "preparing" && current.lifecycle.completion === completion.promise) {
                    this.#write(id, { ...current, lifecycle: current.lifecycle.resource });
                }
                this.#events.changed();
            }
        };
        void run().then(completion.resolve, completion.reject);
        return completion.promise;
    };
    readonly use = async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
        const entry = this.#entry(id);
        this.#write(id, { ...entry, users: entry.users + 1 });
        this.touch(id);
        try {
            return await operation();
        } finally {
            const current = this.#entry(id);
            this.#write(id, { ...current, users: current.users - 1 });
            this.touch(id);
            this.#events.changed();
        }
    };
}
