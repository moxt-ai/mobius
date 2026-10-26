type Resource<P> = { readonly kind: "empty" } | { readonly kind: "ready"; readonly runtime: P };
type Lifecycle<P> =
    | Resource<P>
    | {
          readonly kind: "preparing";
          readonly completion: Promise<P>;
          readonly resource: Resource<P>;
      };
interface Entry<P> {
    readonly lifecycle: Lifecycle<P>;
    readonly users: number;
}
interface RetainedSessionEvents<P> {
    readonly touch: (runtime: P) => void;
    readonly changed: () => void;
}

/** Tracks reusable Agent processes and their preparation/borrow lifetimes. */
export class RetainedAgentProcesses<P> {
    readonly #entries = new Map<string, Entry<P>>();
    readonly #events: RetainedSessionEvents<P>;
    constructor(events: RetainedSessionEvents<P>) {
        this.#events = events;
    }

    readonly #entry = (id: string): Entry<P> => this.#entries.get(id) ?? { lifecycle: { kind: "empty" }, users: 0 };
    readonly #write = (id: string, entry: Entry<P>): void => {
        if (entry.lifecycle.kind === "empty" && entry.users === 0) {
            this.#entries.delete(id);
        } else {
            this.#entries.set(id, entry);
        }
    };
    readonly #resource = (entry: Entry<P>): Resource<P> =>
        entry.lifecycle.kind === "preparing" ? entry.lifecycle.resource : entry.lifecycle;
    readonly get = (id: string): P | undefined => {
        const resource = this.#resource(this.#entry(id));
        return resource.kind === "ready" ? resource.runtime : undefined;
    };
    readonly pending = (id: string): Promise<P> | undefined => {
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
    readonly #setResource = (id: string, resource: Resource<P>): void => {
        const entry = this.#entry(id);
        this.#write(id, {
            ...entry,
            lifecycle: entry.lifecycle.kind === "preparing" ? { ...entry.lifecycle, resource } : resource,
        });
    };
    readonly retain = (id: string, runtime: P): void => {
        this.#setResource(id, { kind: "ready", runtime });
    };
    readonly detach = (id: string, expected: P): boolean => {
        if (this.get(id) !== expected) {
            return false;
        }
        this.#setResource(id, { kind: "empty" });
        return true;
    };
    readonly entries = (): readonly (readonly [string, P])[] => {
        const result: (readonly [string, P])[] = [];
        for (const id of this.#entries.keys()) {
            const runtime = this.get(id);
            if (runtime !== undefined) {
                result.push([id, runtime]);
            }
        }
        return result;
    };
    readonly prepare = (id: string, start: () => Promise<P>): Promise<P> => {
        const pending = this.pending(id);
        if (pending !== undefined) {
            return pending;
        }
        const completion = Promise.withResolvers<P>();
        const entry = this.#entry(id);
        this.#write(id, {
            ...entry,
            lifecycle: {
                kind: "preparing",
                completion: completion.promise,
                resource: this.#resource(entry),
            },
        });
        const run = async (): Promise<P> => {
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
