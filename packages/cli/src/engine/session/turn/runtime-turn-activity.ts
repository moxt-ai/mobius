import type { BackgroundActivity } from "../../acp/agent/in-process-endpoint.ts";
import type { ActiveRuntimeTurn } from "./active-turn.ts";

/** Worker upgrade admission: foreground turns, queued input, and live native background work. */
export class RuntimeTurnActivity {
    readonly #turns = new Set<ActiveRuntimeTurn>();
    readonly #backgroundSources = new Map<object, Exclude<BackgroundActivity, "none">>();
    readonly #idleWaiters = new Set<() => void>();
    // When work last started or stopped; the quiet period is measured from here.
    #changedAt = Date.now();
    #reserved = false;

    readonly acceptsPrompts = (): boolean => !this.#reserved;

    readonly count = (): number => this.#turns.size + this.#backgroundSources.size;

    /** Why admission is held: prompts running or queued, native tasks running, results not yet handled. */
    readonly describe = (): {
        readonly turns: number;
        readonly backgroundRunning: number;
        readonly backgroundAwaitingResults: number;
    } => {
        const activities = [...this.#backgroundSources.values()];
        return {
            turns: this.#turns.size,
            backgroundRunning: activities.filter((activity) => activity === "running").length,
            backgroundAwaitingResults: activities.filter((activity) => activity === "awaiting-results").length,
        };
    };

    readonly setBackgroundActivity = (source: object, activity: BackgroundActivity): void => {
        // Agents repeat unchanged reports; only a transition counts as activity.
        if (activity === (this.#backgroundSources.get(source) ?? "none")) {
            return;
        }
        if (activity === "none") {
            this.#backgroundSources.delete(source);
        } else {
            this.#backgroundSources.set(source, activity);
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
