import type { ActiveRuntimeTurn } from "./active-turn.ts";

/** Worker upgrade admission: foreground turns, queued input, and live native background work. */
export class RuntimeTurnActivity {
    readonly #turns = new Set<ActiveRuntimeTurn>();
    readonly #backgroundSources = new Set<object>();
    readonly #idleWaiters = new Set<() => void>();
    // When work last started or stopped; the quiet period is measured from here.
    #changedAt = Date.now();
    #reserved = false;

    readonly acceptsPrompts = (): boolean => !this.#reserved;

    readonly count = (): number => this.#turns.size + this.#backgroundSources.size;

    readonly describe = (): { readonly turns: number; readonly backgroundSources: number } => ({
        turns: this.#turns.size,
        backgroundSources: this.#backgroundSources.size,
    });

    readonly setBackgroundActivity = (source: object, active: boolean): void => {
        // Agents repeat unchanged reports; only a transition counts as activity.
        if (active === this.#backgroundSources.has(source)) {
            return;
        }
        if (active) {
            this.#backgroundSources.add(source);
        } else {
            this.#backgroundSources.delete(source);
        }
        this.#changed();
    };

    readonly start = (turn: ActiveRuntimeTurn): void => {
        this.#turns.add(turn);
        this.#changed();
    };

    readonly finish = (turn: ActiveRuntimeTurn): void => {
        this.#turns.delete(turn);
        this.#changed();
    };

    #changed(): void {
        this.#changedAt = Date.now();
        if (this.count() === 0) {
            for (const resolve of this.#idleWaiters) {
                resolve();
            }
            this.#idleWaiters.clear();
        }
    }

    readonly whenIdle = (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if (this.count() === 0) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const abort = (): void => {
                this.#idleWaiters.delete(idle);
                reject(signal.reason);
            };
            const idle = (): void => {
                signal.removeEventListener("abort", abort);
                resolve();
            };
            this.#idleWaiters.add(idle);
            signal.addEventListener("abort", abort, { once: true });
        });
    };

    /**
     * Close admission only after the Runtime has had no work for `quietMilliseconds`.
     * The moment a reply finishes is when a user is most likely to continue, so idle
     * alone is not an upgrade window. Checking and reserving happen synchronously, so
     * no prompt can be admitted between them.
     */
    readonly reserveIfQuiet = (quietMilliseconds: number): Disposable | null => {
        if (this.#reserved) {
            throw new Error("A daemon upgrade already owns admission");
        }
        if (this.count() > 0 || Date.now() - this.#changedAt < quietMilliseconds) {
            return null;
        }
        this.#reserved = true;
        return {
            [Symbol.dispose]: () => {
                this.#reserved = false;
            },
        };
    };
}
