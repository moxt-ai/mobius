import type { ActiveRuntimeTurn } from "./active-turn.ts";

type UpgradeAdmission =
    | { readonly kind: "open" }
    | { readonly kind: "waiting"; readonly reserve: () => void }
    | { readonly kind: "reserved" };

/** Worker upgrade admission: foreground turns, queued input, and live native background work. */
export class RuntimeTurnActivity {
    readonly #turns = new Set<ActiveRuntimeTurn>();
    readonly #backgroundSources = new Set<object>();
    #admission: UpgradeAdmission = { kind: "open" };

    readonly acceptsPrompts = (): boolean => this.#admission.kind !== "reserved";

    readonly count = (): number => this.#turns.size + this.#backgroundSources.size;

    readonly setBackgroundActivity = (source: object, active: boolean): void => {
        if (active) {
            this.#backgroundSources.add(source);
        } else {
            this.#backgroundSources.delete(source);
        }
        this.#reserveIfIdle();
    };

    #reserveIfIdle(): void {
        if (this.count() === 0 && this.#admission.kind === "waiting") {
            this.#admission.reserve();
        }
    }

    readonly start = (turn: ActiveRuntimeTurn): void => {
        this.#turns.add(turn);
    };

    readonly finish = (turn: ActiveRuntimeTurn): void => {
        this.#turns.delete(turn);
        // Close admission synchronously with the last completion.
        this.#reserveIfIdle();
    };

    readonly reserveWhenIdle = (signal: AbortSignal): Promise<Disposable> => {
        signal.throwIfAborted();
        if (this.#admission.kind !== "open") {
            throw new Error("A daemon upgrade already owns admission");
        }
        return new Promise<Disposable>((resolve, reject) => {
            const abort = (): void => {
                this.#admission = { kind: "open" };
                signal.removeEventListener("abort", abort);
                reject(signal.reason);
            };
            const reserve = (): void => {
                this.#admission = { kind: "reserved" };
                signal.removeEventListener("abort", abort);
                resolve({
                    [Symbol.dispose]: () => {
                        this.#admission = { kind: "open" };
                    },
                });
            };
            this.#admission = { kind: "waiting", reserve };
            signal.addEventListener("abort", abort, { once: true });
            if (this.count() === 0) {
                reserve();
            }
        });
    };
}
