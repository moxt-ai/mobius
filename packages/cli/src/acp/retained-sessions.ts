import type { AcpProcessSession } from "./process-session.ts";

type Resource = { readonly kind: "empty" } | { readonly kind: "ready"; readonly runtime: AcpProcessSession };
type Lifecycle =
    | Resource
    | {
          readonly kind: "preparing";
          readonly completion: Promise<AcpProcessSession>;
          readonly resource: Resource;
      };
interface Entry {
    readonly lifecycle: Lifecycle;
    readonly users: number;
}
interface RetainedSessionEvents {
    readonly touch: (runtime: AcpProcessSession) => void;
    readonly changed: () => void;
}

/** One independent cache for either execution sessions or history browsers. */
export class RetainedSessions {
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
    readonly get = (id: string): AcpProcessSession | undefined => {
        const resource = this.#resource(this.#entry(id));
        return resource.kind === "ready" ? resource.runtime : undefined;
    };
    readonly pending = (id: string): Promise<AcpProcessSession> | undefined => {
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
    readonly retain = (id: string, runtime: AcpProcessSession): void => {
        this.#setResource(id, { kind: "ready", runtime });
    };
    readonly detach = (id: string, expected: AcpProcessSession): boolean => {
        if (this.get(id) !== expected) {
            return false;
        }
        this.#setResource(id, { kind: "empty" });
        return true;
    };
    readonly entries = (): readonly (readonly [string, AcpProcessSession])[] => {
        const result: (readonly [string, AcpProcessSession])[] = [];
        for (const id of this.#entries.keys()) {
            const runtime = this.get(id);
            if (runtime !== undefined) {
                result.push([id, runtime]);
            }
        }
        return result;
    };
    readonly prepare = (id: string, start: () => Promise<AcpProcessSession>): Promise<AcpProcessSession> => {
        const pending = this.pending(id);
        if (pending !== undefined) {
            return pending;
        }
        const completion = Promise.withResolvers<AcpProcessSession>();
        const entry = this.#entry(id);
        this.#write(id, {
            ...entry,
            lifecycle: {
                kind: "preparing",
                completion: completion.promise,
                resource: this.#resource(entry),
            },
        });
        const run = async (): Promise<AcpProcessSession> => {
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
